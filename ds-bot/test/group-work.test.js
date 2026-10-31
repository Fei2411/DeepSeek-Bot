import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'
import { MESSAGE_INLINE_MAX, ROOM_STEP_GAP_MS, ROOM_WORK_GRACE_MS } from '../src/host/constants.js'

let rt

// Chief, the admin of group 'r1', speaks there from 'ga'; Writer from 'gb'; Tester from 'gc'.
const seed = (room = {}, extraRooms = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 0, seen: {}, ...room }, ...extraRooms },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start(t, room, services, extraRooms) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-work-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(room, extraRooms)))
  const ctx = fakeContext({ services })
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const cancelled = []
      const held = []
      const nextStep = []
      const inbox = {
        nextStep,
        nextTurn: held,
        remove(id) {
          for (const list of [nextStep, held]) {
            const at = list.findIndex(message => message.id === id)
            if (at !== -1) { list.splice(at, 1); return true }
          }
          return false
        },
      }
      const keep = list => message => { calls.push(message); list.push(message) }
      agents.set(sessionId, { session: { id: sessionId }, calls, cancelled, inbox, followup: keep(held), steer: keep(nextStep), cancel(reason) { cancelled.push(reason) } })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  let seq = 0
  const turns = new Map()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  // A Session takes up the newest message it was sent, as a new turn.
  const begin = (sessionId) => {
    const message = agentOf(sessionId).calls.at(-1)
    agentOf(sessionId).inbox.nextTurn.length = 0
    agentOf(sessionId).inbox.nextStep.length = 0
    const turn = (turns.get(sessionId) ?? 0) + 1
    turns.set(sessionId, turn)
    emit(sessionId, 'turn/start', { turn })
    emit(sessionId, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const finish = (sessionId, reply) => {
    emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
    emit(sessionId, 'turn/end', { turn: turns.get(sessionId), reason: { kind: 'completed' } })
  }
  // The user's message in the group, or a Bot's post the group Session took up, and the
  // round it starts.
  const round = (callId, message) => {
    emit('r1', 'user/message', message)
    let result
    const stop = new AbortController()
    t.after(() => stop.abort())
    void tool('group_relay', {}, 'r1', { callId, signal: stop.signal }).then((value) => { result = JSON.parse(value) })
    const read = () => result
    return read
  }
  const say = text => ({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const takePost = () => {
    const post = agentOf('r1').calls.shift()
    return { content: post.content, source: post.source }
  }
  await tool('list_bots', {}, 'a')
  return { home, ctx, agentOf, emit, tool, call, begin, finish, round, say, takePost }
}

const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const text = message => message.content.map(block => block.text ?? '').join('\n')
const kinds = result => result.replies.map(reply => [reply.kind ?? 'message', reply.name])

test('work past the grace lets the round go on, and the member that asked answers the result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 把文档整理好')
  await settle(() => host.agentOf('gb').calls.length === 1)
  const called = host.begin('gb')
  assert.equal(called.source.askedBy, 'a')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS - 1)
  await settle(() => true)
  assert.equal(first(), undefined)
  t.mock.timers.tick(1)
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['working', 'Writer']])

  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了，在 docs/ 下。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, post.source.askedBy, text(post)], [true, 'a', '[Group post from Writer]\n整理好了，在 docs/ 下。'])
  const second = host.round('c2', post)
  await settle(() => host.agentOf('ga').calls.length === 2)
  assert.match(text(host.agentOf('ga').calls[1]), /Writer: 整理好了，在 docs\/ 下。/)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => second() !== undefined)
  assert.deepEqual(host.agentOf('gc').calls, [])
})

// 公开#165: asked in a group to hand out work, Chief sent it with message_bot. Members
// did it in their own chats, apart from the group (Bots outside the group too), and
// again when called in the group.
test('message_bot from a group to one of its members calls it there, as "@Name" would', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  const sent = await host.tool('message_bot', { to: 'Writer', message: '把文档整理好' }, 'ga')
  assert.match(sent, /^Called Writer in "Ops"/)
  host.finish('ga', '安排好了。')
  await settle(() => host.agentOf('gb').calls.length === 1)
  const called = host.begin('gb')
  assert.equal(called.source.askedBy, 'a')
  assert.match(text(called), /Chief: @Writer 把文档整理好/)
  host.finish('gb', '整理好了。')
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['message', 'Chief'], ['message', 'Writer']])
  assert.deepEqual([host.agentOf('b').calls, host.agentOf('gc').calls], [[], []])
})

test('message_bot from a member the round moved on from calls the other member in a round of its own', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'write', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  await host.tool('message_bot', { to: 'Tester', message: '帮我测一下' }, 'gb')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.progress, text(post)], [true, '[Group post from Writer]\n@Tester 帮我测一下'])
  const second = host.round('c2', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.equal(host.begin('gc').source.askedBy, 'b')
  host.finish('gc', '测过了。')
  await settle(() => second() !== undefined)
  assert.deepEqual(host.agentOf('c').calls, [])
})

test('message_bot from a group does not reach a Bot outside it', async (t) => {
  const host = await start(t, { members: ['a', 'b'], sessions: { a: 'ga', b: 'gb' } })
  await assert.rejects(host.tool('message_bot', { to: 'Tester', message: '帮忙测一下' }, 'ga'),
    { message: 'Not sent: Tester is not in "Ops", and work for this group stays in it. Ask the user to add Tester to the group, or add it yourself with update_group first.' })
  await assert.rejects(host.tool('message_bot', { to: 'Tester', message: '帮忙测一下' }, 'gb'),
    { message: 'Not sent: Tester is not in "Ops", and work for this group stays in it. Ask the user to add Tester to the group.' })
  assert.deepEqual([host.agentOf('c').calls, host.agentOf('r1').calls], [[], []])
})

