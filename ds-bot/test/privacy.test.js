import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeApproval, fakeContext } from './fake-ctx.js'

let rt

// A Bot's id is a Session id, which a path may hold.
const P = 'd1a40000-1111-4222-8333-444444444444'

// Chief (Main), Writer in the group Ops, and Diary, a Bot with a folder of its own.
function seed({ diary, privateBot, archives = [] }) {
  return {
    version: 1,
    mainBotIds: ['a'],
    privateArchives: archives,
    workspaceId: 'w1',
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
      [P]: { id: P, name: 'Diary', role: 'Notes', sessionId: P, createdAt: 3, instructions: 'Keep the diary of the user.', workDir: diary, ...(privateBot ? { private: true } : {}) },
    },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb' } } },
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
}

async function start({ services = {}, privateBot = true, archives } = {}) {
  // The native realpath, as fs/promises uses: on Windows the JS one keeps 8.3 short names.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-privacy-')))
  const dsh = join(root, 'dsh')
  const home = join(dsh, 'bot')
  const team = join(home, 'workspace')
  const project = join(root, 'project')
  const diary = join(root, 'diary')
  for (const dir of [team, project, diary]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(diary, 'notes.txt'), 'secret')
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed({ diary, privateBot, archives })))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dsh

  const ctx = fakeContext({ services })
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      agents.set(sessionId, {
        id: sessionId,
        session: { id: sessionId, header: { cwd: sessionId === P ? diary : team }, requestHeader: () => undefined, deriveMessages: () => [] },
        status: 'idle',
        followup() {},
        steer() {},
        inject() {},
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(sessionId)
  }
  const registry = new Map([['w1', { id: 'w1', path: team, title: 'DS Bot' }]])
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: id => registry.get(id),
      list: () => [...registry.values()],
      resolveByPath: async path => [...registry.values()].find(workspace => workspace.path === path),
      create: async (path) => {
        const workspace = { id: 'w-new', path, title: 'DS Bot' }
        registry.set(workspace.id, workspace)
        return workspace
      },
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
  rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: agentOf(sessionId), name, callId: 'c1' })
  // The privacy listener alone, which runs first; the last step stands for the tool.
  const guard = ctx.listeners.get('tools/execute')[0]
  const run = async (name, args, sessionId, agent = agentOf(sessionId)) => {
    let ran = false
    const exec = { name, arguments: args, agent, callId: 'c1', signal: AbortSignal.timeout(60_000) }
    try {
      await guard(exec, async () => { ran = true })
      return { ran }
    } catch (error) {
      return { ran, error: error.message }
    }
  }
  const stop = async () => {
    await ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  // Loading once fills the Session-owner indexes.
  await tool('list_bots', {}, 'a')
  return { rt, ctx, root, dsh, home, team, project, diary, agentOf, call, tool, run, state, stop }
}

const CLOSED = /private Bot/

test('only the user makes a Bot private, and the Bot needs a folder of its own', async (t) => {
  const { rt, project, team, state, stop } = await start({ privateBot: false })
  t.after(stop)
  await assert.rejects(rt.updateBot(P, { private: true }, 'a'), /Only the user can make Diary private/)
  await assert.rejects(rt.updateBot('b', { private: true }), /needs a folder of its own/)
  await assert.rejects(rt.updateBot('b', { private: true, workDir: team }), /needs a folder of its own/)
  await assert.rejects(rt.updateBot('a', { private: true, workDir: project }), /Main Bot/)
  // Writer is in the group Ops, where every member reads what is said.
  await assert.rejects(rt.updateBot('b', { private: true, workDir: project }), /group chat/)
  assert.equal(state().bots.b.private, undefined)
  await rt.updateBot(P, { private: true })
  assert.equal(state().bots.p, undefined)
  assert.equal(state().bots[P].private, true)
  await rt.updateBot(P, { private: false })
  assert.equal(state().bots[P].private, undefined)
})

test('the user makes a Bot private through the client channel', async (t) => {
  const { call, state, stop } = await start({ privateBot: false })
  t.after(stop)
  await call('update-bot', { id: P, private: true })
  assert.equal(state().bots[P].private, true)
  await call('update-bot', { id: P, private: false })
  assert.equal(state().bots[P].private, undefined)
})

