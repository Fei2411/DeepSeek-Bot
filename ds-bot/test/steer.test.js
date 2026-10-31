import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { turnOf } from '../src/host/resume.js'
import { fakeContext } from './fake-ctx.js'
import { SOURCE_KIND, STEER_CUT } from '../src/host/constants.js'

// A user steer in a private Bot chat detaches a running shell call into a
// promoted job and cuts a running model call, so the steer is claimed at once.
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'dm-a', createdAt: 1 } },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

const SHELL_SCHEMA = { oneOf: [
  { properties: { kind: { const: 'foreground' }, exitCode: {} } },
  { properties: { kind: { const: 'promoted' }, cwd: {}, jobId: {}, timeoutMs: {}, output: {} } },
  { properties: { kind: { const: 'background' }, jobId: {} } },
] }

const shellDef = (name = 'pwsh') => {
  const calls = []
  return {
    calls,
    name,
    description: 'shell',
    output: {
      schema: SHELL_SCHEMA,
      render: (args, value) => [{ type: 'text', text: `exit ${value?.exitCode ?? '?'} out:${value?.stdout?.text ?? ''}` }],
    },
    execute: (args) => new Promise((res, rej) => { calls.push({ args, res, rej }) }),
  }
}

const jobsService = (read) => ({ read })

let rt
const start = async ({ services = {}, def = shellDef() } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-steer-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services })
  const agentMap = new Map()
  const deliveries = []
  const inboxOf = () => {
    const nextStep = []
    const nextTurn = []
    return { nextStep, nextTurn,
      prepend: (t, m) => (t === 'next-turn' ? nextTurn : nextStep).unshift(m),
      append: (t, m) => (t === 'next-turn' ? nextTurn : nextStep).push(m),
      remove: mid => { for (const l of [nextStep, nextTurn]) { const at = l.findIndex(m => m.id === mid); if (at !== -1) { l.splice(at, 1); return true } } return false },
    }
  }
  const calls = []
  const agentOf = (id, over = {}) => {
    const inbox = inboxOf()
    const agent = {
      id,
      session: { id, header: { cwd: '/team' } },
      ctx: { tools: { register: t => (calls.push(['register', t]), () => {}), restrict: () => () => {} }, on: () => () => {}, effect: execute => execute?.() },
      status: 'running',
      followup: msg => calls.push(['followup', msg]),
      inject: msg => calls.push(['inject', msg]),
      send: (msg, target) => inbox[target === 'next-turn' ? 'nextTurn' : 'nextStep'].push(msg),
      cancel: (cause, options) => calls.push(['cancel', cause, options]),
      inbox,
      ...over,
    }
    agentMap.set(id, agent)
    return agent
  }
  const agentById = agentOf('dm-a')
  ctx.tools.register({ ...def })
  ctx.tools.schemas = () => [{ name: 'pwsh' }, { name: 'bash' }, { name: 'ask_user_question' }]
  ctx.tools.get = (name) => (name === def.name ? def : undefined)
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => ({ id: 'w1', path: '/team' }), list: () => [{ id: 'w1', path: '/team' }], resolveByPath: async () => undefined, create: async p => ({ id: 'w1', path: p }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 'dm-a' }), resolveAgent: async () => ({ agent: agentById }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const origGet = ctx.get
  Object.assign(ctx, { get: name => (name === 'agents' ? agentMap : origGet(name)) })
  rt = createRuntime(ctx, { home })
  await rt.load?.()
  const origDeliver = rt.deliver
  rt.deliver = (...args) => { deliveries.push(args); return origDeliver ? origDeliver(...args) : Promise.resolve() }
  const emit = async (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) await listener({ id }, { type, data })
    }
    await new Promise(r => setTimeout(r, 0))
  }
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  const shadowOf = () => calls.find(c => c[0] === 'register')?.[1]
  return { ctx, emit, stop, rt, agent: agentById, agentMap, calls, deliveries, shadowOf }
}

