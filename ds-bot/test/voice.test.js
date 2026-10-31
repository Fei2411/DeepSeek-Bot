import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// voice.js imports react; the client tests bundle it and stub react, as the
// other client tests do.
const bundle = await build({
  stdin: { contents: "export { watchReply } from './src/client/voice.js'", resolveDir: dirname(dirname(fileURLToPath(import.meta.url))) },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
const platform = {
  react: {
    createElement: () => null, Fragment: 'fragment',
    useState: initial => [initial, () => {}], useEffect: () => {}, useMemo: make => make(), useCallback: fn => fn,
    useRef: current => ({ current }), useId: () => 'id', useSyncExternalStore: (sub, get) => get(),
    createContext: initial => ({ value: initial, Provider: () => null }), useContext: ctx => ctx.value,
  },
  'react-dom': { createPortal: node => node },
  '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
}
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: name => platform[name] ?? {} })
const { watchReply } = module.exports

test('a reply published synchronously during subscribe is spoken once', () => {
  const consumed = []
  // DSH's target publishes on subscribe, before watch() returns the disposer.
  const watch = (listener) => { listener(); return () => {} }
  const off = watchReply(() => 'the answer', watch, text => consumed.push(text))
  assert.deepEqual(consumed, ['the answer'])
  off()
})

test('watchReply waits for the reply, speaks it once, then stops', () => {
  const consumed = []
  const calls = []
  let text
  const listeners = new Set()
  const off = watchReply(
    () => text,
    (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    (value) => { calls.push('consume'); consumed.push(value) })
  assert.deepEqual(consumed, [])
  text = 'first'
  for (const listener of [...listeners]) listener()
  assert.deepEqual(consumed, ['first'])
  assert.equal(listeners.size, 0)
  // A later publish must not speak the same reply again.
  text = 'again'
  assert.deepEqual(consumed, ['first'])
  assert.equal(calls.length, 1)
  off()
})
