import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { BotViews, isBotId } from '../src/bot-views.mjs'

function fixture({ statePath } = {}) {
  const changes = []
  const handlers = new Map()
  const views = []
  class WebContents extends EventEmitter {
    constructor() {
      super()
      this.url = 'about:blank'
      this.loadedUrls = []
      this.debugger = Object.assign(new EventEmitter(), {
        attach() {},
        async sendCommand(method) {
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-a', url: 'https://example.com/' } } }
          return { method }
        },
      })
    }
    getURL() { return this.url }
    getTitle() { return this.url }
    isLoading() { return false }
    canGoBack() { return false }
    canGoForward() { return false }
    isDestroyed() { return false }
    async loadURL(url) { this.url = url; this.loadedUrls.push(url) }
    async executeJavaScript(script) { return script }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler }
    close() {}
    focus() {}
  }
  class WebContentsView {
    constructor(options) {
      this.options = options
      this.webContents = new WebContents()
      views.push(this)
    }
    setBounds(bounds) { this.bounds = bounds }
    setVisible(visible) { this.visible = visible }
  }
  const guests = {
    storageFor(key) { return { partition: `persist:${key}` } },
    setDownloadHandler(key, handler) { handlers.set(key, handler) },
  }
  const window = { contentView: { addChildView() {} } }
  const manager = new BotViews({ window: () => window, WebContentsView, guests, origin: () => 'http://127.0.0.1:43117', statePath, onChange: change => changes.push(change) })
  return { manager, handlers, views, changes }
}

test('Bot endpoint identifiers follow DSH session.create IDs', () => {
  assert.equal(isBotId('session-7e90ddf9-38a7-4c6c-b37a-1c445f771234'), true)
  assert.equal(isBotId('7e90ddf9-38a7-4c6c-b37a-1c445f771234'), false)
  assert.equal(isBotId('session-1'), false)
})