const userMessage = text => ({ id: `m-${text}`, content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' })
const execOf = (agent, callId = 'c1') => ({ agent, callId, name: 'pwsh', signal: AbortSignal.timeout(30_000) })

test('shell shadow: no steer returns the native value as is', async () => {
  const { stop, rt, agent, shadowOf } = await start({ services: { jobs: jobsService(() => { throw new Error('no job') }) } })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const NATIVE = { kind: 'foreground', exitCode: 0 }
  const pending = shadow.execute({ command: 'pwd' }, execOf(agent))
  shadow.calls[0].res(NATIVE)
  assert.equal(await pending, NATIVE)
  await stop()
})

test('shell shadow: steer promotes the call and native settle notifies later', async () => {
  const { emit, stop, rt, agent, calls, shadowOf } = await start({ services: { jobs: jobsService((jobId) => ({
    job: { id: jobId, status: 'running', output: { spillPaths: ['/tmp/j1.log'] } },
    lossy: true,
    chunks: [
      { text: 'one', channel: 'stdout' },
      { text: 'oops', channel: 'stderr' },
      { text: 'two', channel: 'stdout' },
      { text: 'hidden', channel: 'log' },
    ],
  })) } })
  await emit('dm-a', 'turn/start', { turn: 1 })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'sleep 5', workdir: 'sub' }, execOf(agent))
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('hurry')] })
  await emit('dm-a', 'job/registered', { jobId: 'j1', toolCall: { callId: 'c1' } })
  const value = await pending
  assert.equal(value.kind, 'promoted')
  assert.equal(value.jobId, 'j1')
  assert.equal(value.cwd, resolve('/team', 'sub'))
  assert.equal(value.output, 'onetwo\n[stderr]\noops\n[some output was dropped from memory; full output: /tmp/j1.log]')
  agent.status = 'idle'
  shadow.calls[0].res({ kind: 'foreground', exitCode: 0, stdout: { text: 'done' } })
  await new Promise(r => setTimeout(r, 0))
  const notice = calls.find(c => c[0] === 'followup')
  assert.ok(notice !== undefined)
  assert.equal(notice[1].content[0].text, 'background job j1 (pwsh: sleep 5) finished:\nexit 0 out:done')
  assert.equal(notice[1].source.kind, 'tool-jobs')
  await stop()
})

test('shell shadow: steer pending at call start keeps the native value inside the grace', async () => {
  const { stop, rt, agent, shadowOf } = await start({ services: { jobs: jobsService(() => { throw new Error('no job') }) } })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  agent.inbox.nextStep.push(userMessage('waiting'))
  const pending = shadow.execute({ command: 'pwd' }, execOf(agent))
  // The native settles at once, inside the grace, so its own value comes back.
  const NATIVE = { kind: 'foreground', exitCode: 9 }
  shadow.calls[0].res(NATIVE)
  assert.equal(await pending, NATIVE)
  await stop()
})

test('shell shadow: steer before job registration detaches once registered', async () => {
  const { emit, stop, rt, agent, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'running', output: {} }, chunks: [{ text: 'x' }],
  })) } })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'sleep 5' }, execOf(agent))
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('go')] })
  await new Promise(r => setTimeout(r, 1100))
  await emit('dm-a', 'job/registered', { jobId: 'j2', toolCall: { callId: 'c1' } })
  const value = await pending
  assert.equal(value.kind, 'promoted')
  assert.equal(value.jobId, 'j2')
  await stop()
})

test('shell shadow: a native rejection before any steer propagates unchanged', async () => {
  const { stop, rt, agent, shadowOf } = await start({ services: { jobs: jobsService(() => ({ job: { status: 'running', output: {} }, chunks: [] })) } })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const err = new Error('spawn failed')
  const pending = shadow.execute({ command: 'pwd' }, execOf(agent))
  shadow.calls[0].rej(err)
  await assert.rejects(pending, e => e === err)
  await stop()
})

