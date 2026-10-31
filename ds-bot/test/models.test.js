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

test('a Bot model selection is a durable Session event; the profile default is never written', async () => {
  const writes = []
  const appended = new Map()
  const agentOf = (sessionId) => {
    if (!appended.has(sessionId)) {
      const events = []
      appended.set(sessionId, { session: { id: sessionId, append: (type, data) => events.push({ type, data }) }, ctx: { on() {} }, events })
    }
    return appended.get(sessionId)
  }
  const ctx = {
    llm: { listProviders: () => [], listModels: async () => [] },
    get: name => (name === 'agentDefaultModel' ? {
      currentSelection: () => ({ provider: 'ollama', model: 'kimi-k3' }),
      saveSelection: async next => writes.push(`${next.provider}/${next.model}`),
    } : undefined),
    sessionController: {
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => { throw new Error('selectModel must not be called') },
    },
  }
  const rt = { ctx, state: { bots: {} }, warn() {} }
  install(rt)
  await Promise.all([
    rt.selectSessionModel('s1', { provider: 'deepseek', model: 'deepseek-v4-pro' }),
    rt.selectSessionModel('s2', { provider: 'deepseek', model: 'deepseek-v4.1-flash' }),
    rt.selectSessionModel('s3', { provider: 'ollama', model: 'kimi-k3' }),
  ])
  assert.deepEqual(writes, [])
  assert.deepEqual(appended.get('s1').events, [{ type: 'model/selection', data: { provider: 'deepseek', model: 'deepseek-v4-pro' } }])
  assert.deepEqual(appended.get('s2').events, [{ type: 'model/selection', data: { provider: 'deepseek', model: 'deepseek-v4.1-flash' } }])
})

test('a Bot with no model yet changes nothing until the user picks one', async () => {
  const rt = runtime({ provider: 'ollama', model: 'kimi-k3' })
  assert.equal(await rt.desiredModel({ appliedModel: 'deepseek/deepseek-v4-pro' }), undefined)
  assert.equal(await rt.desiredModel({}), undefined)
  await rt.catalog()
  assert.equal(rt.cachedDefault(), 'ollama/kimi-k3')
})

// A runtime with two providers, a DSH default, and per-Session agents that log
// appended events and register request hooks like a live Agent. `selectModel`
// throws: a Bot selection must never reach it — it would save the profile default.
function bench({ providers = { deepseek: ['v4-flash'], stepfun: ['step-5'] }, fallback = { provider: 'stepfun', model: 'step-5' }, reasoning = {} } = {}) {
  const current = { ...fallback }
  const selected = []
  const saved = []
  const listeners = new Map()
  const agents = new Map()
  const projections = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const hooks = []
      agents.set(sessionId, {
        session: {
          id: sessionId,
          append: (type, data) => {
            if (type !== 'model/selection') return
            selected.push(`${sessionId}:${data.provider}/${data.model}${data.reasoningEffort === undefined ? '' : `:${data.reasoningEffort}`}`)
            projections.set(sessionId, { lastUsed: null, pending: { ...data } })
          },
        },
        ctx: { on: (name, listener) => hooks.push(listener) },
        hooks,
      })
    }
    return agents.get(sessionId)
  }
  const ctx = {
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    get: name => (name === 'agentDefaultModel'
      ? { currentSelection: () => ({ ...current }), saveSelection: async (next) => { saved.push(next); Object.assign(current, next) } }
      : name === 'sessionProjections' ? { stateOf: session => projections.get(session.id) } : undefined),
    llm: {
      listProviders: () => Object.keys(providers).map(id => ({ id, name: id.toUpperCase() })),
      listModels: async id => providers[id].map(model => ({ id: model, name: model, inputModalities: ['text'] })),
      resolveModelInfo: async (provider, model) => reasoning[`${provider}/${model}`] ?? {},
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => { throw new Error('the profile default must not be written for a Bot selection') },
    },
  }
  const rt = { ctx, state: { bots: {} }, chatOf: id => id, groupSessionsOf: () => [], save: async () => {}, warn: () => {} }
  install(rt)
  return { rt, selected, saved, providers, listeners, agentOf, projections, current: () => current }
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

test('a Bot on the default model with its own thinking level leaves the default level as it was', async () => {
  const fallback = { provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'high' }
  const { rt, selected, saved, current } = bench({ fallback, reasoning: { 'deepseek/v4-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } } } })
  await rt.applyModel({ id: 'b1', model: 'deepseek/v4-flash', effort: 'low' })
  assert.deepEqual(selected, ['b1:deepseek/v4-flash:low'])
  assert.deepEqual(saved, [])
  assert.deepEqual(current(), fallback)
})

test('a Session\'s projected selection routes its live Agent\'s requests', async () => {
  const { rt, agentOf, projections } = bench()
  await rt.selectSessionModel('s1', { provider: 'stepfun', model: 'step-5' })
  const agent = agentOf('s1')
  assert.equal(agent.hooks.length, 1)
  // The pending selection replaces the route, and clears an inherited level.
  const request = agent.hooks[0]
  const resolved = { provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'low', temperature: 0.2 }
  assert.deepEqual(await request({ agent }, async () => resolved), { provider: 'stepfun', model: 'step-5', temperature: 0.2 })
  // Once a request used it, the last route holds until another selection lands.
  projections.set('s1', { lastUsed: { provider: 'stepfun', model: 'step-5' }, pending: null })
  assert.deepEqual(await request({ agent }, async () => resolved), { provider: 'stepfun', model: 'step-5', temperature: 0.2 })
  // A Session without a selection keeps the route the machine would use.
  projections.set('s1', { lastUsed: null, pending: null })
  assert.deepEqual(await request({ agent }, async () => resolved), resolved)
})

test('a Bot whose model is not served falls back to the default, never to another Bot\'s model', async () => {
  // #385: another Bot's model once landed in a Session — the only path was the
  // profile default polluted by that Bot's own selection. It is never written now.
  const { rt, selected, saved } = bench({ fallback: {} })
  await rt.applyModel({ id: 'b2', model: 'stepfun/step-5' })
  assert.deepEqual(saved, [])
  await rt.applyModel({ id: 'b1', model: 'gone/model' })
  assert.deepEqual(selected, ['b2:stepfun/step-5', 'b1:deepseek/v4-flash'])
})