test('Bot endpoints accept only up to four absolute download roots', async t => {
  const { manager } = fixture()
  t.after(() => manager.dispose())
  await assert.rejects(() => manager.endpoint('a', { downloadRoots: ['relative'] }), /Invalid browser download roots/u)
  await assert.rejects(() => manager.endpoint('a', { downloadRoots: new Array(1) }), /Invalid browser download roots/u)
  await assert.rejects(() => manager.endpoint('a', { downloadRoots: ['/a', '/b', '/c', '/d', '/e'] }), /Invalid browser download roots/u)
  assert.match(await manager.endpoint('a', { downloadRoots: ['/a', '/b', '/c', '/d'] }), /^ws:\/\//u)
})

function openSocket(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function closed(socket) {
  return new Promise(resolve => {
    socket.on('error', () => {})
    socket.once('close', resolve)
  })
}

function request(socket, id, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 1000)
    const onMessage = raw => {
      const message = JSON.parse(raw.toString())
      if (message.id !== id) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(message)
    }
    socket.on('message', onMessage)
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}

test('CDP endpoint creates and loads an initial view for a Bot with no tabs', async t => {
  const { manager, views } = fixture()
  t.after(() => manager.dispose())
  const endpoint = await manager.endpoint('a')
  assert.deepEqual(views[0].webContents.loadedUrls, ['about:blank'])
  const socket = await openSocket(endpoint)
  t.after(() => socket.close())

  const targets = await request(socket, 1, 'Target.getTargets')
  assert.equal(targets.result.targetInfos.length, 1)
  assert.equal(targets.result.targetInfos[0].url, 'about:blank')
  const info = await request(socket, 2, 'Target.getTargetInfo')
  assert.equal(info.result.targetInfo.targetId, targets.result.targetInfos[0].targetId)
})

test('CDP relay limits targets and created tabs to the token Bot', async t => {
  const { manager, views } = fixture()
  t.after(() => manager.dispose())
  manager.create('a')
  manager.create('b')
  const [a, b] = await Promise.all([manager.endpoint('a'), manager.endpoint('b')])
  const socketA = await openSocket(a)
  const socketB = await openSocket(b)
  t.after(() => { socketA.close(); socketB.close() })
  const targetsA = await request(socketA, 1, 'Target.getTargets')
  const targetsB = await request(socketB, 2, 'Target.getTargets')
  assert.equal(targetsA.result.targetInfos.length, 1)
  assert.equal(targetsA.result.targetInfos[0].browserContextId, 'bot:a')
  assert.equal(targetsB.result.targetInfos.length, 1)
  assert.equal(targetsB.result.targetInfos[0].browserContextId, 'bot:b')
  const rootInfo = await request(socketA, 3, 'Target.getTargetInfo')
  assert.equal(rootInfo.result.targetInfo.targetId, targetsA.result.targetInfos[0].targetId)
  const foreignInfo = await request(socketA, 4, 'Target.getTargetInfo', { targetId: targetsB.result.targetInfos[0].targetId })
  assert.equal(foreignInfo.error.message, 'Browser tab does not belong to this Bot')
  const attached = await request(socketA, 5, 'Target.attachToTarget', { targetId: targetsA.result.targetInfos[0].targetId, flatten: true })
  const sessionId = attached.result.sessionId
  const pageEnabled = await request(socketA, 6, 'Page.enable', {}, sessionId)
  assert.equal(pageEnabled.sessionId, sessionId)
  assert.deepEqual(pageEnabled.result, { method: 'Page.enable' })
  const frameTree = await request(socketA, 7, 'Page.getFrameTree', {}, sessionId)
  assert.equal(frameTree.result.frameTree.frame.id, targetsA.result.targetInfos[0].targetId)
  const created = await request(socketA, 8, 'Target.createTarget', { url: 'about:blank' })
  assert.equal(created.result.targetId, manager.sync('a')[1].tabId)
  assert.equal(manager.sync('a').length, 2)
  assert.equal(manager.sync('b').length, 1)
})

test('CDP relay rejects invalid paths and Origin headers', async t => {
  const { manager } = fixture()
  t.after(() => manager.dispose())
  const endpoint = await manager.endpoint('a')
  const valid = await openSocket(endpoint)
  t.after(() => valid.close())
  const originSocket = new WebSocket(endpoint, { headers: { Origin: 'https://example.com' } })
  await closed(originSocket)
  const badPath = new WebSocket(endpoint.replace(/\/devtools\/browser\/[^/]+$/u, '/invalid'))
  await closed(badPath)
})

test('CDP download behavior saves to the Bot path and emits download events', async t => {
  const { manager, handlers, views } = fixture()
  t.after(() => manager.dispose())
  const rootPath = mkdtempSync(join(tmpdir(), 'bot-views-download-root-'))
  const downloadPath = join(rootPath, 'downloads')
  t.after(() => rmSync(rootPath, { recursive: true, force: true }))
  const entry = manager.create('a')
  const socket = await openSocket(await manager.endpoint('a', { downloadRoots: [rootPath] }))
  t.after(() => socket.close())
  const discovered = await request(socket, 1, 'Target.attachToTarget', { targetId: entry.tabId, flatten: true })
  assert.ok(discovered.result.sessionId)
  const sessionId = discovered.result.sessionId
  await request(socket, 2, 'Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath })
  const events = []
  let resolveEvents
  const eventsReady = new Promise(resolve => { resolveEvents = resolve })
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString())
    if (message.method?.startsWith('Browser.download')) {
      events.push(message)
      if (events.length === 3) resolveEvents()
    }
  })
  const saved = []
  const item = Object.assign(new EventEmitter(), {
    setSavePath(path) { saved.push(path) },
    getURL() { return 'https://example.com/file' },
    getFilename() { return 'report.pdf' },
    getReceivedBytes() { return 3 },
    getTotalBytes() { return 3 },
  })
  const event = { preventDefault() { throw new Error('download was unexpectedly prevented') } }
  handlers.get('bot:a')(event, item, views[0].webContents)
  item.emit('updated', {}, 'progressing')
  item.emit('done', {}, 'completed')
  await Promise.race([eventsReady, new Promise((_, reject) => setTimeout(() => reject(new Error('download events were not relayed')), 1000))])
  assert.equal(saved.length, 1)
  assert.match(saved[0], new RegExp(`^${downloadPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]`, 'u'))
  assert.equal(events[0].params.suggestedFilename, 'report.pdf')
  assert.equal(events.some(message => message.method === 'Browser.downloadProgress' && message.params.state === 'completed'), true)
  assert.equal(sessionId.length > 0, true)
})

