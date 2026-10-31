import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The repair card of a failed Bot turn, bundled once and rendered with a stateful
// stand-in React: useState slots persist across renders, so a click and the next render
// see the same state the real React would keep. Effects run after each render, when
// their dependencies changed, as the real React would run them.
const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { FailureCell, accountModel, failureText, fixesFor, retryShown } from './src/client/turn-error.js'",
      "export { installLocale } from './src/client/i18n.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
// Hook slots per component, by its place among the components above it.
const slots = new Map()
let scope = ''
let cursor = 0
const hook = (make) => {
  if (!slots.has(scope)) slots.set(scope, [])
  const list = slots.get(scope)
  const i = cursor++
  if (list[i] === undefined) list[i] = make()
  return list[i]
}
const effects = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useState(initial) {
    const slot = hook(() => ({ v: typeof initial === 'function' ? initial() : initial }))
    return [slot.v, (v) => { slot.v = typeof v === 'function' ? v(slot.v) : v }]
  },
  useRef: initial => hook(() => ({ current: initial })),
  useEffect(effect, deps) {
    const slot = hook(() => ({ deps: null }))
    if (deps === undefined || slot.deps === null || deps.some((dep, i) => !Object.is(dep, slot.deps[i]))) {
      slot.deps = deps ?? null
      effects.push(effect)
    }
  },
  useMemo: make => make(), useLayoutEffect() {}, useSyncExternalStore: (subscribe, get) => get(), useId: () => 'id',
}
const copied = []
// Timers the card set, for a test to run.
const timers = []
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  navigator: { clipboard: { writeText: async (text) => { copied.push(text) } } },
  setTimeout: (run) => { timers.push(run); return timers.length },
  clearTimeout: () => {},
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { FailureCell, accountModel, failureText, fixesFor, retryShown, installLocale } = module.exports

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const walk = (node, match, out = []) => {
  if (Array.isArray(node)) { node.forEach(child => walk(child, match, out)); return out }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  walk(node.props?.children, match, out)
  return out
}
// Runs the function components in a tree, keeping each element with its output.
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type !== 'function') return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
  const outer = [scope, cursor]
  scope = `${scope}/${node.type.name}:${node.props.key ?? ''}`
  cursor = 0
  try {
    return { ...node, props: { ...node.props, children: [expand(node.type(node.props))] } }
  } finally {
    [scope, cursor] = outer
  }
}
const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

const models = [
  { ref: 'deepseek-official/deepseek-chat', provider: 'deepseek-official', providerName: 'DeepSeek', name: 'DeepSeek Chat' },
  { ref: 'router/flash', provider: 'router', providerName: 'Router', name: 'Flash' },
]