test('a private Bot has a folder that no other folder is in or around', async (t) => {
  const { rt, team, project, diary, state, stop } = await start({ privateBot: false })
  t.after(stop)
  mkdirSync(join(team, 'inside'))
  mkdirSync(join(diary, 'inside'))
  await rt.updateBot(P, { workDir: join(team, 'inside') })
  await assert.rejects(rt.updateBot(P, { private: true }), /team workspace/)
  await rt.updateBot(P, { workDir: diary })
  // Writer's folder lies in Diary's, so Diary cannot be private there.
  await rt.updateBot('b', { workDir: join(diary, 'inside') })
  await assert.rejects(rt.updateBot(P, { private: true }), /folder of Writer/)
  await rt.updateBot('b', { workDir: project })
  await rt.updateBot(P, { private: true })
  assert.equal(state().bots[P].private, true)
  // Once Diary is private, no other Bot, group or team workspace goes in or around its folder.
  await assert.rejects(rt.updateBot('b', { workDir: diary }), CLOSED)
  await assert.rejects(rt.updateBot('b', { workDir: join(diary, 'inside') }), CLOSED)
  await assert.rejects(rt.updateRoom('r1', { workDir: join(diary, 'inside') }), CLOSED)
  await assert.rejects(rt.createBot({ name: 'Third', workDir: diary }), CLOSED)
  await assert.rejects(rt.setTeamWorkspace(diary), CLOSED)
  await assert.rejects(rt.updateBot(P, { workDir: project }), /folder of Writer/)
  assert.equal(state().bots.b.workDir, project)
})

test('a private Bot is no Main Bot, no member of a group and no copy', async (t) => {
  const { rt, stop } = await start()
  t.after(stop)
  await assert.rejects(rt.setMain(P, true), /private/)
  await assert.rejects(rt.createRoom({ members: ['a', P], createdBy: 'a' }), /cannot be in a group chat/)
  await assert.rejects(rt.updateRoom('r1', { add: [P] }, 'a'), /cannot be in a group chat/)
  await assert.rejects(rt.duplicateBot(P), /cannot be copied/)
})

test('the others only see the name and role of a private Bot', async (t) => {
  const { tool, stop } = await start()
  t.after(stop)
  const others = await tool('list_bots', {}, 'b')
  assert.match(others, /- Diary \(Notes, private Bot, closed to other Bots\)/)
  assert.doesNotMatch(others, /Keep the diary|works in/)
  assert.doesNotMatch(others, /Diary[^\n]*\n\s+now:/)
  const own = await tool('list_bots', {}, P)
  assert.match(own, /Diary \(Notes, .*private, you\) — Keep the diary of the user\./)
})

test('other Bots cannot reach a private Bot through the tools between Bots', async (t) => {
  const { run, stop } = await start()
  t.after(stop)
  for (const [name, args, from] of [
    ['message_bot', { to: 'Diary', message: 'hi' }, 'a'],
    ['message_bot', { to: '@diary', message: 'hi' }, 'b'],
    ['message_bot', { to: P, message: 'hi' }, 'b'],
    ['stop_bot', { bot: 'Diary' }, 'a'],
    ['attach_capability', { bot: 'Diary', name: 'x' }, 'a'],
    ['detach_capability', { bot: 'Diary', name: 'x' }, 'a'],
    ['update_bot', { bot: 'Diary', instructions: 'x' }, 'a'],
    ['recall', { scope: 'Diary', query: 'x' }, 'a'],
    ['recall', { scope: '"Diary"' }, 'b'],
    ['remember', { scope: 'Diary', text: 'x' }, 'a'],
    ['forget', { scope: 'Diary', entry: 'x' }, 'a'],
  ]) {
    const result = await run(name, args, from)
    assert.equal(result.ran, false, `${name} from ${from}`)
    assert.match(result.error, CLOSED)
  }
  // The others still reach each other and the shared scopes.
  assert.deepEqual(await run('message_bot', { to: 'Writer', message: 'hi' }, 'a'), { ran: true })
  assert.deepEqual(await run('recall', { scope: 'team', query: 'x' }, 'b'), { ran: true })
  assert.deepEqual(await run('recall', { scope: 'own' }, P), { ran: true })
  assert.deepEqual(await run('update_bot', { bot: 'Diary', role: 'x' }, P), { ran: true })
})

