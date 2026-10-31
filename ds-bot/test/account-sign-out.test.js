import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The account menu bundled once and rendered with a stateful stand-in React:
// useState/useRef slots persist across renders, so clicking a menu item and
// re-rendering drives the same state the real React would keep.
const { outputFiles } = await build({
  stdin: {
    contents: "export { AccountLauncher } from './src/client/sidebar.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const slots = []
let cursor = 0
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useState(initial) {
    const i = cursor++
    if (slots[i] === undefined) slots[i] = { v: typeof initial === 'function' ? initial() : initial }
    const slot = slots[i]
    return [slot.v, v => { slot.v = typeof v === 'function' ? v(slot.v) : v }]
  },
  useRef(initial) { const i = cursor++; if (slots[i] === undefined) slots[i] = { current: initial }; return slots[i] },
  useMemo: make => make(), useEffect() {}, useLayoutEffect() {}, useSyncExternalStore: (subscribe, get) => get(), useId: () => 'id',
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  window: { innerHeight: 800, addEventListener() {}, removeEventListener() {} },
  document: { body: {} },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { AccountLauncher } = module.exports

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const walk = (node, match, out = []) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, match, out)); return out }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  walk(node.props?.children, match, out)
  return out
}
const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

// `status` is what the account plugin's snapshot reports; `running` is what its
// hasRunningAccountTasks answers (or throws); `fail` makes signOut reject.
function launcher({ status = 'credential-stored', running = false, runningError = false, fail = '', withEntry = true, actions = {} } = {}) {
  const calls = []
  slots.length = 0
  const ops = {
    signOut: async () => { calls.push('signOut'); if (fail !== '') throw new Error(fail) },
    hasRunningAccountTasks: async () => { calls.push('hasRunningAccountTasks'); if (runningError) throw new Error('no account api'); return running },
    hooks: { account: { subscribe: () => () => {}, getSnapshot: () => ({ view: { status } }) } },
  }
  const props = {
    seat: false,
    actions: {
      signInEntry: () => ((typeof withEntry === 'function' ? withEntry() : withEntry) ? { inject: () => ops } : null),
      accountT: () => key => `acc:${key}`,
      reportError: () => {},
      ...actions,
    },
  }
  const render = () => { cursor = 0; return AccountLauncher(props) }
  const open = () => {
    const tree = render()
    const [button] = walk(tree, node => node.props?.className === 'bt-account')
    button.props.ref.current = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }), contains: () => false, focus() {} }
    button.props.onClick()
    return render()
  }
  const items = tree => walk(tree, node => node.props?.role === 'menuitem')
  const item = (tree, label) => items(tree).find(node => textOf(node) === label)
  return { render, open, items, item, calls }
}

test('the sign-out item only shows when the account snapshot is signed in', () => {
  const out = launcher({ status: 'signed-out' })
  const menu = out.open()
  assert.equal(out.item(menu, 'acc:signOut'), undefined)
  const inside = launcher()
  assert.ok(out.item(inside.open(), 'acc:signOut') !== undefined)
})

test('without the shell account entry there is no sign-out item', () => {
  const side = launcher({ withEntry: false })
  assert.equal(side.item(side.open(), 'acc:signOut'), undefined)
})

test('a shell account entry that arrives after mount still lends its sign-out', () => {
  let arrived = false
  const side = launcher({ withEntry: () => arrived })
  side.render()
  arrived = true
  // The first open is after the entry arrived; it must inject now, not reuse the
  // empty operations from mount.
  assert.ok(side.item(side.open(), 'acc:signOut') !== undefined)
})

test('signing out asks about running tasks, confirms, then signs out', async () => {
  const side = launcher()
  let tree = side.open()
  side.item(tree, 'acc:signOut').props.onClick()
  await tick()
  tree = side.render()
  const [confirm] = walk(tree, node => node.props?.className === 'bt-confirm')
  assert.match(textOf(confirm), /acc:signOutDescription/)
  const [go] = walk(tree, node => node.props?.className === 'bt-confirm-go')
  go.props.onClick()
  await tick()
  await tick()
  assert.deepEqual(side.calls, ['hasRunningAccountTasks', 'signOut'])
  // The confirm and the menu are gone after a successful sign-out.
  assert.equal(walk(side.render(), node => node.props?.className === 'bt-menu').length, 0)
})

