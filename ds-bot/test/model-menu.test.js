import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/model-menu.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: name => {
    const platform = {
      react: { Fragment: 'fragment', createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx }, useContext: ctx => ctx.value, useMemo: make => make(), useCallback: fn => fn, useId: () => 'dv-id', useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(), 
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}],
        useEffect: () => {},
      },
      'react-dom': {},
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { groupModels, ModelChoiceDock, ModelKeyCard, effortRows } = module.exports

function nodes(tree, match) {
  if (!tree || typeof tree !== 'object') return []
  return [...(match(tree) ? [tree] : []), ...(tree.children ?? []).flatMap(child => nodes(child, match))]
}

// `harness`: the window has DSH's own settings to send the user to, as the plugin does.
function dock(models, { model, ready = true, harness = true } = {}) {
  const picked = []
  const bot = { id: 'chief', name: 'Chief', model }
  const roster = { ready, byId: { chief: bot }, models, defaultModel: models[0]?.ref }
  const tree = ModelChoiceDock({
    sessionId: bot.id, useRoster: select => select(roster),
    actions: {
      updateBot: (id, patch) => { picked.push([id, patch.model]); return Promise.resolve() },
      ...(harness ? { openHarnessSettings: () => {}, openHarnessOnboarding: () => {} } : {}),
    },
  })
  return { tree, picked }
}

