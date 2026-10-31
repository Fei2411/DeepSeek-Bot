import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

let rt

// #280: a switch that fails while the plugin is being unloaded must not lose the input
// it carried — a turn's claimed messages and whatever the old part held. The old
// part's durable inbox keeps them (the fake persists it across starts), a switch is
// marked in state.switching until its input is handed on, a retry does not double,
// and the restart pass hands marked input on or wakes the part that kept it.
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

// The error every ctx service lookup gives once the plugin's fiber is disposed.
const INACTIVE = 'cannot get required service "sessions" in inactive context'

// `fail.create`/`fail.resolve`/`fail.flush`: true fails with the inactive-context
// error; an Error value fails with it, so an ordinary error is testable too.
async function start({ fail = {}, services = {}, home: reuse } = {}) {
  const root = reuse === undefined
    ? realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-switch-')))
    : join(reuse, '..', '..')
  const home = reuse ?? join(root, 'dsh', 'bot')
  const team = join(home, 'workspace')
  const project = join(root, 'project')
  for (const dir of [team, project]) mkdirSync(dir, { recursive: true })
  if (reuse === undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

  // The real inbox is durable; the fake keeps it in a file so a "restart" sees it.
  const inboxPath = join(home, 'fake-inbox.json')
  const inboxSeed = () => {
    try { return JSON.parse(readFileSync(inboxPath, 'utf8')) } catch { return {} }
  }
  const saved = inboxSeed()
  const persist = (agents) => {
    const all = { ...saved }
    for (const [id, agent] of agents) all[id] = { nextStep: agent.inbox.nextStep, nextTurn: agent.inbox.nextTurn }
    writeFileSync(inboxPath, JSON.stringify(all))
  }

  const ctx = fakeContext({ services })
  const warnings = []
  const infos = []
  ctx.logger = {
    warn: (...args) => warnings.push(args.map(String).join(' ')),
    info: (...args) => infos.push(args.map(String).join(' ')),
  }
  const errorOf = value => (value instanceof Error ? value : new Error(INACTIVE))
  let flushes = 0
  const created = []
  const resolved = []
  const archived = []
  const cwds = new Map()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const nextStep = [...saved[sessionId]?.nextStep ?? []]
      const nextTurn = [...saved[sessionId]?.nextTurn ?? []]
      agents.set(sessionId, {
        id: sessionId,
        session: { id: sessionId, header: { cwd: cwds.get(sessionId) ?? team }, requestHeader: () => undefined, deriveMessages: () => [] },
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        send(message, target, wakeup) {
          ;(target === 'next-turn' ? nextTurn : nextStep).push(message)
          calls.push(['send', message, target, wakeup])
          persist(agents)
        },
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep,
          nextTurn,
          prepend(target, message) { ;(target === 'next-turn' ? nextTurn : nextStep).unshift(message); persist(agents) },
          append(target, message) { ;(target === 'next-turn' ? nextTurn : nextStep).push(message); persist(agents) },
          remove(id) {
            for (const list of [nextStep, nextTurn]) {
              const at = list.findIndex(message => message.id === id)
              if (at !== -1) { list.splice(at, 1); persist(agents); return true }
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
      list: () => [{ id: 'w1', path: team }],
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w-new', path }),
      archiveSession: async (sessionId, options) => { archived.push([sessionId, options]) },
    },
    sessionController: {
      create: async (options) => {
        if (fail.create) throw errorOf(fail.create)
        const sessionId = `s${created.length + 1}`
        created.push(options)
        cwds.set(sessionId, options.cwd ?? team)
        return { sessionId }
      },
      resolveAgent: async (sessionId) => {
        if (fail.resolve?.has(sessionId)) throw errorOf(fail.resolve)
        resolved.push(sessionId)
        return { agent: agentOf(sessionId) }
      },
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: {
      // A number fails that call; true fails them all, so a test can break the flush
      // of the handed-on input without breaking the fresh part's own write before it.
      flush: async () => {
        flushes += 1
        if (fail.flush === true || fail.flush instanceof Error || fail.flush === flushes) throw errorOf(fail.flush)
      },
    },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: agentOf(sessionId), name, callId: 'c1' })
  const preStep = (sessionId, messages = [], step = 1) => ctx.listeners.get('agent/pre-step').at(-1)(
    { agent: agentOf(sessionId), messages, step, signal: AbortSignal.timeout(60_000) }, async () => 'next')
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  await tool('list_bots', {}, 'a')
  return { ctx, rt, root, home, team, project, created, resolved, archived, agentOf, call, tool, preStep, state, warnings, infos, fail, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold')
    await settle()
  }
}

const text = message => message.content.map(block => block.text ?? '').join('\n')
const inboxTexts = agent => [...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(text)
const PAUSE = 'DS Bot paused your turn for a context check. Go on with it now from where you stopped.'
const said = (id, body, exchangeId) => ({ id, role: 'user', content: [{ type: 'text', text: body }], source: { kind: 'user', ...(exchangeId ? { exchangeId } : {}) } })
// A folder outside the team workspace asks for approval once; then the move is allowed.
const services = {
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  approval: { request: async () => 'allowed-once' },
}

// Writer's own chat gets a working folder while it is mid-turn; its next step starts
// the switch and carries that step's input along.
const moveWriter = async (host, input, step = 2) => {
  host.agentOf('b').status = 'running'
  assert.equal((await host.tool('update_bot', { work_dir: host.project }, 'b')).includes('From your next step on'), true)
  assert.deepEqual(await host.preStep('b', input, step), { kind: 'reject' })
}

test('a move that fails while the plugin unloads hands its input back to the part it left', async (t) => {
  // The first flush writes the fresh part's handoff; the second moves the input.
  const fail = { flush: 2 }
  const host = await start({ fail, services })
  t.after(host.stop)
  host.agentOf('b').inbox.nextTurn.push(said('h1', 'waiting input', 'e-held'))
  await moveWriter(host, [said('m1', 'Now build it', 'e-carry'), said('m2', 'and this too', 'e-carry2')])

  // The fresh part took over, then moving the input failed while unloaded.
  await until(() => host.infos.some(line => line.includes('plugin unloaded')))
  assert.equal(host.state().bots.b.sessionId, 's1')
  // The part stays marked until the restart pass hands the input on.
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })

  // carry went back in order at the front of next-turn; the held message stayed put.
  assert.deepEqual(inboxTexts(host.agentOf('b')), ['Now build it', 'and this too', 'waiting input'])
  assert.equal(host.warnings.length, 0)
  assert.ok(host.infos.some(line => line.includes('input kept in part')))
})

test('a move that never started keeps carry and one pause note in the inbox; a retry adds none', async (t) => {
  const fail = { create: true, flush: true }
  const host = await start({ fail, services })
  t.after(host.stop)
  await moveWriter(host, [said('m1', 'keep me', 'e1')])
  await until(() => host.infos.some(line => line.includes('plugin unloaded')))
  assert.equal(host.warnings.length, 0)
  assert.deepEqual(inboxTexts(host.agentOf('b')), [PAUSE, 'keep me'])
  // The part stayed put and kept its input, so it stays marked.
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })

  // A retry that also fails neither loses nor doubles the note; a folder move waits
  // out its retry cooldown, so the retry comes in as an overflow switch.
  const retry = () => Promise.all((host.ctx.listeners.get('agent/request-error') ?? [])
    .map(listener => listener({ agent: host.agentOf('b'), failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: AbortSignal.timeout(60_000) }, async () => undefined)))
  await retry()
  await until(() => host.infos.filter(line => line.includes('plugin unloaded')).length >= 2)
  assert.deepEqual(inboxTexts(host.agentOf('b')), [PAUSE, 'keep me'])
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })

  // With the plugin live again the same input moves on — the note still only once.
  fail.create = false
  fail.flush = false
  await retry()
  await until(() => host.state().bots.b.sessionId === 's1' && host.state().switching?.b === undefined)
  const forwarded = host.agentOf('s1').calls.filter(([kind]) => kind === 'followup' || kind === 'inject').map(([, message]) => text(message))
  assert.equal(forwarded.filter(line => line === PAUSE).length, 1)
  assert.equal(forwarded.filter(line => line === 'keep me').length, 1)
  assert.deepEqual(inboxTexts(host.agentOf('b')), [])
  // The move finished and nothing stayed behind, so the mark is gone.
  assert.deepEqual(host.state().switching, {})
})

