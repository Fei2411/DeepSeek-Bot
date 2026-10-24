// The result of work a Bot handed on, when it is longer than state.json keeps: the
// whole result has to survive a restart, so the Bot that asked for it gets all of it.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { install as installHandoffs } from '../src/host/handoffs.js'

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 },
    d: { id: 'd', name: 'Editor', role: 'Edit', sessionId: 'd', createdAt: 4 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

// A host over the plugin's own folder. Starting the same folder again is a restart:
// the first host is closed before the second one starts.
async function startHost(home, team) {
  if (team !== undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
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
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await tool('list_bots', {}, 'a')
  return { ctx, agents, agentOf, emit, tool, call, home, stop: () => ctx.dispose() }
}

// The plugin folder of a test, and the hosts over it. A second host over the same
// folder is a restart. Everything is closed and removed when the test ends.
function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-handoff-results-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { home, start: async team => { const host = await startHost(home, team); hosts.push(host); return host } }
}

const textBlock = content => [{ type: 'text', text: content }]
const assistantText = text => ({ message: { content: textBlock(text) } })
const textOf = content => content.map(block => block.text ?? '').join('\n')
const callsOf = (agents, id) => agents.get(id)?.calls ?? []
const settled = async (check) => {
  for (let count = 0; count < 200 && !check(); count += 1) await delay(5)
}

// Each Session takes up the newest message it was sent as its next turn.
function turnTaker(agents, emit) {
  const turns = new Map()
  const open = (id, message) => {
    turns.set(id, (turns.get(id) ?? 0) + 1)
    emit(id, 'turn/start', { turn: turns.get(id) })
    emit(id, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const take = id => open(id, agents.get(id).calls.at(-1)[1])
  const end = (id, text) => {
    if (text !== undefined) emit(id, 'assistant/message', assistantText(text))
    emit(id, 'turn/end', { turn: turns.get(id), reason: { kind: 'completed' } })
  }
  const userTurn = (id, text) => {
    turns.set(id, (turns.get(id) ?? 0) + 1)
    emit(id, 'turn/start', { turn: turns.get(id) })
    emit(id, 'user/message', { content: textBlock(text), source: { kind: 'user' } })
  }
  return { take, open, end, userTurn }
}

// The works the team file holds, once the saves made so far are done.
const worksIn = async ({ call, home }) => {
  await call('set-prefs', {})
  return JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).works ?? {}
}
const keptIn = home => (existsSync(join(home, 'handoff-results')) ? readdirSync(join(home, 'handoff-results')) : [])

// Chief asks Writer, which hands part of it on to Tester, which answers.
async function handedOn({ start }, review) {
  const first = await start(seed())
  const { agents, emit, tool } = first
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'have Writer do it')
  await tool('message_bot', { to: 'Writer', message: 'carry out the plan' }, 'a')
  turns.end('a', 'asked Writer')
  turns.take('b')
  await tool('message_bot', { to: 'Tester', message: 'review my work' }, 'b')
  turns.end('b', 'handed it on')
  turns.take('c')
  turns.end('c', review)
  await settled(() => callsOf(agents, 'b').length === 2)
  return { first, agents, result: callsOf(agents, 'b')[1][1] }
}

const LONG = '审查意见。'.repeat(1000)

test('a result longer than 2,000 characters survives a restart before the Bot that asked for it answers', async (t) => {
  const { home, start } = bench(t)
  const { first, result } = await handedOn({ start }, LONG)
  // The whole result is in a file of its own, and the team file names it.
  const works = await worksIn(first)
  const [work] = Object.values(works)
  assert.equal(work.results.length, 1)
  assert.equal(work.results[0].text.length, 2000)
  assert.equal(work.results[0].length, LONG.length)
  assert.deepEqual(keptIn(home), [`${work.results[0].id}.txt`])
  assert.equal(readFileSync(join(home, 'handoff-results', `${work.results[0].id}.txt`), 'utf8'), LONG)

  // The host restarts before the Writer answers.
  await first.stop()
  const second = await start()
  const again = turnTaker(second.agents, second.emit)
  again.open('b', result)
  again.end('b', 'fixed both')
  await settled(() => callsOf(second.agents, 'a').length === 1)
  const answer = textOf(callsOf(second.agents, 'a')[0][1].content)
  assert.ok(answer.includes(LONG), 'the whole result goes up')
  assert.ok(!answer.includes('the rest was not kept'))
})

test('a short result stays in the team file, and no file of its own is made', async (t) => {
  const { home, start } = bench(t)
  const { first } = await handedOn({ start }, 'two things to fix')
  const works = await worksIn(first)
  const [work] = Object.values(works)
  assert.equal(work.results[0].text, 'two things to fix')
  assert.equal(work.results[0].length, undefined)
  assert.deepEqual(keptIn(home), [])
})

test('a result inside a result survives a restart too', async (t) => {
  const { home, start } = bench(t)
  const first = await start(seed())
  const { agents, emit, tool } = first
  const turns = turnTaker(agents, emit)
  turns.userTurn('a', 'have Writer do it')
  await tool('message_bot', { to: 'Writer', message: 'carry out the plan' }, 'a')
  turns.end('a', 'asked Writer')
  turns.take('b')
  await tool('message_bot', { to: 'Tester', message: 'review my work' }, 'b')
  turns.end('b', 'handed it on')
  turns.take('c')
  await tool('message_bot', { to: 'Editor', message: 'proofread it' }, 'c')
  turns.end('c', 'handed it on')
  turns.take('d')
  turns.end('d', LONG)
  await settled(() => callsOf(agents, 'c').length === 2)
  const fromEditor = callsOf(agents, 'c')[1][1]
  const works = await worksIn(first)
  const [testerId, tester] = Object.entries(works).find(([, work]) => work.to === 'c')
  assert.equal(tester.results.length, 1)
  assert.equal(tester.results[0].length, LONG.length)
  assert.deepEqual(keptIn(home), [`${tester.results[0].id}.txt`])

  // The host restarts before the Tester answers.
  await first.stop()
  const second = await start()
  const again = turnTaker(second.agents, second.emit)
  again.open('c', fromEditor)
  again.end('c', 'the review is done')
  await settled(() => callsOf(second.agents, 'b').length === 1)
  const toWriter = callsOf(second.agents, 'b')[0][1]
  assert.ok(textOf(toWriter.content).includes(LONG), 'the result inside the result goes up')
  // The old copy goes only after the replacement state has been saved.
  await settled(() => keptIn(home).length === 1 && keptIn(home)[0] === `${testerId}.txt`)
  assert.deepEqual(keptIn(home), [`${testerId}.txt`])

  // The Writer picks that up and answers the Chief.
  const last = turnTaker(second.agents, second.emit)
  last.open('b', toWriter)
  last.end('b', 'all done')
  await settled(() => callsOf(second.agents, 'a').length === 1)
  const toChief = textOf(callsOf(second.agents, 'a')[0][1].content)
  assert.ok(toChief.includes(LONG), 'the result inside the result is still there')
  assert.ok(toChief.includes('the review is done'))
  await settled(() => keptIn(home).length === 0)
  assert.deepEqual(keptIn(home), [])
})

test('a result whose file is gone is reported, not passed on as if it were whole', async (t) => {
  const { home, start } = bench(t)
  const { first, result } = await handedOn({ start }, LONG)
  rmSync(join(home, 'handoff-results'), { recursive: true, force: true })
  await first.stop()
  const second = await start()
  const again = turnTaker(second.agents, second.emit)
  again.open('b', result)
  again.end('b', 'fixed both')
  await settled(() => callsOf(second.agents, 'a').length === 1)
  const answer = textOf(callsOf(second.agents, 'a')[0][1].content)
  assert.ok(answer.includes(LONG.slice(0, 2000)))
  assert.ok(!answer.includes(LONG))
  assert.match(answer, /\[cut; 5000 characters in all, the rest was not kept\]/)
})

test('a result file that was cut short is reported as well', async (t) => {
  const { home, start } = bench(t)
  const { first, result } = await handedOn({ start }, LONG)
  const works = await worksIn(first)
  const [work] = Object.values(works)
  writeFileSync(join(home, 'handoff-results', `${work.results[0].id}.txt`), LONG.slice(0, 100), 'utf8')
  await first.stop()
  const second = await start()
  const again = turnTaker(second.agents, second.emit)
  again.open('b', result)
  again.end('b', 'fixed both')
  await settled(() => callsOf(second.agents, 'a').length === 1)
  const answer = textOf(callsOf(second.agents, 'a')[0][1].content)
  assert.ok(!answer.includes(LONG))
  assert.match(answer, /\[cut; 5000 characters in all, the rest was not kept\]/)
})

test('a result that could not be written is not claimed, and is reported after a restart', async (t) => {
  const { home, start } = bench(t)
  // A file where the folder of the results should be: the write cannot succeed.
  writeFileSync(join(home, 'handoff-results'), 'not a folder', 'utf8')
  const { first, result } = await handedOn({ start }, LONG)
  const works = await worksIn(first)
  const [work] = Object.values(works)
  assert.equal(work.results[0].length, LONG.length)
  assert.equal(work.results[0].file, undefined)
  await first.stop()
  const second = await start()
  const again = turnTaker(second.agents, second.emit)
  again.open('b', result)
  again.end('b', 'fixed both')
  await settled(() => callsOf(second.agents, 'a').length === 1)
  const answer = textOf(callsOf(second.agents, 'a')[0][1].content)
  assert.ok(!answer.includes(LONG))
  assert.match(answer, /\[cut; 5000 characters in all, the rest was not kept\]/)
})

test('closing or dropping work retains result files until its state save succeeds', async (t) => {
  const { home } = bench(t)
  const rt = { home, state: { works: {} }, botOf: () => undefined, readOnly: () => undefined, warn() {}, save: async () => {} }
  installHandoffs(rt)
  rt.openWork('parent', { from: 'a', to: 'b' })
  rt.openWork('child', { from: 'b', to: 'c', parent: 'parent' })
  rt.closeWork('child', 'Tester', LONG)
  await delay(0)
  const saved = JSON.parse(JSON.stringify(rt.state))
  writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
  assert.deepEqual(keptIn(home), ['child.txt'])
  let rejectSave
  rt.save = () => new Promise((resolve, reject) => { rejectSave = reject })
  rt.closeWork('parent', 'Writer', LONG)
  assert.deepEqual(keptIn(home), ['child.txt'])
  rejectSave(new Error('disk full'))
  await delay(0)
  assert.deepEqual(keptIn(home), ['child.txt'])
  const restarted = { ...rt, state: saved, save: async () => {} }
  installHandoffs(restarted)
  assert.ok(restarted.answerText('parent', 'done', 'Writer').includes(LONG))
  let finishSave
  restarted.save = () => new Promise(resolve => { finishSave = resolve })
  restarted.dropWork('parent')
  assert.deepEqual(keptIn(home), ['child.txt'])
  writeFileSync(join(home, 'state.json'), JSON.stringify(restarted.state))
  finishSave()
  await delay(0)
  assert.deepEqual(keptIn(home), [])
})

test('a save that resolves without writing during shutdown keeps the durable result', async (t) => {
  const { home } = bench(t)
  const rt = { home, state: { works: {} }, botOf: () => undefined, readOnly: () => undefined, warn() {}, save: async () => {} }
  installHandoffs(rt)
  rt.openWork('parent', { from: 'a', to: 'b' })
  rt.openWork('child', { from: 'b', to: 'c', parent: 'parent' })
  rt.closeWork('child', 'Tester', LONG)
  await delay(0)
  const saved = JSON.parse(JSON.stringify(rt.state))
  writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
  rt.closeWork('parent', 'Writer', LONG)
  await delay(0)
  assert.deepEqual(keptIn(home), ['child.txt'])
  const restarted = { ...rt, state: saved }
  installHandoffs(restarted)
  assert.ok(restarted.answerText('parent', 'done', 'Writer').includes(LONG))
})

test('a team saved before the result was kept whole still answers, and says what is missing', async (t) => {
  const { start } = bench(t)
  const old = seed()
  old.works = { w1: { from: 'a', to: 'b', open: [], results: [{ id: 'w2', name: 'Tester', text: 'x'.repeat(2000), length: 5000 }], at: Date.now() } }
  const first = await start(old)
  const turns = turnTaker(first.agents, first.emit)
  turns.open('b', {
    content: textBlock('[Reply from Tester]\nthe review'),
    source: { kind: SOURCE_KIND, role: 'reply', exchangeId: 'x9', senderSessionId: 'c', senderName: 'Tester', work: 'w1', replyTo: 'w2' },
  })
  turns.end('b', 'fixed both')
  await settled(() => callsOf(first.agents, 'a').length === 1)
  const answer = textOf(callsOf(first.agents, 'a')[0][1].content)
  assert.match(answer, /Tester:\nx{2000}\n\[cut; 5000 characters in all, the rest was not kept\]/)
})