test('download roots are isolated per Bot', async t => {
  const { manager, handlers, views } = fixture()
  t.after(() => manager.dispose())
  const rootA = mkdtempSync(join(tmpdir(), 'bot-views-download-a-'))
  const rootB = mkdtempSync(join(tmpdir(), 'bot-views-download-b-'))
  t.after(() => {
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  })
  const entryA = manager.create('a')
  const entryB = manager.create('b')
  const [endpointA, endpointB] = await Promise.all([
    manager.endpoint('a', { downloadRoots: [rootA] }),
    manager.endpoint('b', { downloadRoots: [rootB] }),
  ])
  const socketA = await openSocket(endpointA)
  const socketB = await openSocket(endpointB)
  t.after(() => { socketA.close(); socketB.close() })
  await request(socketA, 1, 'Target.attachToTarget', { targetId: entryA.tabId, flatten: true })
  await request(socketB, 2, 'Target.attachToTarget', { targetId: entryB.tabId, flatten: true })
  await request(socketA, 3, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: rootA })
  await request(socketB, 4, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: rootA })
  let savedByA
  const accepted = Object.assign(new EventEmitter(), {
    setSavePath(path) { savedByA = path },
    getURL() { return 'https://example.com/file' },
    getFilename() { return 'report.pdf' },
  })
  handlers.get('bot:a')({ preventDefault() { throw new Error('Bot A download was refused') } }, accepted, views[0].webContents)
  assert.match(savedByA, new RegExp(`^${rootA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]`, 'u'))
  let preventedForB = false
  const refused = Object.assign(new EventEmitter(), {
    setSavePath() { throw new Error('Bot B must not use Bot A download root') },
    getURL() { return 'https://example.com/file' },
    getFilename() { return 'report.pdf' },
  })
  handlers.get('bot:b')({ preventDefault() { preventedForB = true } }, refused, views[1].webContents)
  assert.equal(preventedForB, true)
})

test('cancelling a relay download removes its save path', async t => {
  const { manager, handlers, views } = fixture()
  t.after(() => manager.dispose())
  const downloadPath = mkdtempSync(join(tmpdir(), 'playwright-artifacts-bot-views-cancel-'))
  t.after(() => rmSync(downloadPath, { recursive: true, force: true }))
  const entry = manager.create('a')
  const socket = await openSocket(await manager.endpoint('a'))
  t.after(() => socket.close())
  await request(socket, 1, 'Target.attachToTarget', { targetId: entry.tabId, flatten: true })
  await request(socket, 2, 'Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath })
  const events = []
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString())
    if (message.method?.startsWith('Browser.download')) events.push(message)
  })
  let savePath
  const item = Object.assign(new EventEmitter(), {
    setSavePath(path) { savePath = path; writeFileSync(path, 'partial') },
    getURL() { return 'https://example.com/file' },
    getFilename() { return 'report.pdf' },
    getReceivedBytes() { return 1 },
    getTotalBytes() { return 2 },
    async cancel() { this.emit('done', {}, 'cancelled') },
  })
  handlers.get('bot:a')({ preventDefault() {} }, item, views[0].webContents)
  await new Promise(resolve => setTimeout(resolve, 0))
  const guid = events.find(message => message.method === 'Browser.downloadWillBegin').params.guid
  await request(socket, 3, 'Browser.cancelDownload', { guid })
  for (let tries = 0; tries < 100 && existsSync(savePath); tries++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(existsSync(savePath), false)
})

