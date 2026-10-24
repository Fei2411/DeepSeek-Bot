import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/about.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'fragment',
  useState: initial => [initial, () => {}],
  useEffect: () => {},
  useRef: current => ({ current }),
  useLayoutEffect: () => {},
}
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, URL, URLSearchParams, setTimeout, clearTimeout,
  require: (name) => {
    if (name === 'react') return react
    return {}
  },
})
const { AboutPage, ownAppRow } = module.exports

// The DS Bot row in Settings → About, with the row's hint and its buttons' text, class
// and clicks. `update` is the value the update source holds.
function page(update) {
  const calls = []
  const actions = new Proxy({ repoStars: async () => null }, {
    get: (target, name) => target[name] ?? (() => calls.push(name)),
  })
  const run = promise => promise
  const tree = AboutPage({ useUpdate: select => select(update), actions, run, Section: 'section', Row: 'row' })
  const find = (node, pick) => (Array.isArray(node) ? node.flatMap(one => find(one, pick))
    : node && typeof node === 'object' ? [...pick(node), ...find(node.children, pick)] : [])
  const [row] = find(tree, node => (node.props?.label === 'DS Bot' ? [node] : []))
  const buttons = find(row?.children ?? [], node => (node.type === 'button' ? [node] : []))
  return {
    hint: row?.props?.hint,
    buttons: buttons.map(node => ({ text: node.children[0], className: node.props.className, click: () => node.props.onClick() })),
    calls,
  }
}

// 公开#499: in the desktop app the DS Bot row shows the app's own update state.
test('the six app update states set the DS Bot row\'s hint and button', () => {
  const cases = [
    [{ phase: 'checking' }, 'Checking for updates…', []],
    [{ phase: 'current' }, 'Up to date', [{ text: 'Check for updates', className: 'bt-soft bt-soft-sm', action: 'checkOwnApp' }]],
    [{ phase: 'downloading', version: '0.2.2' }, 'Downloading 0.2.2…', []],
    [{ phase: 'downloaded', version: '0.2.2' }, '0.2.2 is ready; it installs when you restart',
      [{ text: 'Restart to update', className: 'bt-fb-primary', action: 'installOwnApp' }]],
    [{ phase: 'available', version: '0.2.2', page: 'https://github.com/Fei2411/DeepSeek-Bot/releases/tag/v0.2.2' }, '0.2.2 is available',
      [{ text: 'Download', className: 'bt-soft bt-soft-sm', action: 'openOwnApp' }]],
    [{ phase: 'failed' }, 'Could not check for updates.', [{ text: 'Check for updates', className: 'bt-soft bt-soft-sm', action: 'checkOwnApp' }]],
  ]
  for (const [ownApp, hint, buttons] of cases) {
    const view = page({ source: 'app', ownApp })
    assert.equal(view.hint, hint)
    assert.equal(view.buttons.length, buttons.length)
    for (const [index, expected] of buttons.entries()) {
      assert.equal(view.buttons[index].text, expected.text)
      assert.equal(view.buttons[index].className, expected.className)
      view.buttons[index].click()
      assert.deepEqual(view.calls, [expected.action])
      view.calls.length = 0
    }
  }
})

test('without an app update state the row keeps today\'s text and no button', () => {
  for (const ownApp of [undefined, null, 'checking', {}]) {
    const view = page({ source: 'app', ownApp })
    assert.equal(view.hint, 'Updates come with the DeepSeek Bot app.')
    assert.deepEqual(view.buttons, [])
  }
})

test('an app update state is ignored outside the app', () => {
  const view = page({ source: 'registry', checkedAt: Date.now(), latest: '0.2.1', ownApp: { phase: 'downloaded', version: '0.2.2' } })
  assert.match(view.hint, /^Up to date · Checked /)
  assert.equal(view.buttons.length, 1)
  assert.equal(view.buttons[0].text, 'Check for updates')
})

test('ownAppRow maps each phase to its hint and button kind', () => {
  assert.equal(ownAppRow(null), null)
  assert.equal(ownAppRow('downloaded'), null)
  // The bundled module's realm has its own Object, so compare the fields.
  const checking = ownAppRow({ phase: 'checking' })
  assert.equal(checking.hint, 'Checking for updates…')
  assert.equal(checking.button, null)
  const downloaded = ownAppRow({ phase: 'downloaded', version: '0.2.2' })
  assert.equal(downloaded.hint, '0.2.2 is ready; it installs when you restart')
  assert.equal(downloaded.button, 'restart')
})
