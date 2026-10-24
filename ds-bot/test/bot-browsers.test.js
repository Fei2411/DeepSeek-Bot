import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserAddress, createBotBrowsers, PREVIEW_SCRIPT, READ_PAGE_SCRIPT, serveBrowserReads } from '../src/client/bot-browsers.js'
import { migrateStorage, STORAGE } from '../src/client/storage.js'

function createSource(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    set(next) {
      const resolved = typeof next === 'function' ? next(value) : next
      if (resolved === value) return
      value = resolved
      for (const listener of [...listeners]) listener()
    },
  }
}

// Just enough of a webview: attributes, listeners, navigation state. capturePage only
// records a call: the plugin must never make one (it crashes the app renderer on Windows).
function fakeWebview() {
  const listeners = {}
  const element = {
    dataset: {}, style: {}, attributes: {}, isConnected: true, url: '', loads: [], stopped: false, captured: false,
    setAttribute(name, value) { this.attributes[name] = value; if (name === 'src') this.url = value },
    addEventListener(name, listener, { signal } = {}) {
      (listeners[name] ??= new Set()).add(listener)
      signal?.addEventListener('abort', () => listeners[name].delete(listener))
    },
    emit(name, event = {}) { for (const listener of listeners[name] ?? []) listener(event) },
    remove() { this.isConnected = false },
    getURL() { return this.url },
    getTitle() { return `Title of ${this.url}` },
    isLoading: () => false, canGoBack: () => false, canGoForward: () => false, clearHistory() {},
    stop() { this.stopped = true },
    goBack() {}, goForward() {}, reload() { this.reloaded = true }, focus() { this.focused = true },
    async capturePage() { this.captured = true; return null },
    async loadURL(url) { this.loads.push(url); this.url = url; this.emit('did-navigate') },
    async executeJavaScript() { return { url: this.url, title: this.getTitle(), text: 'hello', items: [] } },
  }
  return element
}

function fakeDesktop() {
  const created = []
  const released = []
  const openHandlers = {}
  let lease = 0
  const doc = {
    body: { append() {} },
    createElement(tag) {
      if (tag === 'webview') { const view = fakeWebview(); created.push(view); return view }
      return { className: '', style: {}, isConnected: true, append() {}, remove() {} }
    },
  }
  const bridge = {
    acquire: async workspace => ({ lease: `lease-${++lease}`, partition: `persist:${workspace}` }),
    release: async (id) => { released.push(id) },
    onOpenRequested: (leaseId, handler) => { openHandlers[leaseId] = handler; return () => { delete openHandlers[leaseId] } },
  }
  const store = new Map()
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) }
  return { doc, bridge, storage, created, released, openHandlers }
}

const tick = () => new Promise(resolve => setImmediate(resolve))
const BOX = { left: 600, top: 90, width: 500, height: 700 }

test('each Bot gets its own partition, and only the shown tab is visible', async () => {
  const desktop = fakeDesktop()
  const browsers = createBotBrowsers({ bridge: desktop.bridge, createSource, storage: desktop.storage, document: desktop.doc })
  const a = browsers.openTab('a')
  const b = browsers.openTab('b')
  await browsers.show(a, BOX)
  await browsers.show(b, BOX)
  const [va, vb] = desktop.created
  assert.equal(va.attributes.partition, 'persist:bot:a')
  assert.equal(vb.attributes.partition, 'persist:bot:b')
  // Agent mode withdraws the Bot styles; a guest must still stay out of the page flow.
  assert.equal(va.style.position, 'fixed')
  assert.equal(va.style.visibility, 'hidden')
  assert.equal(vb.style.visibility, 'visible')
  // Hidden while the panel shows its own state, but kept at the panel's size.
  await browsers.show(b)
  assert.equal(vb.style.visibility, 'hidden')
  assert.equal(vb.style.width, '500px')
})

