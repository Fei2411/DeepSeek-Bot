import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as realDelay } from 'node:timers/promises'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { stripWrittenCalls, writesToolCall } from '../src/host/turns.js'

// Chief in its own chat 'a'; Writer, the admin of group 'r1', speaks there from 'gb'.
const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'gb' }, log: [], seq: 0, seen: {} } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

// One DS Bot host on `home`; a second start on the same home is a restart.
// Hosts by home: a home is removed only after its hosts stopped and their writes landed.
const started = new Map()

// The durable logs DSH keeps, by Session: what a Session's turns did and said.
// `inspect` stands in for DSH reading that log, when a test cannot read it.
async function start(home, logs, inspect) {
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const inbox = { nextStep: [], nextTurn: [], remove: () => false }
      const keep = (message) => { calls.push(message) }
      agents.set(sessionId, { session: { id: sessionId }, calls, inbox, followup: keep, steer: keep, cancel() {} })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      inspect: inspect ?? (async sessionId => ({ events: logs?.get(sessionId) ?? [] })),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId }, ...exec })
  const askApproval = sessionId => ctx.listeners.get('approval/request')[0]({ agent: { session: { id: sessionId } }, toolName: 'pwsh', reason: 'escalate sandbox' }, () => 'from-dsh')
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  await tool('list_bots', {}, 'a')
  const host = { ctx, agentOf, emit, tool, call, askApproval, stop: () => ctx.dispose() }
  started.set(home, [...(started.get(home) ?? []), host])
  return host
}

const freshHome = (t, state = seed()) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-follow-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  t.after(async () => {
    await Promise.all((started.get(home) ?? []).map(host => host.stop()))
    started.delete(home)
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return home
}
const stateOf = home => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
// The team file is written in the background, and Windows may hold it busy for a
// moment: the retry waits on the clock, which the tests mock.
const settleState = async (t, home, check) => {
  const deadline = performance.now() + 3000
  while (!check() && performance.now() < deadline) {
    t.mock.timers.tick(100)
    await realDelay(10)
  }
  assert.ok(check(), 'condition not reached')
}
const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const text = message => message.content.map(block => block.text ?? '').join('\n')
const notes = (home) => {
  try { return JSON.parse(readFileSync(join(home, 'inflight.json'), 'utf8')) } catch { return { turns: {}, queued: {} } }
}
const inflight = home => notes(home).turns ?? {}
// A message as DSH would replay it: the turn starts and takes it up.
const run = (host, sessionId, turn, message) => {
  host.emit(sessionId, 'turn/start', { turn })
  host.emit(sessionId, 'user/message', { content: message.content, source: message.source })
}

// Starts a round in 'r1' and opens Writer's turn in 'gb'.
async function openRoomTurn(t, host) {
  let result
  const stop = new AbortController()
  t.after(() => stop.abort())
  void host.tool('group_relay', {}, 'r1', { callId: 'c1', signal: stop.signal }).then((value) => { result = JSON.parse(value) })
  await settle(() => host.agentOf('gb').calls.length === 1)
  run(host, 'gb', 1, host.agentOf('gb').calls[0])
  return () => result
}

test('a group turn cut off by a restart is picked up once, and the group is told', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  await openRoomTurn(t, first)
  void first.askApproval('gb')
  await settle(() => inflight(home).gb?.approval !== undefined)
  assert.deepEqual([inflight(home).gb.botId, inflight(home).gb.roomId, inflight(home).gb.trigger.role], ['b', 'r1', 'room'])
  await first.stop()

  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('gb').calls.length === 1)
  const post = second.agentOf('r1').calls[0]
  assert.deepEqual([post.source.role, post.source.resumed, post.source.quiet, post.source.senderSessionId], ['post', true, true, 'b'])
  const resumed = second.agentOf('gb').calls[0]
  assert.deepEqual([resumed.source.role, resumed.source.resumed, resumed.source.roomId], ['room', true, 'r1'])
  assert.match(text(resumed), /^\[Group chat "Ops" · picking up after a restart\]/)
  assert.match(text(resumed), /approval to run pwsh \(escalate sandbox\)/)
  await settle(() => Object.keys(inflight(home)).length === 0)

  // The group shows the event, and the admin reads it on its next turn.
  second.emit('r1', 'user/message', { content: post.content, source: post.source })
  const relay = JSON.parse(await second.tool('group_relay', {}, 'r1', { callId: 'c2', signal: new AbortController().signal }))
  assert.deepEqual(relay.replies.map(reply => [reply.kind, reply.name]), [['resumed', 'Writer']])
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(state.rooms.r1.log.at(-1).kind, 'resumed')

  // Cut off again while picking it up: the group hears it, and the turn stays stopped.
  run(second, 'gb', 2, resumed)
  await settle(() => inflight(home).gb?.resumed === true)
  await second.stop()
  const third = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => third.agentOf('r1').calls.length === 1)
  assert.equal(third.agentOf('r1').calls[0].source.again, true)
  assert.equal(third.agentOf('gb').calls.length, 0)
})