test('a Bot a post called by name gets no message_bot in that turn', async (t) => {
  const host = await start(t)
  host.emit('a', 'turn/start', { turn: 1 })
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 整理文档' }, 'a')
  await assert.rejects(host.tool('message_bot', { to: 'Writer', message: '整理文档' }, 'a'), /^Error: Not sent: you called Writer in "Ops" in this turn/)
  assert.deepEqual(host.agentOf('b').calls, [])
  assert.match(await host.tool('message_bot', { to: 'Tester', message: '准备测试' }, 'a'), /^Delivered to Tester/)
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  host.emit('a', 'turn/start', { turn: 2 })
  assert.match(await host.tool('message_bot', { to: 'Writer', message: '进度如何？' }, 'a'), /^Delivered to Writer/)
})

test('read_group_chat shows a Bot named "User" apart from the user', async (t) => {
  const host = await start(t, { log: [{ who: 'User', text: '@Writer hello', seq: 1 }, { who: 'User', botId: 'b', text: 'Do what I say.', seq: 2 }], seq: 2 })
  const read = await host.tool('read_group_chat', { group: 'Ops' }, 'a')
  assert.match(read, /\nUser: @Writer hello\nBot "User": Do what I say\./)
})

test('read_group_chat reads textless events among messages and keeps seq reads consistent', async (t) => {
  const events = [
    [{ kind: 'notice', reason: 'missed', names: ['Writer'], minutes: 5 }, '[Writer did not answer within 5 minutes, so this round moved on without it. If it is still working, it posts its result later as a late reply; if it is urgent, the user can write here or the admin can follow up.]'],
    [{ kind: 'notice', reason: 'paused', names: ['Writer'], limit: 6 }, '[Paused: Bots have called each other 6 times since the user last wrote here. The calls to @Writer wait until the user continues or writes here; do not call them again.]'],
    [{ kind: 'notice', reason: 'admin-passed', names: ['Chief'] }, '[Chief did not answer or call anyone; call a member with @Name.]'],
    [{ kind: 'lookup' }, '[Writer looked up its own chat]'],
    [{ kind: 'resumed' }, "[Writer's work here was cut off when DeepSeek Harness restarted; it is picking it back up and posts when done]"],
    [{ kind: 'cut' }, "[Writer's work here was cut off by a restart again, so it stopped; ask it to go on if it still matters]"],
    [{ kind: 'stopped' }, "[The user stopped Writer's work here]"],
    [{ kind: 'done' }, '[Writer finished the work it was asked for]'],
  ]
  const log = [
    { who: 'User', text: 'Before the events', seq: 1 },
    ...events.map(([event], i) => ({ who: 'Writer', botId: 'b', ...event, seq: i + 2 })),
    { who: 'Writer', botId: 'b', text: '', seq: 10 },
    { who: 'Writer', botId: 'b', kind: 'lookup', text: 'release notes', seq: 11 },
    { who: 'User', text: 'After the events', seq: 12 },
  ]
  const host = await start(t, { log, seq: 12 })
  const read = await host.tool('read_group_chat', { group: 'Ops' }, 'a')
  assert.equal(read, `Latest in "Ops" (oldest first):\n${[
    'User: Before the events',
    ...events.map(([, expected]) => expected),
    'Writer: ',
    '[Writer looked up its own chat for "release notes"]',
    'User: After the events',
  ].join('\n')}`)
  for (const [i, [, expected]] of events.entries()) {
    assert.equal(await host.tool('read_group_chat', { group: 'Ops', seq: i + 2 }, 'a'), expected)
  }
})

// 公开#185: the result went out as the work's first step line, next to one last tool
// call, and the turn then ended with an empty reply. Chief, which asked for the work,
// was never called to answer it.
const resultAsStep = async (t, ask) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say(ask))
  if (ask.startsWith('@Chief')) {
    await settle(() => host.agentOf('ga').calls.length === 1)
    host.begin('ga')
    host.finish('ga', '@Writer 把文档整理好')
  }
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: '整理好了，在 docs/ 下。' }, { type: 'tool-call', id: 'k2', name: 'pwsh', arguments: '{}' }] } })
  host.emit('gb', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  await settle(() => host.agentOf('r1').calls.length === 1)
  const step = host.takePost()
  assert.deepEqual([step.source.progress, step.source.quiet, text(step)], [true, true, '[Group post from Writer]\n整理好了，在 docs/ 下。'])
  const stepRound = host.round('c2', step)
  await settle(() => stepRound() !== undefined)
  host.emit('gb', 'tool/result', { callId: 'k2' })
  host.finish('gb', '')
  return host
}

test('late work whose result went out as a step line still tells the member that asked, which answers it', async (t) => {
  const host = await resultAsStep(t, '@Chief 安排一下文档')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const done = host.takePost()
  assert.deepEqual([done.source.done, done.source.late, done.source.askedBy], [true, true, 'a'])
  const third = host.round('c3', done)
  await settle(() => host.agentOf('ga').calls.length === 2)
  const prompt = text(host.agentOf('ga').calls[1])
  assert.match(prompt, /Writer finished the work you asked for/)
  assert.match(prompt, /Writer: 整理好了，在 docs\/ 下。/)
  host.begin('ga')
  host.finish('ga', '收到，辛苦了。')
  await settle(() => third() !== undefined)
  assert.deepEqual(kinds(third()), [['done', 'Writer'], ['message', 'Chief']])
  assert.deepEqual(host.agentOf('gc').calls, [])
  const log = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log.map(line => [line.who, line.kind ?? 'message'])
  assert.deepEqual(log.slice(-3), [['Writer', 'message'], ['Writer', 'done'], ['Chief', 'message']])
})