test('a dragged panel moves the shown guest at once and the hidden ones after it settles', async () => {
  const desktop = fakeDesktop()
  const browsers = createBotBrowsers({ bridge: desktop.bridge, createSource, storage: desktop.storage, document: desktop.doc })
  const a = browsers.openTab('a')
  const b = browsers.openTab('a')
  await browsers.show(a, BOX)
  await browsers.show(b, BOX)
  const [va, vb] = desktop.created
  for (const width of [520, 540, 560]) await browsers.show(b, { ...BOX, left: 1100 - width, width })
  assert.equal(vb.style.width, '560px')
  assert.equal(vb.style.left, '540px')
  assert.equal(vb.style.visibility, 'visible')
  assert.equal(va.style.width, '500px')
  assert.equal(va.style.visibility, 'hidden')
  await new Promise(resolve => setTimeout(resolve, 260))
  assert.equal(va.style.width, '560px')
  assert.equal(va.style.visibility, 'hidden')
  browsers.dispose()
})

test('openTab activates the new tab; closing the active one activates a neighbor', async () => {
  const desktop = fakeDesktop()
  const browsers = createBotBrowsers({ bridge: desktop.bridge, createSource, storage: desktop.storage, document: desktop.doc })
  const t1 = browsers.openTab('a')
  const t2 = browsers.openTab('a')
  const t3 = browsers.openTab('a')
  assert.deepEqual(browsers.tabs.getSnapshot().a, { ids: [t1, t2, t3], active: t3 })
  browsers.activate('a', t1)
  assert.equal(browsers.tabs.getSnapshot().a.active, t1)
  await browsers.closeTab('a', t1)
  assert.deepEqual(browsers.tabs.getSnapshot().a, { ids: [t2, t3], active: t2 })
  await browsers.closeTab('a', t3)
  assert.equal(browsers.tabs.getSnapshot().a.active, t2)
  await browsers.closeTab('a', t2)
  assert.equal(browsers.tabs.getSnapshot().a, undefined)
  // Another Bot's strip is untouched.
  const other = browsers.openTab('b')
  await browsers.closeTab('b', 'not-a-tab')
  assert.deepEqual(browsers.tabs.getSnapshot().b.ids, [other])
})

test('a navigation before the guest is ready waits for dom-ready, and the address is saved', async () => {
  const desktop = fakeDesktop()
  const browsers = createBotBrowsers({ bridge: desktop.bridge, createSource, storage: desktop.storage, document: desktop.doc })
  const tab = browsers.openTab('a')
  assert.equal(await browsers.navigate(tab, 'example.com'), true)
  const [view] = desktop.created
  assert.deepEqual(view.loads, [])
  view.emit('dom-ready')
  assert.deepEqual(view.loads, ['https://example.com/'])
  assert.equal(browsers.pages.getSnapshot()[tab].url, 'https://example.com/')
  assert.deepEqual(browsers.openPages(), { a: { url: 'https://example.com/', title: 'Title of https://example.com/' } })
  // A new manager (a reload of the app) restores the saved strip.
  const again = createBotBrowsers({ bridge: desktop.bridge, createSource, storage: desktop.storage, document: desktop.doc })
  again.ensureTabs('a')
  const restored = again.tabs.getSnapshot().a
  assert.equal(restored.ids.length, 1)
  assert.equal(restored.active, restored.ids[0])
  await again.show(restored.active, BOX)
  desktop.created.at(-1).emit('dom-ready')
  assert.deepEqual(desktop.created.at(-1).loads, ['https://example.com/'])
  assert.equal(await browsers.navigate(tab, 'file:///etc/passwd'), false)
  assert.match(browsers.pages.getSnapshot()[tab].error, /http/)
  // Cloud metadata stays shut, typed or reached by a link; LAN pages open.
  assert.equal(await browsers.navigate(tab, '169.254.169.254/latest/meta-data'), false)
  assert.match(browsers.pages.getSnapshot()[tab].error, /metadata/)
  view.emit('did-start-navigation', { isMainFrame: true, url: 'http://169.254.169.254/' })
  assert.equal(view.stopped, true)
  assert.equal(await browsers.navigate(tab, '192.168.1.8'), true)
  assert.equal(browsers.pages.getSnapshot()[tab].error, null)
})

test('the v1 one-page store migrates to one tab per Bot', async () => {
  const desktop = fakeDesktop()
  desktop.storage.setItem('ds-bot.browser.v1', JSON.stringify({ a: { url: 'https://example.com/', title: 'Example' } }))
  migrateStorage(desktop.storage)
  const browsers = createBotBrowsers({ bridge: desktop.bridge, createSource, storage: desktop.storage, document: desktop.doc })
  browsers.ensureTabs('a')
  const state = browsers.tabs.getSnapshot().a
  assert.equal(state.ids.length, 1)
  assert.equal(state.active, state.ids[0])
  assert.equal(browsers.pages.getSnapshot()[state.ids[0]].url, 'https://example.com/')
  assert.equal(desktop.storage.getItem('ds-bot.browser.v1'), null)
})