test('running account tasks and an unavailable check pick their own descriptions', async () => {
  for (const [options, label] of [[{ running: true }, 'acc:signOutRunningDescription'], [{ runningError: true }, 'acc:signOutUnknownDescription']]) {
    const side = launcher(options)
    side.item(side.open(), 'acc:signOut').props.onClick()
    await tick()
    const [confirm] = walk(side.render(), node => node.props?.className === 'bt-confirm')
    assert.match(textOf(confirm), new RegExp(label))
  }
})

test('a failed sign-out shows its error and keeps the confirm open', async () => {
  const side = launcher({ fail: 'network down' })
  side.item(side.open(), 'acc:signOut').props.onClick()
  await tick()
  const [go] = walk(side.render(), node => node.props?.className === 'bt-confirm-go')
  go.props.onClick()
  await tick()
  await tick()
  const tree = side.render()
  const [error] = walk(tree, node => node.props?.className === 'bt-confirm-error')
  assert.match(textOf(error), /network down/)
  assert.equal(walk(tree, node => node.props?.className === 'bt-confirm').length, 1)
})

test('cancel closes the confirm without signing out', async () => {
  const side = launcher()
  side.item(side.open(), 'acc:signOut').props.onClick()
  await tick()
  const [cancel] = walk(side.render(), node => textOf(node) === 'Cancel')
  cancel.props.onClick()
  const tree = side.render()
  assert.equal(walk(tree, node => node.props?.className === 'bt-confirm').length, 0)
  assert.deepEqual(side.calls, ['hasRunningAccountTasks'])
})

test('Models and API keys opens DS Bot\'s Models page, or DSH\'s own where the host serves no providers', () => {
  const opened = []
  const page = launcher({ actions: { providers: () => {}, openModels: () => opened.push('models'), openHarnessModels: () => opened.push('harness') } })
  page.item(page.open(), 'Models and API keys').props.onClick()
  const shell = launcher({ actions: { openHarnessModels: () => opened.push('harness') } })
  shell.item(shell.open(), 'Models and API keys').props.onClick()
  assert.deepEqual(opened, ['models', 'harness'])
  const none = launcher()
  assert.equal(none.item(none.open(), 'Models and API keys'), undefined)
})

test('Sign in to DeepSeek shows only while the account plugin says signed out', () => {
  const signIns = []
  const actions = { signIn: () => signIns.push('signIn') }
  const out = launcher({ status: 'signed-out', actions })
  const item = out.item(out.open(), 'Sign in to DeepSeek')
  assert.ok(item !== undefined)
  item.props.onClick()
  assert.deepEqual(signIns, ['signIn'])
  const inside = launcher({ actions })
  assert.equal(inside.item(inside.open(), 'Sign in to DeepSeek'), undefined)
  // An account snapshot that has not answered yet is no sign-out.
  const loading = launcher({ status: undefined, actions })
  assert.equal(loading.item(loading.open(), 'Sign in to DeepSeek'), undefined)
  const entryless = launcher({ status: 'signed-out', withEntry: false, actions })
  assert.equal(entryless.item(entryless.open(), 'Sign in to DeepSeek'), undefined)
})

// #452: the Connect plugins button left the Bot footer; the account menu that
// stays keeps the way into the connectors and the automation panel.
test('the account menu opens the connectors and the automation panel', () => {
  const calls = []
  const side = launcher({ actions: { openConnectors: () => calls.push('connectors'), selectPanel: id => calls.push(id) } })
  const menu = side.open()
  side.item(menu, 'Connectors').props.onClick()
  side.item(menu, 'Automation tasks').props.onClick()
  assert.deepEqual(calls, ['connectors', 'schedules'])
})