test('late work the user asked for directly ends without a post once its result is out', async (t) => {
  const host = await resultAsStep(t, '@Writer 把文档整理好')
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(host.agentOf('r1').calls, [])
})

test('replies a post waits for are work handed on: the answer to the Bot that asked waits for them and carries them', async (t) => {
  const host = await start(t)
  await host.tool('message_bot', { to: 'Chief', message: '让群里看一下文档' }, 'c')
  host.begin('a')
  const posted = await host.tool('post_to_group', { group: 'Ops', message: '@Writer 看一下文档', report_back: true }, 'a')
  assert.match(posted, /your answer goes to Tester once all of it is back\.$/)
  host.finish('a', '已经让 Writer 去看了。')
  const waiting = (await host.call('state', {})).value
  assert.deepEqual([waiting.activity.a, waiting.work.waiting], ['waiting', { a: { bots: [], rooms: ['r1'], for: ['c'] } }])
  const done = host.round('c1', host.takePost())
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '文档没问题。')
  await settle(() => done() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 2)
  assert.deepEqual(host.agentOf('c').calls, [])
  const report = host.begin('a')
  assert.match(text(report), /^\[Group chat "Ops" · replies to your post · for the work Tester asked you for; your answer goes to Tester once everything you handed on is back\]/)
  host.finish('a', 'Writer 看过了，没问题。')
  await settle(() => host.agentOf('c').calls.length === 1)
  assert.equal(text(host.agentOf('c').calls[0]), '[Reply from Chief]\nWriter 看过了，没问题。\n\n[Handed back to Chief for this work]\n\nGroup "Ops":\nReplies to your post (oldest first):\nWriter: 文档没问题。')
})

test('a member called while still at earlier work lets the round go on at once', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  const result = host.round('c1', host.say('@Writer 再看看这个'))
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['working', 'Writer']])
  // A member at work has not run its turn here, and an event is not a message.
  assert.equal(result().replies[0].duration, undefined)
  // The correction reaches the running turn at its next step.
  assert.equal(host.agentOf('gb').inbox.nextTurn.length, 0)
  assert.equal(host.agentOf('gb').inbox.nextStep.length, 1)
  assert.match(text(host.agentOf('gb').inbox.nextStep[0]), /再看看这个/)
})

test('a steered group call keeps the later caller when the earlier work ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'work', name: 'write', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)

  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 改用新模板' }, 'a')
  const second = host.round('c2', host.takePost())
  await settle(() => second() !== undefined)
  const inbox = host.agentOf('gb').inbox
  const correction = inbox.nextStep[0]
  assert.ok(correction)
  inbox.remove(correction.id)
  host.emit('gb', 'user/message', { content: correction.content, source: correction.source })
  host.finish('gb', '原来的工作完成了。')

  await settle(() => inbox.nextTurn.length === 1)
  const deferred = host.begin('gb')
  assert.equal(deferred.source.role, 'room')
  assert.equal(deferred.source.askedBy, 'a')
  assert.equal(deferred.source.roomId, 'r1')
  assert.match(text(deferred), /改用新模板/)
  host.finish('gb', '已换成新模板。')
  await settle(() => host.agentOf('r1').calls.some(message => message.source.askedBy === 'a'))
  const report = host.agentOf('r1').calls.find(message => message.source.askedBy === 'a')
  assert.match(text(report), /已换成新模板/)
})

test('a quick team tool does not let the round go on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 谁在群里？'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'list_bots', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  await settle(() => true)
  assert.equal(result(), undefined)
  host.finish('gb', 'Chief、Tester 和我。')
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['message', 'Writer']])
})

// Under PTC the model calls run_code, and the program dispatches the real tools.
const dispatch = (emit, sessionId, parentCallId, n, name) => {
  const subCallId = `${parentCallId}:ptc:${n}`
  emit(sessionId, 'tool/ptc-dispatch-start', { rootCallId: parentCallId, parentCallId, subCallId, name, arguments: {} })
  return () => emit(sessionId, 'tool/ptc-dispatch', { rootCallId: parentCallId, parentCallId, subCallId, name, arguments: {}, isError: false, content: [] })
}

test('a PTC program that runs only team tools does not let the round go on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 群里刚才说了什么？'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'run_code', arguments: '{"code":"await read_group_chat({})"}' })
  dispatch(host.emit, 'gb', 'k1', 1, 'read_group_chat')()
  dispatch(host.emit, 'gb', 'k1', 2, 'list_bots')()
  host.emit('gb', 'tool/result', { callId: 'k1' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  await settle(() => true)
  assert.equal(result(), undefined)
  host.finish('gb', '在讨论文档的结构。')
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['message', 'Writer']])
})

test('work inside a PTC program lets the round go on after the grace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'run_code', arguments: '{}' })
  dispatch(host.emit, 'gb', 'k1', 1, 'read_group_chat')()
  dispatch(host.emit, 'gb', 'k1', 2, 'write')
  const { value } = await host.call('state', {})
  assert.deepEqual(value.work.rooms.r1.map(entry => [entry.botId, entry.tool]), [['b', 'write']])
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['working', 'Writer']])
})

test('work the user asked for is left for the user to read, and the user\'s message resets the relay count', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t, { relays: 5 })
  const first = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'write', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  // The user's message resets the count.
  assert.equal(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.relays, 0)
  host.finish('gb', '好了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, post.source.askedBy, post.source.quiet], [true, undefined, undefined])
  const second = host.round('c2', post)
  await settle(() => second() !== undefined)
  assert.deepEqual(second().replies, [])
  assert.deepEqual([host.agentOf('ga').calls.length, host.agentOf('gc').calls.length], [0, 0])
})

