import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { agentsProblem, agentsRequest, applyEdits, LEARNING, parseJson, skillProblem, withoutReviewedAgentsRecords } from '../src/host/learning.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', capabilities: [], createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writing', model: 'deepseek/v4', instructions: '', capabilities: [], createdAt: 2 },
  },
  rooms: {},
  capabilities: { items: {} },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const ownChat = [
  { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please review this work' }] } } },
  { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'I finished the work.' }] } } } },
]

const createReply = JSON.stringify({
  action: 'create',
  name: 'release-checks',
  description: 'Use when checking a release.',
  content: 'Run the release checks.',
  why: 'The repeated work showed that the checks need to be kept.',
})
const noneReply = JSON.stringify({ action: 'none', reason: 'This work taught nothing reusable.' })

function start({ replies = [], config = {}, history = {}, seed = TEAM, learningSeed = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-learning-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(JSON.parse(JSON.stringify(seed))))
  if (Object.keys(learningSeed).length > 0) {
    mkdirSync(join(home, 'learning'), { recursive: true })
    writeFileSync(join(home, 'learning', 'state.json'), JSON.stringify(learningSeed))
  }
  const ctx = fakeContext()
  const requests = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }),
      async* stream(request) {
        requests.push(request)
        const reply = await replies.shift()
        if (reply instanceof Error) throw reply
        const out = typeof reply === 'object' && reply !== null ? reply : { text: reply ?? '' }
        yield { type: 'text-delta', index: 0, text: out.text ?? '' }
        yield { type: 'finish', reason: { kind: out.finish ?? 'stop', ...(out.failure ? { failure: { message: out.failure } } : {}) } }
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({
        agent: {
          id: sessionId,
          session: {
            id: sessionId,
            seq: (history[sessionId] ?? ownChat).at(-1).event.seq + 1,
            requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }),
          },
        },
      }),
      selectModel: async () => {},
      page: async ({ address, beforeSeq, maxMessages }) => {
        const all = (history[address.sessionId] ?? ownChat).filter(record => beforeSeq === undefined || record.event.seq < beforeSeq)
        const records = maxMessages === undefined ? all : all.slice(-maxMessages)
        return { records, hasMore: records.length < all.length }
      },
    },
    sessions: { messageProjections: [] },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => {
    route = options
    return register(options)
  }
  const settings = {
    memoryReviewDelayMs: 60_000,
    ...config,
    learningTimes: { minTurnMs: 0, idleMs: 0, intervalMs: 0, tickMs: 10, ...config.learningTimes },
  }
  const rt = createRuntime(ctx, { home, ...settings })
  const call = async (endpoint, payload = {}) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }
  const learningPath = join(home, 'learning', 'state.json')
  const learningState = () => existsSync(learningPath) ? JSON.parse(readFileSync(learningPath, 'utf8')) : {}
  const teamState = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, home, call, requests, history, learningPath, learningState, teamState, rt, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

async function until(check, message = 'condition did not hold within 4 s') {
  for (let tries = 0; tries < 200; tries += 1) {
    if (await check()) return
    await settle()
  }
  assert.fail(message)
}

async function startRuntime(options) {
  const runtime = start(options)
  await runtime.call('state')
  return runtime
}

async function finishTurn(ctx, { id = 'b2', duration = 0 } = {}) {
  const { agent } = await ctx.sessionController.resolveAgent(id)
  ctx.emit('agent/status', { agent, status: 'running' })
  if (duration > 0) await new Promise(resolve => setTimeout(resolve, duration))
  ctx.emit('agent/status', { agent, status: 'idle' })
}

function addNextTurn(history) {
  history.b2.push(
    { event: { seq: 12, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please check the release process too.' }] } } },
    { event: { seq: 13, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The release process is checked.' }] } } } },
  )
}

function projectFolder(t, { git = true, agents = '# Project\n- Existing rule\n' } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'ds-bot-project-'))
  if (git) mkdirSync(join(folder, '.git'))
  if (agents !== null) writeFileSync(join(folder, 'AGENTS.md'), agents)
  t.after(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5 }))
  return folder
}

const agentsEdit = JSON.stringify({
  action: 'edit',
  edits: [{ op: 'add', after: '- Existing rule', text: '- Keep the report concise.', why: 'The user corrected the report format more than once.' }],
})