test('a read reaches the Bot’s active tab', async () => {
  const desktop = fakeDesktop()
  const browsers = createBotBrowsers({ bridge: desktop.bridge, createSource, storage: desktop.storage, document: desktop.doc })
  const t1 = browsers.openTab('a')
  const t2 = browsers.openTab('a')
  await browsers.navigate(t1, 'one.example.com')
  await browsers.navigate(t2, 'two.example.com')
  for (const view of desktop.created) view.emit('dom-ready')
  let page = await browsers.read('a')
  assert.equal(page.url, 'https://two.example.com/')
  browsers.activate('a', t1)
  page = await browsers.read('a')
  assert.equal(page.url, 'https://one.example.com/')
})

test('a page that asks for a new window opens a new tab in the same Bot', async () => {
  const desktop = fakeDesktop()
  const browsers = createBotBrowsers({ bridge: desktop.bridge, createSource, storage: desktop.storage, document: desktop.doc })
  const tab = browsers.openTab('a')
  await browsers.show(tab, BOX)
  const [view] = desktop.created
  view.emit('dom-ready')
  desktop.openHandlers[view.attributes.name]('https://pop.example.com/')
  await tick()
  const state = browsers.tabs.getSnapshot().a
  assert.equal(state.ids.length, 2)
  const popped = state.ids[1]
  assert.equal(state.active, popped)
  await tick()
  // The popup tab loads its address in the same Bot partition.
  const guest = desktop.created.at(-1)
  assert.equal(guest.attributes.partition, 'persist:bot:a')
  guest.emit('dom-ready')
  assert.deepEqual(guest.loads, ['https://pop.example.com/'])
})

test('an app popup is adopted and activated before a Bot has attached', async () => {
  const calls = []
  let receive
  const doc = { body: { append() {} }, createElement: () => ({ style: {}, isConnected: true, append() {}, remove() {} }) }
  const bridge = {
    views: {
      subscribe(listener) { receive = listener; return () => {} },
      async sync() { return [] },
      async create(botId, tabId) { calls.push({ type: 'create', botId, tabId }); return tabId },
      async place(tabId, rect, visible) { calls.push({ type: 'place', tabId, rect, visible }) },
      async navigate() {},
      async command() {},
      async focus() {},
      async read() {},
      async close() {},
    },
  }
  const browsers = createBotBrowsers({ bridge, createSource, storage: fakeDesktop().storage, document: doc })
  browsers.ensureTabs('a')
  receive({ type: 'created', botId: 'a', tabId: 'user-popup', url: 'http://127.0.0.1:43118/popup', createdByBot: false, loading: false })
  await tick()
  assert.deepEqual(browsers.tabs.getSnapshot().a, { ids: ['user-popup'], active: 'user-popup' })
  assert.ok(calls.some(call => call.type === 'create' && call.tabId === 'user-popup'))
  await browsers.show('user-popup', BOX)
  assert.ok(calls.some(call => call.type === 'place' && call.tabId === 'user-popup' && call.visible))
})

test('past six live guests the least recently shown one is released; forget drops all of a Bot’s tabs', async () => {
  const desktop = fakeDesktop()
  const browsers = createBotBrowsers({ bridge: desktop.bridge, createSource, storage: desktop.storage, document: desktop.doc })
  const ids = []
  // Six tabs across three Bots, then a seventh pushes the oldest out.
  for (const botId of ['a', 'b']) for (let at = 0; at < 3; at += 1) ids.push(browsers.openTab(botId))
  const extra = browsers.openTab('c')
  for (const tabId of ids) await browsers.show(tabId, BOX)
  await browsers.show(extra, BOX)
  await tick(); await tick()
  assert.equal(desktop.released.length, 1)
  assert.equal(browsers.pages.getSnapshot()[ids[0]].live, false)
  assert.equal(browsers.tabs.getSnapshot().a.ids.length, 3)
  await browsers.forget('a')
  assert.equal(browsers.tabs.getSnapshot().a, undefined)
  for (const tabId of ids.slice(0, 3)) assert.equal(browsers.pages.getSnapshot()[tabId], undefined)
  assert.deepEqual(desktop.released.length, 1 + 2) // tab a-1 was already released, a-2 and a-3 now
})

