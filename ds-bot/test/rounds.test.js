import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { lineText } from '../src/host/groups.js'
import { fakeAttachments, fakeContext } from './fake-ctx.js'

// A fake team of two Bots in one group; member answers are played back through the
// session/event listener, so a round runs with no model. Prompts land in the
// Session's inbox the way DSH holds them while a turn runs: queued for the next turn,
// or steered into the next step.
// `home`: start on the data of an earlier run, as after a restart.
let rt
function start({ home = mkdtempSync(join(tmpdir(), 'ds-bot-rounds-')) } = {}) {
  const ctx = fakeContext()
  const workspaces = new Map()
  const sent = []
  const inboxes = new Map()
  const inboxOf = (sessionId) => {
    if (!inboxes.has(sessionId)) {
      const inbox = { nextTurn: [], nextStep: [] }
      inbox.remove = (id) => {
        for (const list of ['nextTurn', 'nextStep']) {
          const at = inbox[list].findIndex(message => message.id === id)
          if (at !== -1) {
            inbox[list] = inbox[list].toSpliced(at, 1)
            return true
          }
        }
        return false
      }
      inboxes.set(sessionId, inbox)
    }
    return inboxes.get(sessionId)
  }
  let sessions = 0
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async () => undefined,
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async () => {},
      prompt: async (request) => {
        const inbox = inboxOf(request.sessionId)
        inbox[request.mode === 'steer' ? 'nextStep' : 'nextTurn'].push({ id: randomUUID(), role: 'user', source: { kind: 'user', rpcId: request.requestId }, content: request.content })
        return { accepted: true }
      },
      page: async () => ({ events: [] }),
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
  rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  // Session events arrive one at a time in DSH; awaiting each listener keeps that order.
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const userMessage = text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  // What the shell's composer does: prompt the group's Session directly.
  const compose = (sessionId, content, mode = 'queue') => ctx.sessionController.prompt({
    requestId: randomUUID(),
    sessionId,
    mode,
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
  })
  const relay = (roomId, callId, signal = new AbortController().signal) => rt.teamTools.find(d => d.name === 'group_relay')
    .execute({}, { agent: { id: roomId, inbox: inboxOf(roomId) }, callId, signal })
  // The Bot's answer to its group turn: a delivery source plus the reply text.
  const answer = async (sessionId, exchangeId, text, turn) => {
    await emit(sessionId, { type: 'turn/start', data: { turn } })
    await emit(sessionId, { type: 'user/message', data: { source: { kind: 'bot', role: 'room', exchangeId }, content: [{ type: 'text', text: 'your turn' }] } })
    await emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  }
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, emit, userMessage, compose, relay, inboxOf, answer, stop, sent, ctx, home, rt }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const waitFor = async (check) => {
  for (let at = 0; at < 100; at += 1) {
    const value = check()
    if (value !== undefined) return value
    await settle()
  }
  return undefined
}
const turnFor = (sent, ...earlier) => waitFor(() => sent.find(entry => !earlier.includes(entry) && entry.message.source.role === 'room'))

test('a new group Session waits for capabilities before its first member prompt', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await emit(room.id, userMessage('Start'))

  let release
  let markStarted
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { markStarted = resolve })
  rt.ensureCapabilities = async sessionId => {
    markStarted(sessionId)
    await gate
  }
  const running = relay(room.id, 'first-turn')
  const sessionId = await started
  assert.equal(sent.length, 0)
  release()

  const first = await turnFor(sent)
  assert.equal(first.sessionId, sessionId)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief ready.', 1)
  const second = await turnFor(sent, first)
  assert.ok(second)
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer ready.', 2)
  await running
})

async function team(call, sent) {
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, writer.id] })).value
  await call('update-room', { id: room.id, mode: 'everyone' })
  sent.length = 0
  return room
}

test('a message the composer queues mid-round joins the round and leaves the Session\'s queue', async (t) => {
  const { call, emit, userMessage, compose, relay, inboxOf, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  // The user's first message opens the round: the admin speaks first.
  await emit(room.id, userMessage('Tell me a long story'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  assert.ok(first, 'the admin gets the first turn')

  // While the admin is still answering, the user sends another message.
  await compose(room.id, '@Writer ping mid-round')

  // The admin answers; the Writer's turn prompt must already carry the new line.
  await answer(first.sessionId, first.message.source.exchangeId, 'Once upon a time...', 1)
  const second = await turnFor(sent, first)
  assert.ok(second, 'the Writer gets the next turn')
  assert.match(second.message.content[0].text, /@Writer ping mid-round/)
  assert.match(second.message.content[0].text, /the user mentioned you/)

  await answer(second.sessionId, second.message.source.exchangeId, 'Ping back!', 2)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'User', 'Writer'])
  // Taken out of the queue, the message opens no second round after this one.
  assert.deepEqual(inboxOf(room.id).nextTurn, [])
})

test('a plain message steered mid-round is answered by everyone, admin first, inside the round', async (t) => {
  const { call, emit, userMessage, compose, relay, inboxOf, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await compose(room.id, 'steer this way', 'steer')
  await answer(first.sessionId, first.message.source.exchangeId, 'one', 1)
  // The admin already spoke, so it gets one more turn for the new message.
  const second = await turnFor(sent, first)
  assert.equal(second.sessionId, first.sessionId)
  assert.match(second.message.content[0].text, /steer this way/)
  assert.match(second.message.content[0].text, /new message from the user/)
  await answer(second.sessionId, second.message.source.exchangeId, 'one again', 2)
  const third = await turnFor(sent, first, second)
  assert.match(third.message.content[0].text, /steer this way/)
  await answer(third.sessionId, third.message.source.exchangeId, 'two', 3)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'User', 'Chief', 'Writer'])
  assert.deepEqual(inboxOf(room.id).nextStep, [])
})