test('an ordinary failure during the move is still a warning, not the unload note', async (t) => {
  const fail = { create: new Error('disk full'), flush: new Error('disk full') }
  const host = await start({ fail, services })
  t.after(host.stop)
  await moveWriter(host, [said('m1', 'keep me', 'e1')])
  await until(() => host.warnings.some(line => line.includes('did not move on to a fresh part')))
  await until(() => host.warnings.some(line => line.includes('was not handed on')))
  assert.equal(host.infos.filter(line => line.includes('plugin unloaded')).length, 0)
  // The input is back in the part's inbox even for an ordinary failure.
  assert.deepEqual(inboxTexts(host.agentOf('b')), [PAUSE, 'keep me'])
})

test('an ordinary failure in the move that never started wakes the part at once', async (t) => {
  const fail = { create: new Error('disk full'), flush: new Error('disk full') }
  const host = await start({ fail, services })
  t.after(host.stop)
  await moveWriter(host, [said('m1', 'keep me', 'e1')])
  await until(() => host.warnings.some(line => line.includes('was not handed on')))
  const sends = host.agentOf('b').calls.filter(([kind]) => kind === 'send')
  // One wake on the first message, in the order the inbox kept them.
  assert.deepEqual(sends.map(([, message, target, wakeup]) => [text(message), target, wakeup]), [
    [PAUSE, 'next-turn', true],
    ['keep me', 'next-turn', false],
  ])
  assert.deepEqual(inboxTexts(host.agentOf('b')), [PAUSE, 'keep me'])
  // An unload instead would not wake it: no send calls at all.
  const failOff = { create: true, flush: true }
  const silent = await start({ fail: failOff, services })
  t.after(silent.stop)
  await moveWriter(silent, [said('m1', 'keep me', 'e1')])
  await until(() => silent.infos.some(line => line.includes('plugin unloaded')))
  assert.equal(silent.agentOf('b').calls.filter(([kind]) => kind === 'send').length, 0)
})

