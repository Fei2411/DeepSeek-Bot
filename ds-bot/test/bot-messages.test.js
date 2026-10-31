import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'
import { install as installTurns } from '../src/host/turns.js'
import { install as installParts } from '../src/host/parts.js'
import { SOURCE_KIND } from '../src/host/constants.js'

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
    questions: {},
    prefs: {},
    revision: 0,
  }
}

// Services for a full apply(): resolveAgent returns a per-Session agent that
// records followup/steer/inject/cancel calls.
async function start(seed) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-messages-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
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
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  let seq = 0
  const emit = (id, type, data, extra) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data, ...extra })
    }
  }
  // Runs every registered waterfall listener; `next` settles the chain.
  const fire = (name, payload) => Promise.all((ctx.listeners.get(name) ?? []).map(listener => listener(payload, () => Promise.resolve(undefined))))
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const exchanges = async () => (await call('exchange', { a: 'a', b: 'b' })).value ?? []
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await tool('list_bots', {}, 'a')
  return { ctx, agents, agentOf, emit, fire, tool, call, exchanges, home, stop }
}

const textOf = content => content.map(block => block.text ?? '').join('\n')

test('message_bot steers by default; on an idle Bot it opens the next turn', async (t) => {
  const { agents, emit, tool, stop } = await start(team())
  t.after(stop)

  // Idle: the message goes to the Bot's own chat and starts its next turn.
  const idle = await tool('message_bot', { to: 'Writer', message: 'how are you' }, 'a')
  assert.equal(idle, 'Delivered to Writer. Its reply will arrive later as a new message; do not wait for it.')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['steer'])
  assert.match(textOf(agents.get('b').calls[0][1].content), /^\[Message from Chief\]/)
  assert.equal(agents.get('b').calls[0][1].source.role, 'request')

  // Running: the message cuts into that turn instead of queuing.
  emit('b', 'turn/start', { turn: 1 })
  const busy = await tool('message_bot', { to: 'Writer', message: 'watch out' }, 'a')
  assert.equal(busy, 'Delivered to Writer while it is working: it reads your message at its next step and answers once that work is done. Its reply will arrive later as a new message; do not wait for it. Writer now: working in its own chat for less than a minute, for the user; not read yet: 1 from Chief.')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['steer', 'steer'])
})

test('message_bot when "queue" waits for the current work, and reply_to "user" always queues', async (t) => {
  const { agents, emit, tool, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  const queued = await tool('message_bot', { to: 'Writer', message: 'later', when: 'queue' }, 'a')
  assert.equal(queued, 'Queued for Writer: it reads your message after its current work. Its reply will arrive later as a new message; do not wait for it. Writer now: working in its own chat for less than a minute, for the user.')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup'])

  const toUser = await tool('message_bot', { to: 'Writer', message: 'tell them', reply_to: 'user', when: 'now' }, 'a')
  assert.equal(toUser, 'Delivered to Writer. It will answer the user in its own chat; nothing comes back to you, so point the user to Writer\'s chat instead of relaying. Writer now: working in its own chat for less than a minute, for the user; not read yet: 1 from Chief.')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['followup', 'followup'])
  assert.equal(agents.get('b').calls[1][1].source.audience, 'user')
})

test('a Bot busy in a group gets the message in its own chat, and the sender is told', async (t) => {
  const seed = team({ group: true })
  seed.rooms.r1.sessions.a = 'ga'
  const { agents, emit, tool, stop } = await start(seed)
  t.after(stop)

  emit('gb', 'turn/start', { turn: 1 })
  const out = await tool('message_bot', { to: 'Writer', message: 'status?' }, 'a')
  assert.equal(out, 'Delivered to Writer. Its reply will arrive later as a new message; do not wait for it. Writer now: working in group "Ops" for less than a minute. Your message does not reach its work in group "Ops". If it must not go on there, use stop_bot.')
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['steer'])
  assert.equal(agents.get('gb'), undefined)

  // A non-Main sender gets no stop_bot hint.
  emit('ga', 'turn/start', { turn: 1 })
  const back = await tool('message_bot', { to: 'Chief', message: 'done' }, 'b')
  assert.equal(back, 'Delivered to Chief. Its reply will arrive later as a new message; do not wait for it. Chief now: working in group "Ops" for less than a minute. Your message does not reach its work in group "Ops".')
})