test('a message sent during the last speaker\'s turn is still answered in the round', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Kick it off'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief first', 1)
  const second = await turnFor(sent, first)

  // The last member is already answering when the message lands.
  assert.equal((await call('send', { sessionId: room.id, text: 'one more thing' })).ok, true)
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer done', 2)

  const third = await turnFor(sent, first, second)
  assert.ok(third, 'the admin answers the late message')
  assert.match(third.message.content[0].text, /one more thing/)
  await answer(third.sessionId, third.message.source.exchangeId, 'Back again', 3)
  const fourth = await turnFor(sent, first, second, third)
  assert.ok(fourth, 'and so does the Writer')
  await answer(fourth.sessionId, fourth.message.source.exchangeId, 'Me too', 4)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer', 'User', 'Chief', 'Writer'])
})

test('in admin mode a plain mid-round message goes to the admin', async (t) => {
  const { call, emit, userMessage, compose, relay, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin' })

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  // The admin answers alone and calls the Writer.
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, '@Writer your call', 1)
  const second = await turnFor(sent, first)
  assert.notEqual(second.sessionId, first.sessionId)
  await compose(room.id, 'what do you think?')
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer here', 2)
  const third = await turnFor(sent, first, second)
  assert.equal(third.sessionId, first.sessionId, 'the admin answers the user')
  assert.match(third.message.content[0].text, /what do you think\?/)
  await answer(third.sessionId, third.message.source.exchangeId, 'Admin here', 3)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer', 'User', 'Chief'])
})

test('a message with an image or a chat reference waits for its own round, and so does what follows it', async (t) => {
  const { call, emit, userMessage, compose, relay, inboxOf, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await compose(room.id, [{ type: 'text', text: 'see this' }, { type: 'image', data: 'AAAA', mediaType: 'image/png' }])
  await compose(room.id, 'after the image')
  await compose(room.id, 'about @[Notes](dsh-session:abc123)', 'steer')
  await answer(first.sessionId, first.message.source.exchangeId, 'one', 1)
  const second = await turnFor(sent, first)
  assert.doesNotMatch(second.message.content[0].text, /see this|after the image|about @/)
  await answer(second.sessionId, second.message.source.exchangeId, 'two', 2)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer'])
  assert.equal(inboxOf(room.id).nextTurn.length, 2)
  assert.equal(inboxOf(room.id).nextStep.length, 1)
})

test('the greeting round leaves a waiting message for its own round', async (t) => {
  const { call, emit, compose, relay, inboxOf, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, { type: 'user/message', data: { source: { kind: 'bot', role: 'kickoff' }, content: [{ type: 'text', text: '[Group chat created]' }] } })
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await compose(room.id, 'hello there')
  await answer(first.sessionId, first.message.source.exchangeId, 'Welcome!', 1)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief'])
  assert.equal(inboxOf(room.id).nextTurn.length, 1)
})

test('a stopped round leaves a waiting message for the next round', async (t) => {
  const { call, emit, userMessage, compose, relay, inboxOf, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const controller = new AbortController()
  const running = relay(room.id, 'relay', controller.signal)
  await turnFor(sent)
  await compose(room.id, 'still there?')
  controller.abort()
  const result = JSON.parse(await running)
  assert.equal(result.replies.some(reply => reply.kind === 'user'), false)
  assert.equal(inboxOf(room.id).nextTurn.length, 1)
})

test('a message sent between rounds still opens a full round', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Hello group'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  assert.ok(first)
  await answer(first.sessionId, first.message.source.exchangeId, 'Hi!', 1)
  const second = await turnFor(sent, first)
  assert.ok(second)
  await answer(second.sessionId, second.message.source.exchangeId, 'Hello!', 2)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer'])
})

// 公开#163: a member's group Session whose stored log is corrupt could not be resumed;
// the round counted the member as passed, showed nothing, and tried the same Session
// again every round.
test('a member whose group Session cannot be opened shows a failure, and its next turn there starts a new Session', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt , ctx } = start()
  t.after(stop)
  const room = await team(call, sent)
  const chief = (await call('state', {})).value.mainBotId

  await emit(room.id, userMessage('Report in'))
  let running = relay(room.id, 'r1')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief here.', 1)
  const second = await turnFor(sent, first)
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer here.', 2)
  await running
  const broken = rt.roomOf(room.id).sessions[chief]
  assert.equal(first.sessionId, broken)

  const resolve = ctx.sessionController.resolveAgent
  ctx.sessionController.resolveAgent = async sessionId => (sessionId === broken
    ? { error: { code: 'gateway/internal', message: `resume failed for session "${sessionId}": SessionQueryError: stored session "${sessionId}" is corrupt: released v2 row has seq gap (expected 20, got 16)` } }
    : resolve(sessionId))
  t.mock.method(rt, 'warn', () => {})
  sent.length = 0
  await emit(room.id, userMessage('Again'))
  running = relay(room.id, 'r2')
  const writerTurn = await turnFor(sent)
  assert.equal(writerTurn.sessionId, second.sessionId)
  await answer(writerTurn.sessionId, writerTurn.message.source.exchangeId, 'Still here.', 3)
  const result = JSON.parse(await running)
  const failed = result.replies.filter(reply => reply.kind === 'failed')
  assert.deepEqual(failed.map(reply => [reply.name, reply.code]), [['Chief', 'SESSION_RESET']])
  assert.equal(result.passed.includes('Chief'), false)
  assert.equal(rt.roomOf(room.id).sessions[chief], undefined)

  sent.length = 0
  await emit(room.id, userMessage('Once more'))
  running = relay(room.id, 'r3')
  const fresh = await turnFor(sent)
  assert.notEqual(fresh.sessionId, broken)
  assert.equal(rt.roomOf(room.id).sessions[chief], fresh.sessionId)
  await answer(fresh.sessionId, fresh.message.source.exchangeId, 'Back.', 1)
  const again = await turnFor(sent, fresh)
  await answer(again.sessionId, again.message.source.exchangeId, 'Here.', 4)
  assert.deepEqual(JSON.parse(await running).replies.map(reply => reply.name ?? 'User'), ['Chief', 'Writer'])
})