test('shell shadow: non-private session, run_in_background and no jobs are passthrough', async () => {
  const { rt, agent, calls } = await start({ services: { jobs: jobsService(() => { throw new Error('x') }) } })
  const { rt: rt2, stop: stop2, agent: noJobsAgent, shadowOf: noJobsShadow } = await start({ services: {} })
  rt.shadowShells(agent)
  const shadow = calls.find(c => c[0] === 'register')?.[1]
  const NATIVE = { kind: 'foreground' }
  // run_in_background on the private chat is untouched.
  const p1 = shadow.execute({ command: 'pwd', run_in_background: true }, execOf(agent))
  shadow.calls[0].res(NATIVE)
  assert.equal(await p1, NATIVE)
  // A non-Bot session is untouched.
  const other = { ...agent, id: 'plain', session: { id: 'plain' } }
  const p2 = shadow.execute({ command: 'pwd' }, execOf(other))
  shadow.calls[1].res(NATIVE)
  assert.equal(await p2, NATIVE)
  // No jobs service at all is untouched.
  rt2.shadowShells(noJobsAgent)
  const shadow2 = noJobsShadow()
  const p3 = shadow2.execute({ command: 'pwd' }, execOf(noJobsAgent))
  shadow2.calls[0].res(NATIVE)
  assert.equal(await p3, NATIVE)
  await stop2()
})

test('shell shadow: a def without a promoted variant is not shadowed', async () => {
  const def = shellDef()
  def.output.schema = { oneOf: [{ properties: { kind: { const: 'foreground' } } }] }
  const { rt, agent, calls } = await start({ services: { jobs: jobsService(() => ({})) }, def })
  rt.shadowShells(agent)
  assert.equal(calls.find(c => c[0] === 'register' && c[1].name === 'pwsh'), undefined)
})

test('shell shadow: a killed job gets no notice', async () => {
  const { emit, stop, rt, agent, calls, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'running', output: {} }, chunks: [],
  })) } })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'sleep 5' }, execOf(agent))
  await emit('dm-a', 'job/registered', { jobId: 'j1', toolCall: { callId: 'c1' } })
  await emit('dm-a', 'tool/call', { name: 'job_kill', arguments: JSON.stringify({ job_id: 'j1' }) })
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('go')] })
  assert.equal((await pending).kind, 'promoted')
  shadow.calls[0].res({ kind: 'foreground', exitCode: 0, stdout: { text: 'x' } })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(calls.find(c => c[0] === 'followup' || c[0] === 'inject'), undefined)
  await stop()
})

test('shell shadow: a replaced agent gets no notice', async () => {
  const { emit, stop, rt, agent, agentMap, calls, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'running', output: {} }, chunks: [],
  })) } })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'sleep 5' }, execOf(agent))
  await emit('dm-a', 'job/registered', { jobId: 'j1', toolCall: { callId: 'c1' } })
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('go')] })
  assert.equal((await pending).kind, 'promoted')
  agentMap.set('dm-a', { id: 'dm-a' })
  shadow.calls[0].res({ kind: 'foreground', exitCode: 0, stdout: { text: 'x' } })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(calls.find(c => c[0] === 'followup' || c[0] === 'inject'), undefined)
  await stop()
})

test('shell shadow: a terminal job read returns the native result', async () => {
  const { emit, stop, rt, agent, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'completed', output: {} }, chunks: [],
  })) } })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'pwd' }, execOf(agent))
  await emit('dm-a', 'job/registered', { jobId: 'j1', toolCall: { callId: 'c1' } })
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('go')] })
  const NATIVE = { kind: 'foreground', exitCode: 3 }
  shadow.calls[0].res(NATIVE)
  assert.equal(await pending, NATIVE)
  await stop()
})