test('a request steered into a running turn is recorded once and answered in a turn of its own', async (t) => {
  const { agents, emit, tool, exchanges, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  await tool('message_bot', { to: 'Writer', message: 'which year is the data?' }, 'a')
  const steered = agents.get('b').calls[0][1]
  emit('b', 'user/message', { content: steered.content, source: steered.source })
  emit('b', 'assistant/message', assistantText('the letter, for the user'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  for (let count = 0; count < 200 && agents.get('b').calls.length < 2; count += 1) await delay(5)

  // Nothing from the user's turn goes to Chief; the request comes back to Writer.
  assert.equal(agents.get('a')?.calls.length ?? 0, 0)
  const [kind, again] = agents.get('b').calls[1]
  assert.equal(kind, 'followup')
  assert.equal(textOf(again.content), '[Message from Chief · you read it during your last task; answer it now]\nwhich year is the data?')
  assert.equal(again.source.deferred, true)
  assert.equal(again.source.exchangeId, steered.source.exchangeId)
  assert.deepEqual((await exchanges()).map(entry => entry.role), ['request'])

  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: again.content, source: again.source })
  emit('b', 'assistant/message', assistantText('2025'))
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  for (let count = 0; count < 200 && (agents.get('a')?.calls ?? []).length < 1; count += 1) await delay(5)
  const reply = agents.get('a').calls[0][1]
  assert.equal(textOf(reply.content), '[Reply from Writer]\n2025')
  assert.equal(reply.source.replyTo, steered.source.exchangeId)
  assert.deepEqual((await exchanges()).map(entry => entry.role), ['request', 'reply'])
})

// Issue #580: a queued message the user steers into the running turn restarts
// the activity row's clock from when it landed, not from the turn's start.
test('a user message steered into the running steps marks when it landed', async (t) => {
  const { emit, call, stop } = await start(team())
  t.after(stop)
  const steered = async () => (await call('state', {})).value.work.steered ?? {}
  const userMessage = id => ({ id, role: 'user', content: textBlock('还没好吗'), source: { kind: 'user' } })
  const spliced = (target, inserted, time, extra = {}) => emit('b', 'agent/inbox/spliced', { target, start: 0, inserted, ...extra }, { time })

  emit('b', 'turn/start', { turn: 1 })
  // Queued for the next turn first; only moving it into the running steps steers.
  spliced('next-turn', [userMessage('m1')], 2000)
  assert.deepEqual(await steered(), {})
  spliced('next-turn', [], 3000, { removedCount: 1, outcome: 'canceled' })
  spliced('next-step', [userMessage('m1')], 3001)
  assert.equal((await steered()).b, 3001)
  // A Bot's request spliced into the same place is not the user's input.
  spliced('next-step', [{ ...userMessage('m2'), source: replySource('request') }], 4000)
  assert.equal((await steered()).b, 3001)
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(await steered(), {})

  // A turn a part switch cut short may see turn/start without a turn/end.
  emit('b', 'turn/start', { turn: 2 })
  spliced('next-step', [userMessage('m3')], 5000)
  emit('b', 'turn/start', { turn: 3 })
  assert.deepEqual(await steered(), {})
})

test('a request from a name with brackets keeps its body when replayed after the current work', async (t) => {
  const seed = team()
  seed.bots.a.name = 'R]2'
  const { agents, emit, tool, stop } = await start(seed)
  t.after(stop)
  const body = 'Check [notes](https://example.test)\n[Keep this line]'
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  await tool('message_bot', { to: 'Writer', message: body }, 'a')
  const steered = agents.get('b').calls[0][1]
  assert.equal(steered.source.senderName, 'R]2')
  emit('b', 'user/message', { content: steered.content, source: steered.source })
  emit('b', 'assistant/message', assistantText('the letter'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settled(() => agents.get('b').calls.length === 2)
  const [kind, again] = agents.get('b').calls[1]
  assert.equal(kind, 'followup')
  assert.equal(again.source.exchangeId, steered.source.exchangeId)
  assert.equal(textOf(again.content), `[Message from R]2 · you read it during your last task; answer it now]\n${body}`)
})

test('a message its recipient has not read yet takes in the next one, however many come', async (t) => {
  const { ctx, agentOf, emit, tool, exchanges, stop } = await start(team())
  t.after(stop)
  // Writer's turn waits on something and never reaches its next step.
  const writer = agentOf('b')
  writer.steer = (message) => { writer.calls.push(['steer', message]); writer.inbox.nextStep.push(message) }
  emit('b', 'turn/start', { turn: 1 })

  await tool('message_bot', { to: 'Writer', message: 'task 1' }, 'a')
  const second = await tool('message_bot', { to: 'Writer', message: 'task 2', when: 'queue' }, 'a')
  assert.match(second, /Writer had not read your earlier message yet, so this one was added to it, and it answers both at once\. Writer now: working in its own chat for less than a minute, for the user; not read yet: 1 from Chief\.$/)
  for (let index = 3; index <= 12; index += 1) await tool('message_bot', { to: 'Writer', message: `task ${index}` }, 'a')
  // One message, still steered, under the first one's exchange.
  assert.equal(writer.inbox.nextStep.length, 1)
  const [waiting] = writer.inbox.nextStep
  assert.equal(textOf(waiting.content), `[Message from Chief]\n${Array.from({ length: 12 }, (_, index) => `task ${index + 1}`).join('\n\n')}`)
  assert.equal(waiting.source.exchangeId, writer.calls[0][1].source.exchangeId)
  assert.deepEqual((await exchanges()).map(entry => entry.text.split('\n\n').length), [12])
  assert.match(await tool('list_bots', {}, 'a'), /- Writer \(Write\)\n {2}now: working in its own chat for less than a minute, for the user; not read yet: 1 from Chief\n/)

  // Once a step takes it up, the next message is a new one.
  emit('b', 'user/message', { content: waiting.content, source: waiting.source })
  writer.inbox.nextStep.length = 0
  assert.match(await tool('message_bot', { to: 'Writer', message: 'task 13' }, 'a'), /^Delivered to Writer while it is working[^]*Writer now: working in its own chat for less than a minute, for Chief\.$/)
  assert.equal((await exchanges()).length, 2)

  // An approval the Bot waits for shows in what the sender is told.
  for (const listener of ctx.listeners.get('approval/request')) void listener({ agent: { session: { id: 'b' } }, toolName: 'bash', reason: 'rm' }, () => new Promise(() => {}))
  assert.match(await tool('message_bot', { to: 'Writer', message: 'task 14' }, 'a'), /Writer now: waiting for the user's approval to run bash in its own chat \(for less than a minute\); not read yet: 1 from Chief\.$/)
})

test('requests from two Bots, or for different work, stay apart', async (t) => {
  const seed = team()
  seed.bots.c = { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 }
  const { agentOf, emit, tool, stop } = await start(seed)
  t.after(stop)
  const writer = agentOf('b')
  writer.steer = (message) => { writer.calls.push(['steer', message]); writer.inbox.nextStep.push(message) }
  emit('b', 'turn/start', { turn: 1 })

  await tool('message_bot', { to: 'Writer', message: 'from Chief' }, 'a')
  assert.doesNotMatch(await tool('message_bot', { to: 'Writer', message: 'from Tester' }, 'c'), /added to it/)
  // Tester, now working on what Chief asked it for, writes for that work.
  await tool('message_bot', { to: 'Tester', message: 'check it' }, 'a')
  const ask = agentOf('c').calls.at(-1)[1]
  emit('c', 'turn/start', { turn: 1 })
  emit('c', 'user/message', { content: ask.content, source: ask.source })
  assert.doesNotMatch(await tool('message_bot', { to: 'Writer', message: 'for that check' }, 'c'), /added to it/)
  assert.equal(writer.inbox.nextStep.length, 3)
})

test('a non-Main Bot can steer a message to a Main Bot', async (t) => {
  const { agents, tool, stop } = await start(team())
  t.after(stop)

  const out = await tool('message_bot', { to: 'Chief', message: 'heads up' }, 'b')
  assert.equal(out, 'Delivered to Chief. Its reply will arrive later as a new message; do not wait for it.')
  assert.deepEqual(agents.get('a').calls.map(([kind]) => kind), ['steer'])
  assert.equal(agents.get('a').calls[0][1].source.senderSessionId, 'b')
})

test('stop_bot cancels the running turns and tells the Bot why in a new turn', async (t) => {
  const { agents, emit, tool, stop } = await start(team({ group: true }))
  t.after(stop)

  await assert.rejects(tool('stop_bot', { bot: 'Writer' }, 'a'), /not running/)
  assert.deepEqual(agents.get('b')?.calls ?? [], [])

  emit('b', 'turn/start', { turn: 1 })
  emit('gb', 'turn/start', { turn: 1 })
  const out = await tool('stop_bot', { bot: 'Writer', reason: 'that command deletes data' }, 'a')
  assert.match(out, /Stopped Writer in its own chat and group "Ops"/)
  assert.deepEqual(agents.get('b').calls.map(([kind]) => kind), ['cancel', 'followup'])
  assert.deepEqual(agents.get('b').calls[0][1], { kind: 'hook', reason: 'ds-bot/stopped' })
  assert.deepEqual(agents.get('gb').calls.map(([kind]) => kind), ['cancel'])
  const notice = agents.get('b').calls[1][1]
  assert.match(textOf(notice.content), /^\[Stopped by Chief\]\nthat command deletes data$/)
  assert.equal(notice.source.role, 'stopped')
})

test('stop_bot belongs to a Main Bot', async (t) => {
  const { tool, stop } = await start(team())
  t.after(stop)

  await assert.rejects(tool('stop_bot', { bot: 'Writer' }, 'b'), { message: 'Only a Main Bot can stop other Bots.' })
  await assert.rejects(tool('stop_bot', { bot: 'Chief' }, 'a'), { message: 'You cannot stop yourself.' })
  await assert.rejects(tool('stop_bot', { bot: 'Writer' }, 'a'), { message: 'Writer is not running right now, so there is nothing to stop. Use message_bot to reach it.' })
})

function turnsHost() {
  let listener
  const delivered = []
  const rt = {
    ctx: { on: (name, fn) => { if (name === 'session/event') listener = fn } },
    state: { exchangeTurns: {}, questions: {} },
    bots: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Writer' } },
    isBotSession: () => true,
    roomOf: () => undefined,
    groupOwners: new Map(),
    chatOwners: new Map(),
    botOf: id => rt.bots[id],
    selfOf: id => id,
    save: async () => {},
    deliver: async (args) => { delivered.push(args) },
    noteFailure() {},
    warn() {},
    switchJobs: () => [],
    userWrote() {},
  }
  installTurns(rt)
  let seq = 0
  const emit = (id, type, data) => listener({ id }, { type, seq: ++seq, data })
  return { rt, emit, delivered }
}

const replySource = (role, extra = {}) => ({ kind: SOURCE_KIND, role, senderSessionId: 'a', senderName: 'Chief', exchangeId: 'x1', ...extra })
const textBlock = (content) => [{ type: 'text', text: content }]
const assistantText = text => ({ message: { content: textBlock(text) } })

test('a stopped notice routes the acknowledgement back like a request', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Stopped by Chief]\nwhy'), source: replySource('stopped', { exchangeId: 's1' }) })
  assert.deepEqual(rt.state.exchangeTurns.b, [1])
  emit('b', 'assistant/message', assistantText('understood'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].toId, 'a')
  assert.equal(delivered[0].role, 'reply')
  assert.equal(delivered[0].replyTo, 's1')
  assert.equal(delivered[0].text, 'understood')
})

// What the turn hands back for a joined request: the request itself, to answer next.
const deferredOf = job => [job.fromId, job.toId, job.sessionId, job.role, job.exchangeId, job.deferred, job.text]

test('a request that joins a user-started turn is handed back, not answered with the turn\'s text', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('first half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmake it shorter'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('second half'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(delivered.map(deferredOf), [['a', 'b', 'b', 'request', 'e1', true, 'make it shorter']])
  assert.deepEqual(rt.state.exchangeTurns, {})

  // The handed-back request opens a hidden turn whose text is the reply.
  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief · you read it during your last task; answer it now]\nmake it shorter'), source: replySource('request', { exchangeId: 'e1', deferred: true }) })
  emit('b', 'assistant/message', assistantText('done, it is shorter'))
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.deepEqual(delivered.slice(1).map(job => [job.toId, job.role, job.replyTo, job.text]), [['a', 'reply', 'e1', 'done, it is shorter']])
  assert.deepEqual(rt.state.exchangeTurns, { b: [2] })
})

test('a request that joins a Bot-triggered turn is handed back; the trigger gets the whole turn', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0' }) })
  emit('b', 'assistant/message', assistantText('first half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('second half'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(rt.state.exchangeTurns.b, [1])
  assert.deepEqual(delivered.map(job => [job.role, job.replyTo ?? job.exchangeId, job.text]), [['reply', 'e0', 'first half\n\nsecond half'], ['request', 'e1', 'more']])
})

test('a joined request in a stopped turn tells its sender, and is not handed back', () => {
  const { emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('first half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('second half'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'ds-bot/stopped' } } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].toId, 'a')
  assert.equal(delivered[0].replyTo, 'e1')
  assert.match(delivered[0].text, /was stopped before it could answer/)
})

test('a joined request gets the failure notice when the model call fails', () => {
  const { emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('first half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'SERVER', message: 'upstream busy', status: 503 } } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].replyTo, 'e1')
  assert.match(delivered[0].text, /^Writer could not answer your message: its model call failed \(SERVER 503: upstream busy\)/)
})

test('a joined request never claims the next turn', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('answer'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: textBlock('next task'), source: { kind: 'user' } })
  emit('b', 'assistant/message', assistantText('for the user'))
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.deepEqual(delivered.map(job => [job.role, job.exchangeId, job.deferred]), [['request', 'e1', true]])
  assert.deepEqual(rt.state.exchangeTurns, {})
})

test('a schedule-started turn stays visible when a request joins', () => {
  const { rt, emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('routine'), source: { kind: 'schedule' } })
  emit('b', 'assistant/message', assistantText('before'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  emit('b', 'assistant/message', assistantText('after'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(delivered.map(job => [job.role, job.exchangeId, job.text]), [['request', 'e1', 'more']])
  assert.deepEqual(rt.state.exchangeTurns, {})
})

test('a duplicate exchangeId joins no second reply', () => {
  const { emit, delivered } = turnsHost()
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0' }) })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0' }) })
  emit('b', 'assistant/message', assistantText('answer'))
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].replyTo, 'e0')
})

test('a joined request crosses a part switch and is handed back in the new part', async (t) => {
  const { agents, agentOf, emit, fire, stop } = await start(team())
  t.after(stop)

  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\ntask'), source: replySource('request', { exchangeId: 'e0' }) })
  emit('b', 'assistant/message', assistantText('half'))
  emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource('request', { exchangeId: 'e1' }) })
  // The model call hits the window: the turn stops and the part moves on.
  await fire('agent/request-error', { failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: AbortSignal.timeout(60_000), agent: agentOf('b') })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED' } } })
  // Neither the trigger nor the joined request answers from the old part.
  for (let count = 0; count < 200 && agents.get('s1')?.calls.find(([, message]) => message.source?.handoff === true) === undefined; count += 1) await delay(5)
  const handoff = agents.get('s1').calls.find(([, message]) => message.source?.handoff === true)[1]
  assert.equal((agents.get('a')?.calls ?? []).filter(([, message]) => message.source?.role === 'reply').length, 0)
  assert.equal(handoff.source.exchangeId, 'e0')
  assert.deepEqual(handoff.source.joined.map(item => [item.info.exchangeId, item.text]), [['e1', 'more']])

  // The resumed turn answers its trigger and hands the joined request back there.
  emit('s1', 'turn/start', { turn: 1 })
  emit('s1', 'user/message', { content: textBlock('[Handoff]\npackage'), source: handoff.source })
  emit('s1', 'assistant/message', assistantText('done'))
  emit('s1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const handedBack = () => agents.get('s1').calls.find(([, message]) => message.source?.deferred === true)
  for (let count = 0; count < 200 && ((agents.get('a')?.calls ?? []).length < 1 || handedBack() === undefined); count += 1) await delay(5)
  const replies = (agents.get('a')?.calls ?? []).filter(([, message]) => message.source?.role === 'reply')
  assert.deepEqual(replies.map(([, message]) => message.source.replyTo), ['e0'])
  assert.equal(textOf(replies[0][1].content), '[Reply from Writer]\ndone')
  assert.equal(handedBack()[0], 'followup')
  assert.equal(handedBack()[1].source.exchangeId, 'e1')
  assert.equal(textOf(handedBack()[1].content), '[Message from Chief · you read it during your last task; answer it now]\nmore')
})

// Each Session takes up the newest message it was sent as its next turn.
function turnTaker(agents, emit) {
  const turns = new Map()
  const take = (id) => {
    const [, message] = agents.get(id).calls.at(-1)
    turns.set(id, (turns.get(id) ?? 0) + 1)
    emit(id, 'turn/start', { turn: turns.get(id) })
    emit(id, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const end = (id, text) => {
    if (text !== undefined) emit(id, 'assistant/message', assistantText(text))
    emit(id, 'turn/end', { turn: turns.get(id), reason: { kind: 'completed' } })
  }
  const userTurn = (id, text) => {
    turns.set(id, (turns.get(id) ?? 0) + 1)
    emit(id, 'turn/start', { turn: turns.get(id) })
    emit(id, 'user/message', { content: textBlock(text), source: { kind: 'user' } })
  }
  return { take, end, userTurn }
}
const settled = async (check) => {
  for (let count = 0; count < 200 && !check(); count += 1) await delay(5)
}
const threeBots = () => {
  const seed = team()
  seed.bots.c = { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 }
  return seed
}
const callsOf = (agents, id) => agents.get(id)?.calls ?? []
// What state.json holds once the saves made so far are done: a save waits for the earlier
// ones, and a read while one renames the file over makes that save fail on Windows.
const worksIn = async ({ call, home }) => {
  await call('set-prefs', {})
  return JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).works ?? {}
}

// Chief asks Writer, which hands part of it on to Tester.
async function handedOn({ agents, emit, tool }) {
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'have Writer do it')
  await tool('message_bot', { to: 'Writer', message: 'carry out the plan' }, 'a')
  turns.end('a', 'asked Writer')
  turns.take('b')
  const handed = await tool('message_bot', { to: 'Tester', message: 'review my work' }, 'b')
  return { ...turns, handed }
}

test('a Bot\'s answer waits for the work it handed on, and carries what came back', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, tool, call } = team
  const shown = async () => { const { value } = await call('state', {}); return [value.activity.b === 'waiting', value.work.waiting] }
  const { take, end, handed } = await handedOn(team)
  assert.deepEqual(await shown(), [false, {}])
  assert.match(handed, /When you have handed on everything, end your turn: each reply brings you back to this work, and your answer goes to Chief once all of it is back\.$/)
  end('b', 'handed it to Tester')
  // Nothing goes up yet; Writer waits, and the team can see it.
  assert.match(await tool('list_bots', {}, 'a'), /- Writer \(Write\)\n {2}now: waiting for Tester to hand back work, for Chief\n/)
  assert.deepEqual(Object.values(await worksIn(team)).map(work => [work.from, work.to, work.open.length, work.held]), [['a', 'b', 1, 'handed it to Tester'], ['b', 'c', 0, undefined]])
  assert.deepEqual(callsOf(agents, 'a'), [])
  // Its mark shows it waits, and its row whom for.
  assert.deepEqual(await shown(), [true, { b: { bots: ['c'], rooms: [], for: ['a'] } }])

  take('c')
  end('c', 'two things to fix')
  await settled(() => callsOf(agents, 'b').length === 2)
  const back = take('b')
  assert.deepEqual(await shown(), [false, {}])
  assert.equal(textOf(back.content), '[Reply from Tester · for the work Chief asked you for; your answer goes to Chief once everything you handed on is back]\ntwo things to fix')
  end('b', 'fixed both')
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.equal(textOf(callsOf(agents, 'a')[0][1].content), '[Reply from Writer]\nfixed both\n\n[Handed back to Writer for this work]\n\nTester:\ntwo things to fix')
  assert.match(await tool('list_bots', {}, 'a'), /- Writer \(Write\)\n {2}now: idle\n/)
  assert.deepEqual(await shown(), [false, {}])
  assert.deepEqual(await worksIn(team), {})
})

