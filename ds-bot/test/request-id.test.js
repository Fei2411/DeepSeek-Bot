import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { install as installRequests } from '../src/host/requests.js'

test('old identities survive age and receipt volume without permitting another delivery', async () => {
  const rt = { state: {}, own: (object, key) => Object.hasOwn(object, key) ? object[key] : undefined, readOnly: () => undefined, save: async () => {}, warn() {} }
  installRequests(rt)
  const original = rt.requestIdentity({ caller: 'a', context: 'chat', name: 'original', payload: { message: 'do it' } })
  await rt.admitRequest(original, async () => 'first receipt')
  rt.state.requests[original.key].at = 0
  for (let i = 0; i < 2001; i += 1) rt.state.requests[`other-${i}`] = { at: i, outcome: 'delivered', fingerprint: 'x', receipt: 'kept' }
  const fresh = rt.requestIdentity({ caller: 'a', context: 'chat', name: 'fresh', payload: { message: 'next' } })
  await rt.admitRequest(fresh, async () => 'next receipt')
  const result = await rt.admitRequest(original, async () => { throw new Error('duplicate delivery') })
  assert.deepEqual(result, { status: 'replay', receipt: 'first receipt' })
})

// A two-Bot team, optionally with b in a group Session 'gb' of room 'Ops'.
function team({ group = false } = {}) {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: group ? { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb' } } } : {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    works: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
}

// The plugin in a home of its own, with a stand-in DSH around it. The seed is written the
// first time; a later boot keeps the state the first run saved.
async function boot(home, seed) {
  if (seed !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined },
        id: sessionId,
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel(cause) { calls.push(['cancel', cause]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep: [],
          nextTurn: [],
          remove(id) {
            for (const list of [this.nextStep, this.nextTurn]) {
              const at = list.findIndex(message => message.id === id)
              if (at !== -1) return list.splice(at, 1).length === 1
            }
            return false
          },
        },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const stop = async () => { await ctx.dispose() }
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await tool('list_bots', {}, 'a')
  return { ctx, rt, agents, agentOf, emit, tool, stop }
}

const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-request-'))
const cleanup = home => rmSync(home, { recursive: true, force: true, maxRetries: 5 })

test('a request with an id is delivered once, and a repeat gives the first receipt back', async (t) => {
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const first = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.equal(first, 'Delivered to Writer. Its reply will arrive later as a new message; do not wait for it.')
  assert.equal(agents.get('b').calls.length, 1)

  const again = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.equal(again, first)
  assert.equal(agents.get('b').calls.length, 1)
})

test('the same request id with other content is refused, and nothing goes out', async (t) => {
  const seed = team()
  seed.bots.c = { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 }
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, seed)
  t.after(async () => { await stop(); cleanup(home) })

  await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'do another thing', request_id: 'r-1' }, 'a'), /request_id "r-1" was already used for a different request/)
  assert.equal(agents.get('b').calls.length, 1)
  // Another target under the same name is another request, and is refused as well.
  await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-2' }, 'c')
  await assert.rejects(tool('message_bot', { to: 'Chief', message: 'do the thing', request_id: 'r-2' }, 'c'), /request_id "r-2" was already used for a different request/)
  assert.equal(agents.get('a')?.calls.length ?? 0, 0)
})

test('two callers with the same request id do not collide', async (t) => {
  const seed = team()
  seed.bots.c = { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 }
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, seed)
  t.after(async () => { await stop(); cleanup(home) })

  await tool('message_bot', { to: 'Writer', message: 'from Chief', request_id: 'r-1' }, 'a')
  await tool('message_bot', { to: 'Writer', message: 'from Tester', request_id: 'r-1' }, 'c')
  assert.equal(agents.get('b').calls.length, 2)
})

test('two calls at once with the same request id admit it once', async (t) => {
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const [first, second] = await Promise.all([
    tool('message_bot', { to: 'Writer', message: 'same request', request_id: 'r-1' }, 'a'),
    tool('message_bot', { to: 'Writer', message: 'same request', request_id: 'r-1' }, 'a'),
  ])
  assert.equal(first, second)
  assert.equal(agents.get('b').calls.length, 1)
})

test('a repeat after a restart gives the receipt back and sends nothing', async (t) => {
  const home = tempHome()
  const first = await boot(home, team())
  const receipt = await first.tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  await first.stop()

  const again = await boot(home)
  t.after(async () => { await again.stop(); cleanup(home) })
  const out = await again.tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.equal(out, receipt)
  assert.equal(again.agentOf('b').calls.length, 0)
})