test('a delivery that fails for another reason shows a failure and keeps the Session', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt , ctx } = start()
  t.after(stop)
  const room = await team(call, sent)
  const chief = (await call('state', {})).value.mainBotId
  await emit(room.id, userMessage('Report in'))
  let running = relay(room.id, 'r1')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief here.', 1)
  const second = await turnFor(sent, first)
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer here.', 2)
  await running

  const resolve = ctx.sessionController.resolveAgent
  ctx.sessionController.resolveAgent = async sessionId => (sessionId === first.sessionId
    ? { error: { code: 'session/writer-held', message: 'another process holds this Session' } }
    : resolve(sessionId))
  t.mock.method(rt, 'warn', () => {})
  sent.length = 0
  await emit(room.id, userMessage('Again'))
  running = relay(room.id, 'r2')
  const writerTurn = await turnFor(sent)
  await answer(writerTurn.sessionId, writerTurn.message.source.exchangeId, 'Still here.', 3)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.filter(reply => reply.kind === 'failed').map(reply => [reply.name, reply.code]), [['Chief', 'SESSION']])
  assert.equal(rt.roomOf(room.id).sessions[chief], first.sessionId)
})

// #217: DSH opens a relative file link from the folder of the Session that shows it. A
// member wrote the link in its own group Session, which works in the group's folder; the
// group's Session and other Bots work elsewhere, so the link reaches them in full.
test('a relative file link a member writes reaches the group, and another Bot, as a full path', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-links-')))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const room = await team(call, sent)
  assert.equal((await call('update-room', { id: room.id, workDir: folder })).ok, true)
  const full = path => join(folder, path).replace(/\\/g, '/').replace(/ /g, '%20')
  await emit(room.id, userMessage('Where is the draft?'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'It is in [a.txt](sub/a.txt).', 1)
  const second = await turnFor(sent, first)
  // The next member reads it in its prompt, and the group shows it, with the full path.
  assert.ok(second.message.content[0].text.includes(`[a.txt](${full('sub/a.txt')})`))
  await answer(second.sessionId, second.message.source.exchangeId, 'Thanks.', 2)
  const result = JSON.parse(await running)
  assert.equal(result.replies[0].text, `It is in [a.txt](${full('sub/a.txt')}).`)

  // A Bot that works in the folder sends the same link to another Bot; from its group
  // Session that calls the Bot in the group (#165).
  const chief = rt.state.mainBotIds[0]
  const writer = rt.state.rooms[room.id].members.find(id => id !== chief)
  sent.length = 0
  await rt.teamTools.find(d => d.name === 'message_bot').execute({ to: rt.botOf(writer).name, message: 'Read [notes](notes.md#L3)', when: 'queue' }, {
    agent: { id: first.sessionId, session: { id: first.sessionId, header: { cwd: folder } }, inbox: { nextStep: [], nextTurn: [] } }, callId: 'c1',
  })
  const delivered = await waitFor(() => sent.find(entry => entry.sessionId === room.id && entry.message.source?.role === 'post'))
  assert.ok(delivered.message.content.map(block => block.text).join('\n').includes(`[notes](${full('notes.md')}#L3)`))
})

// #209: DSH can fail a member's turn before its first step (DSH 0.2.1 does so for a folder
// that is gone), so the turn never takes the round's call. The round counts the failure at
// once instead of waiting minutes for a reply that cannot come.
test('a member turn that fails before it takes the call fails that member in the round at once', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent } = start()
  t.after(stop)
  const room = await team(call, sent)
  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await emit(first.sessionId, { type: 'turn/start', data: { turn: 1 } })
  await emit(first.sessionId, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'working-directory: directory does not exist: "/gone"', code: 'UNKNOWN' } } } })
  const second = await turnFor(sent, first)
  assert.ok(second, 'the next member speaks without waiting for the reply timeout')
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer here.', 1)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => [reply.kind ?? 'reply', reply.name]), [['failed', 'Chief'], ['reply', 'Writer']])
})