test('a Bot may take part in the same work again, but not message one that waits for its result', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, tool } = team
  // Chief designs, Writer builds, Tester reviews; then Chief accepts.
  const { take, end } = await handedOn(team)
  end('b')
  take('c')
  // The guard answers with a result, not a failed call: the turn goes on with the
  // work, and the result says where its answer goes.
  const refused = /^Not sent: (Chief|Writer) is waiting for the result of the work you are doing, and your answer reaches it by itself once everything you handed on is back\./
  assert.match(await tool('message_bot', { to: 'Chief', message: 'please accept it' }, 'c'), refused)
  assert.match(await tool('message_bot', { to: 'Writer', message: 'it passes' }, 'c'), refused)
  assert.deepEqual(callsOf(agents, 'a'), [])
  assert.equal(callsOf(agents, 'b').length, 1)
  end('c', 'it passes')
  await settled(() => callsOf(agents, 'b').length === 2)
  take('b')
  end('b', 'built and reviewed')
  await settled(() => callsOf(agents, 'a').length === 1)
  take('a')
  // With the result in hand, Chief asks Tester again, and Tester may ask Writer.
  assert.match(await tool('message_bot', { to: 'Tester', message: 'check the last part once more' }, 'a'), /^Delivered to Tester/)
  end('a')
  take('c')
  assert.match(await tool('message_bot', { to: 'Writer', message: 'what did you change last?' }, 'c'), /^Delivered to Writer/)
  assert.match(await tool('message_bot', { to: 'Chief', message: 'done' }, 'c'), refused)
})

