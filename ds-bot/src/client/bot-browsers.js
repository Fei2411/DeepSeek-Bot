// Bot browsers in DSH Desktop and the desktop app: per Bot, a tab strip of pages. Each tab
// is one Electron webview in the Bot's own storage partition (`browser.acquire('bot:<id>')`
// on either one's bridge — the same key always yields the same partition, so cookies and logins
// never cross Bots while a Bot may hold several pages). Moving a webview to another
// parent reloads its guest, so every webview lives in one body-level layer for its
// whole life: the panel reports a rectangle, the shown tab's webview is placed over
// it, and the others stay at the same size (their layout, and so what a read sees,
// stays the same) but hidden.

import { READ_PAGE_SCRIPT } from './read-page.js'
import { setEntry, sharedMap } from './shared-map.js'
import { STORAGE } from './storage.js'

export { READ_PAGE_SCRIPT }

const STORE_KEY = STORAGE.browsers
// Each live guest is a renderer process; past this many across every Bot and tab,
// the least recently shown one is released (its address and excerpt are kept and
// it reloads when it is shown again).
const MAX_LIVE = 6
const READ_TIMEOUT_MS = 10_000
const PREVIEW_TIMEOUT_MS = 3000
const RESIZE_LATER_MS = 200
const SEARCH_URL = 'https://www.bing.com/search?q='
// The drawer cards preview a page by its own words: its description, else its first
// real paragraph. Webview capturePage() is not used: on Windows a failed capture
// (UnknownVizError) takes the whole app renderer down.
export const PREVIEW_SCRIPT = `(() => {
  const meta = key => document.querySelector('meta[name="' + key + '"],meta[property="' + key + '"]')?.content ?? ''
  const paragraph = [...document.querySelectorAll('main p, article p, p')].map(node => node.innerText ?? '').find(text => text.trim().length > 40) ?? ''
  const text = meta('description') || meta('og:description') || paragraph || document.body?.innerText || ''
  return text.replace(/\\s+/g, ' ').trim().slice(0, 200)
})()`

const EMPTY = { url: '', title: '', favicon: null, loading: false, canGoBack: false, canGoForward: false, error: null, live: false, excerpt: '' }
export function createAppViewProxy(bridge, botId, tabId) {
  const listeners = new Map()
  const state = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false }
  const fire = (name, event = {}) => {
    for (const listener of listeners.get(name) ?? []) listener({ type: name, ...event })
  }
  return {
    isAppViewProxy: true, style: {}, dataset: {},
    addEventListener(name, listener, options = {}) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      options.signal?.addEventListener('abort', () => this.removeEventListener(name, listener), { once: true })
    },
    removeEventListener(name, listener) { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== listener)) },
    setAttribute() {},
    remove() { void bridge.views.place(tabId, null, false) },
    getURL() { return state.url },
    getTitle() { return state.title },
    isLoading() { return state.loading },
    canGoBack() { return state.canGoBack },
    canGoForward() { return state.canGoForward },
    loadURL(url) { return bridge.views.navigate(botId, tabId, url) },
    executeJavaScript(script) { return bridge.views.read(botId, tabId, script) },
    goBack() { return bridge.views.command(botId, tabId, 'back') },
    goForward() { return bridge.views.command(botId, tabId, 'forward') },
    reload() { return bridge.views.command(botId, tabId, 'reload') },
    stop() { return bridge.views.command(botId, tabId, 'stop') },
    focus() { return bridge.views.focus(botId, tabId) },
    update(next) {
      Object.assign(state, next)
      fire('did-navigate')
      fire('did-stop-loading')
      fire('page-title-updated')
      if (!state.loading) fire('dom-ready')
    },
  }
}
// Local and LAN pages open; cloud metadata services do not, since on a cloud machine they
// hand out account credentials. The Desktop shell already refuses its own host port.
const METADATA_HOST = /^(169\.254\.\d+\.\d+|\[fd00:ec2::254\]|metadata\.google\.internal)$/i
const BLOCKED = 'Cloud metadata addresses do not open here.'
export const blockedAddress = url => URL.canParse(url) && METADATA_HOST.test(new URL(url).hostname)