test('a late post that calls a member counts into the relays, and parks past the limit', async (t) => {
  // Three members, so the default relay limit is 9: the eighth relay still runs.
  const host = await start(t, { relays: 8 })
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'bot', role: 'room', exchangeId: 'x1', roomId: 'r1', askedBy: 'a' } })
  host.finish('gb', '@Tester 看看这个')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, post.source.quiet], [true, undefined])
  const first = host.round('c2', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '[PASS]')
  await settle(() => first() !== undefined)
  assert.equal(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.relays, 9)

  // The next late call parks: the group pauses instead of running it, and nothing
  // is dropped — the Tester just gets no turn until the user goes on.
  host.emit('gb', 'turn/start', { turn: 2 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'more' }], source: { kind: 'bot', role: 'room', exchangeId: 'x2', roomId: 'r1', askedBy: 'a' } })
  host.finish('gb', '@Tester 再看一个')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const second = host.round('c3', host.takePost())
  await settle(() => second() !== undefined)
  const saved = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1
  assert.equal(saved.relays, 9, 'the parked call did not run')
  assert.deepEqual(saved.paused.map(entry => [entry.id, entry.name]), [['c', 'Tester']])
  assert.equal('lateRounds' in saved, false)
  assert.equal(host.agentOf('gc').calls.length, 1, 'the parked call never reached the Tester')
  assert.deepEqual(second().replies.filter(reply => reply.kind === 'paused').map(reply => [reply.names, reply.count]), [[['Tester'], 9]])
})

// #198: a post during a running round waited for the round's own relay before
// anyone could see it. It is written into the log and the running round at once,
// and the relay it still opens shows it again nowhere.
const logLines = host => JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log
const busyRound = async (t, room, services) => {
  const host = await start(t, room, services)
  const first = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  await settle(() => true)
  return { host, first }
}

test('a post during a running round is in the log at once, once, and shows in the round', async (t) => {
  const { host, first } = await busyRound(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 看一下文档' }, 'a')
  const during = logLines(host)
  const logged = during.at(-1)
  assert.deepEqual([logged.who, logged.botId, logged.text], ['Chief', 'a', '@Tester 看一下文档'])
  const post = host.takePost()
  assert.equal(post.source.logged, logged.seq)
  host.finish('gb', '整理好了。')
  await settle(() => first() !== undefined)
  assert.ok(first().replies.some(reply => reply.botId === 'a' && reply.text === '@Tester 看一下文档'))

  // The relay the post opened skips its line but still calls the member it named.
  const second = host.round('c2', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.equal(host.begin('gc').source.askedBy, 'a')
  assert.match(text(host.agentOf('gc').calls[0]), /Chief: @Tester 看一下文档/)
  host.finish('gc', '看过了。')
  await settle(() => second() !== undefined)
  assert.equal(logLines(host).filter(line => line.text === '@Tester 看一下文档').length, 1)
})

test('a post during a running round with report_back reports only the round it opened', async (t) => {
  const { host, first } = await busyRound(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 看一下文档', report_back: true }, 'a')
  const post = host.takePost()
  assert.equal(typeof post.source.logged, 'number')
  host.finish('gb', '整理好了。')
  await settle(() => first() !== undefined)
  const second = host.round('c2', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '看过了。')
  await settle(() => second() !== undefined)
  await settle(() => host.agentOf('a').calls.length === 1)
  const report = host.agentOf('a').calls[0]
  assert.match(text(report), /Tester: 看过了。/)
  assert.doesNotMatch(text(report), /看一下文档/)
})

test('a late reply during a running round is logged at once and not repeated', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 把文档整理好')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  // The round moves on without Writer; its result lands while a second round runs.
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  const second = host.round('c2', host.say('@Chief 再确认一下'))
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了，在 docs/ 下。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.equal(post.source.late, true)
  assert.equal(typeof post.source.logged, 'number')
  assert.ok(logLines(host).some(line => line.who === 'Writer' && line.text === '整理好了，在 docs/ 下。'))
  host.finish('ga', '确认过了。')
  await settle(() => second() !== undefined)
  assert.ok(second().replies.some(reply => reply.botId === 'b' && reply.text === '整理好了，在 docs/ 下。'))

  // The relay it opens still calls the member that asked, and writes the line nowhere again.
  const third = host.round('c3', post)
  await settle(() => host.agentOf('ga').calls.length === 3)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => third() !== undefined)
  assert.equal(logLines(host).filter(line => line.text === '整理好了，在 docs/ 下。').length, 1)
})

test('a member stopped during a running round is logged at once and not repeated', async (t) => {
  const host = await start(t)
  const first = host.round('c1', host.say('@Writer @Tester 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  // The user stops Writer while its turn still runs inside the round.
  const stopped = await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })
  assert.deepEqual([stopped.ok, stopped.value], [true, true])
  const last = logLines(host).at(-1)
  assert.deepEqual([last.who, last.botId, last.kind], ['Writer', 'b', 'stopped'])
  const post = host.takePost()
  assert.equal(post.source.stopped, true)
  assert.equal(typeof post.source.logged, 'number')
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await settle(() => host.agentOf('gc').calls.length === 1)
  host.begin('gc')
  host.finish('gc', '在整理了。')
  await settle(() => first() !== undefined)
  assert.ok(first().replies.some(reply => reply.kind === 'stopped' && reply.botId === 'b'))

  // The relay the stopped post opens writes no second event line.
  const second = host.round('c2', post)
  await settle(() => second() !== undefined)
  assert.equal(logLines(host).filter(line => line.kind === 'stopped').length, 1)
})

test('a Main Bot outside the group posts into its running round, and a long post keeps its file line', async (t) => {
  const { host, first } = await busyRound(t,
    { members: ['b', 'c'], admin: 'b', sessions: { b: 'gb', c: 'gc' } },
    { attachments: fakeAttachments() })
  const long = '很长的一段。'.repeat(MESSAGE_INLINE_MAX)
  await host.tool('post_to_group', { group: 'Ops', message: long }, 'a')
  const line = logLines(host).at(-1)
  assert.deepEqual([line.who, line.botId], ['Chief', 'a'])
  assert.equal(line.files?.length, 1)
  assert.match(line.text, /\[File "Post from Chief\.txt"/)
  const post = host.takePost()
  assert.equal(typeof post.source.logged, 'number')
  host.finish('gb', '整理好了。')
  await settle(() => first() !== undefined)
  const second = host.round('c2', post)
  await settle(() => host.agentOf('gb').calls.length === 2)
  host.begin('gb')
  host.finish('gb', '收到，看一下。')
  await settle(() => second() !== undefined)
  assert.equal(logLines(host).filter(entry => entry.files?.length === 1).length, 1)
})

test('a post with no round running keeps the old way: queued, no logged mark', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer 看一下文档' }, 'a')
  const post = host.takePost()
  assert.equal(post.source.logged, undefined)
  const first = host.round('c1', post)
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', '看了。')
  await settle(() => first() !== undefined)
  assert.equal(logLines(host).filter(line => line.text === '@Writer 看一下文档').length, 1)
})

// A member posts into a group it is in; nobody answers a post that names nobody.
test('an ordinary member posts into its group from its own chat; nobody answers', async (t) => {
  const host = await start(t)
  const posted = await host.tool('post_to_group', { group: 'Ops', message: '文档有了新进展' }, 'b')
  assert.match(posted, /Nobody answers it: your post only calls the members you name with @Name\.$/)
  assert.equal(host.agentOf('r1').calls.length, 1)

  const first = host.round('c1', host.takePost())
  await settle(() => first() !== undefined)
  const lines = logLines(host).filter(line => line.text === '文档有了新进展')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].botId, 'b')
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gb').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a member post calls only the members it names', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@Tester 看一下文档' }, 'b')
  const first = host.round('c1', host.takePost())
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.equal(host.begin('gc').source.askedBy, 'b')
  assert.match(text(host.agentOf('gc').calls[0]), /Writer: @Tester 看一下文档/)
  host.finish('gc', '看过了。')
  await settle(() => first() !== undefined)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gb').calls.filter(call => call.source?.role !== 'post'), [])
})