test('shell shadow: a native promoted after detach injects only with output', async () => {
  const { emit, stop, rt, agent, calls, shadowOf } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'running', output: {} }, chunks: [],
  })) } })
  rt.shadowShells(agent)
  const shadow = shadowOf()
  const pending = shadow.execute({ command: 'sleep 5' }, execOf(agent))
  await emit('dm-a', 'job/registered', { jobId: 'j1', toolCall: { callId: 'c1' } })
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('go')] })
  assert.equal((await pending).kind, 'promoted')
  shadow.calls[0].res({ kind: 'promoted', jobId: 'j1', output: 'still going' })
  await new Promise(r => setTimeout(r, 0))
  const notice = calls.find(c => c[0] === 'inject')
  assert.ok(notice !== undefined)
  assert.match(notice[1].content[0].text, /is still running\. Output since your last read:\nstill going/)
  await stop()
})

test('shell shadow: bash is shadowed the same way', async () => {
  const def = shellDef('bash')
  const { emit, stop, rt, agent, calls, } = await start({ services: { jobs: jobsService(jobId => ({
    job: { id: jobId, status: 'running', output: {} }, chunks: [],
  })) }, def })
  rt.shadowShells(agent)
  const shadow = calls.find(c => c[0] === 'register' && c[1].name === 'bash')?.[1]
  assert.ok(shadow !== undefined)
  const pending = shadow.execute({ command: 'sleep 5' }, { agent, callId: 'b1', name: 'bash' })
  await emit('dm-a', 'job/registered', { jobId: 'jb', toolCall: { callId: 'b1' } })
  await emit('dm-a', 'agent/inbox/spliced', { target: 'next-step', inserted: [userMessage('go')] })
  assert.equal((await pending).kind, 'promoted')
  await stop()
})

// Carry tests: the cut turn's routing state rides into the turn that claims the steer.
test('steer carry: a cut request turn hands its answer on the next turn', async () => {
  const { emit, stop, rt, deliveries } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'user/message', {
    content: [{ type: 'text', text: 'do the thing' }],
    source: { kind: SOURCE_KIND, role: 'request', senderSessionId: 'bot-b', exchangeId: 'x1', senderName: 'Writer' },
  })
  await emit(dm, 'user/message', {
    content: [{ type: 'text', text: 'me too' }],
    source: { kind: SOURCE_KIND, role: 'request', senderSessionId: 'bot-c', exchangeId: 'x2', senderName: 'Ops' },
  })
  await emit(dm, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'half done' }] } })
  rt.markSteerCut(dm)
  await emit(dm, 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'hook', reason: STEER_CUT } } })
  assert.deepEqual(deliveries, [])
  await emit(dm, 'turn/start', { turn: 2 })
  const entry = rt.live.get(dm)
  assert.equal(entry.info?.exchangeId, 'x1')
  assert.equal(entry.joined.length, 1)
  assert.equal(entry.carried, true)
  assert.deepEqual(entry.texts, ['half done'])
  await emit(dm, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] } })
  await emit(dm, 'turn/end', { reason: { kind: 'completed' } })
  const reply = deliveries.find(d => d[0]?.replyTo === 'x1')
  assert.ok(reply !== undefined)
  assert.match(reply[0].text, /half done/)
  assert.match(reply[0].text, /all done/)
  const handback = deliveries.find(d => d[0]?.deferred === true)
  assert.ok(handback !== undefined)
  assert.equal(handback[0].exchangeId, 'x2')
  await stop()
})

test('steer carry: a plain user turn delivers nothing for the cut turn', async () => {
  const { emit, stop, rt, deliveries } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
  await emit(dm, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'half' }] } })
  rt.markSteerCut(dm)
  await emit(dm, 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'hook', reason: STEER_CUT } } })
  assert.deepEqual(deliveries, [])
  await emit(dm, 'turn/start', { turn: 2 })
  assert.deepEqual(rt.live.get(dm).texts, ['half'])
  await stop()
})

