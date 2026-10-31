import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/fold.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react'],
})
// Hooks keep their state between renders, so a click and the render after it can be followed.
let slots = []
let at = 0
const react = {
  Fragment: 'fragment',
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useId: () => 'dv-id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (initial) => {
    const index = at++
    if (!(index in slots)) slots[index] = initial
    return [slots[index], (value) => { slots[index] = value }]
  },
  useMemo: compute => compute(),
}
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    if (name !== 'react') throw new Error(`no platform module ${name}`)
    return react
  },
})
const { FOLD_AT, FOLD_HUGE, foldPreview, foldView, stripLongNote, useFold } = module.exports
const render = (text, options) => { at = 0; return useFold(text, options) }
const fresh = () => { slots = [] }
const buttons = node => (node === null || typeof node !== 'object' ? [] : [...(node.type === 'button' ? [node] : []), ...node.children.flatMap(buttons)])
const words = node => (node === null || typeof node !== 'object' ? String(node ?? '') : node.children.map(words).join(''))
const lines = count => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')

test('a text folds past 1,500 characters or 25 lines, and shows its first ten lines', () => {
  assert.equal(foldPreview('x'.repeat(1500)), null)
  assert.equal(foldPreview(lines(25)), null)
  assert.equal(foldPreview(lines(26)), lines(10))
  assert.equal(foldPreview('x'.repeat(1501)), 'x'.repeat(600))
  // Within the ten lines the preview ends at a line end, at most 600 characters in.
  const wide = Array.from({ length: 20 }, () => 'y'.repeat(100)).join('\n')
  assert.equal(foldPreview(wide), Array.from({ length: 5 }, () => 'y'.repeat(100)).join('\n'))
  // A character outside the BMP is not cut in half.
  assert.equal(foldPreview(`${'x'.repeat(599)}😀${'x'.repeat(1000)}`), 'x'.repeat(599))
})

test('the preview closes a code fence it cuts open, in Markdown only', () => {
  // A fence the cut opened loses its language tag, so a downstream renderer
  // (dsh-ui cards) does not claim a half message.
  const code = `Here:\n\`\`\`js\n${lines(30)}\n\`\`\``
  assert.equal(foldPreview(code), `Here:\n\`\`\`\n${lines(8)}\n\`\`\``)
  assert.equal(foldPreview(code, FOLD_AT, false), `Here:\n\`\`\`js\n${lines(8)}`)
  const tilde = `~~~~\n\`\`\`\n${lines(30)}`
  assert.equal(foldPreview(tilde), `~~~~\n\`\`\`\n${lines(8)}\n~~~~`)
  const closed = `\`\`\`\na\n\`\`\`\n${lines(30)}`
  assert.equal(foldPreview(closed), `\`\`\`\na\n\`\`\`\n${lines(7)}`)
})

// #520: a card message is the fence marker, then one very long line — the
// newline cut left an empty fence, so no preview and nothing on open either.
test('a long message that opens with a card fence still previews its start', () => {
  const card = `\`\`\`dsh-ui\n${'x'.repeat(2000)}`
  const preview = foldPreview(card)
  assert.equal(preview, `\`\`\`\n${'x'.repeat(590)}\n\`\`\``)
})

// Leading blank lines are not part of the preview; an all-blank message does
// not fold at all.
test('the preview starts at the first visible character', () => {
  assert.equal(foldPreview(`\n\n\n${'x'.repeat(1500)}`), 'x'.repeat(600))
  assert.equal(foldPreview(`${' '.repeat(2000)}\n${'\n'.repeat(30)}`), null)
})

test('a Bot reply in its own chat folds only past 20,000 characters', () => {
  assert.equal(foldPreview(lines(500).slice(0, 5000), FOLD_HUGE), null)
  assert.equal(foldPreview('z'.repeat(20_001), FOLD_HUGE), 'z'.repeat(600))
})