test('other Bots cannot read, write or search what a private Bot keeps', async (t) => {
  const { run, root, dsh, home, diary, team, project, stop } = await start()
  t.after(stop)
  const notes = join(diary, 'notes.txt')
  const posix = path => path.replace(/\\/g, '/')
  const gitBash = /^[a-z]:/i.test(diary) ? `/${diary[0].toLowerCase()}${posix(diary).slice(2)}` : posix(diary)
  const refused = async (name, args, from = 'b') => {
    const result = await run(name, args, from)
    assert.equal(result.ran, false, `${name} ${JSON.stringify(args)}`)
    assert.match(result.error, CLOSED)
  }
  await refused('read', { file_path: notes })
  await refused('read', { file_path: relative(team, notes) })
  if (process.platform !== 'linux') await refused('read', { file_path: notes.toUpperCase() })
  await refused('write', { file_path: notes, content: 'x' })
  await refused('edit', { file_path: join(diary, 'new.txt'), old_string: 'a', new_string: 'b' })
  await refused('str_replace_editor', { command: 'view', path: notes })
  await refused('read_image', { file_path: join(diary, 'a.png') })
  await refused('read', { file_path: join(home, 'memory', 'bots', P, 'MEMORY.md') })
  await refused('read', { file_path: join(home, 'memory', 'journal.jsonl') })
  await refused('read', { file_path: join(home, 'state.json') })
  await refused('read', { file_path: join(home, 'chat-index.sqlite') })
  await refused('read', { file_path: join(home, 'usage.sqlite') })
  await refused('read', { file_path: join(home, 'secrets.json') })
  await refused('read', { file_path: join(home, 'learning', 'state.json') })
  await refused('read', { file_path: join(home, 'memory', 'pending.json') })
  await refused('glob', { pattern: '**/*', path: diary })
  await refused('glob', { pattern: '**/*.txt', path: root })
  await refused('grep', { pattern: 'secret', path: root })
  await refused('glob', { pattern: `${posix(diary)}/**` })
  await refused('glob', { pattern: '**/*', path: home })
  await refused('bash', { command: `cat ${posix(notes)}` })
  await refused('bash', { command: `cat ${gitBash}/notes.txt` })
  await refused('pwsh', { command: `Get-Content '${notes}'`, workdir: project })
  await refused('bash', { command: 'ls', workdir: diary })
  await refused('bash', { command: `cat ${posix(join(home, 'state.json'))}` })
  await refused('bash', { command: `cat ${posix(join(home, 'chat-index.sqlite'))}` })
  await refused('working_directory', { cd: diary })
  await refused('working_directory', { cd: root })
  await refused('subagent', { cwd: diary, prompt: 'read notes.txt' })
  await refused('subagent_fork', { cwd: relative(team, diary), prompt: 'read notes.txt' })
  await refused('session_search', { query: 'x' })
  await refused('session_search', { query: 'x', session_id: P })
  await refused('session_trace', { session_ids: ['b', P] })
  await refused('session_event_read', { parent_session_ids: [P] })
  // What is open stays open.
  for (const [name, args] of [
    ['read', { file_path: join(project, 'a.txt') }],
    ['read', { file_path: 'a.txt' }],
    ['write', { file_path: join(team, 'a.txt'), content: 'x' }],
    ['read', { file_path: join(dsh, 'sessions', 'b.jsonl') }],
    ['read', { file_path: join(home, 'memory', 'team', 'MEMORY.md') }],
    ['glob', { pattern: '**/*', path: join(home, 'memory', 'team') }],
    ['glob', { pattern: '**/*', path: project }],
    ['glob', { pattern: '**/*', path: team }],
    ['grep', { pattern: 'x' }],
    ['bash', { command: 'ls', workdir: project }],
    ['subagent', { cwd: project, prompt: 'work in the open folder' }],
    ['working_directory', { cd: join(team, 'sub') }],
    ['session_search', { query: 'x', session_ids: ['b'] }],
  ]) {
    assert.deepEqual(await run(name, args, 'b'), { ran: true }, `${name} ${JSON.stringify(args)}`)
  }
})