test('agentsProblem validates edit safety and whole-line matches', () => {
  const current = '# Project\n- Existing rule\n'
  assert.equal(agentsProblem({ action: 'none' }, current), undefined)
  const replace = (old, text = '- New rule') => ({ action: 'edit', edits: [{ op: 'replace', old, text, why: 'Repeated correction.' }] })
  assert.match(agentsProblem(replace('- Missing'), current), /exactly once/)
  assert.match(agentsProblem(replace('- Existing rule'), `${current}- Existing rule\n`), /exactly once/)
  assert.match(agentsProblem(replace('Existing rule'), current), /exactly once/)
  assert.match(agentsProblem({ action: 'edit', edits: [{ op: 'add', after: '', text: '- Task #123 happened 2026-10-28 v2.1', why: 'Repeated correction.' }] }, current), /number, date, or version/)
  assert.match(agentsProblem({ action: 'edit', edits: [{ op: 'add', after: '', text: '- Password is hunter2', why: 'Repeated correction.' }] }, current), /secret/)
  assert.match(agentsProblem({ action: 'edit', edits: [{ op: 'add', after: '', text: '- Keep this rule.', why: 'The password is hunter2.' }] }, current), /secret/)
  assert.match(agentsProblem(replace('- Existing rule'), undefined), /only add lines/)
  assert.match(agentsProblem({ action: 'edit', edits: [{ op: 'add', after: '', text: 'x'.repeat(LEARNING.agentsEditMax + 1), why: 'Repeated correction.' }] }, current), /at most/)
  assert.match(agentsProblem({ action: 'edit', edits: [{ op: 'replace', old: '- Existing rule', text: '- Existing rule', why: 'Repeated correction.' }] }, current), /change nothing/)
  const long = `# ${'x'.repeat(3997)}`
  const large = { action: 'edit', edits: [1, 2, 3].map(index => ({ op: 'add', after: '', text: `- ${index}${'y'.repeat(397)}`, why: 'Repeated correction.' })) }
  assert.match(agentsProblem(large, long), /too large/)
})

test('applyEdits supports end and anchored add, replace, remove, and a new file', () => {
  const current = '# Project\n- Existing rule\n'
  assert.equal(applyEdits(current, [{ op: 'add', after: '', text: '- End rule' }]), '# Project\n- Existing rule\n- End rule\n')
  assert.equal(applyEdits(current, [{ op: 'add', after: '# Project', text: '- Before rule' }]), '# Project\n- Before rule\n- Existing rule\n')
  assert.equal(applyEdits(current, [{ op: 'replace', old: '- Existing rule', text: '- Updated rule' }]), '# Project\n- Updated rule\n')
  assert.equal(applyEdits(current, [{ op: 'remove', old: '- Existing rule' }]), '# Project\n')
  assert.equal(applyEdits(undefined, [{ op: 'add', after: '', text: '# Project\n- New rule' }]), '# Project\n- New rule\n')
})

test('AGENTS review keeps records appended while its model is running', () => {
  const reviewed = [{ text: 'User: Earlier work', order: 0 }]
  const queued = [...reviewed, { text: 'User: New work', order: 1 }]
  assert.deepEqual(withoutReviewedAgentsRecords(queued, reviewed.map(item => item.order)), [{ text: 'User: New work', order: 1 }])
})

test('agentsRequest includes only the declined edits for its folder', () => {
  const request = agentsRequest({
    folder: '/project', current: undefined, lines: ['User: Keep reports short.'],
    declined: [{ kind: 'agents', folder: '/project', edits: [{ op: 'add', text: '- Keep reports short.' }] }, { kind: 'agents', folder: '/other', edits: [{ op: 'add', text: '- Other' }] }],
  })
  assert.match(request, /There is no AGENTS.md yet/)
  assert.match(request, /Keep reports short/)
  assert.doesNotMatch(request, /Other/)
})

