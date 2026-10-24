import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { columnOpened, createSwitchWindow, drawerOpened, rightColumnOpen } from '../src/client/right-panel.js'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

const document = attrs => new JSDOM(`<!doctype html><body><div ${attrs}><div data-rightbar-col></div></div></body>`).window.document

// 公开#456: the Bot drawer and DSH's right column never share the window; whichever
// the user asked for last wins. The column's state lives on the frame's attributes.
test('the frame attributes read as the column state', () => {
  assert.equal(rightColumnOpen(document('')), true)
  assert.equal(rightColumnOpen(document('data-rightbar-collapsed')), false)
  assert.equal(rightColumnOpen(document('data-rightbar-fullscreen')), true)
  // A narrow window presents the panel fullscreen with no track: both marks.
  assert.equal(rightColumnOpen(document('data-rightbar-collapsed data-rightbar-fullscreen')), true)
  // No frame at all reads as closed.
  assert.equal(rightColumnOpen(new JSDOM('<!doctype html><body></body>').window.document), false)
})

test('a drawer opening folds an open column back', () => {
  assert.equal(drawerOpened(true), 'collapse-column')
  assert.equal(drawerOpened(false), null)
})

test('a column the user opens takes the space from an open drawer', () => {
  assert.equal(columnOpened(true, false), 'close-drawer')
})

test('a column a Session switch revealed yields to the open drawer', () => {
  assert.equal(columnOpened(true, true), 'collapse-column')
})

test('with no drawer open the column opens on its own', () => {
  assert.equal(columnOpened(false, false), null)
  assert.equal(columnOpened(false, true), null)
})

// The switch window holds "the Session moved" until `settle` calls back: inside
// it a column opening is the switch revealing that Session's own column, past
// it the user's own. A newer move restarts it and a stale settle is ignored.
test('the switch window steers the verdict while it is open', () => {
  const ends = []
  const window = createSwitchWindow(done => ends.push(done))
  assert.equal(window.pending, false)
  window.moved()
  assert.equal(window.pending, true)
  assert.equal(columnOpened(true, window.pending), 'collapse-column')
  ends[0]()
  assert.equal(window.pending, false)
  assert.equal(columnOpened(true, window.pending), 'close-drawer')
})

test('a newer Session switch restarts the window and the old settle is stale', () => {
  const ends = []
  const window = createSwitchWindow(done => ends.push(done))
  window.moved()
  window.moved()
  ends[0]()
  assert.equal(window.pending, true)
  assert.equal(columnOpened(true, window.pending), 'collapse-column')
  ends[1]()
  assert.equal(window.pending, false)
})

// The drawer's top row, bundled once and run with a minimal React stand-in; the
// row's components are vnodes, so only the drawer's own body runs.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/details-drawer.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}], useEffect: () => {}, useRef: current => ({ current }),
        useLayoutEffect: () => {}, useMemo: make => make(), useCallback: fn => fn,
        useSyncExternalStore: (_subscribe, get) => get(), Fragment: 'fragment',
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { DetailsDrawer } = module.exports

const bot = { id: 'a', name: 'Chief', sessionId: 'a' }
const room = { id: 'g', name: 'Writers', named: true, members: ['a'] }
const roster = { byId: { a: bot }, roomsById: { g: room }, bots: [], exchangeTurns: {}, questions: {}, memory: false }
const hook = value => select => select(value)
const drawer = (sessionId, actions, liveRoster = roster) => DetailsDrawer({
  sessionId, roster: liveRoster, actions,
  useSessions: hook({ byId: {} }),
  useSessionStatus: hook(new Map()),
  useActivity: hook({}),
  useWork: hook({ bots: {}, approvals: [] }),
  useBrowserTabs: hook({}),
  useBrowserPages: hook({}),
})
const moreButton = (node) => {
  if (Array.isArray(node)) return node.map(moreButton).find(found => found !== null) ?? null
  if (node === null || typeof node !== 'object') return null
  if (node.props?.['data-info-row'] === 'more') return node
  for (const child of node.children ?? []) {
    const found = moreButton(child)
    if (found) return found
  }
  return null
}
const menuKeys = (node) => {
  const button = moreButton(node)
  const items = button?.children.flat(Infinity).find(child => child?.props?.items)?.props?.items ?? []
  // `items` was built inside the bundle's vm context; a test-context array compares deep-equal.
  return [...items].map(item => (item.sep ? 'sep' : item.key))
}
const menuItem = (node, key) => {
  const button = moreButton(node)
  return [...(button?.children.flat(Infinity).find(child => child?.props?.items)?.props?.items ?? [])].find(item => item.key === key)
}

test('the drawer `···` lists browser, a side chat, and the column tabs', () => {
  const picks = { openBrowser: 0, newSideChat: 0, newTerminal: 0, openFiles: 0 }
  const actions = {
    ...Object.fromEntries(Object.keys(picks).map(name => [name, () => { picks[name] += 1 }])),
    canOpenTerminal: () => true,
    canOpenFiles: () => true,
  }
  const browseRoster = { ...roster, browser: true }
  const withBrowser = drawer('a', actions, browseRoster)
  assert.deepEqual(menuKeys(withBrowser), ['browser', 'side', 'sep', 'terminal', 'files'])
  for (const key of ['browser', 'side', 'terminal', 'files']) {
    const action = { browser: 'openBrowser', side: 'newSideChat', terminal: 'newTerminal', files: 'openFiles' }[key]
    menuItem(withBrowser, key).onPick()
    assert.equal(picks[action], 1, `${key} runs ${action}`)
  }
})

test('a bot in a window without a browser still gets Side chat in the `···`', () => {
  assert.deepEqual(menuKeys(drawer('a', {})), ['side'])
})

test('a group keeps only the column tabs, and nothing when they are absent', () => {
  const actions = { canOpenTerminal: () => true, canOpenFiles: () => true, newTerminal: () => {}, openFiles: () => {} }
  assert.deepEqual(menuKeys(drawer('g', actions)), ['terminal', 'files'])
  assert.equal(moreButton(drawer('g', {})), null)
  assert.equal(moreButton(drawer('g', { canOpenTerminal: () => false })), null)
})

test('a non-team surface shows no `···`', () => {
  assert.equal(moreButton(drawer('plain', { canOpenTerminal: () => true })), null)
})