test('a link into the folder of a private Bot is closed too', async (t) => {
  const { run, project, diary, stop } = await start()
  t.after(stop)
  try {
    symlinkSync(diary, join(project, 'link'), 'junction')
  } catch {
    t.skip('no links here')
    return
  }
  const result = await run('read', { file_path: join(project, 'link', 'notes.txt') }, 'b')
  assert.equal(result.ran, false)
  assert.match(result.error, CLOSED)
  // The file does not exist yet: the link above it still has to be resolved.
  const created = await run('write', { file_path: join(project, 'link', 'new.txt'), content: 'x' }, 'b')
  assert.equal(created.ran, false)
  assert.match(created.error, CLOSED)
})

test('the private Bot reads its own and the team\'s files; a Session it starts speaks for it', async (t) => {
  const { run, diary, project, team, home, stop } = await start()
  t.after(stop)
  assert.deepEqual(await run('read', { file_path: join(diary, 'notes.txt') }, P), { ran: true })
  assert.deepEqual(await run('glob', { pattern: '**/*', path: diary }, P), { ran: true })
  // Its own data is no secret from it: with no other private Bot, the data folder is open to a search.
  assert.deepEqual(await run('glob', { pattern: '**/*', path: home }, P), { ran: true })
  assert.deepEqual(await run('read', { file_path: join(project, 'a.txt') }, P), { ran: true })
  assert.deepEqual(await run('glob', { pattern: '**/*', path: team }, P), { ran: true })
  assert.deepEqual(await run('read', { file_path: join(home, 'memory', 'team', 'MEMORY.md') }, P), { ran: true })
  assert.deepEqual(await run('glob', { pattern: '**/*', path: join(home, 'memory', 'team') }, P), { ran: true })
  assert.deepEqual(await run('subagent', { cwd: diary, prompt: 'work in my folder' }, P), { ran: true })
  const sub = parent => ({ id: 'sub1', session: { id: 'sub1', header: { cwd: team, parentSession: parent } } })
  const fromWriter = await run('read', { file_path: join(diary, 'notes.txt') }, 'b', sub('b'))
  assert.equal(fromWriter.ran, false)
  assert.match(fromWriter.error, CLOSED)
  assert.deepEqual(await run('read', { file_path: join(diary, 'notes.txt') }, P, sub(P)), { ran: true })
})

test('what a private Bot sends to the others waits for the user', async (t) => {
  const approval = fakeApproval('allowed-once')
  const { run, stop } = await start({ services: { approval } })
  t.after(stop)
  assert.deepEqual(await run('message_bot', { to: 'Writer', message: 'My secret plan' }, P), { ran: true })
  assert.equal(approval.requests.length, 1)
  assert.equal(approval.requests[0].toolName, 'message_bot')
  assert.match(approval.requests[0].reason, /Diary[\s\S]*Writer[\s\S]*My secret plan/)
  assert.match(approval.requests[0].displayReason.zh, /My secret plan/)
  // The Bots that are not private send as before.
  await run('message_bot', { to: 'Chief', message: 'hi' }, 'b')
  assert.equal(approval.requests.length, 1)
  const content = 'secret step '.repeat(80)
  assert.deepEqual(await run('save_capability', { name: 'plan', kind: 'skill', content }, P), { ran: true })
  assert.equal(approval.requests.length, 2)
  assert.match(approval.requests[1].reason, /share this with the team/)
  assert.ok(approval.requests[1].reason.includes(content), 'the approval shows the whole skill, not a prefix')
  assert.deepEqual(await run('save_capability', { name: 'search', kind: 'mcp', command: 'secret-command', args: ['--private'] }, P), { ran: true })
  assert.equal(approval.requests.length, 3)
  assert.match(approval.requests[2].reason, /secret-command/)
  assert.match(approval.requests[2].reason, /--private/)
})