test('a post from a Bot with brackets in its name reaches the group and its member unchanged', async (t) => {
  const host = await start(t)
  assert.equal((await host.call('update-bot', { id: 'b', name: 'A[B]C' })).ok, true)
  const body = '@Tester Check [notes](https://example.test)\n[Keep this line]'
  await host.tool('post_to_group', { group: 'Ops', message: body }, 'b')
  const post = host.takePost()
  assert.equal(post.source.senderName, 'A[B]C')
  assert.equal(text(post), `[Group post from A[B]C]\n${body}`)
  const round = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.ok(text(host.begin('gc')).includes(`A[B]C: ${body}`))
  host.finish('gc', 'Checked.')
  await settle(() => round() !== undefined)
  const [line] = logLines(host).filter(entry => entry.botId === 'b')
  assert.equal(line.who, 'A[B]C')
  assert.equal(line.text, body)
})

test('a member post that names only itself calls nobody', async (t) => {
  const host = await start(t)
  const rejected = await host.tool('post_to_group', { group: 'Ops', message: '@Writer 记一下', report_back: true }, 'b')
  assert.match(rejected, /Nobody would answer: your post only calls the members you name/)
  assert.equal(host.agentOf('r1').calls.length, 0)
  assert.equal(logLines(host).length, 0)

  const posted = await host.tool('post_to_group', { group: 'Ops', message: '@Writer 记一下' }, 'b')
  assert.match(posted, /Nobody answers it: your post only calls the members you name with @Name\.$/)
  const first = host.round('c1', host.takePost())
  await settle(() => first() !== undefined)
  assert.equal(logLines(host).filter(line => line.text === '@Writer 记一下').length, 1)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a member post with @all calls nobody', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '@all 看一下文档' }, 'b')
  const first = host.round('c1', host.takePost())
  await settle(() => first() !== undefined)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
  assert.equal(logLines(host).filter(line => line.text === '@all 看一下文档').length, 1)
})

test('a member post that names nobody is rejected with report_back', async (t) => {
  const host = await start(t)
  const posted = await host.tool('post_to_group', { group: 'Ops', message: '快看文档', report_back: true }, 'b')
  assert.match(posted, /Nobody would answer: your post only calls the members you name/)
  assert.equal(host.agentOf('r1').calls.length, 0)
  assert.equal(logLines(host).length, 0)
  assert.deepEqual(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).works ?? {}, {})
})