test('a marked earlier part hands its kept input on after a restart, once, and is archived', async (t) => {
  const fail = { flush: 2 }
  const host = await start({ fail, services })
  host.agentOf('b').inbox.nextTurn.push(said('h1', 'waiting input', 'e-held'))
  await moveWriter(host, [said('m1', 'Now build it', 'e-carry')])
  await until(() => host.infos.some(line => line.includes('plugin unloaded')))
  assert.equal(host.state().bots.b.sessionId, 's1')
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })
  await host.stop({ keep: true })

  // The restart: the kept input sits in the earlier part's (durable fake) inbox; a
  // copy of one message already reached the fresh part before the unload.
  const second = await start({ home: host.home, services })
  t.after(second.stop)
  second.agentOf('s1').inbox.nextTurn.push(said('m1-copy', 'Now build it', 'e-carry'))
  await second.rt.heldBack()

  const delivered = second.agentOf('s1').calls
    .filter(([kind, message]) => (kind === 'followup' || kind === 'inject') && message.source?.role !== 'handoff')
    .map(([, message]) => message.source?.exchangeId)
  assert.equal(delivered.filter(id => id === 'e-carry').length, 0) // already pending — not sent twice
  assert.equal(delivered.filter(id => id === 'e-held').length, 1)
  assert.deepEqual(inboxTexts(second.agentOf('b')), [])
  assert.deepEqual(second.archived, [['b', { stopActivity: true }]])
  assert.deepEqual(second.state().switching, {})
})