test('a message of a private Bot that the user does not allow is not sent', async (t) => {
  for (const outcome of ['rejected', 'cancelled']) {
    const { run, stop } = await start({ services: { approval: fakeApproval(outcome) } })
    t.after(stop)
    const result = await run('message_bot', { to: 'Writer', message: 'My secret plan' }, P)
    assert.equal(result.ran, false, outcome)
    assert.match(result.error, /not done/)
  }
  // With no way to ask, nothing goes either.
  const { run, stop } = await start()
  t.after(stop)
  const result = await run('message_bot', { to: 'Writer', message: 'x' }, P)
  assert.equal(result.ran, false)
  assert.match(result.error, /no way to ask/)
})

test('a private Bot changes files outside its folder only with the user\'s approval', async (t) => {
  const approval = fakeApproval('allowed-once')
  const { run, ctx, diary, project, stop } = await start({ services: { approval } })
  t.after(stop)
  assert.deepEqual(await run('write', { file_path: join(diary, 'today.txt'), content: 'x' }, P), { ran: true })
  assert.deepEqual(await run('write', { file_path: 'today.txt', content: 'x' }, P), { ran: true })
  assert.equal(approval.requests.length, 0)
  assert.deepEqual(await run('edit', { file_path: join(project, 'a.txt'), old_string: 'a', new_string: 'b' }, P), { ran: true })
  assert.equal(approval.requests.length, 1)
  assert.match(approval.requests[0].reason, /outside its own folder/)
  // A path that leaves the folder by `..` is outside it.
  assert.deepEqual(await run('write', { file_path: join(diary, '..', 'project', 'b.txt'), content: 'x' }, P), { ran: true })
  assert.equal(approval.requests.length, 2)
  // Reading is free.
  assert.deepEqual(await run('read', { file_path: join(project, 'a.txt') }, P), { ran: true })
  assert.equal(approval.requests.length, 2)
  // A subagent can have no cwd of its own; an absolute path still needs no TypeError.
  const getWorkspace = ctx.workspaceRegistry.get
  try {
    ctx.workspaceRegistry.get = () => undefined
    const noCwd = { id: 'sub-no-cwd', session: { id: 'sub-no-cwd', header: { parentSession: P } } }
    assert.deepEqual(await run('write', { file_path: join(diary, 'no-cwd.txt'), content: 'x' }, P, noCwd), { ran: true })
  } finally {
    ctx.workspaceRegistry.get = getWorkspace
  }
})

test('a write of a private Bot outside its folder that the user does not allow is not made', async (t) => {
  const { run, project, stop } = await start({ services: { approval: fakeApproval('rejected') } })
  t.after(stop)
  const result = await run('write', { file_path: join(project, 'a.txt'), content: 'x' }, P)
  assert.equal(result.ran, false)
  assert.match(result.error, /not done/)
})

test('one private Bot reads its own data but not another private Bot\'s', async (t) => {
  const { rt, run, dsh, home, diary, project, stop } = await start()
  t.after(stop)
  const other = await rt.createBot({ name: 'Other', workDir: project })
  await rt.updateBot(other.id, { private: true })
  assert.deepEqual(await run('read', { file_path: join(diary, 'notes.txt') }, P), { ran: true })
  assert.deepEqual(await run('read', { file_path: join(home, 'memory', 'bots', P, 'MEMORY.md') }, P), { ran: true })
  assert.deepEqual(await run('read', { file_path: join(dsh, 'sessions', `${P}.jsonl`) }, P), { ran: true })
  assert.deepEqual(await run('session_search', { query: 'x', session_ids: [P] }, P), { ran: true })
  assert.deepEqual(await run('session_search', { query: 'x', session_ids: ['b'] }, P), { ran: true })
  const search = await run('session_search', { query: 'x' }, P)
  assert.equal(search.ran, false)
  assert.match(search.error, CLOSED)
  const otherSearch = await run('session_search', { query: 'x', session_ids: [other.id] }, P)
  assert.equal(otherSearch.ran, false)
  assert.match(otherSearch.error, CLOSED)
  const result = await run('read', { file_path: join(home, 'memory', 'bots', other.id, 'MEMORY.md') }, P)
  assert.equal(result.ran, false)
  assert.match(result.error, CLOSED)
  const folder = await run('read', { file_path: join(project, 'notes.txt') }, P)
  assert.equal(folder.ran, false)
  assert.match(folder.error, CLOSED)
})