test('a repeat after the recipient read the message does not send it again', async (t) => {
  const home = tempHome()
  const { agents, emit, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const first = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  const delivered = agents.get('b').calls[0][1]
  emit('b', 'user/message', { content: delivered.content, source: delivered.source })
  const again = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.equal(again, first)
  assert.equal(agents.get('b').calls.length, 1)
})

test('a request whose delivery failed is not sent again', async (t) => {
  const home = tempHome()
  const { agentOf, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const writer = agentOf('b')
  const steer = writer.steer
  writer.steer = () => { throw new Error('dsh is down') }
  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a'), /dsh is down/)
  writer.steer = steer
  // The outcome of that admission is not known, so it is not sent again.
  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a'), /outcome of request_id "r-1" is not known/)
  assert.equal(writer.calls.length, 0)
})

test('a request with an id takes in the message before it, and a repeat merges nothing', async (t) => {
  const home = tempHome()
  const { agentOf, emit, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const writer = agentOf('b')
  writer.steer = (message) => { writer.calls.push(['steer', message]); writer.inbox.nextStep.push(message) }
  emit('b', 'turn/start', { turn: 1 })

  const first = await tool('message_bot', { to: 'Writer', message: 'task 1', request_id: 'r-1' }, 'a')
  const second = await tool('message_bot', { to: 'Writer', message: 'task 2', request_id: 'r-2' }, 'a')
  assert.match(second, /had not read your earlier message yet/)
  assert.equal(writer.inbox.nextStep.length, 1)

  const again = await tool('message_bot', { to: 'Writer', message: 'task 1', request_id: 'r-1' }, 'a')
  assert.equal(again, first)
  assert.equal(writer.inbox.nextStep.length, 1)
  assert.equal(writer.inbox.nextStep[0].source.exchangeId, writer.calls[0][1].source.exchangeId)
})

test('a request with an id that queues, or that answers the user, goes out once', async (t) => {
  const home = tempHome()
  const { agents, emit, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  // Writer is working, so a request that waits for its current work is queued.
  emit('b', 'turn/start', { turn: 1 })
  const queued = await tool('message_bot', { to: 'Writer', message: 'later', when: 'queue', request_id: 'r-1' }, 'a')
  assert.match(queued, /^Queued for Writer/)
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup'])
  assert.equal(await tool('message_bot', { to: 'Writer', message: 'later', when: 'queue', request_id: 'r-1' }, 'a'), queued)

  const toUser = await tool('message_bot', { to: 'Writer', message: 'tell them', reply_to: 'user', request_id: 'r-2' }, 'a')
  assert.match(toUser, /It will answer the user in its own chat/)
  assert.equal(await tool('message_bot', { to: 'Writer', message: 'tell them', reply_to: 'user', request_id: 'r-2' }, 'a'), toUser)
  assert.equal(agents.get('b').calls.length, 2)
})

test('a request with an id in a group calls the member once', async (t) => {
  const seed = team({ group: true })
  seed.rooms.r1.sessions.a = 'ga'
  const home = tempHome()
  const { rt, tool, stop } = await boot(home, seed)
  t.after(async () => { await stop(); cleanup(home) })

  let posts = 0
  rt.roomStepText = async () => { posts += 1 }
  const first = await tool('message_bot', { to: 'Writer', message: 'do it', request_id: 'r-1' }, 'ga')
  assert.match(first, /^Called Writer in "Ops"/)
  assert.equal(posts, 1)
  assert.equal(await tool('message_bot', { to: 'Writer', message: 'do it', request_id: 'r-1' }, 'ga'), first)
  assert.equal(posts, 1)
})

test('a request that was in the air when DS Bot stopped is not sent again', async (t) => {
  const home = tempHome()
  const first = await boot(home, team())
  // The delivery hangs, as it would when DS Bot stops in the middle of it.
  first.ctx.sessions.flush = async () => new Promise(() => {})
  const inFlight = first.tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  inFlight.catch(() => {})
  for (let count = 0; count < 200 && Object.keys(first.rt.state.requests).length === 0; count += 1) await delay(10)
  assert.equal(Object.keys(first.rt.state.requests).length, 1)
  assert.equal(Object.values(first.rt.state.requests)[0].outcome, 'pending')
  await first.stop()

  const again = await boot(home)
  t.after(async () => { await again.stop(); cleanup(home) })
  // The outcome of that admission is not known, so it is not sent again.
  await assert.rejects(again.tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a'), /outcome of request_id "r-1" is not known/)
  assert.equal(again.agentOf('b').calls.length, 0)
})

test('a name whose receipt is no longer kept is not used again', async (t) => {
  const home = tempHome()
  const { rt, agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  // The receipt falls out of what is kept; the name itself stays taken.
  for (const record of Object.values(rt.state.requests)) record.receipt = undefined
  const out = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.match(out, /Nothing was sent again: request_id "r-1" was admitted before/)
  assert.equal(agents.get('b').calls.length, 1)
})

test('a request whose receipt cannot be saved is not sent', async (t) => {
  const home = tempHome()
  const { rt, agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  const save = rt.save
  rt.save = async () => { throw new Error('the disk is full') }
  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a'), /the disk is full/)
  assert.equal(agents.get('b')?.calls.length ?? 0, 0)
  // Nothing went out, so the name is free again.
  rt.save = save
  const out = await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  assert.match(out, /^Delivered to Writer/)
  assert.equal(agents.get('b').calls.length, 1)
})

test('calls without a request id are sent as they were', async (t) => {
  const home = tempHome()
  const { agents, tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  await tool('message_bot', { to: 'Writer', message: 'one' }, 'a')
  await tool('message_bot', { to: 'Writer', message: 'two' }, 'a')
  assert.equal(agents.get('b').calls.length, 2)
})

test('the receipt of a request is kept in the team file', async (t) => {
  const home = tempHome()
  const { tool, stop } = await boot(home, team())
  t.after(async () => { await stop(); cleanup(home) })

  await tool('message_bot', { to: 'Writer', message: 'do the thing', request_id: 'r-1' }, 'a')
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const receipts = Object.values(saved.requests)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].outcome, 'delivered')
  assert.match(receipts[0].receipt, /^Delivered to Writer/)
})