test('retain forgets Bots that are gone, saved tabs included', async () => {
  const desktop = fakeDesktop()
  const browsers = createBotBrowsers({ bridge: desktop.bridge, createSource, storage: desktop.storage, document: desktop.doc })
  const ta = browsers.openTab('a')
  const tb = browsers.openTab('b')
  await browsers.navigate(ta, 'example.com')
  await browsers.navigate(tb, 'example.org')
  for (const view of desktop.created) view.emit('dom-ready')
  await browsers.retain(['a'])
  assert.equal(browsers.tabs.getSnapshot().b, undefined)
  assert.equal(browsers.pages.getSnapshot()[tb], undefined)
  assert.deepEqual(Object.keys(JSON.parse(desktop.storage.getItem(STORAGE.browsers))), ['a'])
  assert.equal(desktop.released.length, 1)
})

test('a bridge that keeps logins on disk forgets a deleted Bot’s storage, tabs or none', async () => {
  const desktop = fakeDesktop()
  const forgotten = []
  const bridge = { ...desktop.bridge, forget: async (key) => { forgotten.push(key) } }
  const browsers = createBotBrowsers({ bridge, createSource, storage: desktop.storage, document: desktop.doc })
  await browsers.navigate(browsers.openTab('a'), 'example.com')
  await browsers.retain(['a', 'b', 'c'])
  assert.deepEqual(forgotten, [])
  // a had a tab, b never had one; both go, c stays.
  await browsers.retain(['c'])
  assert.deepEqual(forgotten.sort(), ['bot:a', 'bot:b'])
  await browsers.retain(['c'])
  assert.equal(forgotten.length, 2)
})

test('a settled page leaves a text excerpt, shown or hidden, and no tab is ever captured', async () => {
  const desktop = fakeDesktop()
  const browsers = createBotBrowsers({ bridge: desktop.bridge, createSource, storage: desktop.storage, document: desktop.doc })
  const t1 = browsers.openTab('a')
  const t2 = browsers.openTab('a')
  await browsers.navigate(t1, 'example.com')
  const view = desktop.created[0]
  view.executeJavaScript = async script => (script === PREVIEW_SCRIPT ? 'A page about examples.' : { url: view.url, title: view.getTitle(), text: 'hello', items: [] })
  view.emit('dom-ready')
  // Hidden (t2 is on screen) and settled: the excerpt still arrives.
  await browsers.show(t2, BOX)
  view.emit('did-stop-loading')
  await tick()
  assert.equal(browsers.pages.getSnapshot()[t1].excerpt, 'A page about examples.')
  // A failed or empty read keeps the excerpt the tab already has.
  view.executeJavaScript = async () => ''
  assert.equal(await browsers.preview(t1), false)
  view.executeJavaScript = async () => { throw new Error('gone') }
  assert.equal(await browsers.preview(t1), false)
  assert.equal(browsers.pages.getSnapshot()[t1].excerpt, 'A page about examples.')
  // Switching tabs back and forth never asks a webview for a screenshot.
  await browsers.show(t1, BOX)
  await browsers.show(t2, BOX)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(desktop.created.some(created => created.captured), false)
})

