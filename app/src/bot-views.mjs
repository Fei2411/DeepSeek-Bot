import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative as relativePath, resolve, sep } from 'node:path'
import { WebSocketServer } from 'ws'
import { allowedNavigation, requestAllowed } from './bot-browser.mjs'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const PLAYWRIGHT_ARTIFACT_PREFIX = 'playwright-artifacts-'
const rectOf = rect => ({
  x: Math.max(0, Math.round(rect?.left ?? 0)),
  y: Math.max(0, Math.round(rect?.top ?? 0)),
  width: Math.max(1, Math.round(rect?.width ?? 800)),
  height: Math.max(1, Math.round(rect?.height ?? 600)),
})
const BOT_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
export const isBotId = value => typeof value === 'string' && BOT_ID.test(value)

function containsPath(root, target) {
  const relative = relativePath(resolve(root), resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${sep}`) && !isAbsolute(relative))
}

function isDirectChild(root, target) {
  const relative = relativePath(resolve(root), resolve(target))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${sep}`) && !relative.includes(sep) && !isAbsolute(relative)
}

export class BotViews {
  #window
  #WebContentsView
  #guests
  #origin
  #devTools
  #views = new Map()
  #tokens = new Map()
  #clients = new Map()
  #server
  #wss
  #address
  #onChange
  #downloadPaths = new Map()
  #downloadRoots = new Map()
  #statePath
  #saved = {}
  #active = new Map()
  #held = new Set()