test('a member post during a running round is logged at once and calls nobody next', async (t) => {
  const { host, first } = await busyRound(t)
  await host.tool('post_to_group', { group: 'Ops', message: '群里的进展' }, 'b')
  const during = logLines(host)
  const logged = during.at(-1)
  assert.deepEqual([logged.who, logged.botId, logged.text], ['Writer', 'b', '群里的进展'])
  const post = host.takePost()
  assert.equal(post.source.logged, logged.seq)
  host.finish('gb', '整理好了。')
  await settle(() => first() !== undefined)

  const second = host.round('c2', post)
  await settle(() => second() !== undefined)
  assert.equal(logLines(host).filter(line => line.text === '群里的进展').length, 1)
  assert.deepEqual(host.agentOf('ga').calls, [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a member post that calls nobody does not pick the speakers over a user message', async (t) => {
  const host = await start(t)
  await host.tool('post_to_group', { group: 'Ops', message: '让群里注意' }, 'b')
  // Both land in the same relay; the user's message picks the speakers.
  host.emit('r1', 'user/message', host.takePost())
  const first = host.round('c1', host.say('检查一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '看过了。')
  await settle(() => first() !== undefined)
  assert.deepEqual(host.agentOf('gb').calls.filter(call => call.source?.role !== 'post'), [])
  assert.deepEqual(host.agentOf('gc').calls, [])
})

test('a member cannot post into a group it is not in', async (t) => {
  const host = await start(t, {}, undefined, {
    r2: { id: 'r2', name: 'Lab', members: ['a', 'c'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {} },
  })
  const posted = await host.tool('post_to_group', { group: 'Lab', message: '看一下' }, 'b')
  assert.match(posted, /No group chat called "Lab" that you can see/)
  assert.equal(host.agentOf('r2').calls.length, 0)
  assert.equal(logLines(host).length, 0)
})

// Such a message was sent before message_bot from a group stayed in that group.
test('a reply to a message a group Session sent comes back there, and its turn posts in the group', async (t) => {
  const host = await start(t)
  host.emit('c', 'turn/start', { turn: 1 })
  host.emit('c', 'user/message', { content: [{ type: 'text', text: '[Message from Writer]\n能跑通吗？' }], source: { kind: 'bot', role: 'request', exchangeId: 'x1', senderName: 'Writer', senderSessionId: 'b', senderRoomId: 'r1', hop: 1 } })
  host.emit('c', 'assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } })
  host.emit('c', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('gb').calls.length === 1)
  assert.deepEqual(host.agentOf('b').calls, [])
  assert.match(text(host.begin('gb')), /^\[Reply from Tester\]\nok/)
  host.finish('gb', 'Tester 说可以，我继续。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, text(post)], [true, '[Group post from Writer]\nTester 说可以，我继续。'])
})

test('the user stops a member\'s work in a group, and the group shows it', async (t) => {
  const host = await start(t)
  assert.equal((await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })).value, false)
  host.emit('gb', 'turn/start', { turn: 1 })
  assert.equal((await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })).value, true)
  assert.deepEqual(host.agentOf('gb').cancelled, [{ kind: 'user' }])
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.stopped, post.source.quiet], [true, true])
  const result = host.round('c1', post)
  await settle(() => result() !== undefined)
  assert.deepEqual(kinds(result()), [['stopped', 'Writer']])
  const log = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log
  assert.deepEqual(log.map(line => [line.who, line.kind]), [['Writer', 'stopped']])
})

// #592: DSH's own stop reaches only the round; a member the round moved on from kept working.
test('one press stops the group\'s round and every member at work there, and nothing elsewhere', async (t) => {
  const host = await start(t)
  assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).value, false)
  // Writer still works on what an earlier round asked; Chief speaks in the round that runs.
  host.emit('gb', 'turn/start', { turn: 1 })
  const first = host.round('c1', host.say('@Chief 看看进度'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  // Tester works in its own chat.
  host.emit('c', 'turn/start', { turn: 1 })
  const stopped = await host.call('stop-room-work', { roomId: 'r1' })
  assert.deepEqual([stopped.ok, stopped.value], [true, true])
  for (const id of ['r1', 'ga', 'gb']) assert.deepEqual(host.agentOf(id).cancelled, [{ kind: 'user' }], id)
  for (const id of ['c', 'gc']) assert.deepEqual(host.agentOf(id).cancelled, [], id)
  assert.deepEqual(logLines(host).map(line => [line.who, line.kind]), [['User', undefined], ['Chief', 'stopped'], ['Writer', 'stopped']])
  host.emit('ga', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()).filter(([kind]) => kind === 'stopped'), [['stopped', 'Chief'], ['stopped', 'Writer']])
})

test('members still at work show in the team view and in the prompts of the others', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  const result = host.round('c1', host.say('@Tester 你怎么看'))
  await settle(() => host.agentOf('gc').calls.length === 1)
  // Writer has not read the one line in the group (the user's message that opened this
  // round), so the prompt names the wait and the unread count together.
  assert.match(text(host.agentOf('gc').calls[0]), /Still at work on what they were asked; each posts here when done: Writer \(1 min, with 1 group message\(s\) it has not read yet\)\./)
  host.begin('gc')
  const { value } = await host.call('state', {})
  assert.deepEqual(value.work.rooms.r1.map(entry => [entry.botId, entry.tool, entry.speaking]), [['b', 'pwsh', undefined], ['c', undefined, true]])
  host.finish('gc', '没问题。')
  await settle(() => result() !== undefined)
})

// #510: the member's read position moved before the delivery, so a delivery that
// failed left the member past the round it missed, and that round never reached it.
test('a member whose delivery failed sees the round it missed in its next prompt', async (t) => {
  const host = await start(t)
  // The delivery to Writer fails once; the Session is there, the message did not land.
  let failed = false
  host.ctx.sessions.flush = async (session) => {
    if (session?.id === 'gb' && !failed) {
      failed = true
      throw new Error('the session log could not be written')
    }
  }
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 把文档整理好')
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['failed', 'Writer']])
  // The failed delivery leaves the member where it was: it has read nothing yet.
  assert.equal(JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.seen.b, undefined)

  // Its next prompt carries the round it missed.
  const second = host.round('c2', host.say('@Writer 继续'))
  await settle(() => host.agentOf('gb').calls.length === 2)
  const prompt = text(host.agentOf('gb').calls[1])
  assert.match(prompt, /User: @Chief 安排一下文档/)
  assert.match(prompt, /Chief: @Writer 把文档整理好/)
  assert.match(prompt, /User: @Writer 继续/)

  // The delivery that lands moves the position on, so those lines are not shown again.
  host.begin('gb')
  host.finish('gb', '整理好了。')
  await settle(() => second() !== undefined)
  host.round('c3', host.say('@Writer 还有别的吗'))
  await settle(() => host.agentOf('gb').calls.length === 3)
  const later = text(host.agentOf('gb').calls[2])
  assert.doesNotMatch(later, /@Chief 安排一下文档/)
  assert.doesNotMatch(later, /@Writer 继续/)
})