test('CDP rejects outside, traversal, and symlink download paths and cancels downloads', async t => {
  const { manager, handlers, views } = fixture()
  t.after(() => manager.dispose())
  const rootPath = mkdtempSync(join(tmpdir(), 'bot-views-download-root-'))
  const outsidePath = mkdtempSync(join(tmpdir(), 'bot-views-download-outside-'))
  symlinkSync(outsidePath, join(rootPath, 'outside-link'))
  t.after(() => {
    rmSync(rootPath, { recursive: true, force: true })
    rmSync(outsidePath, { recursive: true, force: true })
  })
  const entry = manager.create('a')
  const socket = await openSocket(await manager.endpoint('a', { downloadRoots: [rootPath] }))
  t.after(() => socket.close())
  await request(socket, 1, 'Target.attachToTarget', { targetId: entry.tabId, flatten: true })
  const refusedPaths = [
    '/etc/x',
    join(rootPath, '..', 'bot-views-download-escape'),
    join(rootPath, 'outside-link'),
  ]
  let id = 2
  for (const downloadPath of refusedPaths) {
    await request(socket, id++, 'Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: rootPath })
    const response = await request(socket, id++, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath })
    assert.deepEqual(response.result, {})
    let prevented = false
    let savePath
    const item = Object.assign(new EventEmitter(), {
      setSavePath(path) { savePath = path },
      getURL() { return 'https://example.com/file' },
      getFilename() { return 'report.pdf' },
    })
    handlers.get('bot:a')({ preventDefault() { prevented = true } }, item, views[0].webContents)
    assert.equal(prevented, true)
    assert.equal(savePath, undefined)
  }
  await request(socket, id++, 'Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: rootPath })
  await request(socket, id, 'Browser.setDownloadBehavior', { behavior: 'deny', downloadPath: rootPath })
  let denied = false
  const item = Object.assign(new EventEmitter(), {
    setSavePath() { throw new Error('denied downloads must not get a save path') },
    getURL() { return 'https://example.com/file' },
    getFilename() { return 'report.pdf' },
  })
  handlers.get('bot:a')({ preventDefault() { denied = true } }, item, views[0].webContents)
  assert.equal(denied, true)
})

test('CDP accepts a direct Playwright artifacts directory under os.tmpdir()', async t => {
  const { manager, handlers, views } = fixture()
  t.after(() => manager.dispose())
  const downloadPath = mkdtempSync(join(tmpdir(), 'playwright-artifacts-bot-views-'))
  t.after(() => rmSync(downloadPath, { recursive: true, force: true }))
  const entry = manager.create('a')
  const socket = await openSocket(await manager.endpoint('a'))
  t.after(() => socket.close())
  await request(socket, 1, 'Target.attachToTarget', { targetId: entry.tabId, flatten: true })
  const response = await request(socket, 2, 'Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath })
  assert.deepEqual(response.result, {})
  let savePath
  const item = Object.assign(new EventEmitter(), {
    setSavePath(path) { savePath = path },
    getURL() { return 'https://example.com/file' },
    getFilename() { return 'report.pdf' },
  })
  let prevented = false
  handlers.get('bot:a')({ preventDefault() { prevented = true } }, item, views[0].webContents)
  assert.equal(prevented, false)
  assert.match(savePath, new RegExp(`^${downloadPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]`, 'u'))
})

test('user hold closes relay sockets, rejects endpoints, and allows a new endpoint after give-back', async t => {
  const { manager } = fixture()
  t.after(() => manager.dispose())
  const endpoint = await manager.endpoint('a')
  const socket = await openSocket(endpoint)
  const closedPromise = closed(socket)
  await manager.hold('a', true)
  await closedPromise
  await assert.rejects(() => manager.endpoint('a'), /The user has taken over this browser/u)
  await manager.hold('a', false)
  const resumed = await manager.endpoint('a')
  const resumedSocket = await openSocket(resumed)
  t.after(() => resumedSocket.close())
  assert.equal((await request(resumedSocket, 3, 'Target.getTargets')).result.targetInfos.length, 1)
})

test('navigation guard rejects the app origin and popup tabs work before relay attachment', async t => {
  const { manager, views } = fixture()
  t.after(() => manager.dispose())
  const entry = manager.create('a')
  let prevented = false
  entry.view.webContents.emit('will-frame-navigate', { url: 'http://127.0.0.1:43117/settings', isMainFrame: true, preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  const popup = entry.view.webContents.windowOpenHandler({ url: 'http://127.0.0.1:43118/popup', postBody: undefined })
  assert.deepEqual(popup, { action: 'deny' })
  assert.equal(views.length, 2)
  assert.equal(manager.sync('a')[1].url, 'http://127.0.0.1:43118/popup')
})

test('saved active tabs restore their tab id and URL', async t => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'bot-views-state-')), 'bot-views.json')
  t.after(() => rmSync(statePath, { force: true }))
  const first = fixture({ statePath })
  const entry = first.manager.create('a', { tabId: 'saved-tab', url: 'http://127.0.0.1:43118/form' })
  assert.equal(first.manager.create('a', { tabId: 'saved-tab' }), entry)
  first.manager.dispose()
  const second = fixture({ statePath })
  t.after(() => second.manager.dispose())
  const endpoint = await second.manager.endpoint('a')
  assert.equal(second.manager.sync('a')[0].tabId, entry.tabId)
  assert.equal(second.manager.sync('a')[0].url, 'http://127.0.0.1:43118/form')
  const socket = await openSocket(endpoint)
  t.after(() => socket.close())
})

