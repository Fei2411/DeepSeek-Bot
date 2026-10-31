import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// DS Bot's settings.onboarding step that opens DSH's settings on Models. Rendered with a
// stand-in React whose effects run at once, as the mounted step's would.
const { outputFiles } = await build({
  stdin: {
    contents: "export { MODELS_STEP, MODELS_STEP_ORDER, OpenModelsStep } from './src/client/sidebar.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const frames = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect: (effect) => { effect() }, useLayoutEffect() {}, useState: initial => [initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
  // The bundled Deep View widgets make a React context when their module loads.
  createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value,
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  window: { innerWidth: 1280 },
  requestAnimationFrame: (fn) => { frames.push(fn); return frames.length },
  require: name => (name === 'react' ? react : {}),
})
const { MODELS_STEP, MODELS_STEP_ORDER, OpenModelsStep } = module.exports

function step(props) {
  const calls = []
  const tree = OpenModelsStep({
    stepId: MODELS_STEP,
    complete: () => calls.push('complete'),
    openSection: id => calls.push(['openSection', id]),
    ...props,
  })
  return { tree, calls }
}

test('in the first-run pass the step draws nothing and steps aside at once', () => {
  const { tree, calls } = step({ explicit: false })
  assert.equal(tree, null)
  assert.deepEqual(calls, ['complete'])
})

test('opened by its id, the step opens DSH settings on Models and completes', () => {
  const { tree, calls } = step({ explicit: true })
  assert.equal(tree, null)
  assert.deepEqual(calls, [['openSection', 'models'], 'complete'])
})

test('a shell without openSection still opens its settings and completes the step', () => {
  frames.length = 0
  const { calls } = step({ explicit: true, openSection: undefined })
  assert.deepEqual(calls, ['complete'])
  // The fallback is the plain settings opener, a frame later.
  assert.equal(frames.length, 1)
})

// The shell's own steps are the welcome notice (-100) and the DeepSeek key step (0).
test('the step comes after the shell\'s own onboarding steps', () => {
  assert.equal(MODELS_STEP, 'ds-bot-models')
  assert.ok(MODELS_STEP_ORDER > 0)
})

// The DS Bot settings dialog, drawn once with effects left out: its Advanced settings
// entry is the way to DSH's own Models page.
const dialog = await build({
  stdin: {
    contents: "export { SettingsDialog } from './src/client/settings.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const still = {
  ...react, useEffect() {}, useCallback: fn => fn, useRef: current => ({ current }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
}
const settings = { exports: {} }
runInNewContext(dialog.outputFiles[0].text, {
  module: settings, exports: settings.exports,
  window: { innerWidth: 1280, matchMedia: () => ({ matches: false }) },
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  require: name => (name === 'react' ? still : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { SettingsDialog } = settings.exports
const walk = (node, match, out = []) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, match, out)); return out }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  walk(node.props?.children, match, out)
  return out
}
const textOf = node => (typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : node?.props ? textOf(node.props.children) : '')

function advanced(actions) {
  const calls = []
  const all = {
    closeSettings: () => calls.push('close'), openSettings() {},
    openHarnessSettings: () => calls.push('settings'),
    ...actions(calls),
  }
  const roster = { byId: {}, roomsById: {}, bots: [], rooms: [], models: [], prefs: {} }
  const tree = SettingsDialog({ page: 'general', id: null, roster, actions: all, useUpdate: pick => pick({}) })
  const [button] = walk(tree, node => node.type === 'button' && textOf(node) === 'Advanced settings (DeepSeek Harness)')
  return { button, calls }
}

test('Advanced settings opens DSH settings on Models, or on their first page without that opener', () => {
  const models = advanced(calls => ({ openHarnessModels: () => calls.push('models') }))
  models.button.props.onClick()
  assert.deepEqual(models.calls, ['close', 'models'])
  const plain = advanced(() => ({}))
  plain.button.props.onClick()
  assert.deepEqual(plain.calls, ['close', 'settings'])
})