test('steer carry: a cut turn that ends on error keeps normal failure handling', async () => {
  const { emit, stop, rt, deliveries } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'user/message', {
    content: [{ type: 'text', text: 'do it' }],
    source: { kind: SOURCE_KIND, role: 'request', senderSessionId: 'bot-b', exchangeId: 'x1', senderName: 'Writer' },
  })
  rt.markSteerCut(dm)
  await emit(dm, 'turn/end', { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: 'over' } } })
  assert.equal(rt.live.get(dm).carry, undefined)
  const failed = deliveries.find(d => /could not answer/.test(d[0]?.text ?? ''))
  assert.ok(failed !== undefined)
  assert.equal(failed[0].replyTo, 'x1')
  await stop()
})

test('steer carry: a pending request survives a carry that reclaims the trigger', async () => {
  const { emit, stop, rt, deliveries } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'user/message', {
    content: [{ type: 'text', text: 'do the thing' }],
    source: { kind: SOURCE_KIND, role: 'request', senderSessionId: 'bot-b', exchangeId: 'x1', senderName: 'Writer' },
  })
  await emit(dm, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'half done' }] } })
  rt.markSteerCut(dm)
  await emit(dm, 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'hook', reason: STEER_CUT } } })
  assert.deepEqual(deliveries, [])
  // Another request lands between the cut and the next turn: it waits as pending.
  await emit(dm, 'user/message', {
    content: [{ type: 'text', text: '[Ops → Chief]\nme later' }],
    source: { kind: SOURCE_KIND, role: 'request', senderSessionId: 'bot-c', exchangeId: 'x2', senderName: 'Ops' },
  })
  await emit(dm, 'turn/start', { turn: 2 })
  const entry = rt.live.get(dm)
  // The carry's own request reclaims the trigger; the pending one joins it deferred.
  assert.equal(entry.info?.exchangeId, 'x1')
  assert.equal(entry.joined.length, 1)
  assert.equal(entry.joined[0].info.exchangeId, 'x2')
  assert.equal(entry.joined[0].text, 'me later')
  await emit(dm, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] } })
  await emit(dm, 'turn/end', { reason: { kind: 'completed' } })
  const reply = deliveries.find(d => d[0]?.replyTo === 'x1')
  assert.ok(reply !== undefined)
  assert.match(reply[0].text, /all done/)
  const handback = deliveries.find(d => d[0]?.deferred === true)
  assert.ok(handback !== undefined)
  assert.equal(handback[0].exchangeId, 'x2')
  assert.ok(!deliveries.some(d => /was stopped/.test(d[0]?.text ?? '')))
  await stop()
})

test('steer cut: a running part switch blocks the cut', async () => {
  const { emit, stop, rt, agent, calls } = await start()
  const dm = 'dm-a'
  // switchJobs() hands back a Map values iterator, never an array.
  const original = rt.switchJobs
  rt.switchJobs = () => new Map([['job', { botId: rt.chatOwners.get(dm) }]]).values()
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'step/start', { turn: 1, step: 1 })
  const steer = userMessage('还没好吗')
  agent.inbox.nextStep.push(steer)
  await emit(dm, 'agent/inbox/spliced', { target: 'next-step', inserted: [steer] })
  assert.equal(calls.find(c => c[0] === 'cancel'), undefined)
  // A group part switch of the same Bot carries a roomId and must not block this cut.
  rt.switchJobs = () => new Map([['job', { botId: rt.chatOwners.get(dm), roomId: 'r1' }]]).values()
  await emit(dm, 'agent/inbox/spliced', { target: 'next-step', inserted: [steer] })
  assert.deepEqual(calls.find(c => c[0] === 'cancel')?.[1], { kind: 'hook', reason: STEER_CUT })
  rt.switchJobs = original
  await stop()
})

