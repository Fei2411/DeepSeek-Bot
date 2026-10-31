import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The sidebar imports the browser's React; bundle it with a minimal stand-in, as the
// sidebar tests do: components run as plain functions, and each mounted one keeps its
// refs and runs an effect after a render when the effect's dependencies changed.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { BotReturn, TeamSidebar } from './src/client/sidebar.js'\nexport { clientErrors } from './src/client/diagnostics.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

let hooks
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useRef: initial => hooks.ref(initial), useEffect: (run, deps) => hooks.effect(run, deps), useLayoutEffect() {},
  useMemo: make => make(), useState: initial => [initial, () => {}], useId: () => 'id',
  // The bundled Deep View widgets make a React context when their module loads.
  createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value,
}

function mount(component) {
  const slots = []
  return (props) => {
    let at = 0
    const effects = []
    hooks = {
      ref: initial => (slots[at++] ??= { current: initial }),
      effect: (run, deps) => {
        const i = at++
        if (slots[i] !== undefined && deps.every((value, index) => value === slots[i][index])) return
        slots[i] = deps
        effects.push(run)
      },
    }
    const tree = component(props)
    hooks = undefined
    for (const run of effects) run()
    return tree
  }
}

// One page load: a fresh copy of the client modules, under the app bridge it was given.
function page(dsBotApp) {
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require: name => (name === 'react' ? react : {}),
    window: { innerWidth: 1280, addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, removeEventListener() {}, querySelector: () => null, documentElement: { setAttribute() {}, removeAttribute() {} } },
    setTimeout: () => 0, clearTimeout() {},
    ...(dsBotApp === undefined ? {} : { dsBotApp }),
  })
  return module.exports
}

const BEFORE_STATE = { ready: false, mainBotId: null, bots: [], rooms: [], agents: [], byId: {}, roomsById: {}, agentOf: {} }
const main = { id: 'main', name: 'DeepSeek', createdAt: 1 }
const TEAM = { ...BEFORE_STATE, ready: true, revision: 1, mainBotId: 'main', mainBotIds: ['main'], bots: [main], byId: { main } }

const sidebarProps = roster => ({
  wide: true, actions: { landOn() {} },
  useRoster: pick => pick(roster), useUi: pick => pick({ unread: {} }), useRegistry: pick => pick({}),
  useSessions: pick => pick({ ids: [], byId: {} }), useUpdate: () => ({}),
})
const returnProps = (mode, roster) => ({ wide: true, actions: {}, useSurface: pick => pick({ mode }), useRoster: pick => pick(roster) })

// The team column's content sits inside the frame's column, under a Fragment.
const drawsSide = node => node !== null && typeof node === 'object'
  && (node.props?.className === 'bt-side' || (node.props?.children ?? []).flat().some(drawsSide))

function readyCalls() {
  const calls = []
  return { calls, app: { ready: (...args) => { calls.push(args) } } }
}

test('the desktop app hears once that the team sidebar drew the first state', async () => {
  const { calls, app } = readyCalls()
  const { TeamSidebar } = page(app)
  const sidebar = mount(TeamSidebar)
  sidebar(sidebarProps(BEFORE_STATE))
  await setImmediate()
  assert.deepEqual(calls, [], 'the sidebar is not ready before the first state')
  sidebar(sidebarProps(TEAM))
  await setImmediate()
  assert.deepEqual(calls, [[]])
  sidebar(sidebarProps({ ...TEAM, revision: 2 }))
  mount(TeamSidebar)(sidebarProps(TEAM))
  await setImmediate()
  assert.deepEqual(calls, [[]], 'later states and a second mount report nothing more')
})

test('in Agent mode the return button reports what the team sidebar would', async () => {
  const { calls, app } = readyCalls()
  const { BotReturn, TeamSidebar } = page(app)
  const button = mount(BotReturn)
  assert.equal(button(returnProps('bot', TEAM)), null)
  button(returnProps('agent', BEFORE_STATE))
  await setImmediate()
  assert.deepEqual(calls, [])
  button(returnProps('agent', TEAM))
  mount(TeamSidebar)(sidebarProps(TEAM))
  await setImmediate()
  assert.deepEqual(calls, [[]])
})

test('without the app bridge or its ready() the sidebar draws as before', async () => {
  for (const app of [undefined, {}]) {
    const { TeamSidebar, clientErrors } = page(app)
    const tree = mount(TeamSidebar)(sidebarProps(TEAM))
    await setImmediate()
    assert.ok(drawsSide(tree))
    assert.equal(clientErrors().length, 0)
  }
})

test('a ready() that throws is noted and the sidebar stays', async () => {
  const { TeamSidebar, clientErrors } = page({ ready: () => { throw new Error('bridge gone') } })
  const tree = mount(TeamSidebar)(sidebarProps(TEAM))
  await setImmediate()
  assert.ok(drawsSide(tree))
  assert.deepEqual(Array.from(clientErrors(), entry => entry.text), ['app ready: bridge gone'])
})
