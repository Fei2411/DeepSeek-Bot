import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/models.js'

const PROVIDERS = {
  deepseek: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }, { id: 'deepseek-v4-pro' }],
  ollama: [{ id: 'kimi-k3' }, { id: 'deepseek-v4-pro' }],
}

function runtime(defaultSelection) {
  const ctx = {
    llm: {
      listProviders: () => Object.keys(PROVIDERS).map(id => ({ id })),
      listModels: async id => PROVIDERS[id],
    },
    get: name => (name === 'agentDefaultModel' && defaultSelection ? { currentSelection: () => defaultSelection } : undefined),
  }
  const rt = { ctx, state: { bots: {} } }
  install(rt)
  return rt
}

test('the default model is the DSH default when served, else the first served model', async () => {
  assert.equal(await runtime({ provider: 'ollama', model: 'kimi-k3' }).defaultModel(), 'ollama/kimi-k3')
  assert.equal(await runtime({ provider: 'gone', model: 'x' }).defaultModel(), 'deepseek/deepseek-v4.1-flash')
  assert.equal(await runtime(undefined).defaultModel(), 'deepseek/deepseek-v4.1-flash')
})

// DSH serves the models of a provider whose key is not set; every turn on them fails.
function withoutKeys(defaultSelection, providers) {
  const rt = runtime(defaultSelection)
  rt.missingKeys = async () => new Set(providers)
  return rt
}

test('a model that needs a key is never a default or a fallback, though a Bot keeps its own', async () => {
  const rt = withoutKeys({ provider: 'deepseek', model: 'deepseek-v4-pro' }, ['deepseek'])
  assert.equal(await rt.defaultModel(), 'ollama/kimi-k3')
  assert.equal(rt.cachedDefault(), 'ollama/kimi-k3')
  assert.equal(rt.isUsable('ollama/kimi-k3'), true)
  assert.equal(rt.isUsable('deepseek/deepseek-v4-pro'), false)
  assert.equal(rt.isUsable(undefined), false)
  assert.equal(await rt.desiredModel({ model: 'deepseek/deepseek-v4-pro' }), 'deepseek/deepseek-v4-pro')
  assert.equal(await rt.desiredModel({ model: 'gone/model', appliedModel: 'deepseek/deepseek-v4-pro' }), 'ollama/kimi-k3')
  assert.equal(await rt.desiredModel({ model: 'gone/model', appliedModel: 'ollama/deepseek-v4-pro' }), 'ollama/deepseek-v4-pro')
})

test('with every model needing a key, nothing is picked', async () => {
  const rt = withoutKeys({ provider: 'ollama', model: 'kimi-k3' }, ['deepseek', 'ollama'])
  assert.equal(await rt.defaultModel(), undefined)
  assert.equal(rt.cachedDefault(), undefined)
  assert.equal(await rt.desiredModel({ model: 'gone/model', appliedModel: 'ollama/kimi-k3' }), undefined)
})

test('a model is named by its ref, or by an id or name only one provider serves', async () => {
  const rt = runtime(undefined)
  assert.equal(await rt.resolveModel('ollama/kimi-k3'), 'ollama/kimi-k3')
  assert.equal(await rt.resolveModel(' Kimi-K3 '), 'ollama/kimi-k3')
  assert.equal(await rt.resolveModel('DeepSeek V4.1 Flash'), 'deepseek/deepseek-v4.1-flash')
  await assert.rejects(rt.resolveModel('deepseek-v4-pro'), /more than one provider.*deepseek\/deepseek-v4-pro, ollama\/deepseek-v4-pro/)
  await assert.rejects(rt.resolveModel('kimi'), /not available\. Available models: deepseek\/deepseek-v4\.1-flash/)
})

test('a Bot runs on its own model, else the one it last ran on, else the default', async () => {
  const rt = runtime({ provider: 'ollama', model: 'kimi-k3' })
  assert.equal(await rt.desiredModel({ model: 'deepseek/deepseek-v4-pro', appliedModel: 'ollama/kimi-k3' }), 'deepseek/deepseek-v4-pro')
  assert.equal(await rt.desiredModel({ model: 'gone/model', appliedModel: 'deepseek/deepseek-v4-pro' }), 'deepseek/deepseek-v4-pro')
  assert.equal(await rt.desiredModel({ model: 'gone/model' }), 'ollama/kimi-k3')
})