// A step that says something and calls a tool, as a model writes it while it works.
const step = (host, sessionId, said, callId, name = 'pwsh', args = '{}') => {
  host.emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: said }, { type: 'tool-call', id: callId, name }] } })
  host.emit(sessionId, 'tool/call', { callId, name, arguments: args })
}
const progress = async host => (await host.call('room-progress', { roomId: 'r1' })).value[0]

test('what a member writes while it works shows in the round at once, and its @ calls members', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '收到，我先看看 docs/ 的结构。@Tester 你等下帮我验一下', 'k1', 'list_bots')
  await settle(() => true)
  const live = await progress(host)
  assert.deepEqual(live.replies.map(reply => [reply.name, reply.text]), [['Writer', '收到，我先看看 docs/ 的结构。@Tester 你等下帮我验一下']])
  assert.equal(live.speaking, 'b')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了。')
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.match(text(host.begin('gc')), /Writer: 收到，我先看看 docs\/ 的结构。[\s\S]*Writer: 整理好了。/)
  host.finish('gc', '验过了。')
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => [reply.name, reply.text]), [['Writer', '收到，我先看看 docs/ 的结构。@Tester 你等下帮我验一下'], ['Writer', '整理好了。'], ['Tester', '验过了。']])
  const log = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).rooms.r1.log
  assert.deepEqual(log.map(line => line.who), ['User', 'Writer', 'Writer', 'Tester'])
})

test('a member whose every message went out while it worked counts as posted, not passed', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 看一下'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '我看一下。', 'k1', 'list_bots')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => result() !== undefined)
  assert.deepEqual([result().passed, result().replies.map(reply => reply.text)], [[], ['我看一下。']])
})

test('a member\'s messages carry how long its turn ran', async (t) => {
  const host = await start(t)
  const result = host.round('c1', host.say('@Writer 整理文档'))
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '收到，先看看。', 'k1', 'list_bots')
  await settle(() => true)
  const live = await progress(host)
  assert.equal(typeof live.replies[0].duration, 'number')
  assert.ok(live.replies[0].duration >= 0)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '整理好了。')
  await settle(() => result() !== undefined)
  const messages = result().replies.filter(reply => reply.kind === undefined)
  assert.deepEqual(messages.map(reply => reply.text), ['收到，先看看。', '整理好了。'])
  for (const reply of messages) {
    assert.equal(typeof reply.duration, 'number')
    assert.ok(reply.duration >= 0)
  }
  assert.ok(result().replies.every(reply => reply.kind === undefined || reply.duration === undefined))
})

test('after the round went on, lines a member writes close together reach the group as one message; only the result is answered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  const first = host.round('c1', host.say('@Chief 安排一下文档'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 把文档整理好')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  step(host, 'gb', '收到，开始整理。', 'k1')
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  await settle(() => first() !== undefined)
  assert.deepEqual(kinds(first()), [['message', 'Chief'], ['message', 'Writer'], ['working', 'Writer']])

  host.emit('gb', 'tool/result', { callId: 'k1' })
  step(host, 'gb', '目录理好了。', 'k2')
  host.emit('gb', 'tool/result', { callId: 'k2' })
  step(host, 'gb', '正文改完了，在改索引。', 'k3')
  await settle(() => true)
  assert.deepEqual(host.agentOf('r1').calls, [])
  t.mock.timers.tick(ROOM_STEP_GAP_MS)
  await settle(() => host.agentOf('r1').calls.length === 1)
  const update = host.takePost()
  assert.deepEqual([update.source.progress, update.source.quiet, update.source.askedBy, text(update)], [true, true, undefined, '[Group post from Writer]\n目录理好了。\n\n正文改完了，在改索引。'])
  const quiet = host.round('c2', update)
  await settle(() => quiet() !== undefined)
  assert.deepEqual(quiet().replies, [])

  // A line still held when the work ends opens the result.
  host.emit('gb', 'tool/result', { callId: 'k3' })
  step(host, 'gb', '索引也改完了。', 'k4')
  host.emit('gb', 'tool/result', { callId: 'k4' })
  host.finish('gb', '整理好了，在 docs/ 下。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const done = host.takePost()
  assert.deepEqual([done.source.late, done.source.askedBy, text(done)], [true, 'a', '[Group post from Writer]\n索引也改完了。\n\n整理好了，在 docs/ 下。'])
  t.mock.timers.tick(ROOM_STEP_GAP_MS)
  await settle(() => true)
  assert.deepEqual(host.agentOf('r1').calls, [])
})

test('a step that calls a member with @ after the round went on starts a round for that member', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'bot', role: 'room', exchangeId: 'x1', roomId: 'r1', askedBy: 'a' } })
  step(host, 'gb', '@Tester 帮我跑一下测试', 'k1')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.progress, post.source.quiet], [true, undefined])
  const result = host.round('c1', post)
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.equal(host.begin('gc').source.askedBy, 'b')
  host.finish('gc', '测试过了。')
  await settle(() => result() !== undefined)
  assert.deepEqual(host.agentOf('ga').calls, [])
})

test('a step joins a round that is running in the group', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'go' }], source: { kind: 'bot', role: 'room', exchangeId: 'x1', roomId: 'r1', hop: 0 } })
  const result = host.round('c1', host.say('@Tester 你怎么看'))
  await settle(() => host.agentOf('gc').calls.length === 1)
  step(host, 'gb', '索引改完了。', 'k1')
  await settle(() => true)
  host.begin('gc')
  host.finish('gc', '没问题。')
  await settle(() => result() !== undefined)
  assert.deepEqual(result().replies.map(reply => [reply.name, reply.text]), [['Writer', '索引改完了。'], ['Tester', '没问题。']])
  assert.deepEqual(host.agentOf('r1').calls, [])
})