// A member deleted while its group Session is made sits the round out; the Session it was
// getting belongs to no one, so it is archived instead of left over.
test('a member deleted while its group Session is made is left out, and the Session is not kept', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt , ctx } = start()
  t.after(stop)
  const room = await team(call, sent)
  const writer = rt.state.rooms[room.id].members.find(id => !rt.isMain(id))
  const archived = []
  ctx.workspaceRegistry.archiveSession = async (sessionId) => { archived.push(sessionId) }
  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)

  let release
  const gate = new Promise(resolve => { release = resolve })
  let made
  const making = new Promise(resolve => { made = resolve })
  const create = ctx.sessionController.create
  ctx.sessionController.create = async (options) => {
    const result = await create(options)
    made(result.sessionId)
    await gate
    return result
  }
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief here.', 1)
  const sessionId = await making
  assert.equal((await call('delete-bot', { id: writer })).ok, true)
  release()

  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => [reply.kind ?? 'reply', reply.name]), [['reply', 'Chief']])
  assert.ok(archived.includes(sessionId))
  assert.equal(rt.state.rooms[room.id].sessions?.[writer], undefined)
})

// #206: state.json is written whole on every save, so a long group line keeps its start
// there and its whole text in a file of its own. Members still read it whole.
test('a long group line keeps its start in state.json, and members and read_group_chat read it whole', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, home, rt } = start()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const room = await team(call, sent)
  const long = `${'长'.repeat(9000)}结尾`
  await emit(room.id, userMessage('Write it all out'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, long, 1)
  const second = await turnFor(sent, first)
  assert.ok(second.message.content[0].text.includes(long), 'the next member reads the line whole')
  await answer(second.sessionId, second.message.source.exchangeId, 'Thanks.', 2)
  assert.equal(JSON.parse(await running).replies[0].text, long)

  await rt.save()
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms[room.id].log.find(line => line.length !== undefined)
  assert.equal(saved.text.length, 2000)
  assert.equal(saved.length, long.length)
  assert.equal(readFileSync(join(home, 'group-lines', room.id, `${saved.seq}.txt`), 'utf8'), long)
  const read = rt.teamTools.find(d => d.name === 'read_group_chat')
  const exec = { agent: { id: first.sessionId } }
  assert.match(await read.execute({ group: 'R1' }, exec), new RegExp(`cut; ${long.length} characters in all; read_group_chat with seq ${saved.seq} reads it whole`))
  assert.ok((await read.execute({ group: 'R1', seq: saved.seq }, exec)).endsWith(long))
  await stop({ keep: true })

  // The log is full (60 lines) when DSH starts again, the long line second oldest.
  const file = join(home, 'state.json')
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  const kept = onDisk.rooms[room.id]
  const fillers = Array.from({ length: 60 - kept.log.length }, (_, at) => ({ who: 'User', text: `line ${at}`, seq: kept.seq + at + 1 }))
  kept.log = [...kept.log, ...fillers]
  kept.seq += fillers.length
  writeFileSync(file, JSON.stringify(onDisk))

  // After a restart the whole line is read back from its file.
  const again = start({ home })
  t.after(() => again.stop({ keep: true }))
  await again.call('state', {})
  const whole = await again.rt.teamTools.find(d => d.name === 'read_group_chat').execute({ group: 'R1', seq: saved.seq }, exec)
  assert.ok(whole.endsWith(long))

  // The file goes with the line once the log moves past it, and with the group.
  await again.emit(room.id, again.userMessage('Next'))
  const next = again.relay(room.id, 'relay-2')
  const one = await turnFor(again.sent)
  await again.answer(one.sessionId, one.message.source.exchangeId, 'One.', 3)
  const two = await turnFor(again.sent, one)
  await again.answer(two.sessionId, two.message.source.exchangeId, 'Two.', 4)
  await next
  await waitFor(() => (existsSync(join(home, 'group-lines', room.id, `${saved.seq}.txt`)) ? undefined : true))
  assert.equal(existsSync(join(home, 'group-lines', room.id, `${saved.seq}.txt`)), false)
  await again.call('delete-room', { id: room.id })
  await waitFor(() => (existsSync(join(home, 'group-lines', room.id)) ? undefined : true))
  assert.equal(existsSync(join(home, 'group-lines', room.id)), false)
})

test('a group line longer than a member reads is cut in its prompt, with its length, and its file keeps only that', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, home, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await emit(room.id, userMessage('Go'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'x'.repeat(25_000), 1)
  const second = await turnFor(sent, first)
  const prompt = second.message.content[0].text
  assert.ok(prompt.includes(`${'x'.repeat(20_000)}… (cut; 25000 characters in all)`))
  assert.ok(!prompt.includes('x'.repeat(20_001)))
  await answer(second.sessionId, second.message.source.exchangeId, 'Ok.', 2)
  await running
  const line = rt.state.rooms[room.id].log.find(entry => entry.length === 25_000)
  assert.equal(readFileSync(join(home, 'group-lines', room.id, `${line.seq}.txt`), 'utf8').length, 20_000)
})

