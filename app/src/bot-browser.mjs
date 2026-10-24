// The Bot browsers' webviews in the app window, adapted from DeepSeek Harness
// apps/desktop/src/browser-guests.ts (see NOTICE). ds-bot asks for a lease on a storage key
// (`bot:<id>`) and creates a webview that carries the lease; only such a webview attaches, and it
// gets fixed preferences. Unlike DSH Desktop's, a key's storage is kept on disk: a Bot stays signed
// in after a restart until ds-bot forgets the key.
import { createHash, randomUUID } from 'node:crypto'

const KEY_MAX = 4096
const BLANK = 'about:blank#'
const LOOPBACK = new Set(['localhost', '0.0.0.0', '[::1]', '[::]', '[::ffff:7f00:1]'])

/** The persistent partition of a storage key: the same key keeps the same storage across restarts. */
export const partitionOf = key => `persist:ds-bot-browser-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`

/** Whether a URL reaches the app's own Host: its port answers under every loopback name. */
export function isAppHost(url, origin) {
  if (origin === undefined) return false
  const host = new URL(origin)
  if (url.port !== host.port) return false
  const name = url.hostname.replace(/\.$/u, '')
  return name === host.hostname || LOOPBACK.has(name) || name.endsWith('.localhost') || /^127\./u.test(name)
}

const credentialFree = url => url.username === '' && url.password === ''

/** Where a page may go, or open a new tab to: http(s) without credentials, never the app's Host. */
export function allowedNavigation(value, origin) {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return (url.protocol === 'http:' || url.protocol === 'https:') && credentialFree(url) && !isAppHost(url, origin)
}

/** Every request of a guest: network ones as navigations allow, else only inert local schemes. */
export function requestAllowed(value, origin) {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return credentialFree(url) && !isAppHost(url, origin)
  return ['about:', 'data:', 'blob:'].includes(url.protocol)
}

const keyOf = (key) => {
  if (typeof key !== 'string' || key.length === 0 || key.length > KEY_MAX) throw new Error('DeepSeek Bot: a browser storage key is required')
  return key
}

export class BotBrowserGuests {
  /** @type {Map<string, {owner: any, partition: string, attached: boolean, guest?: any}>} */
  #leases = new Map()
  #configured = new Set()
  #downloadHandlers = new Map()

  /**
   * @param {{ session: any, origin: () => string | undefined, devTools: boolean }} options - Electron's
   * `session` module, the Host's loopback origin, which guests cannot reach, and whether guests open DevTools.
   */
  constructor({ session, origin, devTools }) {
    this.session = session
    this.origin = origin
    this.devTools = devTools
  }

  /** One guest in the key's partition: an opaque lease and the partition approved for it. */
  acquire(owner, key) {
    const { partition } = this.storageFor(key)
    const lease = randomUUID()
    this.#leases.set(lease, { owner, partition, attached: false })
    return { lease, partition }
  }

  /** Return the configured storage used by both the legacy guest and main-owned views. */
  storageFor(key) {
    const partition = partitionOf(keyOf(key))
    if (!this.#configured.has(partition)) {
      this.#configure(this.session.fromPartition(partition), partition)
      this.#configured.add(partition)
    }
    return { partition, storage: this.session.fromPartition(partition) }
  }

  setDownloadHandler(key, handler) {
    const { storage, partition } = this.storageFor(key)
    this.#downloadHandlers.set(partition, handler)
    return storage
  }

  /** Close a lease's guest; its partition's storage stays. */
  async release(owner, id) {
    if (typeof id !== 'string') throw new Error('DeepSeek Bot: invalid browser lease')
    const lease = this.#leases.get(id)
    if (lease === undefined) return
    if (lease.owner !== owner) throw new Error('DeepSeek Bot: the browser lease belongs to another window')
    this.#leases.delete(id)
    const guest = lease.guest
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise((resolve) => { guest.once('destroyed', resolve) })
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
  }

  /** Close the key's guests and clear its storage, as when its Bot is deleted. */
  async forget(owner, key) {
    const partition = partitionOf(keyOf(key))
    const own = [...this.#leases].filter(([, lease]) => lease.owner === owner && lease.partition === partition)
    await Promise.all(own.map(([id]) => this.release(owner, id)))
    const storage = this.session.fromPartition(partition)
    await storage.clearStorageData()
    await storage.clearCache()
    this.#downloadHandlers.delete(partition)
  }

  /** Install the attachment checks before the window's page can create a webview. */
  bind(window) {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith(BLANK) ? params.src.slice(BLANK.length) : ''
      const lease = this.#leases.get(id)
      if (lease === undefined || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
        event.preventDefault()
        return
      }
      lease.attached = true
      // Keep Electron's allowpopups flag: it lets window requests reach the guest's handler, which denies them all.
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true, devTools: this.devTools,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      let attached
      // The first document is the inert about:blank that carries the lease; the guest is bound on
      // this main-process event, before the page can navigate it.
      guest.once('dom-ready', () => {
        const url = guest.getURL()
        const id = url.startsWith(BLANK) ? url.slice(BLANK.length) : ''
        const lease = this.#leases.get(id)
        if (lease === undefined || lease.owner !== owner || lease.guest !== undefined) {
          guest.close({ waitForBeforeUnload: false })
          return
        }
        lease.guest = guest
        attached = id
        guest.once('destroyed', () => { this.#leases.delete(id) })
      })
      // A page's new window becomes a new tab of the same Bot, which ds-bot opens on this request.
      guest.setWindowOpenHandler(({ url, postBody }) => {
        const lease = attached === undefined ? undefined : this.#leases.get(attached)
        if (lease?.guest === guest && !owner.isDestroyed() && postBody === undefined && allowedNavigation(url, this.origin())) {
          owner.send('ds-bot:browser-open-requested', { lease: attached, url: new URL(url).href })
        }
        return { action: 'deny' }
      })
      guest.on('will-frame-navigate', (event) => {
        if (event.isMainFrame && !allowedNavigation(event.url, this.origin())) event.preventDefault()
      })
      guest.on('will-redirect', (event) => {
        if (event.isMainFrame && !allowedNavigation(event.url, this.origin())) event.preventDefault()
      })
      guest.on('will-attach-webview', (event) => { event.preventDefault() })
      guest.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    })
    const releaseAll = () => {
      for (const [id, lease] of this.#leases) {
        if (lease.owner === owner) void this.release(owner, id).catch((error) => { console.error(error) })
      }
    }
    owner.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) releaseAll()
    })
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  #configure(storage, partition) {
    storage.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    storage.setPermissionCheckHandler(() => false)
    storage.setDevicePermissionHandler(() => false)
    storage.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    storage.on('will-download', (event, item, source) => {
      const handler = this.#downloadHandlers.get(partition)
      if (handler) handler(event, item, source)
      else event.preventDefault()
    })
    storage.webRequest.onBeforeRequest((details, callback) => { callback({ cancel: !requestAllowed(details.url, this.origin()) }) })
  }
}
