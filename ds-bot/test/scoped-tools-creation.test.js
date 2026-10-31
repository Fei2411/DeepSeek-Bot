import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { TEAM_TOOLS } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

// A Bot-owned Session gets its Agent before ds-bot records the owner, so the
// scoped show_view and the hidden-tool restrict used to wait for a later
// resolveAgent that a held kickoff never ran. These tests drive each creation
// path with another plugin's global show_view already in place and check the
// Agent's own tool list before its first step.
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {
    r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {} },
  },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

let rt
const start = (team = TEAM, services = {}, globals = []) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-scoped-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext({ services })
  // Another plugin's global show_view, in place before ds-bot loads.
  ctx.tools.register({ name: 'show_view', description: 'global', execute: async () => 'global' })
  for (const tool of globals) ctx.tools.register(tool)
  // DSH refuses a second global registration of one name — the throw that killed
  // ds-bot's boot in #703 — so the fake refuses the same way.
  const plainRegister = ctx.tools.register.bind(ctx.tools)
  ctx.tools.register = (tool) => {
    if (ctx.registeredTools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`)
    return plainRegister(tool)
  }
  const scoped = []
  const restricted = []
  let sessions = 0
  const agentOf = (sessionId) => {
    const nextStep = []
    const nextTurn = []
    return {
      id: sessionId,
      session: { id: sessionId, header: { cwd: '/team' }, requestHeader: () => undefined, deriveMessages: () => [] },
      ctx: {
        tools: {
          register: (tool) => { scoped.push({ sessionId, name: tool.name, tool }); return () => {} },
          restrict: (filter) => { restricted.push({ sessionId, deny: filter.deny ?? [] }); return () => {} },
        },
        effect: execute => (typeof execute === 'function' ? execute() : undefined),
        on: () => () => {},
      },
      status: 'idle',
      followup() {},
      steer() {},
      inject() {},
      send(message, target) {
        ;(target === 'next-turn' ? nextTurn : nextStep).push(message)
      },
      cancel() {},
      async whenIdle() {},
      async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
      inbox: {
        nextStep,
        nextTurn,
        prepend(target, message) { ;(target === 'next-turn' ? nextTurn : nextStep).unshift(message) },
        append(target, message) { ;(target === 'next-turn' ? nextTurn : nextStep).push(message) },
        remove(id) {
          for (const list of [nextStep, nextTurn]) {
            const at = list.findIndex(message => message.id === id)
            if (at !== -1) { list.splice(at, 1); return true }
          }
          return false
        },
      },
    }
  }
  // ask_user_question is served, so the deny list is not empty in a Bot scope.
  ctx.tools.schemas = () => [{ name: 'ask_user_question' }, { name: 'show_view' }]
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id: 'w1', path: '/team' } : undefined),
      list: () => [{ id: 'w1', path: '/team' }],
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, data })
    }
  }
  const agentCreated = async (sessionId) => {
    for (const listener of ctx.listeners.get('agent/created') ?? []) await listener({ agent: agentOf(sessionId) })
  }
  const tool = (name, args, sessionId, exec = {}) =>
    rt.teamTools.find(d => d.name === name).execute(args, { agent: agentOf(sessionId), name, callId: 'c1', ...exec })
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, call, tool, emit, agentCreated, agentOf, scoped, restricted, stop }
}

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const hasShowView = (host, id) => host.scoped.some(entry => entry.sessionId === id && entry.name === 'show_view')
const denied = (host, id) => host.restricted.some(entry => entry.sessionId === id && entry.deny.includes('ask_user_question'))
const scopedNames = (host, id) => host.scoped.filter(entry => entry.sessionId === id).map(entry => entry.name)

test('a Bot Session gets every team tool in its own scope', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  assert.deepEqual(scopedNames(host, 'a').sort(), [...TEAM_TOOLS].filter(name => name !== 'read_browser').sort())
})

test('a Session ds-bot does not own sees none of the team tools', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('plain1')
  assert.deepEqual(scopedNames(host, 'plain1'), [])
  // Nothing of the team's reaches the global layer a plain session reads; the
  // only team-named global is another plugin's show_view.
  const leaked = [...host.ctx.registeredTools.keys()].filter(name => TEAM_TOOLS.includes(name))
  assert.deepEqual(leaked, ['show_view'])
  assert.equal(host.ctx.registeredTools.get('show_view').description, 'global')
})

test("a group's own Session is scoped to group_relay alone", async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('r1')
  assert.deepEqual(scopedNames(host, 'r1'), ['group_relay'])
})

test("another plugin's global recall cannot stop ds-bot or shadow its own", async (t) => {
  // #703: a same-named global tool from another plugin must not fail apply(),
  // and inside a Bot Session ds-bot's recall still wins.
  const host = start(TEAM, {}, [{ name: 'recall', description: 'foreign recall', execute: async () => 'foreign' }])
  t.after(host.stop)
  assert.equal(host.ctx.registeredTools.get('recall').description, 'foreign recall')
  await host.call('state', {})
  await host.agentCreated('a')
  const recall = host.scoped.find(entry => entry.sessionId === 'a' && entry.name === 'recall')
  assert.match(String(recall?.tool?.description), /^Search your memory/)
})

test('a Bot made without a model has the scoped tools before its first step', async (t) => {
  const host = start({ ...TEAM, rooms: {} })
  t.after(host.stop)
  const created = await host.call('create-bot', { name: 'Solo' })
  assert.equal(created.ok, true)
  const id = created.value.id
  assert.ok(hasShowView(host, id), 'the Bot scope has ds-bot\'s show_view over the global one')
  assert.ok(denied(host, id), 'the blocking question tool is denied')
})

test('a group Session made for a member has the scoped tools before its first step', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  const stop = new AbortController()
  t.after(() => stop.abort())
  // The user's post starts a round; Writer has no group Session yet, so the round
  // makes one — which used to keep whatever tools a global registration left.
  host.emit('r1', 'user/message', { content: [{ type: 'text', text: 'launch moved' }], source: { kind: 'user' } })
  void host.tool('group_relay', {}, 'r1', { callId: 'r1', signal: stop.signal }).catch(() => {})
  await until(() => hasShowView(host, 's1'), 5000)
  assert.ok(denied(host, 's1'), 'the blocking question tool is denied in the group scope')
})

test('a fresh part Session has the scoped tools before its first step', async (t) => {
  const project = mkdtempSync(join(tmpdir(), 'ds-bot-scoped-proj-'))
  const host = start({ ...TEAM, rooms: {} }, {
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    approval: { request: async () => 'allowed-once' },
  })
  t.after(async () => {
    await host.stop()
    rmSync(project, { recursive: true, force: true, maxRetries: 5 })
  })
  await host.call('state', {})
  host.agentOf('b').status = 'running'
  const moved = await host.tool('update_bot', { work_dir: project }, 'b')
  assert.equal(String(moved).includes('From your next step on'), true)
  // The next step sees the folder change and switches to a fresh part.
  const preStep = host.ctx.listeners.get('agent/pre-step').at(-1)
  const answer = await preStep(
    { agent: host.agentOf('b'), messages: [{ role: 'user', content: [{ type: 'text', text: 'go on' }], source: { kind: 'user' } }], step: 2, signal: AbortSignal.timeout(60_000) },
    async () => 'next',
  )
  assert.deepEqual(answer, { kind: 'reject' })
  await until(() => hasShowView(host, 's1'), 5000)
  assert.ok(denied(host, 's1'), 'the blocking question tool is denied in the fresh part')
})

test('a Session ds-bot does not own keeps only the global show_view', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('plain1')
  assert.ok(!hasShowView(host, 'plain1'), 'no scoped show_view shadows the global one')
  assert.ok(!host.restricted.some(entry => entry.sessionId === 'plain1'), 'no restrict applies outside the team')
})