// 公开#176: a PDF the user sent in a group reached neither the log nor any member, so
// every Bot said it could not read it; in a Bot's own chat the same file worked.
test('a file the user sends in a group reaches each member the line is shown to, once', async (t) => {
  const { call, emit, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  const pdf = { attachmentId: 'sha256:39cb3dab00', name: 'report-XYZ176.pdf', bytes: 607 }
  await emit(room.id, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Read this PDF' }, { type: 'file', attachment: pdf }] } })
  let running = relay(room.id, 'r1')
  const first = await turnFor(sent)
  const files = message => message.content.filter(block => block.type === 'file').map(block => block.attachment)
  assert.deepEqual(files(first.message), [pdf])
  assert.match(first.message.content[0].text, /User: Read this PDF\n\[File "report-XYZ176\.pdf" \(607 bytes\) attached\]/)
  await answer(first.sessionId, first.message.source.exchangeId, 'Reading it.', 1)
  const second = await turnFor(sent, first)
  assert.deepEqual(files(second.message), [pdf])
  await answer(second.sessionId, second.message.source.exchangeId, 'Me too.', 2)
  await running
  assert.deepEqual(rt.roomOf(room.id).log.find(line => line.who === 'User').files, [pdf])

  sent.length = 0
  await emit(room.id, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Thanks' }] } })
  running = relay(room.id, 'r2')
  const next = await turnFor(sent)
  assert.deepEqual(files(next.message), [])
  await answer(next.sessionId, next.message.source.exchangeId, 'OK.', 3)
  const after = await turnFor(sent, next)
  await answer(after.sessionId, after.message.source.exchangeId, 'OK.', 4)
  await running
})

// #206: a Bot's post past 20,000 characters goes as a file; the line keeps the file and
// each member it is shown to gets it with its prompt.
test('a long post goes to the group as a file, and reaches the member with its prompt', async (t) => {
  const { call, emit, relay, answer, stop, sent, ctx, rt } = start()
  t.after(stop)
  const store = fakeAttachments()
  ctx.get = name => (name === 'attachments' ? store : undefined)
  const room = await team(call, sent)
  const chief = rt.state.mainBotIds[0]
  const long = `${Array.from({ length: 400 }, (_, at) => `第 ${at + 1} 行：${'报告内容。'.repeat(10)}`).join('\n')}\n结尾`
  const posted = await rt.teamTools.find(d => d.name === 'post_to_group').execute({ group: 'R1', message: long }, { agent: { id: rt.chatOf(chief) } })
  assert.match(posted, /^Posted in "R1"/)
  const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  const file = post.message.content.find(block => block.type === 'file')?.attachment
  assert.equal(file?.name, 'Post from Chief.txt')
  assert.equal(post.message.source.length, long.length)
  assert.equal(new TextDecoder().decode(store.files.get(file.attachmentId)), long)

  sent.length = 0
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  const running = relay(room.id, 'relay')
  const turn = await turnFor(sent)
  assert.deepEqual(turn.message.content.filter(block => block.type === 'file').map(block => block.attachment), [file])
  const prompt = turn.message.content[0].text
  assert.ok(prompt.includes(`Chief: [A long message: ${long.length} characters.`))
  assert.ok(prompt.includes(`[File "Post from Chief.txt" (${file.bytes} bytes) attached]`))
  assert.ok(prompt.length < 6000, `the prompt has ${prompt.length} characters`)
  await answer(turn.sessionId, turn.message.source.exchangeId, 'Read it.', 1)
  await running
  const line = rt.state.rooms[room.id].log.find(entry => entry.botId === chief)
  assert.deepEqual(line.files, [file])
  assert.equal(line.length, undefined, 'the line is short; no file of its own')
})

// #395: the per-member and per-round turn bounds dropped calls in silence — a
// "@Name" the user sent mid-round could vanish the same way. Now a member's turns
// are not capped and every user message is answered; the only bound is the group's
// relay limit, at which calls the Bot-to-Bot chain would make park instead of
// dropping, until the user continues or writes in the group.
test('a user @ mid-round reaches a member however often it already spoke', async (t) => {
  const { call, emit, userMessage, compose, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin', relayLimit: 20 })
  const writer = Object.values(rt.state.bots).find(bot => bot.name === 'Writer')

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')

  // The admin and the Writer trade calls ten times: nothing caps a member's turns
  // any more, so each speaks as often as the relay limit leaves room for.
  const spoken = []
  let turn = await turnFor(sent)
  for (let step = 0; step < 10; step += 1) {
    spoken.push(turn)
    await answer(turn.sessionId, turn.message.source.exchangeId, `${step % 2 === 0 ? '@Writer' : '@Chief'} volley ${step + 1}`, step + 1)
    turn = await turnFor(sent, ...spoken)
  }
  const writerSession = rt.state.rooms[room.id].sessions[writer.id]
  assert.equal(sent.filter(entry => entry.sessionId === writerSession && entry.message.source.role === 'room').length,
    5, 'the Writer answered five calls in one round; the old cap would have dropped the fifth')

  // While the admin answers its sixth turn the user @s the Writer. The user's own
  // calls never park: the Writer hears it right after the admin.
  await compose(room.id, '@Writer your take?')
  await answer(turn.sessionId, turn.message.source.exchangeId, 'Done.', 11)
  const called = await turnFor(sent, ...spoken, turn)
  assert.equal(called.sessionId, writerSession)
  assert.match(called.message.content[0].text, /@Writer your take\?/)
  assert.match(called.message.content[0].text, /the user mentioned you/)
  await answer(called.sessionId, called.message.source.exchangeId, 'Here.', 12)
  const result = JSON.parse(await running)
  assert.equal(result.replies.filter(reply => reply.kind === 'paused').length, 0)
})

test('calls past the relay limit park until the user goes on, and the group is told once', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt, home } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const editor = (await call('create-bot', { name: 'Editor' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, writer.id, editor.id] })).value
  await call('update-room', { id: room.id, mode: 'admin', relayLimit: 2 })
  sent.length = 0

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, '@Writer one', 1)
  const second = await turnFor(sent, first)
  await answer(second.sessionId, second.message.source.exchangeId, '@Chief back', 2)
  const third = await turnFor(sent, first, second)
  // The next calls would be the third relay, past the limit: both wait instead of
  // running, and the log does not show a hand-off that never starts.
  await answer(third.sessionId, third.message.source.exchangeId, '@Writer again, @Editor too', 3)
  const result = JSON.parse(await running)

  const state = rt.state.rooms[room.id]
  assert.equal(sent.filter(entry => entry.message.source.role === 'room').length, 3, 'the parked calls never reached their members')
  const notices = state.log.filter(line => line.kind === 'notice')
  assert.equal(notices.length, 1, 'one notice for the pause, not one per parked call')
  assert.deepEqual({ reason: notices[0].reason, names: notices[0].names, limit: notices[0].limit },
    { reason: 'paused', names: ['Writer', 'Editor'], limit: 2 })
  assert.match(lineText(notices[0]), /Paused: Bots have called each other 2 times since the user last wrote here/)
  assert.match(lineText(notices[0]), /@Writer and @Editor wait/)
  // The round the user watched shows the same pause as one line of its replies —
  // and nothing is marked dropped.
  assert.deepEqual(result.replies.filter(reply => reply.kind === 'paused').map(reply => [reply.names, reply.count]),
    [[['Writer', 'Editor'], 2]])
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms[room.id]
  assert.deepEqual(saved.paused.map(entry => [entry.id, entry.name, entry.note, entry.by]),
    [[writer.id, 'Writer', 'Chief mentioned you', chief], [editor.id, 'Editor', 'Chief mentioned you', chief]])
})