test('a marked part that stayed current is woken for its kept input, once, in order', async (t) => {
  const fail = { create: true, flush: true }
  const host = await start({ fail, services })
  await moveWriter(host, [said('m1', 'keep me', 'e1'), said('m2', 'and me', 'e2')])
  await until(() => host.infos.some(line => line.includes('plugin unloaded')))
  assert.equal(host.state().bots.b.sessionId, 'b')
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })
  await host.stop({ keep: true })

  const second = await start({ home: host.home, services })
  t.after(second.stop)
  await second.rt.heldBack()

  // The inbox kept the input; the wake re-sends it through send() so the driver runs.
  const sends = second.agentOf('b').calls.filter(([kind]) => kind === 'send')
  assert.deepEqual(sends.map(([, message, target, wakeup]) => [text(message), target, wakeup]), [
    [PAUSE, 'next-turn', true],
    ['keep me', 'next-turn', false],
    ['and me', 'next-turn', false],
  ])
  assert.deepEqual(inboxTexts(second.agentOf('b')), [PAUSE, 'keep me', 'and me'])
  assert.deepEqual(second.state().switching, {})
})

// #571: archiving with stopActivity drops the tasks the earlier part still owns, so
// the archive waits for the task move the switch started.
test('an earlier part is stopped only after its tasks moved to the fresh part', async (t) => {
  const host = await start({ services })
  t.after(host.stop)
  const order = []
  let release
  const moved = new Promise(resolve => { release = resolve })
  host.rt.moveSchedules = async (from, to) => { order.push(['move', from, to]); await moved }
  const archive = host.ctx.workspaceRegistry.archiveSession
  host.ctx.workspaceRegistry.archiveSession = async (id, options) => { order.push(['archive', id]); return archive(id, options) }
  await moveWriter(host, [])
  await until(() => order.length >= 1)
  await settle()
  assert.deepEqual(order, [['move', 'b', 's1']])
  release()
  await until(() => order.some(([kind]) => kind === 'archive'))
  assert.deepEqual(order, [['move', 'b', 's1'], ['archive', 'b']])
})

test('a failed task move leaves the earlier part unarchived and marked for retry', async (t) => {
  const host = await start({ services })
  t.after(host.stop)
  host.rt.moveSchedules = async () => { throw new Error('task storage unavailable') }
  await moveWriter(host, [])
  await until(() => host.warnings.some(line => line.includes('task storage unavailable')))
  await settle()
  assert.deepEqual(host.archived, [])
  assert.deepEqual(host.state().switching, { b: { botId: 'b' } })

  host.rt.moveSchedules = async () => {}
  await host.rt.heldBack()
  assert.deepEqual(host.archived, [['b', { stopActivity: true }]])
  assert.deepEqual(host.state().switching, {})
})

test('unmarked earlier parts are never resolved by the restart pass', async (t) => {
  const host = await start({ services })
  await moveWriter(host, [])
  // The fresh part is the Bot's before the switch ends and drops its mark.
  await until(() => host.state().bots.b.sessionId === 's1' && Object.keys(host.state().switching).length === 0)
  await host.stop({ keep: true })

  const second = await start({ home: host.home, services })
  t.after(second.stop)
  await second.rt.heldBack()
  assert.equal(second.resolved.includes('b'), false)
})

test('a state write that fails as a switch ends is warned about, not left unhandled', async (t) => {
  const unhandled = []
  const note = (error) => { unhandled.push(error) }
  process.on('unhandledRejection', note)
  t.after(() => { process.off('unhandledRejection', note) })
  const host = await start({ services })
  t.after(host.stop)
  // The write that drops the switch's mark fails, as on a full disk.
  const save = host.rt.save
  host.rt.save = () => (host.rt.state.bots.b.sessionId === 's1' && Object.keys(host.rt.state.switching).length === 0
    ? Promise.reject(new Error('disk full'))
    : save())
  await moveWriter(host, [])
  await until(() => host.warnings.some(line => line.includes('did not finish') && line.includes('disk full')))
  await settle()
  assert.deepEqual(unhandled, [])
})