test('a stopped turn answers at once, and what it handed on comes back to it alone', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, emit } = team
  const { take, end } = await handedOn(team)
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.equal(textOf(callsOf(agents, 'a')[0][1].content), '[Reply from Writer]\nWriter was stopped before it could answer your message.')

  take('c')
  end('c', 'reviewed')
  await settled(() => callsOf(agents, 'b').length === 2)
  assert.equal(textOf(callsOf(agents, 'b')[1][1].content), '[Reply from Tester]\nreviewed')
  take('b')
  end('b', 'noted')
  await delay(20)
  assert.equal(callsOf(agents, 'a').length, 1)
})

test('a result read during other work comes back in a turn of its own and goes on with its work', async (t) => {
  const seed = threeBots()
  seed.bots.a.name = 'Chief [ops]'
  const team = await start(seed)
  t.after(team.stop)
  const { agents, emit } = team
  const { take, end, userTurn } = await handedOn(team)
  end('b', 'handed it on')
  take('c')
  end('c', 'reviewed')
  await settled(() => callsOf(agents, 'b').length === 2)
  const [, result] = callsOf(agents, 'b')[1]
  // The user's turn reads the result along with the user's message.
  userTurn('b', 'an unrelated question')
  emit('b', 'user/message', { content: result.content, source: result.source })
  end('b', 'the answer for the user')
  await settled(() => callsOf(agents, 'b').length === 3)
  const [kind, again] = callsOf(agents, 'b')[2]
  assert.equal(kind, 'followup')
  assert.equal(textOf(again.content), '[Reply from Tester · you read it during your last task; go on with the work it is for now · for the work Chief [ops] asked you for; your answer goes to Chief [ops] once everything you handed on is back]\nreviewed')
  assert.deepEqual(callsOf(agents, 'a'), [])
  take('b')
  end('b', 'done after the review')
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.equal(textOf(callsOf(agents, 'a')[0][1].content), '[Reply from Writer]\ndone after the review\n\n[Handed back to Writer for this work]\n\nTester:\nreviewed')
})