// `blocked` is what the host's state view carries on the Bot; `later` adds a turn after
// the failed one; `account` is the shell account snapshot's view, which a test may change
// between renders; `asked` marks the failed turn, or the turns listed, as ones another
// Bot asked for.
function cell({ code, message = '', turn = 3, blocked, model = models[0].ref, later = false, signIn = true, account, sessionId = 'chief-part', bot: botPatch = {}, catalog = models, defaultModel = null, asked = false } = {}) {
  slots.clear()
  effects.length = 0
  const calls = []
  const bot = { id: 'chief', name: 'Chief', model, sessionId: 'chief-part', blocked, ...botPatch }
  const byId = Object.fromEntries([...(bot.parts ?? []), 'chief-part', 'chief'].map(id => [id, bot]))
  const roster = { ready: true, byId, roomsById: {}, models: catalog, defaultModel, exchangeTurns: asked ? { [sessionId]: asked === true ? [turn] : asked } : {} }
  const ops = account ? { hooks: { account: { subscribe: () => () => {}, getSnapshot: () => ({ view: account }) } } } : {}
  const actions = {
    resume: async (id) => { calls.push(['resume', id]); if (actions.failResume) throw new Error(actions.failResume) },
    updateBot: async (id, patch) => { calls.push(['updateBot', id, { ...patch }]); if (actions.failUpdate) throw new Error(actions.failUpdate) },
    signIn: () => calls.push(['signIn']),
    canSignIn: () => signIn,
    signInEntry: () => (signIn ? { inject: () => ops } : null),
    showDetails: id => calls.push(['showDetails', id]),
    setProviderKey: (provider, value) => { calls.push(['key', provider, value]) },
    openModels: () => calls.push(['openModels']),
    openHarnessOnboarding: id => calls.push(['onboarding', id]),
  }
  const clock = later ? { [sessionId]: { [turn]: { first: 1 }, [turn + 1]: { first: 2 } } } : { [sessionId]: { [turn]: { first: 1 } } }
  const props = {
    node: { data: { kind: 'turn-error', seq: 9, time: 5, turn, step: 0, message, ...(code ? { code } : {}) } },
    sessionId, actions,
    useRoster: pick => pick(roster), useTurnClock: pick => pick(clock),
  }
  const render = () => {
    scope = ''
    cursor = 0
    const tree = expand(FailureCell(props))
    for (const effect of effects.splice(0)) effect()
    return tree
  }
  const buttons = tree => walk(tree, node => node.type === 'button' || node.type === 'a').map(node => ({ node, label: textOf(node), primary: String(node.props.className).includes('bt-send') }))
  const tech = tree => walk(tree, node => node.type === 'dd').map(textOf)
  return { render, buttons, tech, calls, actions, bot, roster }
}
const labels = list => list.filter(entry => !entry.node.props.className?.includes('bt-fail-copy')).map(entry => entry.label)