test('serveBrowserReads answers each request once and re-polls when the open pages change', async () => {
  const desktop = fakeDesktop()
  const browsers = createBotBrowsers({ bridge: desktop.bridge, createSource, storage: desktop.storage, document: desktop.doc })
  const tab = browsers.openTab('a')
  await browsers.navigate(tab, 'example.com')
  desktop.created[0].emit('dom-ready')
  const calls = []
  const polls = []
  const post = (endpoint, payload, signal) => {
    calls.push([endpoint, payload])
    if (endpoint !== 'browser-wait') return Promise.resolve(true)
    return new Promise((resolve, reject) => {
      polls.push(resolve)
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
  }
  const stop = serveBrowserReads({ browsers, post, clientId: 'w1' })
  await tick()
  assert.deepEqual(calls[0], ['browser-wait', { clientId: 'w1', open: { a: { url: 'https://example.com/', title: 'Title of https://example.com/' } } }])
  // The same request twice (a resend) is read once; the cached answer posts again.
  polls.at(-1)([{ id: 'read-1', botId: 'a' }, { id: 'read-1', botId: 'a' }])
  await tick(); await tick()
  const results = calls.filter(([endpoint]) => endpoint === 'browser-result')
  assert.equal(results.length, 2)
  assert.deepEqual(results[1][1], results[0][1])
  assert.equal(results[0][1].ok, true)
  assert.equal(results[0][1].page.text, 'hello')
  assert.ok(browsers.pages.getSnapshot()[tab].readAt > 0)
  // A read for a Bot with no page reports the error.
  polls.at(-1)([{ id: 'read-2', botId: 'zzz' }])
  await tick(); await tick()
  assert.equal(calls.filter(([endpoint]) => endpoint === 'browser-result').at(-1)[1].ok, false)
  const before = calls.filter(([endpoint]) => endpoint === 'browser-wait').length
  await browsers.navigate(tab, 'example.org')
  await tick()
  assert.equal(calls.filter(([endpoint]) => endpoint === 'browser-wait').length, before + 1)
  assert.equal(calls.at(-1)[1].open.a.url, 'https://example.org/')
  stop()
})

test('serveBrowserReads answers a resend from the cache when the first submit failed', async () => {
  const desktop = fakeDesktop()
  const browsers = createBotBrowsers({ bridge: desktop.bridge, createSource, storage: desktop.storage, document: desktop.doc })
  const tab = browsers.openTab('a')
  await browsers.navigate(tab, 'example.com')
  desktop.created[0].emit('dom-ready')
  let reads = 0
  const readPage = browsers.read.bind(browsers)
  browsers.read = (...args) => { reads += 1; return readPage(...args) }
  const results = []
  const polls = []
  let offline = true
  const post = (endpoint, payload, signal) => {
    if (endpoint === 'browser-result') {
      results.push(payload)
      if (offline) return Promise.reject(new Error('offline'))
      return Promise.resolve(true)
    }
    if (endpoint !== 'browser-wait') return Promise.resolve(true)
    return new Promise((resolve, reject) => {
      polls.push(resolve)
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
  }
  const stop = serveBrowserReads({ browsers, post, clientId: 'w1' })
  await tick()
  // The first submit fails; the host's resend gets the cached answer, no re-read.
  polls.at(-1)([{ id: 'read-1', botId: 'a' }])
  await tick(); await tick()
  assert.equal(results.length, 1)
  offline = false
  polls.at(-1)([{ id: 'read-1', botId: 'a' }])
  await tick(); await tick()
  assert.equal(results.length, 2)
  assert.equal(reads, 1)
  assert.deepEqual(results[1], results[0])
  assert.equal(results[1].ok, true)
  stop()
})

test('browserAddress opens hosts over https, local addresses over http, and searches the rest', () => {
  assert.equal(browserAddress('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(browserAddress('http://example.com'), 'http://example.com/')
  assert.equal(browserAddress('example.com'), 'https://example.com/')
  assert.equal(browserAddress('docs.python.org/3/library'), 'https://docs.python.org/3/library')
  assert.equal(browserAddress('localhost:5173'), 'http://localhost:5173/')
  assert.equal(browserAddress('192.168.1.8/admin'), 'http://192.168.1.8/admin')
  assert.equal(browserAddress('127.0.0.1:8080'), 'http://127.0.0.1:8080/')
  assert.equal(browserAddress('deepseek harness'), 'https://www.bing.com/search?q=deepseek%20harness')
  assert.equal(browserAddress('小红书 运营'), 'https://www.bing.com/search?q=%E5%B0%8F%E7%BA%A2%E4%B9%A6%20%E8%BF%90%E8%90%A5')
  assert.equal(browserAddress('  '), null)
  assert.equal(browserAddress('file:///etc/passwd'), null)
  assert.equal(browserAddress('javascript:alert(1)'), null)
  assert.equal(browserAddress('ftp://example.com'), null)
})

test('the page reader is one valid expression', () => {
  assert.doesNotThrow(() => new Function(`return ${READ_PAGE_SCRIPT}`))
})