test('Continue runs the parked calls in a round of their own, and a free group ignores it', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin', relayLimit: 2 })
  const writer = Object.values(rt.state.bots).find(bot => bot.name === 'Writer')
  const state = rt.state.rooms[room.id]

  // Nothing parked yet: Continue is a no-op and sends no relay.
  sent.length = 0
  await call('room-continue', { roomId: room.id })
  assert.equal(sent.filter(entry => entry.message.source?.role === 'resume').length, 0)

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, '@Writer one', 1)
  const second = await turnFor(sent, first)
  await answer(second.sessionId, second.message.source.exchangeId, '@Chief back', 2)
  const third = await turnFor(sent, first, second)
  await answer(third.sessionId, third.message.source.exchangeId, '@Writer again', 3)
  await running
  assert.equal(state.paused.length, 1)
  assert.equal(state.paused[0].id, writer.id)

  // Continue: the count restarts and a resume relay runs the parked call.
  sent.length = 0
  assert.equal((await call('room-continue', { roomId: room.id })).ok, true)
  assert.equal(state.relays, 0)
  const resume = sent.find(entry => entry.sessionId === room.id && entry.message.source?.role === 'resume')
  assert.ok(resume, 'Continue sends a resume relay to the group Session')
  await emit(room.id, { type: 'user/message', data: { source: resume.message.source, content: resume.message.content } })
  const running2 = relay(room.id, 'relay-2')
  const turn = await turnFor(sent)
  assert.equal(turn.sessionId, state.sessions[writer.id], 'the parked call runs')
  await answer(turn.sessionId, turn.message.source.exchangeId, 'Back on it.', 4)
  await running2
  assert.deepEqual(state.paused, [])
})

test('a user message after a pause answers the user first, then runs the parked call', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin', relayLimit: 2 })
  const chief = rt.state.mainBotIds[0]
  const writer = Object.values(rt.state.bots).find(bot => bot.name === 'Writer')
  const state = rt.state.rooms[room.id]

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, '@Writer one', 1)
  const second = await turnFor(sent, first)
  await answer(second.sessionId, second.message.source.exchangeId, '@Chief back', 2)
  const third = await turnFor(sent, first, second)
  await answer(third.sessionId, third.message.source.exchangeId, '@Writer again', 3)
  await running
  assert.equal(state.paused.length, 1)

  sent.length = 0
  await emit(room.id, userMessage('@Chief one more question'))
  const next = relay(room.id, 'relay-2')
  const own = await turnFor(sent)
  assert.equal(own.sessionId, state.sessions[chief], 'the member the user called answers first')
  await answer(own.sessionId, own.message.source.exchangeId, 'Yes?', 4)
  const parked = await turnFor(sent, own)
  assert.equal(parked.sessionId, state.sessions[writer.id], 'the parked call runs after the user\'s speaker')
  await answer(parked.sessionId, parked.message.source.exchangeId, 'On it.', 5)
  await next
  assert.equal(state.relays, 1, 'the count restarted with the user\'s message; the parked call counts into it')
  assert.deepEqual(state.paused, [])
})