test('a private Bot reads public memory and keeps its own journal out of the shared log', async (t) => {
  const { tool, home, stop } = await start()
  t.after(stop)
  await tool('remember', { text: 'a public fact', scope: 'own' }, 'b')
  await tool('remember', { text: 'a private fact', scope: 'own' }, P)
  const recalled = await tool('recall', { scope: 'Writer', query: 'public fact' }, P)
  assert.match(recalled, /a public fact/)
  const shared = readFileSync(join(home, 'memory', 'journal.jsonl'), 'utf8')
  assert.match(shared, /a public fact/)
  assert.doesNotMatch(shared, /a private fact/)
  const own = readFileSync(join(home, 'memory', 'bots', P, 'journal.jsonl'), 'utf8')
  assert.match(own, /a private fact/)
})

test('a nested subagent speaks for the private Bot at its root', async (t) => {
  const approval = fakeApproval('allowed-once')
  const { run, diary, agentOf, stop } = await start({ services: { approval } })
  t.after(stop)
  agentOf('sub1').session.header.parentSession = P
  const nested = agentOf('sub2')
  nested.session.header.cwd = diary
  nested.session.header.parentSession = 'sub1'
  assert.deepEqual(await run('read', { file_path: join(diary, 'notes.txt') }, P, nested), { ran: true })
  assert.deepEqual(await run('message_bot', { to: 'Writer', message: 'from a nested subagent' }, P, nested), { ran: true })
  assert.equal(approval.requests.length, 1)
  assert.match(approval.requests[0].reason, /from a nested subagent/)
  for (const id of ['sub1', 'sub2']) {
    const result = await run('session_trace', { session_id: id }, 'b')
    assert.equal(result.ran, false, id)
    assert.match(result.error, CLOSED)
  }
})

test('deleting a private Bot keeps its folder and archived memory closed', async (t) => {
  const { rt, run, home, diary, project, state, stop } = await start()
  t.after(stop)
  const memory = join(home, 'memory', 'bots', P)
  mkdirSync(memory, { recursive: true })
  writeFileSync(join(memory, 'MEMORY.md'), 'private memory')
  await rt.deleteBot(P)
  assert.equal(state().bots[P], undefined)
  const archived = state().privateArchives
  assert.equal(archived.length, 1)
  assert.equal(archived[0].id, P)
  assert.equal(typeof archived[0].archivePath, 'string')
  for (const [name, args] of [
    ['read', { file_path: join(diary, 'notes.txt') }],
    ['read', { file_path: join(archived[0].archivePath, 'MEMORY.md') }],
    ['glob', { pattern: '**/*', path: home }],
    ['session_trace', { session_id: P }],
  ]) {
    const result = await run(name, args, 'b')
    assert.equal(result.ran, false, name)
    assert.match(result.error, CLOSED)
  }
  await assert.rejects(rt.createBot({ name: 'Third', workDir: diary }), CLOSED)
  const third = await rt.createBot({ name: 'Third', workDir: project })
  await assert.rejects(rt.updateBot(third.id, { workDir: diary, private: true }), CLOSED)
})