test('deleting a Bot that waits for work it handed on tells the Bot that asked', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { agents, call } = team
  const { end } = await handedOn(team)
  end('b', 'handed it on')
  assert.equal((await call('delete-bot', { id: 'b' })).ok, true)
  await settled(() => callsOf(agents, 'a').length === 1)
  assert.equal(textOf(callsOf(agents, 'a')[0][1].content), '[Reply from Writer]\nWriter was deleted before it could answer your message.')
  assert.deepEqual(await worksIn(team), {})
})

test('an answer that grows past 20,000 characters with what came back goes as a file', async (t) => {
  const team = await start(threeBots())
  t.after(team.stop)
  const { ctx, agents } = team
  const store = fakeAttachments()
  ctx.get = name => (name === 'attachments' ? store : undefined)
  const { take, end } = await handedOn(team)
  end('b', 'handed it on')
  take('c')
  const review = '审查意见。'.repeat(3000)
  end('c', review)
  await settled(() => callsOf(agents, 'b').length === 2)
  take('b')
  end('b', '改好了。'.repeat(1500))
  await settled(() => callsOf(agents, 'a').length === 1)
  const [text, file] = callsOf(agents, 'a')[0][1].content
  const whole = `${'改好了。'.repeat(1500)}\n\n[Handed back to Writer for this work]\n\nTester:\n${review}`
  assert.ok(text.text.startsWith(`[Reply from Writer]\n[A long message: ${whole.length} characters.`))
  assert.equal(file.attachment.name, 'Answer from Writer.txt')
  assert.equal(new TextDecoder().decode(store.files.get(file.attachment.attachmentId)), whole)
})