// Model-cut tests.
test('steer cut: user steer during model phase cancels with hook and moves steer to next-turn', async () => {
  const { emit, stop, agent, calls } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'step/start', { turn: 1, step: 1 })
  const steer = userMessage('还没好吗')
  agent.inbox.nextStep.push(steer)
  await emit(dm, 'agent/inbox/spliced', { target: 'next-step', inserted: [steer] })
  const cancel = calls.find(c => c[0] === 'cancel')
  assert.deepEqual(cancel?.[1], { kind: 'hook', reason: STEER_CUT })
  assert.deepEqual(cancel?.[2], { keepInbox: true })
  assert.deepEqual(agent.inbox.nextTurn.map(m => m.id), [steer.id])
  await stop()
})

test('steer cut: no cut during tools phase or for a non-Bot session', async () => {
  const { emit, stop, agent, calls } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'step/start', { turn: 1, step: 1 })
  await emit(dm, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call' }] } })
  const steer = userMessage('go')
  agent.inbox.nextStep.push(steer)
  await emit(dm, 'agent/inbox/spliced', { target: 'next-step', inserted: [steer] })
  assert.equal(calls.find(c => c[0] === 'cancel'), undefined)
  await emit('plain', 'agent/inbox/spliced', { target: 'next-step', inserted: [steer] })
  assert.equal(calls.find(c => c[0] === 'cancel'), undefined)
  await stop()
})

test('steer cut: earlier steers and queued next-turn keep order', async () => {
  const { emit, stop, agent } = await start()
  const dm = 'dm-a'
  await emit(dm, 'turn/start', { turn: 1 })
  await emit(dm, 'step/start', { turn: 1, step: 1 })
  const s1 = userMessage('one'); const s2 = userMessage('two')
  agent.inbox.nextStep.push(s1, s2)
  agent.inbox.nextTurn.push(userMessage('queued'))
  await emit(dm, 'agent/inbox/spliced', { target: 'next-step', inserted: [s2] })
  assert.deepEqual(agent.inbox.nextTurn.map(m => m.content[0].text), ['two', 'queued'])
  assert.deepEqual(agent.inbox.nextStep.map(m => m.content[0].text), ['one'])
  await stop()
})

test('steer resume: turnOf follows a steer cut to its continuation', async () => {
  const turn = (n, events = []) => [
    { type: 'turn/start', data: { turn: n } },
    ...events,
  ]
  const said = text => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  const took = exchangeId => ({ type: 'user/message', data: { source: { kind: SOURCE_KIND, role: 'request', exchangeId }, content: [{ type: 'text', text: 'do' }] } })
  const ended = reason => ({ type: 'turn/end', data: { reason } })
  const cut = { kind: 'aborted', reason: { kind: 'hook', reason: STEER_CUT } }

  // A cut turn whose continuation answered: the continuation's reason and the texts
  // merged, with the cut step's interrupted draft dropped.
  const follow = turnOf([
    ...turn(1, [took('x1'), said('a'), { type: 'step/start', data: { turn: 1, step: 2 } }, said('p'), ended(cut)]),
    ...turn(2, [said('b'), ended({ kind: 'completed' })]),
  ], 'x1')
  assert.deepEqual(follow?.reason, { kind: 'completed' })
  assert.deepEqual(follow?.texts, ['a', 'b'])

  // A cut turn with no continuation yet: read as unfinished, not as stopped.
  const dangling = turnOf([
    ...turn(1, [took('x1'), said('a'), ended(cut)]),
  ], 'x1')
  assert.equal(dangling?.reason, undefined)
  assert.deepEqual(dangling?.texts, ['a'])

  // A user stop stays a stop.
  const stopped = turnOf([
    ...turn(1, [took('x1'), ended({ kind: 'aborted', reason: { kind: 'user' } })]),
  ], 'x1')
  assert.deepEqual(stopped?.reason, { kind: 'aborted', reason: { kind: 'user' } })
})