test('the note for the model at the start of a long message stays out of the chat', () => {
  const plain = '[A long message: 25007 characters. Its start is below; all of it is in the attached file. Read the file before you act on it.]\nHello'
  const wide = '[A long message: 25017 characters. Its start is below; all of it is in the attached file. Read the file before you act on it. Some lines are longer than the 2000 characters the read tool shows of a line; read those with a shell command.]\nHello'
  assert.equal(stripLongNote(plain), 'Hello')
  assert.equal(stripLongNote(wide), 'Hello')
  assert.equal(stripLongNote('[A long message is coming]\nHello'), '[A long message is coming]\nHello')
})

test('a long text opens and closes in place; a short one has no control', async () => {
  fresh()
  // Values from the bundle's realm compare by content only.
  assert.deepEqual(JSON.parse(JSON.stringify(render('short'))), { shown: 'short', control: null })
  fresh()
  const text = lines(40)
  const folded = render(text)
  assert.equal(folded.folded, true)
  assert.equal(folded.shown, lines(10))
  const [show] = buttons(folded.control)
  assert.equal(words(show), `Show all · ${text.length} characters`)
  await show.props.onClick()
  const open = render(text)
  assert.equal(open.shown, text)
  assert.equal(open.folded, undefined)
  const [less] = buttons(open.control)
  assert.equal(words(less), 'Show less')
  less.props.onClick()
  assert.equal(render(text).shown, lines(10))
})

test('a message kept only in part is read whole on request, and says when it is still cut', async () => {
  fresh()
  const start = 'x'.repeat(2000)
  let reads = 0
  const whole = { length: 30_000, load: async () => { reads += 1; return { text: 'x'.repeat(30_000), whole: true } } }
  const folded = render(start, { whole })
  assert.equal(folded.shown, 'x'.repeat(600), 'the start shows as any preview does')
  assert.equal(words(buttons(folded.control)[0]), 'Show all · 30,000 characters')
  await buttons(folded.control)[0].props.onClick()
  assert.equal(render(start, { whole }).shown.length, 30_000)
  assert.deepEqual(buttons(render(start, { whole }).control).map(words), ['Show less'])
  // Closed and opened again, it is not read twice.
  buttons(render(start, { whole }).control)[0].props.onClick()
  await buttons(render(start, { whole }).control)[0].props.onClick()
  assert.equal(reads, 1)

  fresh()
  const short = 'a short start'
  const partly = { length: 300_000, load: async () => ({ text: 'y'.repeat(200_000), whole: false }) }
  assert.equal(render(short, { whole: partly }).folded, true, 'a cut message folds even when its start is short')
  assert.equal(render(short, { whole: partly }).shown, short)
  await buttons(render(short, { whole: partly }).control)[0].props.onClick()
  assert.match(words(render(short, { whole: partly }).control), /^Showing the first 200,000 characters/)

  fresh()
  const lost = { length: 300_000, load: async () => undefined }
  await buttons(render(short, { whole: lost }).control)[0].props.onClick()
  assert.equal(render(short, { whole: lost }).shown, short)
  assert.match(words(render(short, { whole: lost }).control), /^Only the start of this message is kept here/)
})

// #718: the copy of a code block the preview cut must reach the whole block.
test('a folded preview also yields the whole code block it cut', () => {
  const inner = lines(30)
  const view = foldView(`Here:\n\`\`\`js\n${inner}\n\`\`\`\nafter`)
  assert.equal(view.head, `Here:\n\`\`\`\n${lines(8)}\n\`\`\``)
  assert.equal(view.code, inner)
  // A block that never closes yields to the end of the text.
  assert.equal(foldView(`\`\`\`js\n${inner}`).code, inner)
  // No fence is cut: nothing extra to copy.
  assert.equal(foldView(lines(30)).code, undefined)
  const closed = foldView(`\`\`\`\na\n\`\`\`\n${lines(30)}`)
  assert.equal(closed.code, undefined)
  // The folded state hands the code to the caller; a cut message cannot.
  fresh()
  assert.equal(render(`Here:\n\`\`\`js\n${inner}\n\`\`\``, {}).code, inner)
  fresh()
  assert.equal(render('short', { whole: { length: 300_000 } }).code, undefined)
})

test('a streaming text never folds', () => {
  fresh()
  assert.equal(render(lines(40), { live: true }).control, null)
})