test('choosing a Bot model leaves the user\'s DSH default model as it was', async () => {
  const writes = []
  let current = { provider: 'ollama', model: 'kimi-k3' }
  const defaults = {
    currentSelection: () => ({ ...current }),
    saveSelection: async (next) => { writes.push(`${next.provider}/${next.model}`); current = { ...next } },
  }
  const ctx = {
    llm: { listProviders: () => [], listModels: async () => [] },
    get: name => (name === 'agentDefaultModel' ? defaults : undefined),
    // Like DSH: the selection is also saved as the default, in the background.
    sessionController: { selectModel: async ({ provider, model }) => { void defaults.saveSelection({ provider, model }) } },
  }
  const rt = { ctx, state: { bots: {} }, warn() {} }
  install(rt)
  await Promise.all([
    rt.selectSessionModel('s1', { provider: 'deepseek', model: 'deepseek-v4-pro' }),
    rt.selectSessionModel('s2', { provider: 'deepseek', model: 'deepseek-v4.1-flash' }),
    rt.selectSessionModel('s3', { provider: 'ollama', model: 'kimi-k3' }),
  ])
  assert.deepEqual(current, { provider: 'ollama', model: 'kimi-k3' })
  assert.deepEqual(writes, ['deepseek/deepseek-v4-pro', 'ollama/kimi-k3', 'deepseek/deepseek-v4.1-flash', 'ollama/kimi-k3', 'ollama/kimi-k3'])
})

test('a Bot with no model yet changes nothing until the user picks one', async () => {
  const rt = runtime({ provider: 'ollama', model: 'kimi-k3' })
  assert.equal(await rt.desiredModel({ appliedModel: 'deepseek/deepseek-v4-pro' }), undefined)
  assert.equal(await rt.desiredModel({}), undefined)
  await rt.catalog()
  assert.equal(rt.cachedDefault(), 'ollama/kimi-k3')
})

// A runtime with two providers, a DSH default, and a session controller that, like
// DSH, saves every Session selection as the default.
function bench({ providers = { deepseek: ['v4-flash'], stepfun: ['step-5'] }, fallback = { provider: 'stepfun', model: 'step-5' }, reasoning = {}, services = {} } = {}) {
  let current = { ...fallback }
  const selected = []
  const saved = []
  const listeners = new Map()
  const ctx = {
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    get: name => (name === 'agentDefaultModel'
      ? { currentSelection: () => ({ ...current }), saveSelection: async (next) => { saved.push(next); current = { ...next } } }
      : services[name]),
    llm: {
      listProviders: () => Object.keys(providers).map(id => ({ id, name: id.toUpperCase() })),
      listModels: async id => providers[id].map(model => ({ id: model, name: model, inputModalities: ['text'] })),
      resolveModelInfo: async (provider, model) => reasoning[`${provider}/${model}`] ?? {},
    },
    sessionController: {
      selectModel: async ({ sessionId, provider, model, reasoningEffort }) => {
        selected.push(`${sessionId}:${provider}/${model}${reasoningEffort === undefined ? '' : `:${reasoningEffort}`}`)
        current = { provider, model }
      },
    },
  }
  const rt = { ctx, state: { bots: {} }, chatOf: id => id, groupSessionsOf: () => [], save: async () => {}, warn: () => {} }
  install(rt)
  return { rt, selected, saved, providers, listeners, current: () => current }
}

test('the catalog is every model DSH serves, with no lab', async () => {
  const { rt } = bench()
  assert.deepEqual((await rt.catalog()).map(entry => [entry.ref, entry.providerName, 'lab' in entry]), [
    ['deepseek/v4-flash', 'DEEPSEEK', false],
    ['stepfun/step-5', 'STEPFUN', false],
  ])
})

test('a fresh catalog sees a model list changed in DSH settings at once', async () => {
  const { rt, providers } = bench()
  await rt.catalog()
  providers.deepseek = ['deepseek-flash', 'deepseek-v4-pro']
  assert.ok((await rt.catalog()).some(entry => entry.ref === 'deepseek/v4-flash'))
  assert.deepEqual((await rt.catalog({ fresh: true })).filter(entry => entry.provider === 'deepseek').map(entry => entry.id), ['deepseek-flash', 'deepseek-v4-pro'])
})

test('applying a Bot model leaves the DSH default as the user set it', async () => {
  const { rt, selected, current } = bench()
  const bot = { id: 'b1', model: 'deepseek/v4-flash' }
  assert.equal(await rt.applyModel(bot), 'deepseek/v4-flash')
  assert.deepEqual(selected, ['b1:deepseek/v4-flash'])
  assert.deepEqual(current(), { provider: 'stepfun', model: 'step-5' })
  assert.equal(bot.appliedModel, 'deepseek/v4-flash')
})