  constructor({ window, WebContentsView, guests, origin, devTools = false, onChange = () => {}, statePath }) {
    this.#window = window
    this.#WebContentsView = WebContentsView
    this.#guests = guests
    this.#origin = origin
    this.#devTools = devTools
    this.#onChange = onChange
    this.#statePath = statePath
    if (statePath !== undefined) {
      try {
        const stored = JSON.parse(readFileSync(statePath, 'utf8'))
        if (stored && typeof stored === 'object' && stored.bots && typeof stored.bots === 'object') {
          const bots = {}
          let changed = false
          for (const [botId, saved] of Object.entries(stored.bots)) {
            if (!saved || !Array.isArray(saved.tabs)) { changed = true; continue }
            const tabs = saved.tabs.flatMap(tab => {
              if (!tab || typeof tab.tabId !== 'string' || tab.tabId.length === 0) { changed = true; return [] }
              const url = typeof tab.url === 'string' ? tab.url : 'about:blank'
              const safeUrl = allowedNavigation(url, this.#origin()) ? url : 'about:blank'
              const title = safeUrl === url && typeof tab.title === 'string' ? tab.title : ''
              if (safeUrl !== url || title !== tab.title) changed = true
              return [{ tabId: tab.tabId, url: safeUrl, title }]
            })
            const active = tabs.some(tab => tab.tabId === saved.active) ? saved.active : tabs[0]?.tabId ?? null
            if (tabs.length !== saved.tabs.length || active !== saved.active) changed = true
            if (tabs.length === 0) { changed = true; continue }
            bots[botId] = { tabs, active }
          }
          if (Object.keys(bots).length !== Object.keys(stored.bots).length) changed = true
          this.#saved = bots
          if (changed) this.#persist()
        }
      } catch {}
    }
    this.#server = createServer((_request, response) => { response.writeHead(404).end() })
    this.#wss = new WebSocketServer({ noServer: true })
    this.#server.on('upgrade', (request, socket, head) => {
      const peer = request.socket.remoteAddress
      const token = /^\/devtools\/browser\/([a-f0-9]{64})$/u.exec(request.url ?? '')?.[1]
      if (request.headers.origin !== undefined || !LOOPBACK.has(peer) || token === undefined || !this.#tokens.has(token)) {
        socket.destroy()
        return
      }
      this.#wss.handleUpgrade(request, socket, head, client => {
        this.#wss.emit('connection', client, request, this.#tokens.get(token))
      })
    })
    this.#wss.on('connection', (client, _request, botId) => this.#connect(client, botId))
    this.#server.listen(0, '127.0.0.1')
    this.#server.on('listening', () => { this.#address = this.#server.address() })
  }

  create(botId, { url = 'about:blank', createdByBot = false, openerId, tabId: requestedTabId } = {}) {
    const tabId = requestedTabId ?? randomUUID()
    const existing = this.#views.get(tabId)
    if (existing) {
      if (existing.botId !== botId) throw new Error('Browser tab belongs to another Bot')
      return existing
    }
    const { partition } = this.#guests.storageFor(`bot:${botId}`)
    const view = new this.#WebContentsView({
      webPreferences: {
        partition, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true, devTools: this.#devTools,
      },
    })
    const entry = { tabId, botId, view, createdByBot, openerId, sessions: new Map(), sessionMaps: new Map(), downloads: new Map(), downloadPath: this.#downloadPaths.get(botId), mainFrameId: undefined }
    this.#views.set(tabId, entry)
    this.#window()?.contentView.addChildView(view)
    view.setBounds(rectOf(null))
    view.setVisible(false)
    const contents = view.webContents
    const clients = this.#clients.get(botId) ?? []
    for (const client of clients) {
      if (client.discover) this.#send(client.socket, { method: 'Target.targetCreated', params: { targetInfo: this.#targetInfo(entry) } })
      if (client.autoAttach) client.attach(entry)
    }
    contents.on('did-navigate', () => this.#publish(entry))
    contents.on('did-navigate-in-page', () => this.#publish(entry))
    contents.on('page-title-updated', () => this.#publish(entry))
    contents.on('page-favicon-updated', (_event, favicons) => { entry.favicon = favicons?.[0] ?? null; this.#publish(entry) })
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) { entry.error = description; this.#publish(entry) }
    })
    contents.on('did-start-loading', () => this.#publish(entry))
    contents.on('did-stop-loading', () => this.#publish(entry))
    contents.on('did-start-navigation', event => {
      if (event.isMainFrame && !event.isSameDocument) {
        entry.error = null
        this.#publish(entry)
      }
    })
    contents.on('will-navigate', (event, target) => { if (!allowedNavigation(target, this.#origin())) event.preventDefault() })
    contents.on('will-redirect', (event, target) => { if (!allowedNavigation(target, this.#origin())) event.preventDefault() })
    contents.on('will-frame-navigate', event => {
      if (event.isMainFrame && !allowedNavigation(event.url, this.#origin())) event.preventDefault()
    })
    contents.setWindowOpenHandler(({ url: target, postBody }) => {
      if (postBody === undefined && allowedNavigation(target, this.#origin())) {
        const popup = this.create(botId, { url: target, createdByBot: entry.sessions.size > 0, openerId: tabId })
        this.#publish(popup)
      }
      return { action: 'deny' }
    })
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('login', (event, _details, _auth, callback) => { event.preventDefault(); callback() })
    this.#guests.setDownloadHandler(`bot:${botId}`, (event, item, source) => {
      const target = [...this.#views.values()].find(value => value.botId === botId && value.view.webContents === source)
      if (!target) { event.preventDefault(); return }
      this.#download(target, event, item)
    })
    this.#installDebugger(entry)
    this.#active.set(botId, tabId)
    this.#remember(entry)
    this.#persist()
    this.#onChange({ type: 'created', ...this.#state(entry) })
    const loading = contents.loadURL(url)
    this.#remember(entry)
    this.#persist()
    void loading.catch(() => {})
    return entry
  }

  #download(entry, event, item) {
    if (entry.downloadPath === undefined || entry.sessions.size === 0) {
      event.preventDefault()
      return
    }
    try {
      mkdirSync(entry.downloadPath, { recursive: true })
      const guid = randomUUID()
      const savePath = join(entry.downloadPath, guid)
      item.setSavePath(savePath)
      entry.downloads.set(guid, { item, savePath })
      this.#broadcast(entry.botId, { method: 'Browser.downloadWillBegin', params: {
        frameId: entry.tabId, guid, url: item.getURL(), suggestedFilename: item.getFilename(),
      } })
      const progress = state => this.#broadcast(entry.botId, { method: 'Browser.downloadProgress', params: {
        guid, receivedBytes: item.getReceivedBytes(), totalBytes: Math.max(0, item.getTotalBytes()),
        state: state === 'completed' ? 'completed' : state === 'interrupted' || state === 'cancelled' ? 'canceled' : 'inProgress',
      } })
      item.on('updated', (_event, state) => progress(state))
      item.once('done', (_event, state) => {
        progress(state)
        entry.downloads.delete(guid)
        if (state !== 'completed') void rm(savePath, { force: true }).catch(() => {})
      })
    } catch {
      event.preventDefault()
    }
  }

  #allowedDownloadPath(botId, requested) {
    if (typeof requested !== 'string' || !isAbsolute(requested)) return undefined
    const target = resolve(requested)
    const roots = (this.#downloadRoots.get(botId) ?? []).filter(root => containsPath(root, target))
    const temporaryRoot = resolve(tmpdir())
    let temporaryRealRoot
    try {
      temporaryRealRoot = realpathSync(temporaryRoot)
    } catch {}
    const isArtifact = temporaryRealRoot !== undefined && [temporaryRoot, temporaryRealRoot].some(root =>
      isDirectChild(root, target) && basename(target).startsWith(PLAYWRIGHT_ARTIFACT_PREFIX))
    if (roots.length === 0 && !isArtifact) return undefined
    try {
      mkdirSync(target, { recursive: true })
      const realTarget = realpathSync(target)
      const inRoot = roots.some(root => {
        try { return containsPath(realpathSync(root), realTarget) } catch { return false }
      })
      const inArtifacts = isArtifact && temporaryRealRoot !== undefined
        && isDirectChild(temporaryRealRoot, realTarget)
        && basename(realTarget).startsWith(PLAYWRIGHT_ARTIFACT_PREFIX)
      return inRoot || inArtifacts ? target : undefined
    } catch {
      return undefined
    }
  }

  place(tabId, rect, visible = rect !== null) {
    const entry = this.#views.get(tabId)
    if (!entry) return false
    if (rect !== null) entry.view.setBounds(rectOf(rect))
    entry.view.setVisible(visible === true)
    if (visible === true) {
      this.#active.set(entry.botId, tabId)
      this.#remember(entry)
      this.#persist()
    }
    return true
  }

  async operate(botId, action, payload = {}) {
    const entry = this.#owned(botId, payload.tabId)
    const contents = entry.view.webContents
    switch (action) {
      case 'navigate': return contents.loadURL(String(payload.url))
      case 'command':
        if (payload.command === 'back' && contents.canGoBack()) contents.goBack()
        else if (payload.command === 'forward' && contents.canGoForward()) contents.goForward()
        else if (payload.command === 'reload') contents.reload()
        else if (payload.command === 'stop') contents.stop()
        return true
      case 'focus': contents.focus(); return true
      case 'read': return contents.executeJavaScript(String(payload.script))
      case 'close': return this.close(botId, payload.tabId)
      default: throw new Error('Unknown browser view operation')
    }
  }

  async close(botId, tabId) {
    const entry = this.#owned(botId, tabId)
    for (const [socket, sessionId] of entry.sessions) {
      this.#send(socket, { method: 'Target.detachedFromTarget', params: { sessionId, targetId: tabId } })
      if ([...(this.#clients.get(botId) ?? [])].some(client => client.socket === socket && client.discover)) {
        this.#send(socket, { method: 'Target.targetDestroyed', params: { targetId: tabId } })
      }
    }
    this.#views.delete(tabId)
    this.#dropSaved(botId, tabId)
    entry.view.webContents.close()
    entry.sessions.clear()
    entry.sessionMaps.clear()
    this.#onChange({ type: 'closed', botId, tabId })
    return true
  }

  async forget(botId) {
    for (const entry of [...this.#views.values()]) if (entry.botId === botId) await this.close(botId, entry.tabId)
    for (const [token, id] of this.#tokens) if (id === botId) this.#tokens.delete(token)
    this.#downloadPaths.delete(botId)
    this.#downloadRoots.delete(botId)
    this.#held.delete(botId)
    delete this.#saved[botId]
    this.#persist()
  }

  async endpoint(botId, { downloadRoots } = {}) {
    if (this.#held.has(botId)) throw new Error('The user has taken over this browser.')
    if (downloadRoots !== undefined) {
      if (!Array.isArray(downloadRoots) || downloadRoots.length > 4 || !Array.from(downloadRoots).every(root => typeof root === 'string' && isAbsolute(root))) {
        throw new Error('Invalid browser download roots.')
      }
      this.#downloadRoots.set(botId, [...new Set(downloadRoots.map(root => resolve(root)))])
      this.#downloadPaths.delete(botId)
      for (const entry of this.#views.values()) if (entry.botId === botId) entry.downloadPath = undefined
    }
    if (!this.#address) await new Promise(resolve => this.#server.once('listening', resolve))
    if (this.sync(botId).length === 0) {
      const saved = this.#saved[botId]
      const restored = saved?.tabs?.find(tab => tab.tabId === saved.active) ?? saved?.tabs?.[0]
      const url = restored && allowedNavigation(restored.url, this.#origin()) ? restored.url : 'about:blank'
      this.create(botId, { url, ...(restored?.tabId ? { tabId: restored.tabId } : {}), createdByBot: true })
    }
    for (const [token, id] of this.#tokens) if (id === botId) this.#tokens.delete(token)
    const token = randomBytes(32).toString('hex')
    this.#tokens.set(token, botId)
    return `ws://127.0.0.1:${this.#address.port}/devtools/browser/${token}`
  }

  sync(botId) {
    return [...this.#views.values()].filter(entry => entry.botId === botId).map(entry => this.#state(entry))
  }

  dispose() {
    this.#persist()
    for (const entry of this.#views.values()) entry.view.webContents.close()
    this.#views.clear()
    this.#tokens.clear()
    this.#wss.close()
    this.#server.close()
  }

  async hold(botId, held) {
    if (!held) {
      this.#held.delete(botId)
      return true
    }
    this.#held.add(botId)
    for (const [token, id] of this.#tokens) if (id === botId) this.#tokens.delete(token)
    const clients = [...(this.#clients.get(botId) ?? [])]
    for (const client of clients) {
      for (const route of client.sessions.values()) {
        if (!route.nativeId) continue
        await route.entry.view.webContents.debugger.sendCommand('Target.detachFromTarget', { sessionId: route.nativeId }).catch(() => {})
      }
      client.socket.close()
      client.socket.terminate()
    }
    return true
  }

  #owned(botId, tabId) {
    const entry = this.#views.get(tabId)
    if (!entry || entry.botId !== botId) throw new Error('Browser tab does not belong to this Bot')
    return entry
  }

  #state(entry) {
    const contents = entry.view.webContents
    return {
      botId: entry.botId, tabId: entry.tabId, createdByBot: entry.createdByBot,
      url: contents.getURL(), title: contents.getTitle(), loading: contents.isLoading(),
      canGoBack: contents.canGoBack(), canGoForward: contents.canGoForward(),
      favicon: entry.favicon ?? null, error: entry.error ?? null, live: true,
      botAttached: entry.sessions.size > 0,
    }
  }

  #publish(entry) {
    if (!entry.view.webContents.isDestroyed()) {
      this.#remember(entry)
      this.#persist()
      this.#onChange({ type: 'changed', ...this.#state(entry) })
    }
  }

  #remember(entry) {
    const previous = this.#saved[entry.botId] ?? { tabs: [], active: null }
    const tabs = previous.tabs.filter(tab => tab.tabId !== entry.tabId)
    tabs.push({ tabId: entry.tabId, url: entry.view.webContents.getURL(), title: entry.view.webContents.getTitle() })
    this.#saved[entry.botId] = { tabs, active: this.#active.get(entry.botId) ?? previous.active ?? entry.tabId }
  }

  #dropSaved(botId, tabId) {
    const previous = this.#saved[botId]
    if (!previous) return
    const tabs = previous.tabs.filter(tab => tab.tabId !== tabId)
    const wasActive = this.#active.get(botId) === tabId
    const active = wasActive ? tabs.at(-1)?.tabId ?? null : previous.active
    if (tabs.length === 0) {
      delete this.#saved[botId]
      this.#active.delete(botId)
    } else {
      if (wasActive) this.#active.set(botId, active)
      this.#saved[botId] = { tabs, active }
    }
    this.#persist()
  }

  #persist() {
    if (this.#statePath === undefined) return
    const temporary = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      mkdirSync(dirname(this.#statePath), { recursive: true })
      writeFileSync(temporary, JSON.stringify({ version: 1, bots: this.#saved }))
      renameSync(temporary, this.#statePath)
    } catch {
      try { unlinkSync(temporary) } catch {}
    }
  }

  #installDebugger(entry) {
    const debuggerApi = entry.view.webContents.debugger
    debuggerApi.attach('1.3')
    debuggerApi.on('message', (_event, method, params, childSessionId) => {
      this.#sendToSessions(entry, { method, params: this.#framePayload(entry, method, params) }, childSessionId)
    })
  }

  #frameId(entry, frameId) {
    return frameId === entry.mainFrameId ? entry.tabId : frameId
  }

  #framePayload(entry, method, payload) {
    const value = structuredClone(payload)
    if (method === 'Page.getFrameTree' && value.frameTree?.frame && !value.frameTree.frame.parentId) {
      entry.mainFrameId = value.frameTree.frame.id
    }
    if (method === 'Page.frameNavigated' && value.frame && !value.frame.parentId) entry.mainFrameId = value.frame.id
    if (method === 'Page.frameAttached' && !value.parentFrameId) entry.mainFrameId = value.frameId
    const mapFrame = frame => {
      if (!frame) return
      if (frame.id !== undefined) frame.id = this.#frameId(entry, frame.id)
      if (frame.parentId !== undefined) frame.parentId = this.#frameId(entry, frame.parentId)
      for (const child of frame.childFrames ?? []) mapFrame(child)
    }
    if (method === 'Page.getFrameTree') mapFrame(value.frameTree?.frame)
    if (value.frameId !== undefined) value.frameId = this.#frameId(entry, value.frameId)
    if (value.parentFrameId !== undefined) value.parentFrameId = this.#frameId(entry, value.parentFrameId)
    if (value.frame) mapFrame(value.frame)
    if (value.context?.auxData?.frameId !== undefined) value.context.auxData.frameId = this.#frameId(entry, value.context.auxData.frameId)
    return value
  }

  #sendToSessions(entry, message, childSessionId) {
    for (const [socket, rootSessionId] of entry.sessions) {
      if (childSessionId) entry.sessionMaps.get(socket)?.set(childSessionId, { entry, nativeId: childSessionId })
      this.#send(socket, { ...message, sessionId: childSessionId || rootSessionId })
    }
  }

  #broadcast(botId, message) {
    for (const client of this.#clients.get(botId) ?? []) this.#send(client.socket, message)
  }

  #send(socket, message) {
    if (socket.readyState === 1) socket.send(JSON.stringify(message))
  }

  #connect(socket, botId) {
    const sessions = new Map()
    const clientState = { socket, botId, autoAttach: false, discover: false, attach: undefined, sessions }
    const clients = this.#clients.get(botId) ?? new Set()
    clients.add(clientState)
    this.#clients.set(botId, clients)
    const targets = () => [...this.#views.values()].filter(entry => entry.botId === botId)
    const info = entry => this.#targetInfo(entry)
    const attach = entry => {
      const existing = entry.sessions.get(socket)
      if (existing) return existing
      const sessionId = randomUUID()
      sessions.set(sessionId, { entry, nativeId: undefined })
      entry.sessions.set(socket, sessionId)
      entry.sessionMaps.set(socket, sessions)
      this.#send(socket, { method: 'Target.attachedToTarget', params: { sessionId, targetInfo: info(entry), waitingForDebugger: false } })
      this.#onChange({ type: 'changed', ...this.#state(entry) })
      return sessionId
    }
    clientState.attach = attach
    let commandQueue = Promise.resolve()
    socket.on('message', raw => {
      commandQueue = commandQueue.then(async () => {
        let request
        try { request = JSON.parse(raw.toString()) } catch { return }
        const { id, method, params = {}, sessionId } = request
        const reply = result => {
          this.#send(socket, { id, result, ...(sessionId ? { sessionId } : {}) })
        }
        const fail = error => {
          this.#send(socket, { id, error: { code: -32000, message: String(error?.message ?? error) }, ...(sessionId ? { sessionId } : {}) })
        }
        try {
        if (method === 'Browser.getVersion') { reply({ protocolVersion: '1.3', product: `Chrome/${process.versions.chrome}`, userAgent: `Electron/${process.versions.electron} Chrome/${process.versions.chrome}`, jsVersion: process.versions.v8 }); return }
        if (method === 'Browser.setDownloadBehavior') {
          const allowsDownloads = params.behavior === 'allow' || params.behavior === 'allowAndName'
          const downloadPath = allowsDownloads ? this.#allowedDownloadPath(botId, params.downloadPath) : undefined
          this.#downloadPaths.set(botId, downloadPath)
          for (const entry of targets()) entry.downloadPath = downloadPath
          reply({}); return
        }
        if (method === 'Browser.cancelDownload') {
          const download = targets().flatMap(entry => [...entry.downloads.entries()]).find(([guid]) => guid === params.guid)?.[1]
          if (download) await download.item.cancel()
          reply({}); return
        }
        if (method === 'Target.getBrowserContexts') { reply({ browserContextIds: [`bot:${botId}`] }); return }
        if (method === 'Target.getTargets') { reply({ targetInfos: targets().map(info) }); return }
        if (method === 'Target.setDiscoverTargets') {
          clientState.discover = params.discover === true
          if (clientState.discover) for (const entry of targets()) this.#send(socket, { method: 'Target.targetCreated', params: { targetInfo: info(entry) } })
          reply({}); return
        }
        if (method === 'Target.setAutoAttach') {
          clientState.autoAttach = params.autoAttach === true
          if (clientState.autoAttach) for (const entry of targets()) if (!entry.sessions.has(socket)) attach(entry)
          reply({}); return
        }
        if (method === 'Target.attachToTarget') {
          const entry = this.#owned(botId, params.targetId)
          const attached = attach(entry)
          this.#send(socket, { id, result: { sessionId: attached } })
          return
        }
        if (method === 'Target.createTarget') {
          const entry = this.create(botId, { url: params.url ?? 'about:blank', createdByBot: true })
          if (entry && params.background !== true) entry.view.webContents.focus()
          reply({ targetId: entry.tabId }); return
        }
        if (method === 'Target.closeTarget') { await this.close(botId, params.targetId); reply({ success: true }); return }
        if (method === 'Target.activateTarget') { this.#owned(botId, params.targetId).view.webContents.focus(); reply({}); return }
        if (method === 'Target.detachFromTarget') {
          const route = sessions.get(params.sessionId)
          if (route?.nativeId) await route.entry.view.webContents.debugger.sendCommand('Target.detachFromTarget', { sessionId: route.nativeId })
          route?.entry.sessions.delete(socket)
          route?.entry.sessionMaps.delete(socket)
          sessions.delete(params.sessionId); reply({}); return
        }
        if (method === 'Target.getTargetInfo') {
          const entry = params.targetId
            ? this.#owned(botId, params.targetId)
            : sessions.get(sessionId)?.entry ?? targets()[0]
          if (!entry || entry.botId !== botId) throw new Error('Unknown target')
          reply({ targetInfo: info(entry) }); return
        }
        if (method === 'Browser.close') { socket.close(); return }
        if (sessionId) {
          const route = sessions.get(sessionId)
          if (!route) throw new Error('Unknown target session')
          const nativeParams = { ...params }
          if (nativeParams.frameId === route.entry.tabId) nativeParams.frameId = route.entry.mainFrameId
          const result = await route.entry.view.webContents.debugger.sendCommand(method, nativeParams, route.nativeId)
          reply(this.#framePayload(route.entry, method, result))
          return
        }
        if (['Browser.getBrowserCommandLine', 'Browser.getWindowForTarget', 'Target.setDiscoverTargets'].includes(method)) { reply({}); return }
        throw new Error(`Unsupported CDP method: ${method}`)
        } catch (error) { fail(error) }
      })
    })
    socket.on('close', () => {
      for (const entry of targets()) {
        entry.sessions.delete(socket)
        entry.sessionMaps.delete(socket)
        this.#onChange({ type: 'changed', ...this.#state(entry) })
      }
      sessions.clear()
      clients.delete(clientState)
      if (clients.size === 0) this.#clients.delete(botId)
    })
  }

  #targetInfo(entry) {
    return {
      targetId: entry.tabId, type: 'page', title: entry.view.webContents.getTitle(),
      url: entry.view.webContents.getURL(), attached: entry.sessions.size > 0, canAccessOpener: true,
      browserContextId: `bot:${entry.botId}`, ...(entry.openerId ? { openerId: entry.openerId } : {}),
    }
  }
}