test('a request cut off by a restart goes on under the same exchange; own-chat work resumes in the chat', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'b', 1, { content: [{ type: 'text', text: '[Message from Chief]\nDraft the plan' }], source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'x1', senderName: 'Chief', senderSessionId: 'a', hop: 0 } })
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  await settle(() => inflight(home).b?.trigger !== undefined && inflight(home).a !== undefined)
  await first.stop()

  const second = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('b').calls.length === 1 && second.agentOf('a').calls.length === 1)
  const request = second.agentOf('b').calls[0]
  assert.deepEqual([request.source.role, request.source.exchangeId, request.source.senderSessionId, request.source.resumed], ['request', 'x1', 'a', true])
  assert.match(text(request), /^\[Message from Chief · DeepSeek Harness restarted while you were working on it\]/)
  const own = second.agentOf('a').calls[0]
  assert.deepEqual([own.source.role, own.source.resumed], ['resume', true])
  assert.match(text(own), /^\[DeepSeek Harness restarted while you were working\]/)
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(state.exchanges.length, 0)
})

test('when only DS Bot restarts, a turn still running or finished meanwhile is not picked up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'b', 1, { content: [{ type: 'text', text: '[Message from Chief]\nDraft the plan' }], source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'x1', senderName: 'Chief', senderSessionId: 'a', hop: 0 } })
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  await settle(() => inflight(home).b?.trigger !== undefined && inflight(home).a !== undefined)
  await first.stop()

  // DSH went on: Writer is still at work, and Chief's turn ends before the pick-up.
  const second = await start(home)
  second.agentOf('b').status = 'running'
  second.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(3000)
  // One read per check: two reads can see the old notes and the cleared ones.
  await settle(() => {
    const noted = inflight(home)
    return noted.b?.trigger?.exchangeId === 'x1' && noted.a === undefined
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([second.agentOf('a').calls.length, second.agentOf('b').calls.length], [0, 0])

  // Writer's turn stays noted, so a real restart still picks it up.
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  await second.stop()
  const third = await start(home)
  t.mock.timers.tick(3000)
  await settle(() => third.agentOf('b').calls.length === 1)
  assert.deepEqual([third.agentOf('b').calls[0].source.exchangeId, third.agentOf('a').calls.length], ['x1', 0])
})

// Chief asks Writer for the plan; Writer's turn takes it up and the work waits.
const askWriter = async (host, home) => {
  await host.tool('message_bot', { to: 'Writer', message: 'Draft the plan' }, 'a')
  const request = host.agentOf('b').calls[0]
  run(host, 'b', 1, request)
  await settle(() => inflight(home).b?.trigger?.exchangeId === request.source.exchangeId)
  return request
}

// The durable log of Writer's Session: the turn that took the request up, and what it said.
const writerLog = (request, said, reason = { kind: 'completed' }) => [
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, data: { source: request.source, content: request.content } },
  ...(said === undefined ? [] : [{ type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'text', text: said }] } } }]),
  { type: 'turn/end', seq: 4, data: { turn: 1, reason } },
]