const models = [
  { ref: 'official/flash', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Flash' },
  { ref: 'local/flash', provider: 'local', providerName: 'Ollama', name: 'DeepSeek Flash' },
  { ref: 'official/pro', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Pro' },
]

test('the first model choice shows provider groups and keeps each model route', () => {
  const { tree, picked } = dock(models)
  const groups = nodes(tree, node => node.props.className === 'bt-model-choice-group')
  assert.deepEqual(groups.map(group => group.props['aria-label']), ['DeepSeek', 'Ollama'])
  assert.deepEqual(groups.map(group => nodes(group, node => node.props.className === 'bt-model-choice-provider')[0].children[0]), ['DeepSeek', 'Ollama'])
  const buttons = groups.map(group => nodes(group, node => node.type === 'button'))
  assert.deepEqual(buttons.map(list => list.map(button => button.children[0])), [['DeepSeek Flash', 'DeepSeek Pro'], ['DeepSeek Flash']])
  assert.match(buttons[0][0].props.title, /official\/flash.*Harness default/)
  buttons[1][0].props.onClick()
  buttons[0][0].props.onClick()
  assert.deepEqual(picked, [['chief', 'local/flash'], ['chief', 'official/flash']])
  assert.equal(nodes(tree, node => node.type === 'button' && node.children.includes('Manage models')).length, 1)
})

test('providers with the same display name stay distinct, and unnamed providers use their id', () => {
  const entries = [
    { ...models[0], providerName: 'Cloud' },
    { ...models[1], providerName: 'Cloud' },
    { ref: 'custom/flash', provider: 'custom', name: 'Flash' },
  ]
  const groups = groupModels(entries)
  assert.deepEqual(Array.from(groups, ([label, list]) => [label, Array.from(list, model => model.ref)]), [
    ['Cloud (official)', ['official/flash']],
    ['Cloud (local)', ['local/flash']],
    ['custom', ['custom/flash']],
  ])
})

test('an unavailable model offers the same provider groups', () => {
  const { tree } = dock(models, { model: 'gone/flash' })
  assert.deepEqual(nodes(tree, node => node.props.className === 'bt-model-choice-group').map(group => group.props['aria-label']), ['DeepSeek', 'Ollama'])
  assert.ok(nodes(tree, node => node.props.className === 'bt-bubble')[0].children[0].includes('not available anymore'))
})

test('an empty catalog offers setup choices, and a ready model needs no choice dock', () => {
  const { tree } = dock([])
  assert.deepEqual(nodes(tree, node => node.type === 'button').map(button => button.children[0]), [
    'Enter a DeepSeek API key', 'Open settings to set up a custom model',
  ])
  assert.equal(dock(models, { model: models[0].ref }).tree, null)
  assert.equal(dock(models, { ready: false }).tree, null)
})

test('without DSH\'s own settings, the choice offers no way into them', () => {
  const buttons = tree => nodes(tree, node => node.type === 'button').map(button => button.children[0])
  assert.deepEqual(buttons(dock(models, { harness: false }).tree), ['DeepSeek Flash', 'DeepSeek Pro', 'DeepSeek Flash'])
  assert.deepEqual(buttons(dock([], { harness: false }).tree), [])
})

test('the Thinking section always offers Default, so a picked level can be cleared', () => {
  const efforts = [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }]
  // Array.from: the rows come from the bundle's realm, whose arrays are not this one's.
  assert.deepEqual(Array.from(effortRows({ efforts, defaultEffort: 'high' }), row => row.effort), [undefined, 'low', 'high'])
  assert.deepEqual(Array.from(effortRows({ efforts }), row => row.effort), [undefined, 'low', 'high'])
  assert.equal(effortRows({ efforts: [] }).length, 0)
})

const keyless = [
  { ref: 'official/flash', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Flash', needsKey: true },
  { ref: 'official/pro', provider: 'official', providerName: 'DeepSeek', name: 'DeepSeek Pro', needsKey: true },
]

test('models that need an API key are no choice', () => {
  const buttons = tree => nodes(tree, node => node.type === 'button').map(button => button.children[0])
  assert.deepEqual(buttons(dock([...keyless, models[1]], { harness: false }).tree), ['DeepSeek Flash'])
  // Without the host's key endpoint, DSH's own settings take the key.
  assert.deepEqual(buttons(dock(keyless).tree), ['Enter a DeepSeek API key', 'Open settings to set up a custom model'])
})

test('the first choice asks for the missing API key through the host', () => {
  const saved = []
  const bot = { id: 'chief', name: 'Chief' }
  const tree = ModelChoiceDock({
    sessionId: bot.id,
    useRoster: select => select({ ready: true, byId: { chief: bot }, models: keyless }),
    actions: { setProviderKey: (provider, value) => { saved.push([provider, value]) } },
  })
  assert.match(nodes(tree, node => node.props.className === 'bt-bubble')[0].children[0], /need a DeepSeek API key/)
  const [card] = nodes(tree, node => node.props.model !== undefined)
  assert.equal(card.props.model.provider, 'official')
  assert.equal(nodes(tree, node => node.props.className === 'bt-model-chips').length, 0)
})

test('the DeepSeek API key card links to the key page and says the API is billed by usage', () => {
  const card = model => ModelKeyCard({ model, actions: { setProviderKey: () => {} } })
  const official = card({ provider: 'deepseek-official', providerName: 'DeepSeek' })
  const [link] = nodes(official, node => node.type === 'a')
  assert.equal(link.props.href, 'https://platform.deepseek.com/api_keys')
  assert.equal(link.props.target, '_blank')
  assert.match(link.props.rel, /noopener/)
  assert.deepEqual(link.children, ['Create a key on the DeepSeek platform ↗'])
  assert.ok(nodes(official, node => node.children.includes('The API is billed by usage; the account needs a balance first.')).length === 1)
  const other = card({ provider: 'router', providerName: 'Router' })
  assert.equal(nodes(other, node => node.type === 'a').length, 0)
  assert.equal(nodes(other, node => node.props.className === 'bt-model-key-help').length, 0)
})

test('setting up a custom model opens DS Bot\'s Models page, else DSH\'s own Models page', () => {
  const opened = []
  const choices = actions => nodes(ModelChoiceDock({
    sessionId: 'chief', useRoster: select => select({ ready: true, byId: { chief: { id: 'chief', name: 'Chief' } }, models: [] }), actions,
  }), node => node.type === 'button')
  const custom = list => list.find(button => button.children[0] === 'Open settings to set up a custom model')
  custom(choices({ openModels: () => opened.push('models'), openHarnessModels: () => opened.push('harness models'), openHarnessSettings: () => opened.push('harness') })).props.onClick()
  custom(choices({ openHarnessModels: () => opened.push('harness models'), openHarnessSettings: () => opened.push('harness') })).props.onClick()
  assert.deepEqual(opened, ['models', 'harness models'])
})