test('the user lifts what a deleted private Bot left closed, one Bot at a time', async (t) => {
  const { rt, call, run, root, diary, state, stop } = await start()
  t.after(stop)
  const ledgerDir = join(root, 'ledger')
  mkdirSync(ledgerDir)
  writeFileSync(join(ledgerDir, 'books.txt'), 'secret')
  const ledger = await rt.createBot({ name: 'Ledger', workDir: ledgerDir })
  await rt.updateBot(ledger.id, { private: true })
  await rt.deleteBot(P)
  await rt.deleteBot(ledger.id)

  // The list names each place and keeps Session ids and the archive path on the host.
  const listed = (await call('state', {})).value.privateArchives
  assert.deepEqual(listed, [{ id: P, name: 'Diary', workDir: diary }, { id: ledger.id, name: 'Ledger', workDir: ledgerDir }])
  assert.equal((await run('read', { file_path: join(diary, 'notes.txt') }, 'b')).ran, false)
  await assert.rejects(rt.createBot({ name: 'Third', workDir: diary }), CLOSED)

  const lifted = await call('private-release', { id: P })
  assert.equal(lifted.ok, true)
  assert.deepEqual(lifted.value.privateArchives.map(entry => entry.id), [ledger.id])
  assert.deepEqual(state().privateArchives.map(entry => entry.id), [ledger.id])
  assert.deepEqual(await run('read', { file_path: join(diary, 'notes.txt') }, 'b'), { ran: true })
  assert.deepEqual(await run('session_trace', { session_id: P }, 'b'), { ran: true })
  assert.equal((await rt.createBot({ name: 'Third', workDir: diary })).workDir, diary)

  // The other Bot's places stay closed.
  const kept = await run('read', { file_path: join(ledgerDir, 'books.txt') }, 'b')
  assert.equal(kept.ran, false)
  assert.match(kept.error, CLOSED)

  const again = await call('private-release', { id: P })
  assert.equal(again.ok, false)
  assert.match(again.error.message, /Nothing kept closed/)
})

test('the archived memory of a Bot whose protection is lifted opens; another archive stays closed', async (t) => {
  const { rt, ctx, call, run, home, root, project, state, stop } = await start()
  t.after(stop)
  // Ids shaped like real Session ids: a one-letter id would match any path.
  let created = 0
  ctx.sessionController.create = async () => ({ sessionId: `0000000${++created}-1111-4222-8333-444444444444` })
  const ledgerDir = join(root, 'ledger')
  mkdirSync(ledgerDir)
  const ledger = await rt.createBot({ name: 'Ledger', workDir: ledgerDir })
  await rt.updateBot(ledger.id, { private: true })
  const scratch = await rt.createBot({ name: 'Scratch', workDir: project })
  const reader = (await rt.createBot({ name: 'Reader' })).id
  for (const id of [P, ledger.id, scratch.id]) {
    mkdirSync(join(home, 'memory', 'bots', id), { recursive: true })
    writeFileSync(join(home, 'memory', 'bots', id, 'MEMORY.md'), `memory of ${id}`)
  }
  await rt.deleteBot(P)
  await rt.deleteBot(ledger.id)
  await rt.deleteBot(scratch.id)
  const archives = Object.fromEntries(state().privateArchives.map(entry => [entry.id, entry.archivePath]))
  const memoryOf = id => ({ file_path: join(archives[id], 'MEMORY.md') })
  const archiveRoot = join(home, 'memory', 'archive')
  const scratchRead = { file_path: join(archiveRoot, readdirSync(archiveRoot).find(name => name.startsWith(scratch.id)), 'MEMORY.md') }

  // While both are kept, neither archive is read; the archive of a Bot that was never private is.
  for (const id of [P, ledger.id]) {
    const result = await run('read', memoryOf(id), reader)
    assert.equal(result.ran, false, id)
    assert.match(result.error, CLOSED)
  }
  assert.deepEqual(await run('read', scratchRead, reader), { ran: true })

  await call('private-release', { id: P })
  assert.deepEqual(await run('read', memoryOf(P), reader), { ran: true })
  const kept = await run('read', memoryOf(ledger.id), reader)
  assert.equal(kept.ran, false)
  assert.match(kept.error, /Ledger/)
  // A walk of the archive folder would reach the kept one, so it stays closed.
  assert.equal((await run('glob', { pattern: '**/*', path: archiveRoot }, reader)).ran, false)

  await call('private-release', { id: ledger.id })
  assert.deepEqual(await run('read', memoryOf(ledger.id), reader), { ran: true })
  assert.deepEqual(await run('glob', { pattern: '**/*', path: archiveRoot }, reader), { ran: true })
})