test('a user message mid-round restarts the relay count for the calls after it', async (t) => {
  const { call, emit, userMessage, compose, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin', relayLimit: 3 })
  const state = rt.state.rooms[room.id]

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, '@Writer one', 1)
  const second = await turnFor(sent, first)
  await answer(second.sessionId, second.message.source.exchangeId, '@Chief back', 2)
  const third = await turnFor(sent, first, second)

  // Two relays spent of three. While the admin answers, the user writes; its
  // message restarts the count, so the call the Writer then makes does not park.
  await compose(room.id, '@Writer hold on')
  await answer(third.sessionId, third.message.source.exchangeId, 'Done.', 3)
  const fourth = await turnFor(sent, first, second, third)
  await answer(fourth.sessionId, fourth.message.source.exchangeId, '@Chief last', 4)
  const fifth = await turnFor(sent, first, second, third, fourth)
  assert.ok(fifth, 'the Writer\'s call runs: the count restarted at the user\'s message')
  await answer(fifth.sessionId, fifth.message.source.exchangeId, 'All done.', 5)
  const result = JSON.parse(await running)
  assert.equal(result.replies.filter(reply => reply.kind === 'paused').length, 0)
  assert.equal(state.relays, 1)
})

// A group the user has not written in since the limit came in carries no count at
// all: a Bot's own post must count from zero, not from NaN, and still park.
test('a round a Bot opens counts relays from nothing, and parks past the limit', async (t) => {
  const { call, emit, relay, answer, stop, sent, rt, home } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin', relayLimit: 1 })
  const state = rt.state.rooms[room.id]
  const chief = rt.state.mainBotIds[0]
  assert.equal(state.relays, undefined, 'no user message ever: there is no count yet')

  sent.length = 0
  const posted = await rt.teamTools.find(d => d.name === 'post_to_group').execute({ group: 'R1', message: '@Writer ping' }, { agent: { id: rt.chatOf(chief) } })
  assert.match(posted, /^Posted in "R1"/)
  const post = sent.find(entry => entry.sessionId === room.id && entry.message.source.role === 'post')
  assert.ok(post, 'the Bot\'s post reached the group Session')
  await emit(room.id, { type: 'user/message', data: { source: post.message.source, content: post.message.content } })
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, '@Chief back', 1)
  await running
  // The first call ran as relay 1; the call it made is over the limit and parked.
  assert.equal(state.relays, 1)
  assert.deepEqual(state.paused.map(entry => entry.name), ['Chief'])
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).rooms[room.id]
  assert.equal(saved.relays, 1, 'a whole number is saved, not NaN')
})

test('the relay limit is the user\'s to set, not a member\'s', async (t) => {
  const { call, stop, rt } = start()
  t.after(stop)
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const chief = rt.state.mainBotIds[0]
  const room = (await call('create-room', { name: 'R1', members: [chief, writer.id] })).value
  // The group's admin and a Main Bot may change its other settings; the limit stays
  // the user's. A plain member is refused earlier, like for any change.
  await assert.rejects(rt.updateRoom(room.id, { relayLimit: 4 }, chief), /Only the user can set the relay limit of "R1"/)
  await assert.rejects(rt.updateRoom(room.id, { relayLimit: 4 }, writer.id), /can change it/)
})