test('Bots keep messaging and posting with no count of messages or rounds', async (t) => {
  const { agents, tool, stop } = await start(team({ group: true }))
  t.after(stop)
  for (let count = 0; count < 60; count += 1) assert.match(await tool('message_bot', { to: 'Writer', message: `ping ${count}` }, 'a'), /^Delivered to Writer/)
  for (let count = 0; count < 5; count += 1) assert.match(await tool('post_to_group', { group: 'Ops', message: `note ${count}` }, 'a'), /^Posted in "Ops"/)
  assert.equal(agents.get('b').calls.length, 60)
  assert.equal(agents.get('r1').calls.length, 5)
})

// A Writer whose earlier part b1 holds `events`.
function earlierParts(events) {
  const writer = { id: 'b', name: 'Writer', createdAt: 1, sessionId: 'b2', segments: [{ sessionId: 'b1', endedAt: 2 }] }
  const rt = {
    ctx: { on() {}, effect() {}, get() {}, sessionController: { page: async () => ({ records: events.map(event => ({ event })), hasMore: false }) } },
    config: {},
    state: { exchangeTurns: {} },
    chatOwners: new Map([['b2', 'b']]),
    pastOwners: new Map([['b1', { botId: 'b' }]]),
    botOf: id => (id === 'b' ? writer : undefined),
    roomOf: () => undefined,
    chatOf: () => 'b2',
    resolveAgent: async id => ({ session: { id, seq: 3 } }),
  }
  installParts(rt)
  return rt
}

test('an earlier part keeps the request its Bot answered', async () => {
  const rt = earlierParts([
    { type: 'user/message', seq: 1, time: 10, data: { turn: 1, content: [{ type: 'text', text: '[Message from Chief]\nDo not delete that' }], source: replySource('request') } },
    { type: 'assistant/message', seq: 2, time: 11, data: { turn: 1, message: { content: [{ type: 'text', text: 'Understood, I stopped.' }] } } },
  ])
  const { items } = await rt.earlierPage('b2')
  assert.deepEqual(items.map(item => [item.kind, item.role ?? item.text]), [['event', 'request'], ['bot', 'Understood, I stopped.']])
  assert.equal(items[0].botId, 'a')
})

// #537: an archived earlier part may have no live agent to resolve; the page
// still loads from the stored events.
test('an earlier part loads when its agent is gone', async () => {
  const rt = earlierParts([
    { type: 'user/message', seq: 1, time: 10, data: { content: [{ type: 'text', text: 'still here' }], source: { kind: 'user' } } },
  ])
  rt.resolveAgent = async () => { throw Object.assign(new Error('Session unavailable'), { code: 'session/gone' }) }
  const { items } = await rt.earlierPage('b2')
  assert.deepEqual(items.map(item => [item.kind, item.text]), [['user', 'still here']])
})

// #537: a turn that spans a page boundary keeps its number on the newer page
// even when the part's agent is gone (no live projection to seed it).
test('an agentless part keeps the turn that opened on an older page', async () => {
  const events = [{ seq: 1, type: 'turn/start', time: 1, data: { turn: 6 } }]
  for (let seq = 2; seq <= 430; seq += 1) {
    events.push({ seq, type: 'user/message', time: seq, data: { content: [{ type: 'text', text: `m${seq}` }], source: { kind: 'user' } } })
  }
  const rt = earlierParts([])
  rt.ctx.sessionController.page = async ({ beforeSeq, maxMessages }) => {
    let list = events.filter(event => !Number.isInteger(beforeSeq) || event.seq < beforeSeq)
    const hasMore = list.length > maxMessages
    if (hasMore) list = list.slice(-maxMessages)
    return { records: list.map(event => ({ event })), hasMore }
  }
  rt.resolveAgent = async () => { throw Object.assign(new Error('Session unavailable'), { code: 'session/gone' }) }
  const { items } = await rt.earlierPage('b2')
  const first = items.find(item => item.kind !== 'divider')
  assert.equal(first?.kind, 'user')
  assert.equal(first?.turn, 6)
})

test('each text block of a Bot message is an entry of its own, as each is a bubble of its own', async () => {
  const rt = earlierParts([
    { type: 'assistant/message', seq: 1, time: 11, data: { turn: 1, message: { content: [{ type: 'text', text: 'First.' }, { type: 'tool-call', id: 'c1' }, { type: 'text', text: '  ' }, { type: 'text', text: 'Second.' }] } } },
  ])
  const { items } = await rt.earlierPage('b2')
  assert.deepEqual(items.map(item => [item.kind, item.text, item.time]), [['bot', 'First.', 11], ['bot', 'Second.', 11]])
})

test('earlier-part rows carry seq and the turn that turn/start opened', () => {
  const rt = earlierParts([])
  const items = rt.displayItems('b1', [
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'before' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, time: 2, data: { turn: 9, message: { content: [{ type: 'text', text: 'also before' }, { type: 'text', text: 'second bubble' }] } } },
    { type: 'turn/start', seq: 3, time: 3, data: { turn: 4 } },
    { type: 'user/message', seq: 4, time: 4, data: { content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 5, time: 5, data: { turn: 99, message: { content: [{ type: 'text', text: 'working' }] } } },
    { type: 'user/message', seq: 6, time: 6, data: { content: [{ type: 'text', text: '[Message from Chief]\nsteer' }], source: replySource('request') } },
    { type: 'user/message', seq: 7, time: 7, data: { content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: 8, time: 8, data: { turn: 5 } },
    { type: 'user/message', seq: 9, time: 9, data: { content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } } },
    { type: 'assistant/message', time: 10, data: { message: { content: [{ type: 'text', text: 'no seq' }] } } },
  ])
  assert.deepEqual(items.map(item => [item.kind, item.text ?? item.role, item.seq, item.turn]), [
    ['user', 'before', 1, undefined],
    ['bot', 'also before', 2, undefined],
    ['bot', 'second bubble', 2, undefined],
    ['user', 'start', 4, 4],
    ['bot', 'working', 5, 4],
    ['event', 'request', 6, 4],
    ['user', 'queued', 7, 4],
    ['user', 'next', 9, 5],
    ['bot', 'no seq', undefined, 5],
  ])
  assert.equal(items[0].time, 1)
  assert.equal('turn' in items[0], false)
  assert.equal('turn' in items[1], false)
  assert.equal('seq' in items.at(-1), false)
  assert.equal(items[4].turn, 4)
  assert.equal(items[5].botId, 'a')
  assert.equal(items[5].name, 'Chief')
})