test('an answer a turn produced while DS Bot was not watching goes to the Bot that waits for it, once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const request = await askWriter(first, home)
  const exchangeId = request.source.exchangeId
  // Writer answers, and DS Bot restarts before it sees the end of that turn.
  logs.set('b', writerLog(request, 'The plan is ready.'))
  await first.stop()

  const second = await start(home, logs)
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('a').calls.length === 1)
  const reply = second.agentOf('a').calls[0]
  assert.deepEqual([reply.source.role, reply.source.replyTo], ['reply', exchangeId])
  assert.match(text(reply), /The plan is ready\./)
  // The work is settled, and the request is not run again.
  await settleState(t, home, () => stateOf(home).works?.[exchangeId] === undefined)
  assert.equal(second.agentOf('b').calls.length, 0)

  // Chief reads the answer; another restart finds nothing left to settle.
  second.emit('a', 'user/message', { content: reply.content, source: reply.source })
  await settleState(t, home, () => Object.keys(notes(home).queued ?? {}).length === 0)
  await second.stop()
  const third = await start(home, logs)
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([third.agentOf('a').calls.length, third.agentOf('b').calls.length], [0, 0])
})

test('a turn whose record cannot be read says the result is unknown, and is not run again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const request = await askWriter(first, home)
  const exchangeId = request.source.exchangeId
  logs.set('b', writerLog(request, 'The plan is ready.'))
  await first.stop()

  // DSH cannot read that Session's record: whether the turn answered cannot be
  // established, so the sender is told that, and the work is not run again.
  const unreadable = async () => { throw new Error('session not found') }
  const second = await start(home, logs, unreadable)
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('a').calls.length === 1)
  const reply = second.agentOf('a').calls[0]
  assert.deepEqual([reply.source.role, reply.source.replyTo], ['reply', exchangeId])
  assert.match(text(reply), /what it did is unknown/)
  // The work is settled, and the request is not run again.
  await settleState(t, home, () => stateOf(home).works?.[exchangeId] === undefined)
  assert.equal(second.agentOf('b').calls.length, 0)

  // Another restart finds nothing left to settle: nothing is said or run twice.
  second.emit('a', 'user/message', { content: reply.content, source: reply.source })
  await settleState(t, home, () => Object.keys(notes(home).queued ?? {}).length === 0)
  await second.stop()
  const third = await start(home, logs)
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([third.agentOf('a').calls.length, third.agentOf('b').calls.length], [0, 0])
})

test('a turn that ended without saying anything says it finished', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const request = await askWriter(first, home)
  const exchangeId = request.source.exchangeId
  logs.set('b', writerLog(request, undefined))
  await first.stop()

  const second = await start(home, logs)
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('a').calls.length === 1)
  const reply = second.agentOf('a').calls[0]
  assert.deepEqual([reply.source.role, reply.source.replyTo], ['reply', exchangeId])
  assert.match(text(reply), /Writer finished without a reply\./)
  // The work is settled, and the request is not run again.
  await settleState(t, home, () => stateOf(home).works?.[exchangeId] === undefined)
  assert.equal(second.agentOf('b').calls.length, 0)
})

test('a turn that ended on the token limit gives what it said', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const request = await askWriter(first, home)
  const exchangeId = request.source.exchangeId
  logs.set('b', writerLog(request, 'The plan is ready, up to the limit.', { kind: 'max-tokens' }))
  await first.stop()

  const second = await start(home, logs)
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('a').calls.length === 1)
  const reply = second.agentOf('a').calls[0]
  assert.deepEqual([reply.source.role, reply.source.replyTo], ['reply', exchangeId])
  assert.match(text(reply), /The plan is ready, up to the limit\./)
  // The work is settled, and the request is not run again.
  await settleState(t, home, () => stateOf(home).works?.[exchangeId] === undefined)
  assert.equal(second.agentOf('b').calls.length, 0)
})