test('a Bot model applies its thinking level, and only re-selects on a change', async () => {
  const { rt, selected } = bench({ reasoning: { 'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } } } })
  const bot = { id: 'b1', model: 'deepseek/v4-flash', effort: 'low' }
  await rt.applyModel(bot)
  assert.deepEqual(selected, ['b1:deepseek/v4-flash:low'])
  assert.equal(bot.appliedEffort, 'low')
  await rt.applyModel(bot)
  assert.equal(selected.length, 1)

  // A level the model does not serve is never sent: the model's default applies.
  bot.effort = 'max'
  await rt.applyModel(bot)
  assert.deepEqual(selected.at(-1), 'b1:deepseek/v4-flash')
  assert.equal(bot.appliedEffort, undefined)
})

test('resolveEffort takes an id or a name, and refuses what the model has not', async () => {
  const { rt } = bench({ reasoning: {
    'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] } },
    'stepfun/step-5': {},
  } })
  assert.equal(await rt.resolveEffort('deepseek/v4-flash', 'high'), 'high')
  assert.equal(await rt.resolveEffort('deepseek/v4-flash', ' Off '), 'off')
  assert.equal(await rt.resolveEffort('deepseek/v4-flash', ''), undefined)
  await assert.rejects(rt.resolveEffort('stepfun/step-5', 'high'), /no thinking levels/)
  await assert.rejects(rt.resolveEffort('deepseek/v4-flash', 'max'), /not available for deepseek\/v4-flash\. Available: Off, High/)
})

test('the catalog attaches thinking levels to models a Bot uses', async () => {
  const { rt } = bench({ reasoning: { 'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } } } })
  rt.state.bots.b1 = { id: 'b1', model: 'deepseek/v4-flash' }
  const entries = await rt.catalog()
  assert.deepEqual(entries.find(entry => entry.ref === 'deepseek/v4-flash')?.reasoning, { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' })
  assert.equal(entries.find(entry => entry.ref === 'stepfun/step-5')?.reasoning, undefined)
})

test('a greeting waits for the provider of its Bot model to register', async () => {
  const { rt, providers, listeners } = bench({ providers: {} })
  const waiting = rt.waitForModel({ model: 'stepfun/step-5' }, 5000)
  setTimeout(() => {
    providers.stepfun = ['step-5']
    listeners.get('llm/adapters-updated')?.()
  }, 20)
  assert.equal(await waiting, 'stepfun/step-5')
  assert.equal(await rt.waitForModel({}, 5000), undefined)
})

test('a key set or a sign-in lifts what blocked a Bot; a key removed, a sign-out, a provider or a settings change only re-reads', async () => {
  const keys = new Set(['DEEPSEEK_API_KEY'])
  const records = new Set(['deepseek-account-platform/default'])
  const credentials = {
    describe: async ref => ({ configured: keys.has(ref), writable: true }),
    describeRecord: async key => ({ configured: records.has(key), writable: true }),
  }
  const { rt, listeners, providers } = bench({ services: { credentials } })
  const lifted = []
  // Each listing also passes the providers listed with their key (the next test).
  rt.unblockBots = fix => { if (fix.keyed === undefined) lifted.push(fix) }
  await rt.catalog()
  providers.deepseek = ['v4-pro']
  await listeners.get('credentials/reference-updated')('DEEPSEEK_API_KEY')
  assert.ok((await rt.catalog()).some(entry => entry.ref === 'deepseek/v4-pro'))
  await listeners.get('credentials/reference-updated')('STEPFUN_API_KEY')
  // Another plugin's record, such as an OAuth token refresh, is no sign-in.
  await listeners.get('credentials/record-updated')('llm-pi-ai/github-copilot')
  providers.deepseek = ['v4-flash']
  await listeners.get('credentials/record-updated')('deepseek-account-platform/default')
  assert.ok((await rt.catalog()).some(entry => entry.ref === 'deepseek/v4-flash'))
  // The provider refused the token and its record went.
  records.clear()
  await listeners.get('credentials/record-updated')('deepseek-account-platform/default')
  listeners.get('llm/adapters-updated')()
  listeners.get('settings/document-updated')()
  assert.deepEqual(lifted, [{ ref: 'DEEPSEEK_API_KEY' }, { signedIn: true }])
})

test('every listing passes the providers listed with their key, so a key that came without an event still lifts', async () => {
  const { rt, providers } = bench()
  providers.stepfun = ['step-5']
  rt.missingKeys = async () => new Set(['stepfun'])
  const passed = []
  rt.unblockBots = fix => passed.push([...fix.keyed].sort())
  await rt.catalog({ fresh: true })
  rt.missingKeys = async () => new Set()
  await rt.catalog({ fresh: true })
  assert.equal(passed.length, 2)
  assert.equal(passed[0].includes('stepfun'), false)
  assert.equal(passed[1].includes('stepfun'), true)
})

test('a credential DSH cannot describe counts as there, so its fix still lifts', async () => {
  const { rt, listeners } = bench({ services: { credentials: { describe: async () => { throw new Error('locked') } } } })
  const lifted = []
  rt.unblockBots = fix => { if (fix.keyed === undefined) lifted.push(fix) }
  await listeners.get('credentials/reference-updated')('DEEPSEEK_API_KEY')
  await listeners.get('credentials/record-updated')('deepseek-account-platform/default')
  assert.deepEqual(lifted, [{ ref: 'DEEPSEEK_API_KEY' }, { signedIn: true }])
})

test('a Bot on the default model with its own thinking level leaves the default level as it was', async () => {
  const fallback = { provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'high' }
  const { rt, current } = bench({ fallback, reasoning: { 'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } } } })
  rt.ctx.sessionController.selectModel = async ({ provider, model, reasoningEffort }) => {
    const selected = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
    await rt.ctx.get('agentDefaultModel').saveSelection(selected)
    return { selected }
  }
  await rt.applyModel({ id: 'b1', model: 'deepseek/v4-flash', effort: 'low' })
  assert.deepEqual(current(), fallback)
})