// One turn opened on the older page and still running on the newer one.
// The page holds 60 events, so the newer page starts after that turn/start.
test('one turn keeps its identity across two earlier pages', async (t) => {
  const log = [{ seq: 1, type: 'turn/start', time: 1, data: { turn: 6 } }]
  for (let seq = 2; seq <= 70; seq += 1) {
    log.push({ seq, type: 'user/message', time: seq, data: { content: [{ type: 'text', text: `m${seq}` }], source: { kind: 'user' } } })
  }
  const session = { id: 'cur', seq: 71, header: {}, inheritedEventCount: 0, snapshotEvents: () => log }
  const units = new Map()
  const services = {}
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-turn-page-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['b'],
    revision: 1,
    bots: { b: { id: 'b', name: 'Writer', sessionId: 'cur', createdAt: 1, segments: [{ sessionId: 'old', endedAt: 50 }] } },
    rooms: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))
  const ctx = fakeContext({ services })
  services.sessionProjections = {
    register(definition) {
      ctx.effect(() => {
        units.set(definition.key, definition)
        return () => { units.delete(definition.key) }
      }, 'sessionProjections.register()')
    },
    stateOf(target, key) {
      const definition = units.get(key)
      if (definition === undefined) return undefined
      let state = definition.init(target.header, target.inheritedEventCount)
      for (const event of target.snapshotEvents()) state = definition.apply(state, event)
      return state
    },
  }
  ctx.sessionController = {
    resolveAgent: async (sessionId) => ({ agent: { id: sessionId, session: sessionId === 'cur' ? session : { id: sessionId, seq: 1, snapshotEvents: () => [] } } }),
    page: async ({ address, throughSeq, beforeSeq, maxMessages }) => {
      if (address.sessionId !== 'cur') return { records: [], hasMore: false }
      let list = log.filter(event => event.seq <= throughSeq && (!Number.isInteger(beforeSeq) || event.seq < beforeSeq))
      const hasMore = list.length > maxMessages
      if (hasMore) list = list.slice(-maxMessages)
      return { records: list.map(event => ({ event })), hasMore }
    },
  }
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const call = async (payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint: 'chat', payload }) }))).json()
  const newer = (await call({ botId: 'b' })).value
  const older = (await call({ botId: 'b', cursor: newer.cursor })).value
  assert.equal(newer.items.length, 60)
  assert.ok(newer.items[0].seq > 1)
  assert.equal(newer.items.every(item => item.kind === 'user' && item.turn === 6), true)
  assert.equal(older.items[0].kind, 'divider')
  assert.equal(older.items[0].time, 50)
  assert.equal('seq' in older.items[0], false)
  assert.equal('turn' in older.items[0], false)
  assert.equal(older.items.slice(1).every(item => item.kind === 'user' && item.turn === 6 && item.seq < newer.items[0].seq), true)
  assert.equal(older.items.some(item => item.seq === 2 && item.turn === 6), true)
})

test('a request the model keeps turning down moves the Bot on, without its latest messages the second time; a connection failure does not', async (t) => {
  const { ctx, agents, agentOf, emit, fire, stop } = await start(team())
  t.after(stop)
  let made = 0
  ctx.sessionController.create = async () => ({ sessionId: `s${++made}` })
  // Per Session, the events DS Bot reads back; only the previous turn's end matters.
  const ends = new Map()
  const endedWith = (id, code) => ends.set(id, { 9: { type: 'turn/end', data: { reason: { kind: 'error', error: { code } } } } })
  const failTurn = async (id, code) => {
    const agent = agentOf(id)
    agent.session.seq = 10
    agent.session.eventAt = seq => ends.get(id)?.[seq]
    emit(id, 'turn/start', { turn: 1 })
    emit(id, 'user/message', { content: textBlock('look at this'), source: { kind: 'user' } })
    await fire('agent/request-error', { failure: { code }, signal: AbortSignal.timeout(60_000), agent })
    emit(id, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code } } })
  }
  const handoffIn = id => agents.get(id)?.calls.find(([, message]) => message.source?.handoff === true)?.[1]
  const waitFor = async (check) => {
    for (let count = 0; count < 200 && !check(); count += 1) await delay(5)
    assert.ok(check())
  }

  await failTurn('b', 'TRANSPORT')
  // One turned-down request may be the provider's own hiccup.
  await failTurn('b', 'INVALID_REQUEST')
  await delay(30)
  assert.equal(made, 0)

  endedWith('b', 'INVALID_REQUEST')
  await failTurn('b', 'INVALID_REQUEST')
  await waitFor(() => handoffIn('s1') !== undefined)
  const first = textOf(handoffIn('s1').content)
  assert.match(first, /because a request in the previous part kept failing \(INVALID_REQUEST\)/)
  assert.match(first, /first tell the user in one short sentence that the last message could not be sent as it was/)

  endedWith('s1', 'INVALID_REQUEST')
  await failTurn('s1', 'INVALID_REQUEST')
  await waitFor(() => handoffIn('s2') !== undefined)
  const second = textOf(handoffIn('s2').content)
  assert.match(second, /so they are left out this time\. First tell the user/)
  assert.match(second, /## Latest messages[^#]*\(none\)/)

  // A part that already left the messages out stays where it is.
  endedWith('s2', 'INVALID_REQUEST')
  await failTurn('s2', 'INVALID_REQUEST')
  await delay(30)
  assert.equal(made, 2)
})