test('a member the reply timeout cut short is told to the group, not left as silence', async (t) => {
  const { call, emit, userMessage, relay, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin' })

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const turn = await turnFor(sent)
  // The 4-minute reply timeout, fired now instead of in four minutes: the round
  // moves on without the member, and the group is told the baton was dropped.
  rt.roomWaiters.get(turn.message.source.exchangeId).resolve({ missed: true })
  await running

  const notices = rt.state.rooms[room.id].log.filter(line => line.kind === 'notice')
  assert.equal(notices.length, 1)
  assert.deepEqual({ reason: notices[0].reason, names: notices[0].names, minutes: notices[0].minutes },
    { reason: 'missed', names: ['Chief'], minutes: 4 })
  assert.match(lineText(notices[0]), /did not answer within 4 minutes/)
  assert.match(lineText(notices[0]), /late reply/)
})

// #512: in admin mode the user's message goes to the admin alone. When the admin
// passes, the round ends with nothing said, so the group says what to do about it.
test('in admin mode a sole admin that passes leaves the group a notice', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  const chief = (await call('state', {})).value.mainBotId
  await call('update-room', { id: room.id, mode: 'admin' })

  // The user names a member without "@": nobody is called, the admin alone answers.
  await emit(room.id, userMessage('Writer, what do you think?'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  assert.ok(first, 'the admin gets the turn alone')
  await answer(first.sessionId, first.message.source.exchangeId, '[PASS]', 1)
  const result = JSON.parse(await running)
  assert.deepEqual(result.passed, ['Chief'])
  assert.equal(result.replies.filter(reply => reply.kind === undefined).length, 0, 'the round ends without an answer')

  // The user sees the notice in the round, not only the log.
  const events = result.replies.filter(reply => reply.kind === 'admin-passed')
  assert.equal(events.length, 1, 'the round shows the notice once')
  assert.deepEqual({ botId: events[0].botId, name: events[0].name },
    { botId: chief, name: 'Chief' })

  const notices = rt.state.rooms[room.id].log.filter(line => line.kind === 'notice')
  assert.equal(notices.length, 1, 'the group is told once')
  assert.deepEqual({ reason: notices[0].reason, names: notices[0].names },
    { reason: 'admin-passed', names: ['Chief'] })
  assert.match(lineText(notices[0]), /did not answer or call anyone/)
  assert.match(lineText(notices[0]), /@Name/)

  // The notice is in the group: the next member to speak reads it.
  await emit(room.id, userMessage('Anyone there?'))
  const next = relay(room.id, 'relay-2')
  const turn = await turnFor(sent, first)
  assert.match(turn.message.content[0].text, /did not answer or call anyone/)
  await answer(turn.sessionId, turn.message.source.exchangeId, 'Here.', 2)
  await next
})

test('in admin mode an admin that answers leaves the group no notice', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin' })

  await emit(room.id, userMessage('Writer, what do you think?'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'On it.', 1)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Chief'])
  assert.equal(result.replies.filter(reply => reply.kind === 'admin-passed').length, 0)
  assert.deepEqual(rt.state.rooms[room.id].log.filter(line => line.kind === 'notice'), [])
})

test('in admin mode a member the user called alone is not the admin, and the group says nothing', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin' })

  await emit(room.id, userMessage('@Writer your take'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  assert.ok(first, 'the member the user called answers')
  await answer(first.sessionId, first.message.source.exchangeId, '[PASS]', 1)
  const result = JSON.parse(await running)
  assert.deepEqual(result.passed, ['Writer'])
  assert.deepEqual(result.replies, [], 'the member passed, and the admin was not alone')
  assert.deepEqual(rt.state.rooms[room.id].log.filter(line => line.kind === 'notice'), [])
})

test('a group where everyone answers says nothing when the admin passes', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, '[PASS]', 1)
  const second = await turnFor(sent, first)
  await answer(second.sessionId, second.message.source.exchangeId, 'Writer here.', 2)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.map(reply => reply.name ?? 'User'), ['Writer'])
  assert.equal(result.replies.filter(reply => reply.kind === 'admin-passed').length, 0)
  assert.deepEqual(rt.state.rooms[room.id].log.filter(line => line.kind === 'notice'), [])
})

test('a member still at work is shown with the group messages it has not read yet', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const editor = (await call('create-bot', { name: 'Editor' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, writer.id, editor.id] })).value
  await call('update-room', { id: room.id, mode: 'everyone' })
  sent.length = 0

  // First round: every member speaks once, so each has a group Session and a `seen`.
  await emit(room.id, userMessage('hello'))
  const first0 = relay(room.id, 'relay-1')
  const spoken = []
  for (const text of ['Chief here.', 'Writer here.', 'Editor here.']) {
    const turn = await turnFor(sent, ...spoken)
    await answer(turn.sessionId, turn.message.source.exchangeId, text, 1)
    spoken.push(turn)
  }
  await first0

  // Second round. Editor starts a turn of its own and does not finish it, so when
  // the round calls it, it is at earlier work and the round moves on.
  await emit(room.id, userMessage('again'))
  const second0 = relay(room.id, 'relay-2')
  const chiefTurn = await turnFor(sent, ...spoken)
  await emit(rt.state.rooms[room.id].sessions[editor.id], { type: 'turn/start', data: { turn: 9 } })
  await answer(chiefTurn.sessionId, chiefTurn.message.source.exchangeId, 'Chief again.', 2)
  spoken.push(chiefTurn)

  // The Writer's prompt names Editor as still at work, with the group lines Editor
  // has not read: the user's message and the Chief's answer since Editor last spoke.
  const writerTurn = await turnFor(sent, ...spoken)
  assert.match(writerTurn.message.content[0].text, /Editor \(1 min, with [1-9]\d* group message\(s\) it has not read yet\)/)
  await answer(writerTurn.sessionId, writerTurn.message.source.exchangeId, 'Writer again.', 2)
  await second0
})

test('a user message that opens a round restarts the relay count, as a queued one does', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent, rt } = start()
  t.after(stop)
  const room = await team(call, sent)
  await call('update-room', { id: room.id, mode: 'admin', relayLimit: 3 })

  await emit(room.id, userMessage('Start'))
  const first = relay(room.id, 'relay-1')
  const turn = await turnFor(sent)
  await answer(turn.sessionId, turn.message.source.exchangeId, 'Ready.', 1)
  await first

  const state = rt.state.rooms[room.id]
  // The Bot chain has already spent its relays. A message the user writes between
  // rounds opens a round of its own rather than waiting in an inbox, and it has to
  // restart the count there too.
  state.relays = 3
  await emit(room.id, userMessage('carry on'))
  const second = relay(room.id, 'relay-2')
  const again = await turnFor(sent, turn)
  await answer(again.sessionId, again.message.source.exchangeId, '@Writer go', 2)
  const writer = await turnFor(sent, turn, again)
  assert.ok(writer, 'the call runs: the user\'s message restarted the count')
  await answer(writer.sessionId, writer.message.source.exchangeId, 'On it.', 3)
  await second
  assert.equal(state.relays, 1)
})