test('a Git folder with pending work gets one AGENTS proposal and approval writes it atomically', async t => {
  const folder = projectFolder(t)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  const runtime = await startRuntime({ seed, history: { b2: [...ownChat] }, replies: [noneReply, agentsEdit], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  runtime.rt.partLines = async function* () {
    for (let seq = 30; seq > 0; seq -= 1) yield { seq, time: seq, who: 'bot', text: `Bot: ${'x'.repeat(1_200)}` }
    yield { seq: 0, time: 0, who: 'user', text: 'User: Keep the early correction after long Bot output.' }
  }
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  const proposal = (await runtime.call('state')).value.learning.b2[0]
  assert.equal(proposal.kind, 'agents')
  assert.equal(proposal.folder, await runtime.rt.real(folder))
  assert.match(JSON.stringify(runtime.requests.at(-1)), /Keep the early correction after long Bot output/)
  const answer = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(answer.value.applied, true)
  assert.equal(readFileSync(join(folder, 'AGENTS.md'), 'utf8'), '# Project\n- Existing rule\n- Keep the report concise.\n')
  assert.deepEqual(readdirSync(folder).filter(name => name.endsWith('.tmp')), [])
})

test('a failed work-folder check keeps an AGENTS proposal open', async t => {
  const folder = projectFolder(t)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  const runtime = await startRuntime({ seed, replies: [noneReply, agentsEdit], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  const proposal = (await runtime.call('state')).value.learning.b2[0]
  const workFolder = runtime.rt.workFolder
  runtime.rt.workFolder = async () => { throw new Error('folder is no longer available') }
  const failed = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(failed.ok, false)
  assert.equal((await runtime.call('state')).value.learning.b2.length, 1)
  runtime.rt.workFolder = workFolder
  assert.equal((await runtime.call('learning-answer', { id: proposal.id, approve: true })).value.applied, true)
})

test('a Git folder without AGENTS.md can get a new file approved', async t => {
  const folder = projectFolder(t, { agents: null })
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  const reply = JSON.stringify({ action: 'edit', edits: [{ op: 'add', after: '', text: '# Project\n- New rule', why: 'The user corrected this repeatedly.' }] })
  const runtime = await startRuntime({ seed, history: { b2: [...ownChat] }, replies: [noneReply, reply], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  const proposal = (await runtime.call('state')).value.learning.b2[0]
  assert.equal(proposal.exists, false)
  assert.equal((await runtime.call('learning-answer', { id: proposal.id, approve: true })).value.applied, true)
  assert.equal(readFileSync(join(folder, 'AGENTS.md'), 'utf8'), '# Project\n- New rule\n')
})

test('a folder is reviewed once with the pending work from every Bot that used it', async t => {
  const folder = projectFolder(t)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  seed.bots.b3 = { id: 'b3', sessionId: 'b3', name: 'Coder', role: 'Coding', model: 'deepseek/v4', instructions: '', capabilities: [], workDir: folder, createdAt: 3 }
  const runtime = await startRuntime({
    seed,
    replies: [noneReply, noneReply, agentsEdit],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  runtime.rt.partLines = async function* (sessionId) {
    yield { seq: 11, time: sessionId === 'b2' ? 1 : 2, who: 'user', text: `User: Work from ${sessionId}` }
  }
  await finishTurn(runtime.ctx, { id: 'b2' })
  await finishTurn(runtime.ctx, { id: 'b3' })
  await runtime.rt.learningRun()
  assert.equal(runtime.requests.length, 3)
  assert.match(JSON.stringify(runtime.requests.at(-1)), /Work from b2/)
  assert.match(JSON.stringify(runtime.requests.at(-1)), /Work from b3/)
  assert.equal((await runtime.call('state')).value.learning.b2.length, 1)
})

test('work for a folder with an open proposal stays queued until the card is declined', async t => {
  const folder = projectFolder(t)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  seed.bots.b3 = { id: 'b3', sessionId: 'b3', name: 'Coder', role: 'Coding', model: 'deepseek/v4', instructions: '', capabilities: [], workDir: folder, createdAt: 3 }
  const runtime = await startRuntime({
    seed,
    replies: [noneReply, agentsEdit, noneReply, agentsEdit],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  runtime.rt.partLines = async function* (sessionId) {
    yield { seq: 11, time: 1, who: 'user', text: `User: Work from ${sessionId}` }
  }
  await finishTurn(runtime.ctx, { id: 'b2' })
  await runtime.rt.learningRun()
  const proposal = (await runtime.call('state')).value.learning.b2[0]

  await finishTurn(runtime.ctx, { id: 'b3' })
  await runtime.rt.learningRun()
  const queued = runtime.learningState().agentsPending[await runtime.rt.real(folder)]
  assert.match(queued.records.map(item => item.text).join('\n'), /Work from b3/)
  assert.equal(runtime.requests.length, 3)
  assert.equal((await runtime.call('state')).value.learning.b2.length, 1)

  await runtime.call('learning-answer', { id: proposal.id, approve: false })
  await runtime.rt.learningRun()
  assert.match(runtime.requests.at(-1).messages[0].content[0].text, /Work from b3/)
  assert.equal(runtime.learningState().agentsPending[await runtime.rt.real(folder)], undefined)
})

test('a failed AGENTS model call keeps its folder work for the next pass', async t => {
  const folder = projectFolder(t)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  const runtime = await startRuntime({
    seed,
    replies: [createReply, new Error('AGENTS model failed'), agentsEdit],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  runtime.rt.partLines = async function* () {
    yield { seq: 11, time: 1, who: 'user', text: 'User: Keep the same folder work' }
  }
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  const folderKey = await runtime.rt.real(folder)
  assert.match(runtime.learningState().agentsPending[folderKey].records[0].text, /same folder work/)
  assert.equal((await runtime.call('state')).value.learning.b2[0].kind, 'skill')
  const firstRequest = runtime.requests.at(-1).messages[0].content[0].text

  await runtime.rt.learningRun()
  assert.match(runtime.requests.at(-1).messages[0].content[0].text, /same folder work/)
  assert.equal(runtime.requests.at(-1).messages[0].content[0].text, firstRequest)
  assert.equal(runtime.learningState().agentsPending[folderKey], undefined)
  assert.ok((await runtime.call('state')).value.learning.b2.some(proposal => proposal.kind === 'agents'))
})

test('AGENTS review falls back to another contributor when its Bot is deleted', async t => {
  const folder = projectFolder(t)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  seed.bots.b3 = { id: 'b3', sessionId: 'b3', name: 'Coder', role: 'Coding', model: 'deepseek/v4', instructions: '', capabilities: [], workDir: folder, createdAt: 3 }
  const runtime = await startRuntime({
    seed,
    replies: [noneReply, new Error('retry this folder later'), noneReply, new Error('retry after Bot C adds work'), agentsEdit],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  const folderPath = await runtime.rt.real(folder)
  runtime.rt.partLines = async function* (sessionId) {
    yield { seq: 11, time: 1, who: 'user', text: `User: Work from ${sessionId}` }
  }
  await finishTurn(runtime.ctx, { id: 'b2' })
  await runtime.rt.learningRun()
  assert.equal(runtime.learningState().agentsPending[folderPath].botId, 'b2')
  assert.deepEqual(runtime.learningState().agentsPending[folderPath].records.map(item => item.botId), ['b2'])

  await finishTurn(runtime.ctx, { id: 'b3' })
  await runtime.rt.learningRun()
  assert.equal(runtime.learningState().agentsPending[folderPath].botId, 'b2')
  assert.deepEqual(runtime.learningState().agentsPending[folderPath].records.map(item => item.botId), ['b2', 'b3'])

  await runtime.call('delete-bot', { id: 'b2' })
  await runtime.rt.learningRun()
  assert.equal(runtime.learningState().agentsPending[folderPath], undefined)
  const view = (await runtime.call('state')).value.learning
  assert.ok(view.b3.some(proposal => proposal.kind === 'agents'))
  assert.match(runtime.requests.at(-1).messages[0].content[0].text, /Work from b2/)
  assert.match(runtime.requests.at(-1).messages[0].content[0].text, /Work from b3/)
})

test('AGENTS folder queue is removed when all contributing Bots are deleted', async t => {
  const folder = projectFolder(t)
  const folderPath = realpathSync(folder)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b3 = { id: 'b3', sessionId: 'b3', name: 'Coder', role: 'Coding', model: 'deepseek/v4', instructions: '', capabilities: [], workDir: folder, createdAt: 3 }
  const runtime = await startRuntime({
    seed,
    learningSeed: {
      agentsPending: {
        [folderPath]: {
          botId: 'b2',
          records: [
            { botId: 'b2', text: 'User: Work from b2', time: 1, order: 0 },
            { botId: 'b3', text: 'User: Work from b3', time: 2, order: 1 },
          ],
        },
      },
    },
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  await runtime.call('delete-bot', { id: 'b2' })
  await runtime.call('delete-bot', { id: 'b3' })
  await runtime.rt.learningRun()
  assert.equal(runtime.learningState().agentsPending[folderPath], undefined)
  assert.equal(runtime.requests.length, 0)
})

test('agentsMd false keeps folder queues and does not schedule a review', async t => {
  const folder = projectFolder(t)
  const folderPath = realpathSync(folder)
  const runtime = await startRuntime({
    learningSeed: {
      agentsPending: {
        [folderPath]: { botId: 'b2', records: [{ text: 'User: Keep this queued', time: 1, order: 0 }] },
      },
    },
    config: { agentsMd: false, learningTimes: { idleMs: 0, intervalMs: 0, tickMs: 10 } },
  })
  t.after(() => runtime.stop())
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(runtime.learningState().lastRun, undefined)
  assert.deepEqual(runtime.learningState().agentsPending[folderPath].records, [{ text: 'User: Keep this queued', time: 1, order: 0 }])
  assert.equal(runtime.requests.length, 0)
})

test('a changed AGENTS proposal stays open, can be declined, and is included in the next folder request', async t => {
  const folder = projectFolder(t)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  const history = { b2: [...ownChat] }
  const runtime = await startRuntime({ seed, history, replies: [noneReply, agentsEdit, noneReply, noneReply], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  const proposal = (await runtime.call('state')).value.learning.b2[0]
  writeFileSync(join(folder, 'AGENTS.md'), '# Project\n- Changed by the user\n')
  const stale = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.match(JSON.stringify(stale), /AGENTS.md changed since this was proposed/)
  assert.equal((await runtime.call('state')).value.learning.b2.length, 1)
  assert.equal((await runtime.call('learning-answer', { id: proposal.id, approve: false })).value.applied, false)
  addNextTurn(history)
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  assert.match(JSON.stringify(runtime.requests.at(-1)), /Changes the user turned down before/)
  assert.match(JSON.stringify(runtime.requests.at(-1)), /Keep the report concise/)
})

test('folders without a project marker, DSH data folders, and agentsMd:false are not reviewed', async t => {
  const cases = [
    { folder: projectFolder(t, { git: false, agents: null }), config: {} },
    { folder: projectFolder(t, { agents: `# ${'x'.repeat(16_000)}` }), config: {} },
    { folder: undefined, config: {} },
    { folder: projectFolder(t), config: { agentsMd: false } },
  ]
  for (const item of cases) {
    const seed = JSON.parse(JSON.stringify(TEAM))
    const options = { replies: [noneReply], config: { learningTimes: { tickMs: 100_000 }, ...item.config } }
    const runtimeOptions = item.folder
      ? { ...options, seed: { ...seed, bots: { ...seed.bots, b2: { ...seed.bots.b2, workDir: item.folder } } } }
      : options
    const runtime = await startRuntime(runtimeOptions)
    t.after(() => runtime.stop())
    if (!item.folder) runtime.rt.botOf('b2').workDir = runtime.home
    await finishTurn(runtime.ctx)
    await runtime.rt.learningRun()
    assert.equal(runtime.requests.length, 1)
    assert.deepEqual((await runtime.call('state')).value.learning ?? {}, {})
  }
})

test('a disposed learning pass cannot overwrite the next host state with a late model reply', async t => {
  for (const kind of ['skill', 'agents']) await t.test(kind, async t => {
    let finishModel
    const reply = new Promise(resolve => { finishModel = resolve })
    const folder = kind === 'agents' ? projectFolder(t) : undefined
    const seed = folder ? { ...TEAM, bots: { ...TEAM.bots, b2: { ...TEAM.bots.b2, workDir: folder } } } : TEAM
    const runtime = await startRuntime({ seed, replies: kind === 'agents' ? [noneReply, reply] : [reply], config: { learningTimes: { tickMs: 100_000 } } })
    t.after(() => runtime.stop())
    await finishTurn(runtime.ctx)
    await until(() => runtime.learningState().pending?.b2?.includes('b2'))
    const pass = runtime.rt.learningRun()
    const calls = kind === 'agents' ? 2 : 1
    await until(() => runtime.requests.length === calls)
    await runtime.ctx.dispose()

    const next = { pending: { m1: ['m1'] }, proposals: { next: { id: 'next', botId: 'm1', name: 'next-host-skill' } } }
    writeFileSync(runtime.learningPath, JSON.stringify(next))
    finishModel(kind === 'agents' ? agentsEdit : createReply)
    await pass
    assert.deepEqual(runtime.learningState(), next)
    assert.deepEqual(runtime.rt.learningView(), {})
    assert.equal(await runtime.rt.learningRun(), 0)
    assert.equal(runtime.requests.length, calls)
  })
})

test('parseJson accepts fenced and unfenced objects and ignores garbage', () => {
  assert.deepEqual(parseJson('```json\n{"action":"none"}\n```'), { action: 'none' })
  assert.deepEqual(parseJson('Answer: {"action":"none"}'), { action: 'none' })
  const answer = JSON.stringify({ action: 'create', content: 'Use this:\n```js\nvalue\n```' })
  const expected = JSON.parse(answer)
  assert.deepEqual(parseJson(answer), expected)
  assert.deepEqual(parseJson('```json\n' + answer + '\n```'), expected)
  assert.equal(parseJson('No JSON was returned.'), undefined)
  assert.equal(parseJson('```json\n{"action":\n```'), undefined)
})

test('skillProblem validates actions, learned-skill limits, and secret-looking content', () => {
  const proposal = {
    action: 'create',
    name: 'release-checks',
    description: 'Use when checking a release.',
    content: 'Run the release checks.',
  }
  assert.equal(skillProblem({ action: 'none' }, { skills: {}, learned: [] }), undefined)
  assert.match(skillProblem({ ...proposal, name: 'Bad_Name' }, { skills: {}, learned: [] }), /capability name/)
  assert.match(skillProblem(proposal, { skills: { 'release-checks': { kind: 'skill' } }, learned: [] }), /already exists/)
  assert.match(skillProblem(proposal, { skills: {}, learned: ['one', 'two'], limit: 2 }), /learned skills/)
  assert.match(skillProblem({ ...proposal, action: 'update' }, { skills: { 'release-checks': { kind: 'skill', content: 'Old', description: 'Old' } }, learned: [] }), /not a learned skill/)
  assert.match(skillProblem({ ...proposal, action: 'update' }, {
    skills: { 'release-checks': { kind: 'skill', content: proposal.content, description: proposal.description } },
    learned: ['release-checks'],
  }), /changes nothing/)
  assert.match(skillProblem({ ...proposal, content: 'The root password is hunter2' }, { skills: {}, learned: [] }), /secret/)
  assert.match(skillProblem({ ...proposal, why: 'The root password is hunter2' }, { skills: {}, learned: [] }), /secret/)
  assert.equal(skillProblem({ ...proposal, content: 'Compare `password == input` with a timing-safe check' }, { skills: {}, learned: [] }), undefined)
  assert.match(skillProblem({ ...proposal, description: 'x'.repeat(LEARNING.descriptionMax + 1) }, { skills: {}, learned: [] }), /description/)
})

test('short turns do not mark a Bot chat; a longer turn marks it for review', async t => {
  const short = await startRuntime({ config: { learningTimes: { minTurnMs: 60_000, idleMs: 60_000 } } })
  t.after(() => short.stop())
  await finishTurn(short.ctx)
  await settle()
  assert.equal(existsSync(short.learningPath), false)

  const long = await startRuntime({ config: { learningTimes: { minTurnMs: 5, idleMs: 60_000 } } })
  t.after(() => long.stop())
  await finishTurn(long.ctx, { duration: 15 })
  await until(() => long.learningState().pending?.b2?.includes('b2'))
  assert.deepEqual(long.learningState().pending.b2, ['b2'])
})

test('a none reply makes no proposal and advances the chat cursor', async t => {
  const runtime = await startRuntime({ replies: [noneReply] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => runtime.learningState().cursors?.b2 === 11 && runtime.learningState().pending?.b2 === undefined)
  assert.equal(runtime.requests.length, 1)
  assert.deepEqual((await runtime.call('state')).value.learning ?? {}, {})
})

test('a folder lookup failure does not repeat the skill proposal', async t => {
  const runtime = await startRuntime({ config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => runtime.learningState().pending?.b2?.includes('b2'))
  runtime.rt.partLines = async function* () {
    yield { seq: 10, time: 1, who: 'user', text: 'User: Please review this work' }
    yield { seq: 11, time: 2, who: 'assistant', text: 'Bot: I finished the work.' }
  }
  runtime.rt.botShot = async () => createReply
  runtime.rt.resolveAgent = async () => { throw new Error('folder lookup failed') }

  await runtime.rt.learningRun()

  assert.equal(Object.keys(runtime.learningState().proposals ?? {}).length, 1)
  assert.equal(runtime.learningState().pending?.b2, undefined)
  await runtime.rt.learningRun()
  assert.equal(Object.keys(runtime.learningState().proposals ?? {}).length, 1)
})

test('long turns ending during review remain pending for the next pass', async t => {
  const history = { b2: [...ownChat], b3: [...ownChat] }
  const runtime = await startRuntime({
    history,
    replies: [noneReply, noneReply],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  // Every load and save rebuilds the owner maps from the roster, and the startup model sync
  // saves while the test runs: b3 is put back after each of them.
  const owned = () => { runtime.rt.chatOwners.set('b3', 'b2') }
  const load = runtime.rt.load
  runtime.rt.load = async (...args) => {
    const result = await load(...args)
    owned()
    return result
  }
  const save = runtime.rt.save
  runtime.rt.save = (...args) => {
    const result = save(...args)
    owned()
    return result
  }
  owned()
  const b3Statuses = []
  runtime.ctx.on('agent/status', ({ agent, status }) => {
    if (agent?.id === 'b3') b3Statuses.push(status)
  })
  assert.equal(runtime.rt.chatOwners.get('b3'), 'b2')
  assert.equal(runtime.rt.isBotSession('b3'), true)
  await finishTurn(runtime.ctx)
  await until(() => runtime.learningState().pending?.b2?.includes('b2'))

  const botShot = runtime.rt.botShot
  let endedDuringReview = false
  runtime.rt.botShot = async (...args) => {
    if (!endedDuringReview) {
      endedDuringReview = true
      addNextTurn(history)
      history.b3.push(
        { event: { seq: 12, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please keep this new work too.' }] } } },
        { event: { seq: 13, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The second chat has new work.' }] } } } },
      )
      await finishTurn(runtime.ctx, { id: 'b2' })
      await finishTurn(runtime.ctx, { id: 'b3' })
      assert.deepEqual(b3Statuses, ['running', 'idle'])
    }
    return botShot(...args)
  }

  await runtime.rt.learningRun()

  assert.deepEqual(runtime.learningState().pending.b2, ['b2', 'b3'])
  assert.equal(runtime.learningState().cursors.b2, 11)

  await runtime.rt.learningRun()

  assert.equal(runtime.requests.length, 2)
  const request = runtime.requests[1].messages[0].content[0].text
  assert.match(request, /Please check the release process too\./)
  assert.match(request, /Please keep this new work too\./)
  assert.equal(runtime.learningState().pending.b2, undefined)
})

test('approval ownership survives a normal skill edit and remains learned on review', async t => {
  const history = { b2: [...ownChat] }
  const updateReply = JSON.stringify({
    action: 'update',
    name: 'release-checks',
    description: 'Use when checking any release.',
    content: 'Run the release checks.',
    why: 'The work showed the scope should be broader.',
  })
  const runtime = await startRuntime({
    history,
    replies: [createReply, updateReply],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = (await runtime.call('state')).value.learning.b2[0]
  assert.equal(proposal.name, 'release-checks')

  addNextTurn(history)
  await finishTurn(runtime.ctx)
  await until(() => runtime.learningState().pending?.b2?.includes('b2'))
  await settle()
  assert.equal(runtime.requests.length, 1)
  const answer = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(answer.value.applied, true)
  await runtime.call('capability-save', {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release candidate.',
    content: 'Run the release checks.',
  })
  await runtime.rt.learningRun()
  await until(() => runtime.requests.length === 2)
  await until(() => Object.values(runtime.learningState().proposals ?? {}).some(entry => entry.action === 'update'))
  const saved = runtime.teamState()
  assert.equal(saved.capabilities.items['release-checks'].learned, undefined)
  assert.ok(saved.bots.b2.capabilities.includes('release-checks'))
  assert.deepEqual(runtime.learningState().learned.b2, ['release-checks'])
  assert.match(runtime.requests[1].messages[0].content[0].text, /This Bot's learned skills[\s\S]*Use when checking a release candidate\./)
})

test('a failed create attachment can be retried without resaving or losing the proposal', async t => {
  const runtime = await startRuntime({ replies: [createReply] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = Object.values(runtime.learningState().proposals)[0]
  const attach = runtime.rt.capabilityEndpoint
  let fail = true
  runtime.rt.capabilityEndpoint = async (...args) => {
    if (fail) {
      fail = false
      throw new Error('temporary attachment failure')
    }
    return attach(...args)
  }

  const first = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(first.ok, false)
  assert.equal(runtime.learningState().proposals[proposal.id].saved, true)
  assert.ok(runtime.learningState().learned.b2.includes('release-checks'))
  assert.ok(runtime.learningState().proposals[proposal.id])

  const second = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(second.value.applied, true)
  assert.equal(runtime.learningState().proposals[proposal.id], undefined)
  assert.ok(runtime.teamState().bots.b2.capabilities.includes('release-checks'))
})

test('a recreated approved skill is learned when its saved proposal is retried', async t => {
  const runtime = await startRuntime({ replies: [createReply] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = Object.values(runtime.learningState().proposals)[0]
  const endpoint = runtime.rt.capabilityEndpoint
  let fail = true
  runtime.rt.capabilityEndpoint = async (name, body, ...args) => {
    if (name === 'bot-capability' && fail) {
      fail = false
      throw new Error('temporary attachment failure')
    }
    return endpoint(name, body, ...args)
  }

  const first = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(first.ok, false)
  assert.equal(runtime.learningState().proposals[proposal.id].saved, true)
  assert.deepEqual(runtime.learningState().learned.b2, ['release-checks'])

  const deleted = await runtime.call('capability-delete', { name: 'release-checks' })
  assert.equal(deleted.ok, true)
  assert.deepEqual(runtime.learningState().learned.b2, [])
  await runtime.call('capability-save', {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release.',
    content: 'Run the release checks.',
  })

  const retry = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(retry.value.applied, true)
  assert.equal(runtime.learningState().proposals[proposal.id], undefined)
  assert.deepEqual(runtime.learningState().learned.b2, ['release-checks'])
  assert.ok(runtime.teamState().bots.b2.capabilities.includes('release-checks'))
})

test('a failed create retry refuses a skill edited after it was saved', async t => {
  const runtime = await startRuntime({ replies: [createReply] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = Object.values(runtime.learningState().proposals)[0]
  const endpoint = runtime.rt.capabilityEndpoint
  let fail = true
  runtime.rt.capabilityEndpoint = async (name, body, ...args) => {
    if (name === 'bot-capability' && fail) {
      fail = false
      throw new Error('temporary attachment failure')
    }
    return endpoint(name, body, ...args)
  }

  const first = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(first.ok, false)
  assert.equal(runtime.learningState().proposals[proposal.id].saved, true)
  const edit = await runtime.call('capability-save', {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release.',
    content: 'Run the revised release checks.',
  })
  assert.equal(edit.ok, true)

  const retry = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(retry.ok, false)
  assert.match(JSON.stringify(retry), /release-checks changed since this was proposed/)
  assert.ok(runtime.learningState().proposals[proposal.id])
  assert.equal(runtime.teamState().capabilities.items['release-checks'].content, 'Run the revised release checks.')
  assert.equal(runtime.teamState().bots.b2.capabilities.includes('release-checks'), false)
})

test('deleting a learned skill clears ownership before a same-name skill is recreated', async t => {
  const history = { b2: [...ownChat] }
  const runtime = await startRuntime({
    history,
    replies: [createReply, noneReply],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = Object.values(runtime.learningState().proposals)[0]
  const answer = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(answer.value.applied, true)
  assert.deepEqual(runtime.learningState().learned.b2, ['release-checks'])

  const deleted = await runtime.call('capability-delete', { name: 'release-checks' })
  assert.equal(deleted.ok, true)
  assert.deepEqual(runtime.learningState().learned.b2, [])
  await runtime.call('capability-save', {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release.',
    content: 'Run the release checks.',
  })
  await runtime.call('bot-capability', { botId: 'b2', name: 'release-checks', attached: true })
  assert.ok(runtime.teamState().bots.b2.capabilities.includes('release-checks'))

  addNextTurn(history)
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  assert.equal(runtime.requests.length, 2)
  const request = runtime.requests[1].messages[0].content[0].text
  assert.match(request, /This Bot has no learned skills yet\./)
  assert.match(request, /Other skills on the team:\n- release-checks:/)
  assert.deepEqual(runtime.learningState().learned.b2, [])
})

test('declined proposals are recorded and included in the next skill request', async t => {
  const history = { b2: [...ownChat] }
  const runtime = await startRuntime({ history, replies: [createReply, noneReply] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = (await runtime.call('state')).value.learning.b2[0]

  addNextTurn(history)
  await finishTurn(runtime.ctx)
  await until(() => runtime.learningState().pending?.b2?.includes('b2'))
  await settle()
  assert.equal(runtime.requests.length, 1)

  const answer = await runtime.call('learning-answer', { id: proposal.id, approve: false })
  assert.equal(answer.value.applied, false)
  await until(() => runtime.learningState().cursors?.b2 === 13 && runtime.learningState().pending?.b2 === undefined)
  assert.equal(runtime.teamState().capabilities.items['release-checks'], undefined)
  assert.equal(runtime.learningState().declined[0].name, 'release-checks')
  assert.match(runtime.requests[1].messages[0].content[0].text, /Proposals the user declined[\s\S]*- release-checks: Use when checking a release\./)
})

test('an update approval fails if the learned skill description alone changed', async t => {
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.capabilities = ['release-checks']
  seed.capabilities.items['release-checks'] = {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release.',
    content: 'Run the original release checks.',
    createdBy: 'b2',
    createdAt: 3,
    updatedAt: 3,
    learned: true,
  }
  const updateReply = JSON.stringify({
    action: 'update',
    name: 'release-checks',
    description: 'Use when checking a release.',
    content: 'Run the new release checks.',
    why: 'The work showed an additional step.',
  })
  const runtime = await startRuntime({ seed, replies: [updateReply], learningSeed: { learned: { b2: ['release-checks'] } } })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = (await runtime.call('state')).value.learning.b2[0]

  await runtime.call('capability-save', {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release candidate.',
    content: 'Run the original release checks.',
  })
  const answer = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(answer.ok, false)
  assert.match(JSON.stringify(answer), /release-checks changed since this was proposed/)
  assert.equal(runtime.teamState().capabilities.items['release-checks'].description, 'Use when checking a release candidate.')
  assert.equal(Object.keys(runtime.learningState().proposals).length, 1)
  const declined = await runtime.call('learning-answer', { id: proposal.id, approve: false })
  assert.equal(declined.ok, true)
  assert.equal(Object.keys(runtime.learningState().proposals).length, 0)
})

test('a saved secret in a proposed skill is not shown as a proposal', async t => {
  const secretValue = 'saved-secret-value-37'
  const runtime = await startRuntime({
    replies: [JSON.stringify({
      action: 'create',
      name: 'release-checks',
      description: 'Use when checking a release.',
      content: `Run with ${secretValue}.`,
      why: 'The work showed it is needed.',
    })],
  })
  t.after(() => runtime.stop())
  await runtime.call('secret-set', { name: 'LEARNING_TEST', value: secretValue })
  await finishTurn(runtime.ctx)
  await until(() => runtime.learningState().cursors?.b2 === 11)
  assert.deepEqual(runtime.learningState().proposals, {})
})

test('an AGENTS edit containing a saved secret is not shown as a proposal', async t => {
  const folder = projectFolder(t)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  const secretValue = 'agents-saved-secret-42'
  const reply = JSON.stringify({
    action: 'edit',
    edits: [{ op: 'add', after: '- Existing rule', text: `- Use ${secretValue}.`, why: 'The user corrected this repeatedly.' }],
  })
  const runtime = await startRuntime({ seed, replies: [noneReply, reply], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  await runtime.call('secret-set', { name: 'AGENTS_TEST', value: secretValue })
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  assert.equal(Object.values(runtime.learningState().proposals ?? {}).length, 0)
  assert.equal(Object.keys(runtime.learningState().agentsPending ?? {}).length, 0)
})

test('user corrections remain in long chat reviews after the text budget', async t => {
  const runtime = await startRuntime({ replies: [noneReply], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  const lines = Array.from({ length: 30 }, (_, index) => ({
    seq: 41 - index,
    who: 'assistant',
    text: `Bot: ${'x'.repeat(1_200)}`,
  }))
  lines.push({ seq: 10, who: 'user', text: 'User: Keep the correction even when the Bot writes a long answer.' })
  runtime.rt.partLines = async function* () {
    yield* lines
  }
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  assert.match(runtime.requests[0].messages[0].content[0].text, /User: Keep the correction even when the Bot writes a long answer\./)
})

test('a failed chat read keeps that Bot pending while other Bots are reviewed', async t => {
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b3 = { id: 'b3', sessionId: 'b3', name: 'Coder', role: 'Coding', model: 'deepseek/v4', instructions: '', capabilities: [], createdAt: 3 }
  const runtime = await startRuntime({ seed, replies: [noneReply], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  runtime.rt.partLines = async function* (sessionId) {
    if (sessionId === 'b2') throw new Error('session read failed')
    yield { seq: 11, who: 'user', text: 'User: Review this work' }
  }
  await finishTurn(runtime.ctx, { id: 'b2' })
  await finishTurn(runtime.ctx, { id: 'b3' })
  await until(() => runtime.learningState().pending?.b2?.length && runtime.learningState().pending?.b3?.length)

  await runtime.rt.learningRun()

  assert.deepEqual(runtime.learningState().pending.b2, ['b2'])
  assert.equal(runtime.learningState().pending.b3, undefined)
  assert.equal(runtime.learningState().cursors.b3, 11)
  assert.equal(runtime.requests.length, 1)
})