/**
 * An address-bar entry as a URL: an explicit http(s) URL, a host (local and private
 * addresses over http), or else a web search.
 * @returns {string|null} null for a refused scheme.
 */
export function browserAddress(input) {
  const text = String(input ?? '').trim()
  if (text === '') return null
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) return /^https?:\/\//i.test(text) && URL.canParse(text) ? new URL(text).href : null
  if (/^(about|javascript|data|file|blob|chrome|devtools|view-source):/i.test(text)) return null
  const host = text.split(/[/?#]/)[0]
  const local = /^(localhost|127(\.\d+){3}|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|\[[\da-f:]+\])(:\d+)?$/i.test(host)
  const looksLikeHost = !/\s/.test(text) && (local || /^[^\s.]+(\.[^\s.]+)+(:\d+)?$/.test(host))
  if (looksLikeHost && URL.canParse(`http://${text}`)) return new URL(`${local ? 'http' : 'https'}://${text}`).href
  return `${SEARCH_URL}${encodeURIComponent(text)}`
}

/**
 * @param {{ bridge: any, createSource: (initial:any) => any, storage?: Storage, document?: Document }} options
 */
export function createBotBrowsers({ bridge, createSource, storage = globalThis.localStorage, document: doc = globalThis.document, guestFactory }) {
  /** @type {Map<string, any>} tabId -> guest entry */
  const views = new Map()
  /** @type {Map<string, string>} tabId -> owning Bot id */
  const owner = new Map()
  // Per Bot: { ids: [tabId...], active: tabId | null }.
  const tabs = createSource({})
  // Per tab: { url, title, favicon, loading, canGoBack, canGoForward, error, live, readAt?, excerpt }
  const pages = createSource({})
  const holds = createSource({})
  // Per Bot, what survives a reload: { tabs: [{id,url,title}], active }. Another window
  // saves its own Bots' tabs into the same object.
  const store = sharedMap(STORE_KEY, storage)
  let saved = store.read()
  // Bots this window has seen on the team: one deleted later is forgotten even if it never had a tab.
  const seen = new Set()
  let layer
  let shown = null
  // The last panel rectangle sizes every guest, shown or not; `visible` says whether the
  // shown tab's guest is on screen.
  let rect = null
  let visible = false
  let resizeLater = 0
  let disposed = false
  let serial = 0
  const makeGuest = guestFactory ?? (bridge.views
    ? ({ botId, tabId }) => ({ element: createAppViewProxy(bridge, botId, tabId), appView: true })
    : ({ document }) => ({ element: document.createElement('webview'), appView: false }))
  const appViewEvents = bridge.views?.subscribe?.((change) => {
    const { botId, tabId } = change ?? {}
    if (!botId || !tabId) return
    if (change.type === 'closed') {
      const entry = views.get(tabId)
      entry?.stop()
      views.delete(tabId)
      owner.delete(tabId)
      tabs.set(snapshot => {
        const current = snapshot[botId]
        if (!current) return snapshot
        const ids = current.ids.filter(id => id !== tabId)
        if (ids.length === 0) { const next = { ...snapshot }; delete next[botId]; return next }
        return { ...snapshot, [botId]: { ids, active: current.active === tabId ? ids.at(-1) : current.active } }
      })
      pages.set(snapshot => { const { [tabId]: _, ...rest } = snapshot; return rest })
      persist(botId)
      return
    }
    if (!owner.has(tabId)) owner.set(tabId, botId)
    if (change.type === 'created') {
      ensureTabs(botId)
      tabs.set(snapshot => {
        const own = snapshot[botId] ?? { ids: [], active: null }
        if (own.ids.includes(tabId)) return snapshot
        return { ...snapshot, [botId]: { ids: [...own.ids, tabId], active: tabId } }
      })
      publish(tabId, { url: change.url ?? '', title: change.title ?? '', live: true })
      persist(botId)
      void open(tabId)
    }
    const entry = views.get(tabId)
    if (entry?.appView) {
      entry.botAttached = change.botAttached === true
      entry.ready = change.loading !== true
      entry.element.update(change)
      if (entry.ready) { observe(entry); void preview(tabId) }
    }
    publish(tabId, change)
  })

  const savedTab = (botId, tabId) => saved[botId]?.tabs?.find(entry => entry.id === tabId)
  const publish = (tabId, patch) => pages.set((state) => {
    const botId = owner.get(tabId)
    return { ...state, [tabId]: { ...EMPTY, ...savedTab(botId, tabId), ...state[tabId], ...patch } }
  })
  const save = (botId, entry) => { saved = store.update(stored => setEntry(stored, botId, entry), saved) }
  const persist = (botId) => {
    const state = tabs.getSnapshot()[botId]
    const snapshot = pages.getSnapshot()
    save(botId, state && {
      tabs: state.ids.map(id => ({ id, url: snapshot[id]?.url ?? '', title: snapshot[id]?.title ?? '' })),
      active: state.active,
    })
  }

  // Saved tabs come back as placeholders: they show in the strip and open their
  // guest only when the panel puts them on screen.
  const ensureTabs = (botId) => {
    if (tabs.getSnapshot()[botId] !== undefined) return
    const entries = saved[botId]?.tabs ?? []
    const ids = entries.map(entry => entry.id)
    const active = ids.includes(saved[botId]?.active) ? saved[botId].active : (ids.at(-1) ?? null)
    for (const entry of entries) owner.set(entry.id, botId)
    tabs.set(state => ({ ...state, [botId]: { ids, active } }))
    for (const entry of entries) publish(entry.id, { url: entry.url ?? '', title: entry.title ?? '', live: false })
  }

  const ensureLayer = () => {
    if (layer?.isConnected) return layer
    layer = doc.createElement('div')
    layer.className = 'bt-browser-layer'
    // Inline, not in BROWSER_CSS: Agent mode withdraws the Bot styles, and the
    // webviews must stay out of the page flow then too.
    Object.assign(layer.style, { position: 'fixed', inset: '0', zIndex: '41', pointerEvents: 'none' })
    doc.body.append(layer)
    return layer
  }

  const place = (entry) => {
    const box = rect ?? { left: 0, top: 0, width: 800, height: 600 }
    if (entry.appView) {
      void bridge.views.place(entry.tabId, box, shown === entry.tabId && visible && Boolean(rect))
      return
    }
    Object.assign(entry.element.style, {
      left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`,
      visibility: shown === entry.tabId && visible && rect ? 'visible' : 'hidden',
    })
  }

  // A settled page leaves a short excerpt for the drawer cards, shown or hidden; a
  // failed or empty read keeps the excerpt the tab already has.
  async function preview(tabId) {
    const entry = views.get(tabId)
    if (entry === undefined || !entry.ready || !/^https?:/i.test(entry.element.getURL())) return false
    let timer
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(''), PREVIEW_TIMEOUT_MS) })
    try {
      const excerpt = await Promise.race([entry.element.executeJavaScript(PREVIEW_SCRIPT), timeout])
      if (typeof excerpt !== 'string' || excerpt === '' || views.get(tabId) !== entry) return false
      publish(tabId, { excerpt })
      return true
    } catch { return false } finally { clearTimeout(timer) }
  }

  const observe = (entry) => {
    const { element } = entry
    if (!entry.ready) return
    const url = element.getURL()
    if (url.startsWith('about:blank#')) return
    if (entry.fresh) {
      // The lease-bearing bootstrap document is not a history entry.
      element.clearHistory()
      entry.fresh = false
    }
    const title = element.getTitle()
    publish(entry.tabId, { url, title, loading: element.isLoading(), canGoBack: element.canGoBack(), canGoForward: element.canGoForward(), live: true })
    persist(entry.botId)
  }

  async function create(tabId) {
    const botId = owner.get(tabId)
    const guest = await makeGuest({ bridge, document: doc, botId, tabId })
    const pending = pages.getSnapshot()[tabId]?.url || savedTab(botId, tabId)?.url
    const reservation = guest.appView ? undefined : await bridge.acquire(`bot:${botId}`)
    if (disposed) {
      if (reservation) await bridge.release(reservation.lease).catch(() => {})
      else await bridge.views.close(botId, tabId).catch(() => {})
      return undefined
    }
    if (guest.appView) await bridge.views.create(botId, tabId, pending ?? '')
    const element = guest.element
    // The shell forwards app shortcuts from a focused webview that carries these
    // attributes, as it does for its own Sidebar browser.
    element.dataset.sidebarBrowserFrame = 'webview'
    Object.assign(element.style, { position: 'fixed', display: 'flex', border: '0', pointerEvents: 'auto', background: '#fff' })
    element.dataset.btBrowser = tabId
    if (!guest.appView) {
      element.setAttribute('name', reservation.lease)
      element.setAttribute('partition', reservation.partition)
      element.setAttribute('allowpopups', '')
      element.setAttribute('src', `about:blank#${reservation.lease}`)
    }
    const entry = { botId, tabId, element, lease: reservation?.lease, appView: guest.appView, botAttached: false, ready: false, fresh: !guest.appView, pending: guest.appView ? undefined : pending, usedAt: Date.now() }
    const lifetime = new AbortController()
    entry.stop = () => lifetime.abort()
    const { signal } = lifetime
    // A page that asks for a new window gets a new tab in the same Bot, activated.
    if (!guest.appView) {
      const unsubscribe = bridge.onOpenRequested(reservation.lease, url => void openTab(botId, url))
      signal.addEventListener('abort', unsubscribe, { once: true })
    }
    element.addEventListener('dom-ready', () => {
      entry.ready = true
      observe(entry)
      if (entry.pending) {
        const url = entry.pending
        entry.pending = undefined
        void element.loadURL(url).catch(() => {})
      }
    }, { signal })
    for (const name of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']) {
      element.addEventListener(name, () => observe(entry), { signal })
    }
    element.addEventListener('did-stop-loading', () => { void preview(tabId) }, { signal })
    element.addEventListener('page-favicon-updated', (event) => {
      const favicon = event.favicons?.[0]
      // The tab strip renders in the outer renderer, outside the Bot's webview
      // partition; only self-contained icons may load there, the rest stay globes.
      if (typeof favicon === 'string' && favicon.startsWith('data:')) publish(tabId, { favicon })
    }, { signal })
    element.addEventListener('did-start-navigation', (event) => {
      if (!event.isMainFrame) return
      if (blockedAddress(event.url)) {
        element.stop()
        publish(tabId, { loading: false, error: BLOCKED })
        return
      }
      publish(tabId, { loading: true, error: null })
    }, { signal })
    element.addEventListener('did-fail-load', (event) => {
      // -3 is an aborted load: another navigation replaced it.
      if (event.isMainFrame && event.errorCode !== -3) publish(tabId, { loading: false, error: event.errorDescription || `Error ${event.errorCode}` })
    }, { signal })
    element.addEventListener('render-process-gone', () => {
      // A gone renderer while the entry is still live is a crash: drop the guest
      // and leave a retryable error, since the open effect will not fire again
      // for an unchanged tab. (Closing a tab removes the entry first, so its own
      // teardown never lands here.)
      if (views.get(tabId) === undefined) return
      void release(tabId)
      publish(tabId, { loading: false, error: 'The page crashed.' })
    }, { signal })
    views.set(tabId, entry)
    if (!guest.appView) ensureLayer().append(element)
    place(entry)
    publish(tabId, { live: true, loading: Boolean(entry.pending) })
    if (guest.appView) {
      const state = (await bridge.views.sync(botId)).find(view => view.tabId === tabId)
      if (state) {
        entry.botAttached = state.botAttached === true
        element.update(state)
      }
    }
    return entry
  }

  // One acquisition at a time per tab.
  const opening = new Map()
  function open(tabId) {
    const entry = views.get(tabId)
    if (entry) return Promise.resolve(entry)
    let job = opening.get(tabId)
    if (job === undefined) {
      // A refused lease (the Desktop's browser service is not up yet, or the
      // acquire failed) leaves the tab with an error it can retry from; the
      // job resolves undefined instead of rejecting, so no caller drops one.
      job = create(tabId)
        .catch((error) => {
          console.warn('[ds-bot] browser acquire', error)
          publish(tabId, { loading: false, error: String(error?.message ?? error) })
          return undefined
        })
        .finally(() => opening.delete(tabId))
      opening.set(tabId, job)
      void job.then(() => trim())
    }
    return job
  }

  // Release the least recently shown guests beyond the limit, never the one on screen.
  function trim() {
    const idle = [...views.values()].filter(entry => !entry.appView && !entry.botAttached && entry.tabId !== shown).sort((a, b) => a.usedAt - b.usedAt)
    while ([...views.values()].filter(entry => !entry.appView).length > MAX_LIVE && idle.length > 0) void release(idle.shift().tabId)
  }

  async function release(tabId) {
    const entry = views.get(tabId)
    if (entry === undefined) return
    if (entry.appView) {
      await bridge.views.place(tabId, rect ?? { left: 0, top: 0, width: 800, height: 600 }, false)
      return
    }
    views.delete(tabId)
    entry.stop()
    entry.element.remove()
    publish(tabId, { live: false, loading: false })
    await bridge.release(entry.lease).catch(error => console.warn('[ds-bot] browser release', error))
  }

  function openTab(botId, url) {
    ensureTabs(botId)
    const tabId = `t${Date.now().toString(36)}-${++serial}`
    owner.set(tabId, botId)
    tabs.set((state) => {
      const own = state[botId] ?? { ids: [], active: null }
      return { ...state, [botId]: { ids: [...own.ids, tabId], active: tabId } }
    })
    publish(tabId, { url: '', title: '', live: false })
    if (typeof url === 'string' && url !== '') void navigate(tabId, url)
    persist(botId)
    return tabId
  }

  async function closeTab(botId, tabId) {
    const state = tabs.getSnapshot()[botId]
    if (state === undefined || !state.ids.includes(tabId)) return
    await opening.get(tabId)?.catch(() => {})
    if (shown === tabId) await show(null)
    if (views.get(tabId)?.appView) {
      await bridge.views.close(botId, tabId)
      views.get(tabId)?.stop()
      views.delete(tabId)
    } else await release(tabId)
    // The waits above can overlap a new tab or an active-tab switch; drop the
    // target from the latest state, not the snapshot taken before them.
    tabs.set((snapshot) => {
      const current = snapshot[botId]
      if (current === undefined || !current.ids.includes(tabId)) return snapshot
      const at = current.ids.indexOf(tabId)
      const ids = current.ids.filter(id => id !== tabId)
      // The tab after the closed one takes over; closing the last picks the new last.
      const active = current.active === tabId ? (ids[Math.min(at, ids.length - 1)] ?? null) : current.active
      const next = { ...snapshot }
      if (ids.length === 0) delete next[botId]
      else next[botId] = { ids, active }
      return next
    })
    owner.delete(tabId)
    pages.set((snapshot) => {
      if (snapshot[tabId] === undefined) return snapshot
      const { [tabId]: _, ...rest } = snapshot
      return rest
    })
    persist(botId)
  }

  function activate(botId, tabId) {
    ensureTabs(botId)
    const state = tabs.getSnapshot()[botId]
    if (state === undefined || !state.ids.includes(tabId) || state.active === tabId) return
    tabs.set(snapshot => ({ ...snapshot, [botId]: { ...state, active: tabId } }))
    persist(botId)
  }

  const activeTab = botId => tabs.getSnapshot()[botId]?.active ?? null

  /**
   * Select the tab whose guest goes on screen, or none with `null`. With a `box`
   * (viewport pixels) its guest is placed there; without one it stays hidden, as
   * while the panel slides in or shows its own empty or error state.
   */
  async function show(tabId, box = null) {
    // The shown guest only moved (the panel is being dragged): it follows at once, the
    // hidden ones take the new size once the rectangle stops changing.
    if (tabId !== null && tabId === shown && visible && box !== null) {
      rect = box
      const entry = views.get(tabId)
      if (entry) place(entry)
      clearTimeout(resizeLater)
      resizeLater = setTimeout(() => { for (const other of views.values()) place(other) }, RESIZE_LATER_MS)
      return
    }
    shown = tabId
    if (box) rect = box
    visible = tabId !== null && box !== null
    for (const entry of views.values()) place(entry)
    if (tabId === null) return
    const entry = await open(tabId)
    if (entry === undefined || shown !== tabId) return
    entry.usedAt = Date.now()
    place(entry)
  }

  async function navigate(tabId, input) {
    const url = browserAddress(input)
    if (url === null || blockedAddress(url)) {
      publish(tabId, { error: url === null ? 'Only http and https addresses open here.' : BLOCKED })
      return false
    }
    const entry = await open(tabId)
    if (entry === undefined) return false
    publish(tabId, { url, loading: true, error: null })
    persist(owner.get(tabId))
    if (!entry.ready) entry.pending = url
    else void entry.element.loadURL(url).catch(() => {})
    return true
  }

  /** A deleted Bot: close its tabs and drop its saved strip. */
  async function forget(botId) {
    ensureTabs(botId)
    for (const tabId of tabs.getSnapshot()[botId]?.ids ?? []) {
      await opening.get(tabId)?.catch(() => {})
      if (shown === tabId) await show(null)
      if (views.get(tabId)?.appView) {
        await bridge.views.close(botId, tabId)
        views.get(tabId)?.stop()
        views.delete(tabId)
      } else await release(tabId)
      owner.delete(tabId)
      pages.set((snapshot) => {
        if (snapshot[tabId] === undefined) return snapshot
        const { [tabId]: _, ...rest } = snapshot
        return rest
      })
    }
    tabs.set((snapshot) => {
      if (snapshot[botId] === undefined) return snapshot
      const { [botId]: _, ...rest } = snapshot
      return rest
    })
    save(botId, undefined)
    seen.delete(botId)
    // The desktop app keeps a Bot's logins on disk; they go with the Bot.
    await bridge.forget?.(`bot:${botId}`)?.catch(error => console.warn('[ds-bot] browser forget', error))
  }

  return {
    tabs,
    pages,
    holds,
    setHolds(value) { holds.set(value && typeof value === 'object' ? value : {}) },
    /** Restore a Bot's saved strip (or an empty one) so the panel can render it. */
    ensureTabs,
    openTab,
    closeTab,
    activate,
    preview,
    show,
    navigate,
    command(tabId, name) {
      const entry = views.get(tabId)
      if (!entry?.ready) return
      if (name === 'back' && entry.element.canGoBack()) entry.element.goBack()
      else if (name === 'forward' && entry.element.canGoForward()) entry.element.goForward()
      else if (name === 'reload') entry.element.reload()
      else if (name === 'stop') entry.element.stop()
    },
    focus(tabId) { views.get(tabId)?.element.focus() },
    /** Pages a read can reach: each Bot's active tab, live and showing a document. */
    openPages() {
      const open = {}
      const snapshot = pages.getSnapshot()
      for (const [botId, state] of Object.entries(tabs.getSnapshot())) {
        const tabId = state.active
        const entry = tabId ? views.get(tabId) : undefined
        const page = tabId ? snapshot[tabId] : undefined
        if (entry?.ready && page?.url) open[botId] = { url: page.url, title: page.title }
      }
      return open
    },
    /** A Bot's read reaches its active tab. */
    async read(botId) {
      const tabId = activeTab(botId)
      const entry = tabId ? views.get(tabId) : undefined
      if (!entry?.ready) throw new Error('This Bot has no browser page open.')
      let timer
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The page took too long to read.')), READ_TIMEOUT_MS) })
      try {
        return await Promise.race([entry.element.executeJavaScript(READ_PAGE_SCRIPT), timeout])
      } finally {
        clearTimeout(timer)
      }
    },
    noteRead(botId) {
      const tabId = activeTab(botId)
      if (tabId) publish(tabId, { readAt: Date.now() })
    },
    release,
    forget,
    /** Forget every Bot outside `botIds`, as when Bots were deleted from another window. */
    retain(botIds) {
      const keep = new Set(botIds)
      const known = new Set([...Object.keys(tabs.getSnapshot()), ...Object.keys(saved), ...owner.values(), ...seen])
      for (const entry of views.values()) known.add(entry.botId)
      for (const botId of keep) seen.add(botId)
      return Promise.all([...known].filter(botId => !keep.has(botId)).map(forget))
    },
    dispose() {
      disposed = true
      clearTimeout(resizeLater)
      for (const entry of views.values()) {
        if (entry.appView) void bridge.views.place(entry.tabId, rect ?? { left: 0, top: 0, width: 800, height: 600 }, false)
        else void release(entry.tabId)
      }
      appViewEvents?.()
      layer?.remove()
    },
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Answers `read_browser` for this window: a long poll (`browser-wait`) reports which Bots
 * have a page open here and brings back read requests, each answered with
 * `browser-result`. A change in the open pages ends the poll so the host learns at once.
 * @param {{ browsers: ReturnType<typeof createBotBrowsers>, post: (endpoint:string, payload:any, signal?:AbortSignal) => Promise<any>, clientId?: string, retryMs?: number }} options
 * @returns {() => void} stop
 */
export function serveBrowserReads({ browsers, post, clientId = globalThis.crypto.randomUUID(), retryMs = 1000 }) {
  let stopped = false
  let poll
  let reported = ''
  // The host hands a request out again until the result lands; the job is cached
  // the moment it starts, so a resend during a slow read shares it, and a resend
  // after a failed submit posts the cached answer again.
  const answered = new Map()
  const answer = async ({ id, botId }) => {
    let job = answered.get(id)
    if (job === undefined) {
      job = (async () => {
        try {
          const result = { id, ok: true, page: await browsers.read(botId) }
          browsers.noteRead(botId)
          return result
        } catch (error) {
          return { id, ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      })()
      answered.set(id, job)
      if (answered.size > 200) answered.delete(answered.keys().next().value)
    }
    await post('browser-result', await job).catch(error => console.warn('[ds-bot] browser result', error))
  }
  const loop = async () => {
    let failures = 0
    while (!stopped) {
      poll = new AbortController()
      const open = browsers.openPages()
      reported = JSON.stringify(open)
      try {
        const response = await post('browser-wait', { clientId, open }, poll.signal)
        browsers.setHolds?.(response?.holds)
        failures = 0
        const requests = Array.isArray(response) ? response : response?.requests
        for (const request of Array.isArray(requests) ? requests : []) void answer(request)
      } catch {
        if (stopped) return
        if (poll.signal.aborted) continue
        failures += 1
        await sleep(Math.min(30_000, retryMs * 2 ** Math.min(failures, 5)))
      }
    }
  }
  const offPages = browsers.pages.subscribe(() => {
    if (JSON.stringify(browsers.openPages()) !== reported) poll?.abort()
  })
  void loop()
  return () => {
    stopped = true
    offPages()
    poll?.abort()
  }
}