test('a missing key offers the key first, the sign-in and another model, but no retry while the host holds it', () => {
  const side = cell({ code: 'MISSING_CREDENTIAL', message: 'llm-deepseek: no API key for provider route', blocked: { code: 'MISSING_CREDENTIAL', provider: 'deepseek-official', at: 1 } })
  const tree = side.render()
  assert.match(textOf(walk(tree, node => node.props?.className === 'bt-fail-text')[0]), /^Chief's model has no API key yet\.$/)
  const list = side.buttons(tree)
  assert.deepEqual(labels(list), ['Enter API key', 'Sign in with a DeepSeek account', 'Pick another model'])
  assert.equal(list[0].primary, true)
  assert.equal(list.filter(entry => entry.primary).length, 1)
  // The raw text is only under Technical details.
  assert.equal(walk(tree, node => node.props?.className === 'bt-fail-text').some(node => textOf(node).includes('no API key for provider')), false)
  assert.ok(side.tech(tree).includes('llm-deepseek: no API key for provider route'))
  list[1].node.props.onClick()
  list[2].node.props.onClick()
  assert.deepEqual(side.calls, [['signIn'], ['showDetails', 'chief-part']])
})

test('Enter API key opens the key card for the failing provider, with the DeepSeek link', () => {
  const side = cell({ code: 'MISSING_CREDENTIAL', blocked: { code: 'MISSING_CREDENTIAL', provider: 'deepseek-official', at: 1 } })
  side.buttons(side.render())[0].node.props.onClick()
  const [card] = walk(side.render(), node => node.props?.model !== undefined)
  assert.equal(card.props.model.provider, 'deepseek-official')
  assert.equal(card.props.model.providerName, 'DeepSeek')
  const [link] = walk(card, node => node.type === 'a')
  assert.equal(link.props.href, 'https://platform.deepseek.com/api_keys')
  assert.equal(link.props.target, '_blank')
  assert.match(textOf(card), /billed by usage; the account needs a balance first/)
  // The key goes to the failing provider.
  const [input] = walk(card, node => typeof node.props?.onChange === 'function' && node.props?.label !== undefined)
  input.props.onChange('sk-test-ok')
  const [save] = walk(side.render(), node => node.type === 'button' && textOf(node) === 'Save')
  save.props.onClick()
  assert.deepEqual(side.calls, [['key', 'deepseek-official', 'sk-test-ok']])
  // Saving closes the card again.
  card.props.onSaved()
  assert.equal(walk(side.render(), node => node.props?.model !== undefined).length, 0)
})

test('without the host key endpoint, Enter API key goes to the shell key editor of the official route', () => {
  const side = cell({ code: 'MISSING_CREDENTIAL', blocked: { code: 'MISSING_CREDENTIAL', provider: 'deepseek-official', at: 1 } })
  delete side.actions.setProviderKey
  side.buttons(side.render())[0].node.props.onClick()
  assert.deepEqual(side.calls, [['onboarding', 'deepseek-official']])
})

test('once the host no longer holds the failure, Retry leads and asks the Bot to go on once', async () => {
  const side = cell({ code: 'MISSING_CREDENTIAL' })
  const list = side.buttons(side.render())
  assert.equal(list[0].label, 'Retry')
  assert.equal(list[0].primary, true)
  list[0].node.props.onClick()
  await tick()
  const [again] = side.buttons(side.render())
  assert.equal(again.label, 'Retrying…')
  assert.equal(again.node.props.disabled, true)
  assert.deepEqual(side.calls, [['resume', 'chief']])
})

test('a failed retry says why and can be tried again', async () => {
  const side = cell({ code: 'SERVER' })
  side.actions.failResume = 'DS Bot is still loading this chat.'
  side.buttons(side.render())[0].node.props.onClick()
  await tick()
  const tree = side.render()
  assert.match(textOf(walk(tree, node => node.props?.className === 'bt-fail-error')[0]), /still loading/)
  assert.equal(side.buttons(tree)[0].node.props.disabled, false)
})

test('AUTH names the provider and status from the host, and never shows the raw message', () => {
  const side = cell({ code: 'AUTH', message: 'Authentication Fails (sk-... is invalid)', blocked: { code: 'AUTH', status: 401, requestId: 'req-1', provider: 'deepseek-official', at: 1 } })
  const tree = side.render()
  assert.equal(textOf(walk(tree, node => node.props?.className === 'bt-fail-text')[0]), 'DeepSeek did not accept the current API key (401).')
  assert.deepEqual(labels(side.buttons(tree)), ['Enter the key again', 'Use a DeepSeek account instead', 'Pick another model'])
  assert.deepEqual(side.tech(tree), ['AUTH', '401', 'req-1'])
  assert.equal(JSON.stringify(tree).includes('Authentication Fails'), false)
})

test('QUOTA takes its provider and status from the failure, and tops up only the official route', () => {
  const router = cell({ code: 'QUOTA', model: models[1].ref, blocked: { code: 'QUOTA', provider: 'router', at: 1 } })
  let tree = router.render()
  assert.equal(textOf(walk(tree, node => node.props?.className === 'bt-fail-text')[0]), 'Router is out of balance or quota.')
  assert.deepEqual(labels(router.buttons(tree)), ['Retry'])
  const official = cell({ code: 'QUOTA', blocked: { code: 'QUOTA', status: 402, provider: 'deepseek-official', at: 1 } })
  tree = official.render()
  assert.equal(textOf(walk(tree, node => node.props?.className === 'bt-fail-text')[0]), 'DeepSeek is out of balance or quota (402).')
  const list = official.buttons(tree)
  assert.deepEqual(labels(list), ['Top up ↗', 'Retry'])
  assert.equal(list[0].node.props.href, 'https://platform.deepseek.com/top_up')
  assert.equal(list[0].node.props.target, '_blank')
  assert.deepEqual(list.map(entry => entry.primary).slice(0, 2), [true, false])
})

test('the account balance tops up on the account plugin page, when it gives one', () => {
  const linked = cell({ code: 'ACCOUNT_QUOTA', account: { status: 'credential-stored', links: { topUpUrl: 'https://platform.example/top_up', usageUrl: 'https://platform.example/usage' }, attempt: null } })
  const list = linked.buttons(linked.render())
  assert.deepEqual(labels(list), ['Top up ↗', 'Retry'])
  assert.equal(list[0].node.props.href, 'https://platform.example/top_up')
  const bare = cell({ code: 'ACCOUNT_QUOTA' })
  assert.deepEqual(labels(bare.buttons(bare.render())), ['Retry'])
})

test('an account sign-in failure asks to sign in again, or offers another model without the account plugin', () => {
  for (const code of ['ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_SIGNED_OUT', 'ACCOUNT_TOKEN_INVALID']) {
    const side = cell({ code, blocked: { code, provider: 'deepseek-account', at: 1 } })
    const tree = side.render()
    assert.equal(textOf(walk(tree, node => node.props?.className === 'bt-fail-text')[0]), 'The DeepSeek account sign-in has expired.')
    const list = side.buttons(tree)
    assert.deepEqual(labels(list), ['Sign in again'])
    list[0].node.props.onClick()
    assert.deepEqual(side.calls, [['signIn']])
    const alone = cell({ code, signIn: false, blocked: { code, at: 1 } })
    assert.deepEqual(labels(alone.buttons(alone.render())), ['Pick another model'])
  }
})

// The account route next to the failing key route, as the account plugin lists it.
const withAccount = [
  ...models,
  { ref: 'deepseek-account/deepseek-v4-flash', provider: 'deepseek-account', providerName: 'DeepSeek account', name: 'V4 Flash' },
  { ref: 'deepseek-account/deepseek-v4-pro', provider: 'deepseek-account', providerName: 'DeepSeek account', name: 'V4 Pro' },
]

test('a sign-in started from the card moves the Bot onto the account route once the account is signed in', () => {
  for (const [code, label] of [['MISSING_CREDENTIAL', 'Sign in with a DeepSeek account'], ['AUTH', 'Use a DeepSeek account instead']]) {
    const view = { status: 'signed-out', links: null }
    const side = cell({ code, blocked: { code, provider: 'deepseek-official', at: 1 }, account: view, catalog: withAccount })
    side.buttons(side.render()).find(entry => entry.label === label).node.props.onClick()
    assert.deepEqual(side.calls, [['signIn']], code)
    // Nothing moves while the sign-in is under way, or after one that did not finish.
    view.status = 'signing-in'
    side.render()
    assert.deepEqual(side.calls, [['signIn']], code)
    view.status = 'credential-stored'
    side.render()
    side.render()
    assert.deepEqual(side.calls, [['signIn'], ['updateBot', 'chief', { model: 'deepseek-account/deepseek-v4-flash' }]], code)
    // The host lifts the block with the new model; going on is all that is left.
    side.bot.model = 'deepseek-account/deepseek-v4-flash'
    side.bot.blocked = undefined
    const list = side.buttons(side.render())
    assert.deepEqual(labels(list), ['Retry'], code)
    assert.equal(list[0].primary, true, code)
  }
})

test('the Bot takes the DSH default model when it is an account model', () => {
  const view = { status: 'signed-out' }
  const side = cell({ code: 'MISSING_CREDENTIAL', blocked: { code: 'MISSING_CREDENTIAL', provider: 'deepseek-official', at: 1 }, account: view, catalog: withAccount, defaultModel: 'deepseek-account/deepseek-v4-pro' })
  side.buttons(side.render()).find(entry => entry.label === 'Sign in with a DeepSeek account').node.props.onClick()
  view.status = 'credential-stored'
  side.render()
  assert.deepEqual(side.calls.at(-1), ['updateBot', 'chief', { model: 'deepseek-account/deepseek-v4-pro' }])
  assert.equal(accountModel({ models: withAccount, defaultModel: 'router/flash' }), 'deepseek-account/deepseek-v4-flash')
  assert.equal(accountModel({ models, defaultModel: null }), undefined)
})

test('already signed in, the card moves the Bot onto the account at once', () => {
  const side = cell({ code: 'MISSING_CREDENTIAL', blocked: { code: 'MISSING_CREDENTIAL', provider: 'deepseek-official', at: 1 }, account: { status: 'credential-stored' }, catalog: withAccount })
  const list = side.buttons(side.render())
  assert.deepEqual(labels(list), ['Enter API key', 'Use the DeepSeek account', 'Pick another model'])
  list[1].node.props.onClick()
  assert.deepEqual(side.calls, [['updateBot', 'chief', { model: 'deepseek-account/deepseek-v4-flash' }]])
})

test('the account models listed a moment after the sign-in still move the Bot; none for a while, the user picks', () => {
  const view = { status: 'signed-out' }
  const side = cell({ code: 'AUTH', blocked: { code: 'AUTH', provider: 'deepseek-official', at: 1 }, account: view })
  side.actions.refreshModels = () => side.calls.push(['refreshModels'])
  side.buttons(side.render()).find(entry => entry.label === 'Use a DeepSeek account instead').node.props.onClick()
  view.status = 'credential-stored'
  side.render()
  assert.deepEqual(side.calls, [['signIn'], ['refreshModels']])
  side.roster.models = withAccount
  side.render()
  assert.deepEqual(side.calls.at(-1), ['updateBot', 'chief', { model: 'deepseek-account/deepseek-v4-flash' }])

  const slow = cell({ code: 'AUTH', blocked: { code: 'AUTH', provider: 'deepseek-official', at: 1 }, account: view })
  view.status = 'signed-out'
  slow.buttons(slow.render()).find(entry => entry.label === 'Use a DeepSeek account instead').node.props.onClick()
  view.status = 'credential-stored'
  timers.length = 0
  slow.render()
  assert.deepEqual(slow.calls, [['signIn']])
  for (const run of timers.splice(0)) run()
  assert.deepEqual(slow.calls, [['signIn'], ['showDetails', 'chief-part']])
})

test('a model the user picked during the sign-in stands, and a failed move says why', async () => {
  const view = { status: 'signed-out' }
  const side = cell({ code: 'MISSING_CREDENTIAL', blocked: { code: 'MISSING_CREDENTIAL', provider: 'deepseek-official', at: 1 }, account: view, catalog: withAccount })
  side.buttons(side.render()).find(entry => entry.label === 'Sign in with a DeepSeek account').node.props.onClick()
  side.bot.model = 'router/flash'
  view.status = 'credential-stored'
  side.render()
  assert.deepEqual(side.calls, [['signIn']])

  const failing = cell({ code: 'MISSING_CREDENTIAL', blocked: { code: 'MISSING_CREDENTIAL', provider: 'deepseek-official', at: 1 }, account: { status: 'credential-stored' }, catalog: withAccount })
  failing.actions.failUpdate = 'Model deepseek-account/deepseek-v4-flash is not available.'
  failing.buttons(failing.render()).find(entry => entry.label === 'Use the DeepSeek account').node.props.onClick()
  await tick()
  assert.match(textOf(walk(failing.render(), node => node.props?.className === 'bt-fail-error')[0]), /not available/)
})

test('a failed turn another Bot asked for offers its fixes but no Retry', () => {
  const server = cell({ code: 'SERVER', asked: true })
  const tree = server.render()
  assert.deepEqual(labels(server.buttons(tree)), [])
  assert.equal(tree.props['data-settled'], '')
  assert.equal(textOf(walk(tree, node => node.props?.className === 'bt-fail-text')[0]), 'The model service failed.')
  const key = cell({ code: 'MISSING_CREDENTIAL', asked: true })
  const list = key.buttons(key.render())
  assert.deepEqual(labels(list), ['Enter API key', 'Sign in with a DeepSeek account', 'Pick another model'])
  assert.equal(list[0].primary, true)
  // A turn of the user's own in the same chat keeps its Retry.
  const own = cell({ code: 'SERVER', asked: [2] })
  assert.deepEqual(labels(own.buttons(own.render())), ['Retry'])
})

test('connection, rate and server failures retry; other codes keep a short line, not the raw text', () => {
  const cases = [
    ['TRANSPORT', 'Could not reach the model service.'],
    ['TIMEOUT', 'Could not reach the model service.'],
    ['RATE_LIMIT', 'Too many requests. Wait a moment, then try again.'],
    ['SERVER', 'The model service failed.'],
    ['CONTEXT_WINDOW_EXCEEDED', 'The conversation is too long for the model'],
    ['SOMETHING_NEW', 'This turn failed.'],
    [undefined, 'This turn failed.'],
  ]
  for (const [code, text] of cases) {
    const side = cell({ code, message: 'socket hang up at 10.0.0.1' })
    const tree = side.render()
    assert.equal(textOf(walk(tree, node => node.props?.className === 'bt-fail-text')[0]), text, code)
    assert.deepEqual(labels(side.buttons(tree)), ['Retry'], code)
    assert.ok(side.tech(tree).includes('socket hang up at 10.0.0.1'), code)
  }
})

test('every failure code a Bot chat can show offers at least one button', () => {
  for (const code of ['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_SIGNED_OUT', 'ACCOUNT_TOKEN_INVALID', 'TRANSPORT', 'TIMEOUT', 'RATE_LIMIT', 'SERVER', 'INTERRUPTED', 'INVALID_REQUEST', 'OTHER']) {
    for (const blocked of [undefined, { code, at: 1 }]) {
      const side = cell({ code, blocked })
      assert.ok(labels(side.buttons(side.render())).length > 0, `${code} ${blocked ? 'blocked' : 'free'}`)
    }
  }
})

test('a failure a later turn or part moved past keeps its line and details, without buttons', () => {
  const later = cell({ code: 'AUTH', later: true, blocked: { code: 'AUTH', status: 401, at: 1 } })
  let tree = later.render()
  assert.equal(walk(tree, node => node.props?.className === 'bt-fail-actions').length, 0)
  assert.equal(tree.props['data-settled'], '')
  const older = cell({ code: 'SERVER', sessionId: 'chief-old', bot: { parts: ['chief-old', 'chief-part'] } })
  tree = older.render()
  assert.equal(walk(tree, node => node.props?.className === 'bt-fail-actions').length, 0)
  assert.equal(textOf(walk(tree, node => node.props?.className === 'bt-fail-text')[0]), 'The model service failed.')
  const outside = cell({ code: 'MISSING_CREDENTIAL', sessionId: 'room-1' })
  tree = outside.render()
  assert.equal(walk(tree, node => node.props?.className === 'bt-fail-actions').length, 0)
  assert.equal(textOf(walk(tree, node => node.props?.className === 'bt-fail-text')[0]), "This Bot's model has no API key yet.")
})

test('the host facts of another failure are not this one', () => {
  const side = cell({ code: 'QUOTA', blocked: { code: 'AUTH', status: 401, requestId: 'req-2', provider: 'router', at: 1 } })
  const tree = side.render()
  assert.equal(textOf(walk(tree, node => node.props?.className === 'bt-fail-text')[0]), 'DeepSeek is out of balance or quota.')
  assert.deepEqual(side.tech(tree), ['QUOTA'])
})

test('Copy puts the technical details on the clipboard in English', async () => {
  copied.length = 0
  const side = cell({ code: 'SERVER', message: 'upstream 503', blocked: undefined })
  const [copy] = walk(side.render(), node => String(node.props?.className).includes('bt-fail-copy'))
  copy.props.onClick()
  await tick()
  assert.deepEqual(copied, ['Code: SERVER\nMessage: upstream 503'])
})

test('the copy and fix tables go by code alone', () => {
  assert.equal(failureText('QUOTA', { provider: 'X', status: 429 }), 'X is out of balance or quota (429).')
  assert.equal(failureText('INVALID_CREDENTIAL', {}), 'This API key is not in the right format.')
  assert.deepEqual(Array.from(fixesFor('MISSING_CREDENTIAL', { canSignIn: false })), ['key', 'model'])
  assert.deepEqual(Array.from(fixesFor('INVALID_CREDENTIAL', {})), ['rekey', 'model'])
  assert.deepEqual(Array.from(fixesFor('QUOTA', { official: false })), [])
  assert.deepEqual(Array.from(fixesFor('AUTH', { canSignIn: true, onAccount: true })), [])
  assert.deepEqual(Array.from(fixesFor('ACCOUNT_SIGNED_OUT', { canSignIn: true, onAccount: true })), ['sign-in-again'])
  assert.equal(retryShown('AUTH', { code: 'AUTH' }), false)
  assert.equal(retryShown('AUTH', undefined), true)
  assert.equal(retryShown('QUOTA', { code: 'QUOTA' }), true)
})

// The words a Chinese interface may still show in English (design note, 用词).
const ENGLISH_ALLOWED = /\b(DeepSeek|DS Bot|Bot|API|Key|Harness|DSH|HTTP|Router|Chief)\b/gi

test('in a Chinese interface every repair card state reads in Chinese, outside Technical details', () => {
  const dicts = new Map()
  const off = installLocale({
    register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
    bind: ns => (key, params) => {
      const text = dicts.get(`${ns}:zh`)?.[key] ?? key
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    getLocale: () => ({ active: 'zh' }),
  })
  // Text shown to the user, leaving out the Technical details, which keep the raw facts.
  const shown = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(shown).join(' ')
    if (node.type === 'details') return ''
    return shown(node.props?.children)
  }
  try {
    const codes = ['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_SIGNED_OUT', 'ACCOUNT_TOKEN_INVALID', 'TRANSPORT', 'TIMEOUT', 'RATE_LIMIT', 'SERVER', 'INTERRUPTED', 'CONTEXT_WINDOW_EXCEEDED', 'OTHER']
    const account = { status: 'credential-stored', links: { topUpUrl: 'https://platform.example/top_up' }, attempt: null }
    for (const code of codes) {
      for (const blocked of [undefined, { code, status: 401, requestId: 'req-1', provider: 'deepseek-official', at: 1 }]) {
        for (const later of [false, true]) {
          const side = cell({ code, blocked, later, account, message: 'raw provider text' })
          let tree = side.render()
          const key = side.buttons(tree).find(entry => entry.label === '填入 API Key' || entry.label === '重新填 Key')
          if (key) { key.node.props.onClick(); tree = side.render() }
          const left = shown(tree).replace(ENGLISH_ALLOWED, '')
          assert.doesNotMatch(left, /[A-Za-z]{2,}/, `${code} ${blocked ? 'blocked' : 'free'} ${later ? 'settled' : 'current'}: ${shown(tree)}`)
          const [summary] = walk(tree, node => node.type === 'summary')
          if (summary) assert.equal(textOf(summary), '技术详情')
        }
      }
    }
  } finally {
    off()
  }
})

test('a provider that is not in the catalog yet keeps a readable name in the key card', () => {
  const side = cell({ code: 'MISSING_CREDENTIAL', blocked: { code: 'MISSING_CREDENTIAL', provider: 'deepseek-official', at: 1 }, catalog: [models[1]] })
  side.buttons(side.render())[0].node.props.onClick()
  const [card] = walk(side.render(), node => node.props?.model !== undefined)
  assert.equal(card.props.model.provider, 'deepseek-official')
  assert.equal(card.props.model.providerName, 'DeepSeek')
})