test('the answer that goes up keeps what came back for the work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = seed()
  // Writer handed the plan on; what came back for it is kept with the work.
  state.works = { x1: { from: 'a', to: 'b', open: [], results: [{ id: 'y1', name: 'Reviewer', text: 'The numbers check out.' }], at: 1 } }
  const home = freshHome(t, state)
  const logs = new Map()
  const first = await start(home, logs)
  const request = { content: [{ type: 'text', text: '[Message from Chief]\nDraft the plan' }], source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'x1', senderName: 'Chief', senderSessionId: 'a', hop: 0 } }
  run(first, 'b', 1, request)
  await settle(() => inflight(home).b?.trigger?.exchangeId === 'x1')
  logs.set('b', writerLog(request, 'The plan is ready.'))
  await first.stop()

  const second = await start(home, logs)
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('a').calls.length === 1)
  const reply = text(second.agentOf('a').calls[0])
  assert.match(reply, /The plan is ready\./)
  assert.match(reply, /Reviewer:\nThe numbers check out\./)
  // The work is settled, and the request is not run again.
  await settleState(t, home, () => stateOf(home).works?.x1 === undefined)
  assert.equal(second.agentOf('b').calls.length, 0)
})

test('an answer that already went up is not sent again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const logs = new Map()
  const first = await start(home, logs)
  const request = await askWriter(first, home)
  const exchangeId = request.source.exchangeId
  logs.set('b', writerLog(request, 'The plan is ready.'))
  // Chief already has the answer: another run delivered it.
  logs.set('a', [{ type: 'user/message', seq: 1, data: { source: { kind: 'bot', role: 'reply', replyTo: exchangeId, senderSessionId: 'b' }, content: [{ type: 'text', text: '[Reply from Writer]\nThe plan is ready.' }] } }])
  await first.stop()

  const second = await start(home, logs)
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(3000)
  await settleState(t, home, () => stateOf(home).works?.[exchangeId] === undefined)
  assert.deepEqual([second.agentOf('a').calls.length, second.agentOf('b').calls.length], [0, 0])
})

test('a work that still waits for what it handed on holds its text, and is not settled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = seed()
  state.works = { x1: { from: 'a', to: 'b', open: ['y1'], results: [], at: 1 } }
  const home = freshHome(t, state)
  const logs = new Map()
  const first = await start(home, logs)
  const request = { content: [{ type: 'text', text: '[Message from Chief]\nDraft the plan' }], source: { kind: 'bot', form: 'relay', role: 'request', exchangeId: 'x1', senderName: 'Chief', senderSessionId: 'a', hop: 0 } }
  run(first, 'b', 1, request)
  await settle(() => inflight(home).b?.trigger?.exchangeId === 'x1')
  logs.set('b', writerLog(request, 'The plan is ready.'))
  await first.stop()

  const second = await start(home, logs)
  second.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  // The work waits for what Writer handed on: nothing is sent, and it stays open.
  assert.deepEqual([second.agentOf('a').calls.length, second.agentOf('b').calls.length], [0, 0])
  // What the turn said is held for it, until what it handed on comes back.
  await settleState(t, home, () => stateOf(home).works.x1.held !== undefined)
  assert.equal(stateOf(home).works.x1.held, 'The plan is ready.')
  assert.deepEqual(stateOf(home).works.x1.open, ['y1'])
})

test('a finished turn leaves nothing to pick up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = freshHome(t)
  const first = await start(home)
  run(first, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  first.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => Object.keys(inflight(home)).length === 0 && existsSync(join(home, 'inflight.json')))
  await first.stop()
  const second = await start(home)
  t.mock.timers.tick(3000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(second.agentOf('a').calls.length, 0)
})