test('closing the active saved tab preserves the replacement after another page updates', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bot-views-active-state-'))
  const statePath = join(directory, 'bot-views.json')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const first = fixture({ statePath })
  first.manager.create('a', { tabId: 'A', url: 'http://127.0.0.1:43118/a' })
  first.manager.create('a', { tabId: 'B', url: 'http://127.0.0.1:43118/b' })
  first.manager.create('a', { tabId: 'C', url: 'http://127.0.0.1:43118/c' })
  first.manager.place('B', { left: 0, top: 0, width: 400, height: 300 }, true)
  await first.manager.close('a', 'B')
  first.views[0].webContents.url = 'http://127.0.0.1:43118/a-updated'
  first.views[0].webContents.emit('did-navigate')
  first.manager.dispose()

  const second = fixture({ statePath })
  t.after(() => second.manager.dispose())
  await second.manager.endpoint('a')
  assert.deepEqual(second.manager.sync('a').map(({ tabId, url }) => ({ tabId, url })), [
    { tabId: 'C', url: 'http://127.0.0.1:43118/c' },
  ])
})

test('saved file and app-origin URLs restore as blank with their tab ids', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bot-views-unsafe-state-'))
  const statePath = join(directory, 'bot-views.json')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(statePath, JSON.stringify({ version: 1, bots: {
    file: { tabs: [{ tabId: 'file-tab', url: 'file:///etc/passwd', title: 'passwd' }], active: 'file-tab' },
    app: { tabs: [{ tabId: 'app-tab', url: 'http://127.0.0.1:43117/settings', title: 'Settings' }], active: 'app-tab' },
  } }))
  const { manager } = fixture({ statePath })
  t.after(() => manager.dispose())
  const stored = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.deepEqual(stored.bots.file.tabs, [{ tabId: 'file-tab', url: 'about:blank', title: '' }])
  assert.deepEqual(stored.bots.app.tabs, [{ tabId: 'app-tab', url: 'about:blank', title: '' }])
  for (const [botId, tabId] of [['file', 'file-tab'], ['app', 'app-tab']]) {
    await manager.endpoint(botId)
    assert.deepEqual(manager.sync(botId).map(({ tabId: actualId, url }) => ({ tabId: actualId, url })), [
      { tabId, url: 'about:blank' },
    ])
  }
})

test('load errors remain published until a real main-frame navigation starts', async t => {
  const { manager, views, changes } = fixture()
  t.after(() => manager.dispose())
  const entry = manager.create('a')
  const contents = views[0].webContents
  contents.emit('did-fail-load', {}, -105, 'offline', contents.getURL(), true)
  contents.emit('did-stop-loading')
  assert.equal(changes.at(-1).error, 'offline')
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  assert.equal(changes.at(-1).error, null)
  assert.ok(entry)
})