// #206: a message between Bots used to go whole into state.json, which is written whole
// on every save; an empty one started a turn on nothing.
test('message_bot turns down an empty message', async (t) => {
  const { agentOf, tool, exchanges, stop } = await start(team())
  t.after(stop)
  for (const message of ['', '   \n\t ']) assert.equal(await tool('message_bot', { to: 'Writer', message }, 'a'), 'Write a message to send.')
  assert.deepEqual(agentOf('b').calls, [])
  assert.deepEqual(await exchanges(), [])
})

test('a long message between Bots keeps its start in state.json and is read back whole from the Session', async (t) => {
  const { ctx, agentOf, tool, call, exchanges, home, stop } = await start(team())
  t.after(stop)
  const long = `${'长'.repeat(15_000)}结尾`
  await tool('message_bot', { to: 'Writer', message: long }, 'a')
  const [, delivered] = agentOf('b').calls.find(([kind]) => kind === 'steer' || kind === 'followup')
  assert.ok(delivered.content[0].text.endsWith(long), 'the recipient gets it whole')
  const [entry] = await exchanges()
  assert.equal(entry.text.length, 2000)
  assert.equal(entry.length, long.length)
  assert.equal(entry.sessionId, 'b')
  const file = join(home, 'state.json')
  for (let at = 0; at < 100 && !readFileSync(file, 'utf8').includes(entry.id); at += 1) await delay(20)
  const saved = readFileSync(file, 'utf8')
  assert.ok(saved.length < 10_000, `state.json is ${saved.length} characters`)
  assert.ok(!saved.includes('\n'), 'state.json is written without indentation')

  // The dialog reads the whole text back from the Session it was delivered to.
  agentOf('b').session.seq = 2
  ctx.sessionController.page = async ({ address }) => ({
    records: agentOf(address.sessionId).calls.map(([, message], index) => ({ event: { type: 'user/message', seq: index + 1, data: { content: message.content, source: message.source } } })),
    hasMore: false,
  })
  assert.deepEqual((await call('exchange-text', { id: entry.id })).value, { text: long, whole: true })
  // A Session that cannot be read leaves the start, said to be only that.
  ctx.sessionController.page = async () => { throw new Error('gone') }
  assert.deepEqual((await call('exchange-text', { id: entry.id })).value, { text: entry.text, whole: false })
})

test('a team saved with long messages whole keeps only their start after it loads', async (t) => {
  const seed = team()
  seed.exchanges = [{ id: 'x1', from: 'a', to: 'b', text: 'y'.repeat(5000), role: 'request', time: 1 }]
  const { exchanges, stop } = await start(seed)
  t.after(stop)
  const [entry] = await exchanges()
  assert.equal(entry.text, 'y'.repeat(2000))
  assert.equal(entry.length, 5000)
})

// #206: a message past 20,000 characters went whole into every Session it reached and
// into the model's context at once. It now goes as a DSH file the recipient reads.
test('a message past 20,000 characters goes as a file, which the exchange dialog reads back', async (t) => {
  const { ctx, agentOf, tool, call, exchanges, stop } = await start(team())
  t.after(stop)
  const store = fakeAttachments()
  ctx.get = name => (name === 'attachments' ? store : undefined)
  const lines = Array.from({ length: 400 }, (_, at) => `第 ${at + 1} 行：${'长消息的一行。'.repeat(8)}`)
  const long = `${lines.join('\n')}\n结尾`
  assert.ok(long.length > 20_000)
  const answer = await tool('message_bot', { to: 'Writer', message: long }, 'a')
  assert.match(answer, /^Delivered to Writer/)
  const [, delivered] = agentOf('b').calls.find(([kind]) => kind === 'steer' || kind === 'followup')
  const [text, file] = delivered.content
  assert.ok(text.text.startsWith(`[Message from Chief]\n[A long message: ${long.length} characters. Its start is below; all of it is in the attached file. Read the file before you act on it.]\n第 1 行`))
  assert.ok(!text.text.includes('shell command'), 'no line is past what the read tool shows')
  assert.ok(text.text.length < 1200)
  assert.equal(file.type, 'file')
  assert.equal(file.attachment.name, 'Message from Chief.txt')
  assert.equal(new TextDecoder().decode(store.files.get(file.attachment.attachmentId)), long)

  const [entry] = await exchanges()
  assert.equal(entry.length, long.length)
  assert.deepEqual(entry.files, [file.attachment])
  assert.deepEqual((await call('exchange-text', { id: entry.id })).value, { text: long, whole: true })
  assert.deepEqual((await call('file-text', { file: file.attachment })).value, { text: long, whole: true })
})

test('a long message with a line past what the read tool shows says how to read it', async (t) => {
  const { ctx, agentOf, tool, stop } = await start(team())
  t.after(stop)
  ctx.get = name => (name === 'attachments' ? fakeAttachments() : undefined)
  await tool('message_bot', { to: 'Writer', message: 'x'.repeat(25_000) }, 'a')
  const [, delivered] = agentOf('b').calls.find(([kind]) => kind === 'steer' || kind === 'followup')
  assert.match(delivered.content[0].text, /Some lines are longer than the 2000 characters the read tool shows of a line; read those with a shell command\./)
})

test('without file storage a message past 20,000 characters is not sent', async (t) => {
  const { agentOf, tool, exchanges, stop } = await start(team())
  t.after(stop)
  const answer = await tool('message_bot', { to: 'Writer', message: 'x'.repeat(20_001) }, 'a')
  assert.equal(answer, 'Not sent: the message has 20001 characters, more than 20000, and this DeepSeek Harness cannot send it as a file. Write it to a file in your working folder and send its path instead.')
  assert.deepEqual(agentOf('b').calls, [])
  assert.deepEqual(await exchanges(), [])
  // 20,000 characters still go as they are.
  await tool('message_bot', { to: 'Writer', message: 'x'.repeat(20_000) }, 'a')
  assert.equal(agentOf('b').calls.length, 1)
})