test('a turn DSH stops as it shuts down stays noted; one the user stops does not', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  run(host, 'a', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  run(host, 'b', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await settle(() => inflight(home).a !== undefined && inflight(home).b === undefined)
})

test('a message a shutdown cancelled is sent again once; one still waiting, taken up or withdrawn is not', async (t) => {
  const home = freshHome(t)
  const first = await start(home)
  const send = message => first.tool('message_bot', { to: 'Writer', message, when: 'queue' }, 'a')
  await send('Draft the plan')
  await send('Check the numbers')
  await send('Read the notes')
  await send('Never mind')
  const [plan, numbers, notesMessage, withdrawn] = first.agentOf('b').calls
  // Taken up by a turn, or withdrawn while DS Bot runs (the user stopped the Bot).
  first.emit('b', 'user/message', { content: notesMessage.content, source: notesMessage.source })
  for (const listener of first.ctx.listeners.get('agent/inbox/discarded')) listener({ message: withdrawn })
  await settle(() => (notes(home).queued.b ?? []).length === 2)
  await first.stop()

  t.mock.timers.enable({ apis: ['setTimeout'] })
  const second = await start(home)
  // A hard stop keeps the inbox: that message runs when the Session wakes.
  second.agentOf('b').inbox.nextTurn.push(numbers)
  t.mock.timers.tick(3000)
  await settle(() => second.agentOf('b').calls.length === 1)
  const [again] = second.agentOf('b').calls
  assert.deepEqual([again.source.exchangeId, again.source.role, text(again)], [plan.source.exchangeId, 'request', text(plan)])
  // The resend is the same exchange, not a new one.
  assert.equal((await second.call('exchange', { a: 'a', b: 'b' })).value.length, 4)
})

const WRITTEN = 'Checking now.\n<tool_call>\n<function=pwsh>\n<parameter=command>\nGet-ChildItem E:\\\n</parameter>\n</function>\n</tool_call>'

test('a tool call written as text gets one more turn on the same round slot', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  const result = await openRoomTurn(t, host)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: WRITTEN }] } })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('gb').calls.length === 2)
  const retry = host.agentOf('gb').calls[1]
  assert.deepEqual([retry.source.role, retry.source.retried, retry.source.exchangeId], ['room', true, host.agentOf('gb').calls[0].source.exchangeId])
  assert.match(text(retry), /^\[Group chat "Ops" · your tool call did not run\]/)
  assert.equal(result(), undefined)

  // Written again: the text goes on without the call.
  run(host, 'gb', 2, retry)
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: WRITTEN }] } })
  host.emit('gb', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => reply.text), ['Checking now.'])
  assert.equal(host.agentOf('gb').calls.length, 2)
})

test('in its own chat, a Bot that wrote a tool call as text is asked to make it', async (t) => {
  const home = freshHome(t)
  const host = await start(home)
  run(host, 'b', 1, { content: [{ type: 'text', text: 'move the docs' }], source: { kind: 'user' } })
  // A call made for real, with or without text around it, is no retry.
  host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'On it.' }, { type: 'tool-call', id: 'k1', name: 'pwsh', arguments: '{}' }] } })
  host.emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: WRITTEN }] } })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('b').calls.length === 1)
  const retry = host.agentOf('b').calls[0]
  assert.deepEqual([retry.source.role, retry.source.retried], ['retry', true])
  assert.match(text(retry), /^\[Your last reply wrote a tool call as text, so nothing ran\]/)
})

test('a written tool call is told apart from text about one', () => {
  assert.equal(writesToolCall(WRITTEN), true)
  assert.equal(writesToolCall('<function=read>\n<parameter=path>a.md</parameter></function>'), true)
  assert.equal(writesToolCall('Models such as Step write `<tool_call>` tags in their template.'), false)
  assert.equal(writesToolCall(undefined), false)
  assert.equal(stripWrittenCalls(WRITTEN), 'Checking now.')
})