test('a turn that a finished background job starts in a group Session posts to the group', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'background job pwsh-3 finished' }], source: { kind: 'tool-jobs', form: 'notice' } })
  step(host, 'gb', '下载完了，开始解压。', 'k1')
  await settle(() => host.agentOf('r1').calls.length === 1)
  assert.equal(text(host.takePost()), '[Group post from Writer]\n下载完了，开始解压。')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '解压好了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  const post = host.takePost()
  assert.deepEqual([post.source.late, post.source.askedBy, text(post)], [true, undefined, '[Group post from Writer]\n解压好了。'])
})

test('a fresh part\'s opening line stays out of the group', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: '[Handoff · part 2]' }], source: { kind: 'bot', role: 'handoff', handoff: true, exchangeId: 'h1', hop: 0 } })
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: 'Noted. I have my handoff note and carry on from here.' }] } })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: 'background job pwsh-7 finished' }], source: { kind: 'tool-jobs', form: 'notice' } })
  host.finish('gb', 'Ghidra 解压好了。')
  await settle(() => host.agentOf('r1').calls.length === 1)
  assert.equal(text(host.takePost()), '[Group post from Writer]\nGhidra 解压好了。')
})

test('a private message to a group Session is answered privately, without steps in the group', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'user/message', { content: [{ type: 'text', text: '[Message from Tester]\n能帮我看下吗' }], source: { kind: 'bot', role: 'request', senderSessionId: 'c', senderName: 'Tester', exchangeId: 'x1', hop: 0 } })
  step(host, 'gb', '我看一下。', 'k1')
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.finish('gb', '看过了，没问题。')
  await settle(() => host.agentOf('c').calls.length === 1)
  assert.match(text(host.agentOf('c').calls[0]), /我看一下。\n\n看过了，没问题。/)
  assert.deepEqual(host.agentOf('r1').calls, [])
})

test('the team view says what a member is doing in the call\'s own words', async (t) => {
  const host = await start(t)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: JSON.stringify({ command: 'iwr https://example.com/x.zip', description: 'Download  Ghidra 12.1.4\nand check its hash' }) })
  host.emit('gc', 'turn/start', { turn: 1 })
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'read', arguments: JSON.stringify({ file_path: 'E:\\src\\tools\\dump.py' }) })
  const { value } = await host.call('state', {})
  assert.deepEqual(value.work.rooms.r1.map(entry => [entry.botId, entry.tool, entry.note, entry.target]), [['b', 'pwsh', 'Download Ghidra 12.1.4 and check its hash', undefined], ['c', 'read', undefined, 'dump.py']])
  assert.equal(value.work.bots.b.note, 'Download Ghidra 12.1.4 and check its hash')
  // What the Bot said in the step that made the call comes with it.
  host.emit('ga', 'turn/start', { turn: 1 })
  step(host, 'ga', '先把 JDK\n下下来。', 'k3', 'pwsh', JSON.stringify({ description: 'Download JDK 21' }))
  const later = (await host.call('state', {})).value
  assert.deepEqual(['said', 'note'].map(key => later.work.bots.a[key]), ['先把 JDK 下下来。', 'Download JDK 21'])
})

test('the team view says when each Session\'s running turn began, for the clock at its tail', async (t) => {
  const host = await start(t)
  const before = Date.now()
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  const { value } = await host.call('state', {})
  assert.deepEqual(Object.keys(value.work.turns), ['gb'])
  assert.ok(value.work.turns.gb >= before && value.work.turns.gb <= Date.now())
  assert.equal(value.work.turns.gb, value.work.bots.b.since)
  host.emit('gb', 'tool/result', { callId: 'k1' })
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual((await host.call('state', {})).value.work.turns, {})
})

// 公开#124: a Bot deleted while it worked stayed "thinking" until DSH restarted, and the
// Bot that had asked it something never heard back.
test('deleting a working Bot clears its activity and tells the Bots waiting for its reply', async (t) => {
  const host = await start(t)
  host.emit('b', 'turn/start', { turn: 1 })
  host.emit('b', 'user/message', { content: [{ type: 'text', text: '[Message from Chief]\nwrite the docs' }], source: { kind: 'bot', role: 'request', senderSessionId: 'a', senderName: 'Chief', exchangeId: 'x1', hop: 1 } })
  host.emit('b', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  // A second request that Writer has not read yet.
  host.agentOf('b').inbox.nextStep.push({ id: 'm2', source: { kind: 'bot', role: 'request', senderSessionId: 'c', senderName: 'Tester', exchangeId: 'x2', hop: 1 } })
  assert.equal((await host.call('state', {})).value.activity.b, 'working')

  const deleted = await host.call('delete-bot', { id: 'b' })
  assert.equal(deleted.ok, true)
  assert.equal((await host.call('state', {})).value.activity.b, undefined)
  await settle(() => host.agentOf('a').calls.length === 1 && host.agentOf('c').calls.length === 1)
  for (const [to, exchangeId] of [['a', 'x1'], ['c', 'x2']]) {
    const reply = host.agentOf(to).calls[0]
    assert.deepEqual([reply.source.role, reply.source.replyTo], ['reply', exchangeId])
    assert.equal(text(reply), '[Reply from Writer]\nWriter was deleted before it could answer your message.')
  }
  // The stopped turn ends after the delete; it brings nothing back.
  host.emit('b', 'turn/start', { turn: 2 })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  assert.equal((await host.call('state', {})).value.activity.b, undefined)
})