test('an archive whose log row could not be written is still kept closed to a walk', async (t) => {
  const { rt, ctx, run, home, root, state, stop } = await start({ privateBot: false })
  t.after(stop)
  let created = 0
  ctx.sessionController.create = async () => ({ sessionId: `0000000${++created}-1111-4222-8333-444444444444` })
  const ledgerDir = join(root, 'ledger')
  mkdirSync(ledgerDir)
  const ledger = await rt.createBot({ name: 'Ledger', workDir: ledgerDir })
  await rt.updateBot(ledger.id, { private: true })
  const reader = (await rt.createBot({ name: 'Reader' })).id
  mkdirSync(join(home, 'memory', 'bots', ledger.id), { recursive: true })
  writeFileSync(join(home, 'memory', 'bots', ledger.id, 'MEMORY.md'), 'books')
  // A change log that cannot be read stops the archive's row, after the memory has moved.
  mkdirSync(join(home, 'memory', 'journal.jsonl'), { recursive: true })
  await rt.deleteBot(ledger.id)

  const archiveRoot = join(home, 'memory', 'archive')
  const [entry] = state().privateArchives
  assert.ok(entry.archivePath?.startsWith(archiveRoot), 'the path of the archive is kept')
  assert.equal(entry.archiving, undefined)
  assert.equal(readFileSync(join(entry.archivePath, 'MEMORY.md'), 'utf8'), 'books')
  const read = await run('read', { file_path: join(entry.archivePath, 'MEMORY.md') }, reader)
  assert.equal(read.ran, false)
  assert.match(read.error, /Ledger/)
  assert.equal((await run('glob', { pattern: '**/*', path: archiveRoot }, reader)).ran, false)
  assert.equal((await run('grep', { pattern: 'books', path: archiveRoot }, reader)).ran, false)
})

test('a walk of the archive stays closed while a private Bot\'s memory is still on its way there', async (t) => {
  const GHOST = 'e2b60000-1111-4222-8333-444444444444'
  const { call, run, home, stop } = await start({ privateBot: false, archives: [{ id: GHOST, name: 'Ghost', sessionIds: [], archiving: true }] })
  t.after(stop)
  const archiveRoot = join(home, 'memory', 'archive')
  mkdirSync(join(archiveRoot, `${GHOST}-2026-10-28`), { recursive: true })
  writeFileSync(join(archiveRoot, `${GHOST}-2026-10-28`, 'MEMORY.md'), 'ghost')

  const walk = await run('glob', { pattern: '**/*', path: archiveRoot }, 'b')
  assert.equal(walk.ran, false)
  assert.match(walk.error, /Ghost/)
  // Once the user lifts the protection there is nothing left to hide.
  assert.equal((await call('private-release', { id: GHOST })).ok, true)
  assert.deepEqual(await run('glob', { pattern: '**/*', path: archiveRoot }, 'b'), { ran: true })
})

test('a kept Bot whose memory never moved does not close the archive folder', async (t) => {
  const GHOST = 'e2b60000-1111-4222-8333-444444444444'
  const { run, home, stop } = await start({ privateBot: false, archives: [{ id: GHOST, name: 'Ghost', sessionIds: [] }] })
  t.after(stop)
  const archiveRoot = join(home, 'memory', 'archive')
  mkdirSync(archiveRoot, { recursive: true })
  assert.deepEqual(await run('glob', { pattern: '**/*', path: archiveRoot }, 'b'), { ran: true })
})

test('with no private Bot the tools run as they did', async (t) => {
  const { run, diary, stop } = await start({ privateBot: false })
  t.after(stop)
  assert.deepEqual(await run('read', { file_path: join(diary, 'notes.txt') }, 'b'), { ran: true })
  assert.deepEqual(await run('message_bot', { to: 'Diary', message: 'hi' }, 'a'), { ran: true })
  assert.deepEqual(await run('glob', { pattern: '*', path: join(diary, '..') }, 'b'), { ran: true })
})
