import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { dshHomeOf } from '../src/host/folders.js'
import { escapeRegExp } from '../src/host/text.js'
import { fakeContext } from './fake-ctx.js'

// A Main Bot and a Bot, with the Bot in the group Ops through its group Session 'gb'.
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'gb' } } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

// DSH_HOME, the team's data inside it, and a project folder beside it. Every Session
// starts in the team workspace unless it is made with a cwd. `services` are what
// ctx.get finds, such as the sandbox policy and approvals.
// `locked`: another dsh holds the team, so this one only shows it.
async function start({ services = {}, workspaces = [], llm, team: saved = TEAM, locked = false } = {}) {
  // The native realpath, as fs/promises uses: on Windows the JS one keeps 8.3 short names.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-work-dir-')))
  const dsh = join(root, 'dsh')
  const home = join(dsh, 'bot')
  const team = join(home, 'workspace')
  const project = join(root, 'project')
  for (const dir of [team, project]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
  if (locked) writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dsh

  const ctx = fakeContext({ services })
  const created = []
  const cwds = new Map()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        id: sessionId,
        session: { id: sessionId, header: { cwd: cwds.get(sessionId) ?? team }, requestHeader: () => undefined, deriveMessages: () => [] },
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(sessionId)
  }
  const registry = new Map([['w1', { id: 'w1', path: team, title: 'DS Bot' }], ...workspaces.map(workspace => [workspace.id, workspace])])
  Object.assign(ctx, {
    llm: llm ?? { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
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
      create: async (options) => {
        const sessionId = `s${created.length + 1}`
        created.push(options)
        cwds.set(sessionId, options.cwd ?? registry.get(options.workspaceId)?.path)
        return { sessionId }
      },
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
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: agentOf(sessionId), name, callId: 'c1' })
  // Runs the parts check, registered last; 'next' means the step goes on.
  const preStep = (sessionId, messages = [], step = 1) => ctx.listeners.get('agent/pre-step').at(-1)(
    { agent: agentOf(sessionId), messages, step, signal: AbortSignal.timeout(60_000) }, async () => 'next')
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  // Waits until the Bot's own chat runs in `dir` and its move has finished.
  const workingIn = async (botId, dir) => {
    await until(() => agentOf(state().bots[botId].sessionId).session.header.cwd === dir)
    await settle()
  }
  const stop = async () => {
    // The writes still running finish before their folder goes.
    await ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  // Loading once fills the Session-owner indexes.
  await tool('list_bots', {}, 'a')
  return { ctx, root, dsh, home, team, project, created, agentOf, call, tool, preStep, state, workingIn, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const until = async (check) => {
  const end = Date.now() + 2000
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold within 2 s')
    await settle()
  }
}
const textOf = message => message.content.map(block => block.text ?? '').join('\n')
const handoffOf = agent => agent.calls.filter(([kind, message]) => kind === 'followup' && message.source?.role === 'handoff').map(([, message]) => textOf(message)).at(-1)

// Approvals that answer `outcome` and keep every request. Sessions run in `mode`, the
// default, unless `modes` names another for them; 'workspace-write' writes inside the
// Session's folder only. Under the 'never' policy DSH answers 'rejected' without asking.
const approvalServices = (outcome, { policy = 'on-request', mode = 'workspace-write', modes = {} } = {}) => {
  const requests = []
  return {
    requests,
    services: {
      sandboxPolicy: { resolve: ({ session } = {}) => ({ mode: modes[session?.id] ?? mode }) },
      approval: {
        request: async (request) => {
          requests.push(request)
          return policy === 'never' ? 'rejected' : outcome
        },
      },
    },
  }
}
const notAllowed = path => `Working in ${path} was not allowed, so nothing changed. The user can make this change in the settings.`

test('DSH_HOME is read as DSH reads it', () => {
  const dsh = join(homedir(), '.dsh')
  assert.equal(dshHomeOf(undefined), dsh)
  assert.equal(dshHomeOf('  '), dsh)
  assert.equal(dshHomeOf('~'), homedir())
  assert.equal(dshHomeOf('~/dsh-x'), join(homedir(), 'dsh-x'))
  assert.equal(dshHomeOf('~\\dsh-x'), join(homedir(), 'dsh-x'))
  assert.equal(dshHomeOf('dsh-x'), resolve('dsh-x'))
})

test('a working folder is a full path to a folder outside the DeepSeek Harness data', async (t) => {
  const { call, state, workingIn, dsh, home, team, root, project, stop } = await start()
  t.after(stop)
  const error = async workDir => (await call('update-bot', { id: 'b', workDir })).error?.message
  assert.equal(await error('project'), 'Give the full path of the folder, not project')
  assert.equal(await error(join(root, 'missing')), `There is no folder at ${join(root, 'missing')}`)
  writeFileSync(join(project, 'notes.txt'), 'x')
  assert.equal(await error(join(project, 'notes.txt')), `${join(project, 'notes.txt')} is a file, not a folder`)
  // DSH_HOME, the team's data, and any folder that holds them are refused.
  for (const guarded of [dsh, home, root]) assert.equal(await error(guarded), `${guarded} holds DeepSeek Harness data, so Bots cannot work there`)
  // The team workspace and a folder inside it are fine; the workspace itself is no setting.
  assert.equal(state().bots.b.workDir, undefined)
  mkdirSync(join(team, 'site'))
  assert.equal((await call('update-bot', { id: 'b', workDir: join(team, 'site') })).value.workDir, join(team, 'site'))
  assert.equal((await call('update-bot', { id: 'b', workDir: team })).value.workDir, undefined)
  assert.equal(state().bots.b.workDir, undefined)
  // A quoted path and a trailing separator name the same folder.
  assert.equal((await call('update-bot', { id: 'b', workDir: `"${project}/"` })).value.workDir, project)
  assert.equal(state().bots.b.workDir, project)
  // Changed again while it moved, the chat still ends up in the last folder.
  await workingIn('b', project)
})

test('a new Bot with a folder starts its Session there; others start in the team workspace', async (t) => {
  const { call, created, project, state, stop } = await start()
  t.after(stop)
  const made = (await call('create-bot', { name: 'Builder', workDir: project })).value
  assert.equal(made.workDir, project)
  assert.deepEqual(created.at(-1), { cwd: project })
  assert.equal(state().bots[made.id].workDir, project)
  await call('create-bot', { name: 'Plain' })
  assert.deepEqual(created.at(-1), { workspaceId: 'w1' })
  // A copy works in the same folder.
  await call('duplicate-bot', { id: made.id })
  assert.deepEqual(created.at(-1), { cwd: project })
})

test('an idle Bot\'s own chat moves to its new folder at once, and back', async (t) => {
  const { call, created, agentOf, project, team, state, stop } = await start()
  t.after(stop)
  assert.equal((await call('update-bot', { id: 'b', workDir: project })).ok, true)
  // The new Session id is saved before the handoff is sent, so wait for both. The id
  // comes first: the fake agent takes its cwd when it is first looked up.
  await until(() => state().bots.b.sessionId === 's1')
  await until(() => handoffOf(agentOf('s1')) !== undefined)
  assert.deepEqual(created, [{ cwd: project }])
  assert.deepEqual(state().bots.b.segments.map(segment => [segment.sessionId, segment.fallback]), [['b', 'whole']])
  const moved = handoffOf(agentOf('s1'))
  assert.match(moved, new RegExp(`part 2, because your working folder changed to ${escapeRegExp(project)}\\.`))
  assert.match(moved, new RegExp(`You now work in ${escapeRegExp(project)}: commands and file tools start there\\.`))
  assert.match(moved, /No new note: every message of the part was carried over word for word\./)

  assert.equal((await call('update-bot', { id: 'b', workDir: '' })).ok, true)
  await until(() => state().bots.b.sessionId === 's2')
  await until(() => handoffOf(agentOf('s2')) !== undefined)
  assert.deepEqual(created.at(-1), { workspaceId: 'w1' })
  assert.match(handoffOf(agentOf('s2')), new RegExp(`because your working folder changed to ${escapeRegExp(team)}\\.`))
})

test('a running Bot moves at its next step and carries that step\'s input along', async (t) => {
  const { requests, services } = approvalServices('allowed-once')
  const { tool, preStep, agentOf, created, project, state, stop } = await start({ services })
  t.after(stop)
  agentOf('b').status = 'running'
  assert.equal(await tool('update_bot', { work_dir: project }, 'b'), `Updated Writer. From your next step on, you work in ${project}.`)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].reason, `Let Writer work in ${project}? Files there can then be changed.`)
  assert.equal(requests[0].toolName, 'update_bot')
  await settle()
  assert.deepEqual(created, [])

  const input = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Now build it' }], source: { kind: 'user' } }
  assert.deepEqual(await preStep('b', [input]), { kind: 'reject' })
  await until(() => state().bots.b.sessionId === 's1')
  assert.deepEqual(created, [{ cwd: project }])
  await until(() => agentOf('s1').calls.length >= 2)
  assert.deepEqual(agentOf('s1').calls.map(([kind, message]) => [kind, message.source.role ?? textOf(message)]), [['followup', 'handoff'], ['followup', 'Now build it']])
  // The fresh part is where it should be, so its steps go on.
  assert.equal(await preStep('s1'), 'next')
})

test('a folder outside the team workspace needs the user\'s approval', async (t) => {
  const rejected = approvalServices('rejected')
  const first = await start({ services: rejected.services })
  t.after(first.stop)
  assert.equal(await first.tool('update_bot', { work_dir: first.project }, 'b'), `Could not update the Bot: ${notAllowed(first.project)}`)
  assert.equal(first.state().bots.b.workDir, undefined)
  assert.equal(await first.tool('create_bot', { name: 'Builder', role: 'Build', instructions: 'Build', work_dir: first.project }, 'a'), `Could not create the Bot: ${notAllowed(first.project)}`)
  assert.deepEqual(first.created, [])
  // A folder inside the team workspace widens nothing, so nobody is asked.
  mkdirSync(join(first.team, 'site'))
  assert.equal(await first.tool('update_bot', { work_dir: join(first.team, 'site') }, 'b'), `Updated Writer. From your next step on, you work in ${join(first.team, 'site')}.`)
  assert.equal(rejected.requests.length, 2)
  assert.deepEqual(rejected.requests[1].displayReason, { en: `Let the new Bot Builder work in ${first.project}? Files there can then be changed.`, zh: `允许新 Bot Builder 在 ${first.project} 中工作吗？之后可以修改这个文件夹里的文件。` })
  await first.workingIn('b', join(first.team, 'site'))

  const never = await start(approvalServices('allowed-once', { policy: 'never' }))
  t.after(never.stop)
  assert.equal(await never.tool('update_bot', { work_dir: never.project }, 'b'), `Could not update the Bot: ${notAllowed(never.project)}`)
  assert.equal(never.state().bots.b.workDir, undefined)

  const allowed = approvalServices('allowed-once')
  const third = await start({ services: allowed.services })
  t.after(third.stop)
  assert.equal(await third.tool('create_bot', { name: 'Builder', role: 'Build', instructions: 'Build', work_dir: third.project }, 'a'), `Created Builder, working in ${third.project}. It is greeting the user now.`)
  assert.deepEqual(third.created, [{ cwd: third.project }])
  assert.match(await third.tool('list_bots', {}, 'a'), new RegExp(`- Builder \\(Build, works in ${escapeRegExp(third.project)}\\)`))
})

test('a group\'s folder holds for every member there; only the user or a Main Bot sets it', async (t) => {
  const { requests, services } = approvalServices('allowed-once')
  const { call, tool, preStep, created, project, state, stop } = await start({ services })
  t.after(stop)
  // The admin may change the group, but not its folder.
  assert.equal(await tool('update_group', { group: 'Ops', work_dir: project }, 'gb'), 'Only a Main Bot can set the folder of "Ops".')
  assert.equal((await call('update-room', { id: 'r1', workDir: project })).ok, true)
  assert.equal(state().rooms.r1.workDir, project)
  assert.equal(requests.length, 0)
  assert.match(await tool('list_bots', {}, 'a'), new RegExp(`"Ops" — .*; members work in ${escapeRegExp(project)} here`))

  // The member's group Session moves at its next turn there, not within a reply; its
  // own chat stays.
  assert.equal(await preStep('b'), 'next')
  assert.equal(await preStep('gb', [], 2), 'next')
  assert.deepEqual(created, [])
  assert.deepEqual(await preStep('gb'), { kind: 'reject' })
  await until(() => state().rooms.r1.sessions.b === 's1')
  assert.deepEqual(created, [{ cwd: project }])
  assert.equal(state().bots.b.sessionId, 'b')

  // A Main Bot clears it without asking; setting it asks the user once for every member.
  assert.equal(await tool('update_group', { group: 'Ops', work_dir: '' }, 'a'), 'Updated "Ops": every member works in its own folder again.')
  assert.equal(state().rooms.r1.workDir, undefined)
  assert.equal(requests.length, 0)
  assert.match(await tool('update_group', { group: 'Ops', work_dir: project }, 'a'), /^Updated "Ops": every member now works in .* here\.$/)
  assert.equal(requests[0].displayReason.zh, `允许群聊「Ops」的成员在 ${project} 中工作吗？之后可以修改这个文件夹里的文件。`)
})

test('a group\'s permissions hold for every member there in place of its own, until the user clears them', async (t) => {
  // The preset each Session runs on, as DSH keeps it.
  const presetOf = new Map()
  const PRESETS = ['read-only', 'workspace-write', 'danger-full-access']
  const permissionPresets = {
    catalog: () => ({ options: PRESETS.map(value => ({ value, name: value })), defaultPreset: 'workspace-write' }),
    resolve: (name) => { if (!PRESETS.includes(name)) throw new Error(`permission: unknown preset "${name}"`) },
    set: (session, name) => { presetOf.set(session.id, name) },
  }
  const { call, tool, preStep, project, state, stop } = await start({ services: { ...approvalServices('allowed-once').services, permissionPresets } })
  t.after(stop)

  // A preset DSH does not offer changes nothing, not even the rest of the change; the
  // next change that saves would keep it.
  assert.equal((await call('update-room', { id: 'r1', notice: 'Ship it', permission: 'everything' })).ok, false)
  assert.equal(presetOf.size, 0)

  const set = await call('update-room', { id: 'r1', permission: 'read-only' })
  assert.deepEqual(set.value.changes, ['every member now works with the read-only permissions here'])
  assert.equal(state().rooms.r1.notice, undefined)
  assert.equal(set.value.room.permission, 'read-only')
  assert.equal(presetOf.get('gb'), 'read-only')
  assert.match(await tool('list_bots', {}, 'a'), /"Ops" — .*; members work with the read-only permissions here/)

  // Writer has no preset of its own, so its group Session goes back to DSH's default.
  assert.deepEqual((await call('update-room', { id: 'r1', permission: null })).value.changes, ['every member uses its own permissions again'])
  assert.equal(state().rooms.r1.permission, undefined)
  assert.equal(presetOf.get('gb'), 'workspace-write')

  // While the group sets one, Writer's own preset reaches its own chat only.
  await call('update-room', { id: 'r1', permission: 'read-only' })
  assert.equal((await call('update-bot', { id: 'b', permission: 'danger-full-access' })).ok, true)
  assert.deepEqual([presetOf.get('b'), presetOf.get('gb')], ['danger-full-access', 'read-only'])

  // A fresh part of the group conversation starts on the group's preset.
  await call('update-room', { id: 'r1', workDir: project })
  assert.deepEqual(await preStep('gb'), { kind: 'reject' })
  await until(() => state().rooms.r1.sessions.b === 's1')
  assert.equal(presetOf.get('s1'), 'read-only')

  await call('update-room', { id: 'r1', permission: null })
  assert.equal(presetOf.get('s1'), 'danger-full-access')
})

test('the approval counts every Session that would work in the folder', async (t) => {
  // Writer's own chat and new Sessions only read; its conversation in Ops may write.
  const group = approvalServices('allowed-once', { mode: 'read-only', modes: { gb: 'workspace-write' } })
  const first = await start({ services: group.services })
  t.after(first.stop)
  assert.equal(await first.tool('update_bot', { bot: 'Writer', work_dir: first.project }, 'a'), `Updated Writer. It now works in ${first.project}.`)
  assert.equal(group.requests.length, 1)
  await first.workingIn('b', first.project)
  assert.match(await first.tool('update_group', { group: 'Ops', work_dir: first.project }, 'a'), /^Updated "Ops": every member now works in /)
  assert.equal(group.requests.length, 2)

  // Nothing that would work there may write, so nobody is asked.
  const reading = approvalServices('rejected', { mode: 'read-only' })
  const second = await start({ services: reading.services })
  t.after(second.stop)
  assert.equal(await second.tool('update_bot', { bot: 'Writer', work_dir: second.project }, 'a'), `Updated Writer. It now works in ${second.project}.`)
  assert.equal(reading.requests.length, 0)
  await second.workingIn('b', second.project)

  // Sessions made there later start under the default, so a default that writes asks.
  const later = approvalServices('rejected', { modes: { a: 'read-only', b: 'read-only', gb: 'read-only' } })
  const third = await start({ services: later.services })
  t.after(third.stop)
  assert.equal(await third.tool('update_bot', { bot: 'Writer', work_dir: third.project }, 'a'), `Could not update the Bot: ${notAllowed(third.project)}`)
  assert.equal(later.requests.length, 1)
})

test('a Bot that joins a group with a folder needs the user\'s approval to work there', async (t) => {
  const { requests, services } = approvalServices('rejected')
  const { call, tool, project, state, stop } = await start({ services })
  t.after(stop)
  assert.equal((await call('update-room', { id: 'r1', workDir: project })).ok, true)
  assert.equal((await call('create-bot', { name: 'Coder' })).ok, true)
  assert.equal(await tool('update_group', { group: 'Ops', add_members: ['Coder'] }, 'a'), `Could not update "Ops": ${notAllowed(project)}`)
  assert.deepEqual(state().rooms.r1.members, ['a', 'b'])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].reason, `Let Coder work in ${project}? Files there can then be changed.`)
  // Members already there are not asked again.
  assert.equal(await tool('update_group', { group: 'Ops', add_members: ['Writer'], notice: 'Ship it' }, 'a'), 'Updated "Ops": updated the notice.')
  assert.equal(requests.length, 1)
})

test('the folder menu lists DSH projects and the folders Bots use, but not the team workspace', async (t) => {
  const { call, workingIn, root, project, team, stop } = await start({ workspaces: [{ id: 'w2', path: join(rootless(), 'gone'), title: 'Gone' }] })
  t.after(stop)
  const other = join(root, 'other')
  mkdirSync(other)
  await call('update-bot', { id: 'b', workDir: project })
  await workingIn('b', project)
  await call('update-room', { id: 'r1', workDir: other })
  assert.deepEqual((await call('folders', {})).value, {
    team,
    picker: null,
    folders: [{ path: project, title: 'project' }, { path: other, title: 'other' }],
  })
  assert.equal((await call('folder-pick', {})).error.message, 'This DeepSeek Harness has no folder chooser')
})

test('the folder menu browses through the DSH folder picker', async (t) => {
  const asked = []
  const directoryPicker = {
    capability: () => ({
      kind: 'browse',
      list: async (path) => {
        asked.push(path)
        return { path: path ?? '/srv/team', home: '/srv/team', crumbs: [], entries: [{ name: 'code', path: '/srv/team/code' }], truncated: false, extra: 'x' }
      },
    }),
  }
  const { call, stop } = await start({ services: { directoryPicker } })
  t.after(stop)
  assert.equal((await call('folders', {})).value.picker, 'browse')
  assert.deepEqual((await call('folder-list', {})).value, { path: '/srv/team', home: '/srv/team', crumbs: [], entries: [{ name: 'code', path: '/srv/team/code' }], truncated: false })
  await call('folder-list', { path: '/srv/team/code' })
  assert.deepEqual(asked, [undefined, '/srv/team/code'])
})

// A path under no temporary folder of these tests, so nothing is there.
function rootless() {
  return join(tmpdir(), `ds-bot-work-dir-none-${process.pid}`)
}

test('a Bot the Main Bot creates runs on its creator\'s model unless one is named', async (t) => {
  // The DSH default is a provider without a key; the Main Bot runs on one that works.
  const providers = { deepseek: ['v4'], official: ['pro'] }
  const env = await start({
    services: { agentDefaultModel: { currentSelection: () => ({ provider: 'official', model: 'pro' }) } },
    team: { ...TEAM, bots: { ...TEAM.bots, a: { ...TEAM.bots.a, model: 'deepseek/v4' } } },
    llm: {
      listProviders: () => Object.keys(providers).map(id => ({ id, name: id })),
      listModels: async id => providers[id].map(model => ({ id: model })),
      resolveModelInfo: async () => ({}),
    },
  })
  t.after(env.stop)
  const made = name => Object.values(env.state().bots).find(bot => bot.name === name)
  assert.equal(await env.tool('create_bot', { name: 'Editor', role: 'Edit', instructions: 'Edit' }, 'a'), 'Created Editor. It is greeting the user now.')
  assert.equal(made('Editor').model, 'deepseek/v4')
  assert.equal(await env.tool('create_bot', { name: 'Tester', role: 'Test', instructions: 'Test', model: 'official/pro' }, 'a'), 'Created Tester. It is greeting the user now.')
  assert.equal(made('Tester').model, 'official/pro')
})

// 公开#159: the fresh part took the model of the earlier part's last request, so a model
// the user picked during the handoff never reached it, nor any part after it.
const MODELS = {
  listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
  listModels: async () => [{ id: 'flash' }, { id: 'v4-pro' }],
  resolveModelInfo: async () => ({}),
}
const onModel = (model, appliedModel = model) => ({ ...TEAM, bots: { ...TEAM.bots, b: { ...TEAM.bots.b, model, appliedModel } } })
const recordSelections = (env) => {
  const selected = []
  env.ctx.sessionController.selectModel = async (request) => { selected.push([request.sessionId, request.model]) }
  // The earlier part's last request went to flash.
  env.agentOf('b').session.requestHeader = () => ({ config: { provider: 'deepseek', model: 'flash' } })
  return selected
}

test('a fresh part runs on the Bot\'s model, not on the earlier part\'s last request', async (t) => {
  const env = await start({ llm: MODELS, team: onModel('deepseek/v4-pro') })
  t.after(env.stop)
  const selected = recordSelections(env)
  assert.equal((await env.call('update-bot', { id: 'b', workDir: env.project })).ok, true)
  await until(() => env.state().bots.b.sessionId === 's1')
  await until(() => handoffOf(env.agentOf('s1')) !== undefined)
  assert.deepEqual(selected.filter(([sessionId]) => sessionId === 's1'), [['s1', 'v4-pro']])
})

test('a model the user picks while the fresh part is made reaches the fresh part', async (t) => {
  const env = await start({ llm: MODELS, team: onModel('deepseek/flash') })
  t.after(env.stop)
  const selected = recordSelections(env)
  const select = env.ctx.sessionController.selectModel
  env.ctx.sessionController.selectModel = async (request) => {
    await select(request)
    if (request.sessionId !== 's1' || selected.length > 1) return
    // The user switches models after the fresh part got the old one, before it is the Bot's.
    void env.call('update-bot', { id: 'b', model: 'deepseek/v4-pro' })
    await until(() => env.state().bots.b.model === 'deepseek/v4-pro')
  }
  assert.equal((await env.call('update-bot', { id: 'b', workDir: env.project })).ok, true)
  await until(() => env.state().bots.b.sessionId === 's1')
  await until(() => selected.some(([sessionId, model]) => sessionId === 'b' && model === 'v4-pro'))
  await until(() => handoffOf(env.agentOf('s1')) !== undefined)
  assert.deepEqual(selected.filter(([sessionId]) => sessionId === 's1'), [['s1', 'flash'], ['s1', 'v4-pro']])
})

test('a Bot without a model of its own goes on with the earlier part\'s route', async (t) => {
  const env = await start({ llm: MODELS })
  t.after(env.stop)
  const selected = recordSelections(env)
  assert.equal((await env.call('update-bot', { id: 'b', workDir: env.project })).ok, true)
  await until(() => env.state().bots.b.sessionId === 's1')
  await until(() => handoffOf(env.agentOf('s1')) !== undefined)
  assert.deepEqual(selected.filter(([sessionId]) => sessionId === 's1'), [['s1', 'flash']])
})

test('a folder-triggered part switch is flagged in the work view while it runs', async (t) => {
  const env = await start()
  t.after(env.stop)
  let seen
  const archive = env.ctx.workspaceRegistry.archiveSession
  env.ctx.workspaceRegistry.archiveSession = async (...args) => {
    if (seen === undefined) seen = (await env.call('state', {})).value.work.bots.b ?? null
    return archive(...args)
  }
  assert.equal((await env.call('update-bot', { id: 'b', workDir: env.project })).ok, true)
  await until(() => env.state().bots.b.sessionId === 's1')
  await until(() => handoffOf(env.agentOf('s1')) !== undefined)
  assert.equal(seen?.switching, true)
  assert.equal(seen?.folder, true)
})

// #209: DSH 0.2.1 checks a Session's folder as it puts a model request together, before
// agent/pre-step, and fails the turn when the folder and the one the Session was made in
// are gone. Its documented way out is to change the Session's folder first.
function folderService() {
  const dirs = new Map()
  const sets = []
  return {
    sets,
    service: {
      get: session => dirs.get(session.id) ?? session.header.cwd,
      set: async (agent, path) => { sets.push([agent.id, path]); dirs.set(agent.session.id, path) },
    },
  }
}
const assemble = (ctx, agent) => {
  let passed = false
  const run = ctx.listeners.get('system-prompt/assemble').at(-1)({ contexts: [] }, { agent, signal: AbortSignal.timeout(60_000) }, async () => { passed = true })
  return run.then(() => passed)
}

test('a Bot whose folder is gone changes to the team folder before DSH checks it, then moves to a fresh part there', async (t) => {
  const { sets, service } = folderService()
  const { ctx, call, agentOf, created, project, team, state, preStep, stop } = await start({ services: { workingDirectory: service } })
  t.after(stop)
  assert.equal((await call('update-bot', { id: 'b', workDir: project })).ok, true)
  await until(() => state().bots.b.sessionId === 's1')
  await until(() => handoffOf(agentOf('s1')) !== undefined)
  rmSync(project, { recursive: true, force: true })

  assert.equal(await assemble(ctx, agentOf('s1')), true)
  assert.deepEqual(sets, [['s1', team]])
  // The pre-step then moves the Bot on to a fresh part in the team workspace. DSH's notice
  // of the change is about the old part, so it stays behind.
  const notice = { id: 'm0', role: 'user', content: [{ type: 'text', text: 'The working directory is now the team folder.' }], source: { kind: 'working-directory' } }
  const input = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Still there?' }], source: { kind: 'user' } }
  assert.deepEqual(await preStep('s1', [notice, input]), { kind: 'reject' })
  await until(() => state().bots.b.sessionId === 's2')
  assert.deepEqual(created.at(-1), { workspaceId: 'w1' })
  await until(() => agentOf('s2').calls.length >= 2)
  assert.deepEqual(agentOf('s2').calls.map(([kind, message]) => [kind, message.source.role ?? textOf(message)]), [['followup', 'handoff'], ['followup', 'Still there?']])
  // A folder that is there is left as it is.
  assert.equal(await assemble(ctx, agentOf('a')), true)
  assert.equal(sets.length, 1)
})

test('a team copied from another DSH_HOME moves on to a fresh part in the folder the app names at its first turn', async (t) => {
  const copied = { ...TEAM }
  delete copied.workspaceId
  const previous = process.env.DS_BOT_WORKSPACE
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-app-workspace-')))
  process.env.DS_BOT_WORKSPACE = root
  const { agentOf, created, state, preStep, stop } = await start({ team: copied })
  t.after(async () => {
    await stop()
    if (previous === undefined) delete process.env.DS_BOT_WORKSPACE
    else process.env.DS_BOT_WORKSPACE = previous
    rmSync(root, { recursive: true, force: true })
  })
  const input = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Hello again' }], source: { kind: 'user' } }
  assert.deepEqual(await preStep('b', [input]), { kind: 'reject' })
  await until(() => state().bots.b.sessionId === 's1')
  assert.equal(state().workspaceId, 'w-new')
  assert.deepEqual(created, [{ workspaceId: 'w-new' }])
  assert.equal(agentOf('s1').session.header.cwd, root)
  await until(() => agentOf('s1').calls.length >= 2)
  assert.deepEqual(agentOf('s1').calls.map(([kind, message]) => [kind, message.source.role ?? textOf(message)]), [['followup', 'handoff'], ['followup', 'Hello again']])
})

test('the user moves the team workspace, and Bots without a folder of their own move on to a fresh part there at their next turn', async (t) => {
  const { root, team, project, agentOf, created, state, preStep, call, stop } = await start()
  t.after(stop)
  await call('update-bot', { id: 'a', workDir: project })
  const moved = join(root, 'moved')
  assert.deepEqual((await call('team-workspace', { path: moved })).value, { team: moved })
  assert.equal(state().workspaceId, 'w-new')
  assert.equal(existsSync(team), true)
  const input = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Hello again' }], source: { kind: 'user' } }
  assert.deepEqual(await preStep('b', [input]), { kind: 'reject' })
  await until(() => state().bots.b.sessionId !== 'b')
  assert.equal(agentOf(state().bots.b.sessionId).session.header.cwd, moved)
  assert.deepEqual(created.at(-1), { workspaceId: 'w-new' })
  // A Bot with a folder of its own stays where it works.
  assert.equal(state().bots.a.workDir, project)
})

test('the team workspace holds no DeepSeek Harness data, apart from the plugin\'s own default', async (t) => {
  const { root, dsh, home, team, state, call, stop } = await start()
  t.after(stop)
  const error = async path => (await call('team-workspace', { path })).error?.message
  assert.match(await error(join(dsh, 'inside')), /holds DeepSeek Harness data/)
  assert.match(await error(root), /holds DeepSeek Harness data/)
  assert.match(await error('relative'), /full path/)
  assert.equal(existsSync(join(dsh, 'inside')), false)
  // A folder to be made under a link into the data is refused before anything is made.
  symlinkSync(dsh, join(root, 'dsh-link'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.match(await error(join(root, 'dsh-link', 'new')), /holds DeepSeek Harness data/)
  assert.equal(existsSync(join(dsh, 'new')), false)
  assert.equal(state().workspaceId, 'w1')
  await call('team-workspace', { path: join(root, 'moved') })
  assert.deepEqual((await call('team-workspace', { path: join(home, 'workspace') })).value, { team })
  assert.equal(state().workspaceId, 'w1')
  // The default replaced by a link into the data, to all of it or a part, is refused.
  await call('team-workspace', { path: join(root, 'moved') })
  rmSync(team, { recursive: true, force: true })
  symlinkSync(home, team, process.platform === 'win32' ? 'junction' : 'dir')
  assert.match(await error(team), /holds DeepSeek Harness data/)
  rmSync(team, { recursive: true, force: true })
  mkdirSync(join(dsh, 'profiles'))
  symlinkSync(join(dsh, 'profiles'), team, process.platform === 'win32' ? 'junction' : 'dir')
  assert.match(await error(team), /holds DeepSeek Harness data/)
  assert.equal(state().workspaceId, 'w-new')
})

test('a copied team shows its default team workspace before the workspace is registered', async (t) => {
  const copied = { ...TEAM }
  delete copied.workspaceId
  const { home, state, call, stop } = await start({ team: copied })
  t.after(stop)
  assert.equal(state().workspaceId, undefined)
  assert.equal((await call('folders', {})).value.team, resolve(join(home, 'workspace')))
})

test('in the desktop app the user\'s own DSH data is no team workspace and no Bot\'s folder either', async (t) => {
  const { root, state, call, stop } = await start()
  t.after(stop)
  const user = join(root, 'user-dsh')
  mkdirSync(join(user, 'profiles'), { recursive: true })
  process.env.DS_BOT_USER_DSH_HOME = user
  t.after(() => { delete process.env.DS_BOT_USER_DSH_HOME })
  assert.match((await call('team-workspace', { path: join(user, 'new') })).error?.message, /holds DeepSeek Harness data/)
  assert.equal(existsSync(join(user, 'new')), false)
  assert.equal((await call('update-bot', { id: 'b', workDir: join(user, 'profiles') })).error?.message, `${join(user, 'profiles')} holds DeepSeek Harness data, so Bots cannot work there`)
  assert.equal(state().workspaceId, 'w1')
})

test('a team folder that was deleted is made again before DSH checks it', async (t) => {
  const { sets, service } = folderService()
  const { ctx, agentOf, team, stop } = await start({ services: { workingDirectory: service } })
  t.after(stop)
  rmSync(team, { recursive: true, force: true })
  assert.equal(await assemble(ctx, agentOf('a')), true)
  assert.equal(existsSync(team), true)
  assert.deepEqual(sets, [])
})

// A fresh part takes several awaits; a Bot deleted meanwhile must not leave it behind.
test('a Bot deleted while its chat moves to a new folder leaves no fresh part behind', async (t) => {
  const { ctx, call, agentOf, project, state, stop } = await start()
  t.after(stop)
  const archived = []
  ctx.workspaceRegistry.archiveSession = async (sessionId) => { archived.push(sessionId) }
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
  assert.equal((await call('update-bot', { id: 'b', workDir: project })).ok, true)
  const fresh = await making
  assert.equal((await call('delete-bot', { id: 'b' })).ok, true)
  release()
  await until(() => archived.includes(fresh))
  await settle()
  assert.equal(state().bots.b, undefined)
  assert.equal(handoffOf(agentOf(fresh)), undefined)
})

// DSH 0.2.1's working_directory, run through ds-bot's tools/execute listeners as DSH runs
// them; the last step is the tool, which changes the Session's folder in place.
async function changeDirectory(ctx, service, agent, cd) {
  let ran = false
  const tool = async () => {
    ran = true
    const cwd = resolve(service.get(agent.session), cd)
    await service.set(agent, cwd)
    return { isError: false, value: { cwd } }
  }
  const exec = { name: 'working_directory', arguments: { cd }, agent, callId: 'c1', signal: AbortSignal.timeout(60_000) }
  const run = ctx.listeners.get('tools/execute').reduceRight((next, listener) => () => listener(exec, next), tool)
  try {
    return { result: await run(), ran }
  } catch (error) {
    return { error: error.message, ran }
  }
}

test('a Bot that changes to a folder inside its working folder only moves that Session there', async (t) => {
  const { service } = folderService()
  const { requests, services } = approvalServices('rejected')
  const { ctx, agentOf, team, created, state, preStep, stop } = await start({ services: { ...services, workingDirectory: service } })
  t.after(stop)
  mkdirSync(join(team, 'site'))
  agentOf('b').status = 'running'
  const moved = await changeDirectory(ctx, service, agentOf('b'), 'site')
  assert.deepEqual(moved, { result: { isError: false, value: { cwd: join(team, 'site') } }, ran: true })
  assert.equal(state().bots.b.workDir, undefined)
  assert.equal(requests.length, 0)
  assert.equal(await preStep('b'), 'next')
  assert.deepEqual(created, [])
})

test('a Bot that changes to a folder outside its working folder makes it its working folder and goes on in a fresh part there', async (t) => {
  const { service } = folderService()
  const { requests, services } = approvalServices('allowed-once')
  const { ctx, agentOf, project, created, state, preStep, stop } = await start({ services: { ...services, workingDirectory: service } })
  t.after(stop)
  agentOf('b').status = 'running'
  const moved = await changeDirectory(ctx, service, agentOf('b'), project)
  assert.deepEqual(moved, { result: { isError: false, value: { cwd: project } }, ran: true })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].toolName, 'working_directory')
  assert.equal(requests[0].reason, `Let Writer work in ${project}? Files there can then be changed.`)
  assert.equal(state().bots.b.workDir, project)

  const input = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Now build it' }], source: { kind: 'user' } }
  assert.deepEqual(await preStep('b', [input]), { kind: 'reject' })
  await until(() => state().bots.b.sessionId === 's1')
  assert.deepEqual(created, [{ cwd: project }])
  await until(() => handoffOf(agentOf('s1')) !== undefined)
  assert.match(handoffOf(agentOf('s1')), new RegExp(`because your working folder changed to ${escapeRegExp(project)}\\.`))
})

test('a change out of the working folder that is not allowed changes nothing', async (t) => {
  const { service } = folderService()
  const { services } = approvalServices('rejected')
  const { ctx, agentOf, dsh, project, state, stop } = await start({ services: { ...services, workingDirectory: service } })
  t.after(stop)
  assert.deepEqual(await changeDirectory(ctx, service, agentOf('b'), project), { error: notAllowed(project), ran: false })
  const guarded = await changeDirectory(ctx, service, agentOf('b'), dsh)
  assert.match(guarded.error, /holds DeepSeek Harness data, so Bots cannot work there/)
  assert.equal(guarded.ran, false)
  assert.equal(state().bots.b.workDir, undefined)
})

test('in a group with a folder of its own a member stays inside it; without one the member\'s own folder changes', async (t) => {
  const { service } = folderService()
  const { services } = approvalServices('allowed-once')
  const { ctx, call, agentOf, team, project, state, stop } = await start({ services: { ...services, workingDirectory: service } })
  t.after(stop)
  assert.equal((await call('update-room', { id: 'r1', workDir: project })).ok, true)
  mkdirSync(join(project, 'src'))
  const inside = await changeDirectory(ctx, service, agentOf('gb'), join(project, 'src'))
  assert.equal(inside.ran, true)
  const out = await changeDirectory(ctx, service, agentOf('gb'), team)
  assert.deepEqual(out, { error: `Every member of "Ops" works in ${project} here, so you stay inside it. The user or a Main Bot can change the group's folder.`, ran: false })
  assert.equal(state().bots.b.workDir, undefined)

  assert.equal((await call('update-room', { id: 'r1', workDir: '' })).ok, true)
  const own = await changeDirectory(ctx, service, agentOf('gb'), project)
  assert.equal(own.ran, true)
  assert.equal(state().bots.b.workDir, project)
  assert.equal(state().rooms.r1.workDir, undefined)
})

test('Sessions that are not a Bot\'s keep DSH\'s own working_directory', async (t) => {
  const { service } = folderService()
  const { requests, services } = approvalServices('rejected')
  const { ctx, agentOf, project, state, stop } = await start({ services: { ...services, workingDirectory: service } })
  t.after(stop)
  assert.deepEqual(await changeDirectory(ctx, service, agentOf('x'), project), { result: { isError: false, value: { cwd: project } }, ran: true })
  assert.equal(requests.length, 0)
  assert.deepEqual(Object.values(state().bots).map(bot => bot.workDir), [undefined, undefined])
})

test('while another dsh has the team open, a Bot cannot leave its working folder', async (t) => {
  const { service } = folderService()
  const { services } = approvalServices('allowed-once')
  const { ctx, agentOf, team, project, state, stop } = await start({ services: { ...services, workingDirectory: service }, locked: true })
  t.after(stop)
  mkdirSync(join(team, 'site'))
  assert.equal((await changeDirectory(ctx, service, agentOf('b'), 'site')).ran, true)
  const out = await changeDirectory(ctx, service, agentOf('b'), project)
  assert.match(out.error, /^Your working folder cannot change now: The Bot team in .* is open in another dsh/)
  assert.equal(out.ran, false)
  assert.equal(state().bots.b.workDir, undefined)
})

// The trimmed path names no folder, so a check of it would let DSH move out unchecked.
test('the folder is checked as DSH gets it, spaces and all', { skip: process.platform === 'win32' && 'Windows drops trailing spaces from names' }, async (t) => {
  const { service } = folderService()
  const { services } = approvalServices('allowed-once')
  const { ctx, agentOf, root, state, stop } = await start({ services: { ...services, workingDirectory: service } })
  t.after(stop)
  const spaced = join(root, 'outside ')
  mkdirSync(spaced)
  assert.deepEqual(await changeDirectory(ctx, service, agentOf('b'), spaced), { error: `${JSON.stringify(spaced)} cannot be a working folder: its name starts or ends with a space or a quote mark.`, ran: false })
  assert.equal(state().bots.b.workDir, undefined)
})

test('a Bot changes back to the team workspace when the team workspace is known by a link', async (t) => {
  const { service } = folderService()
  const { requests, services } = approvalServices('rejected')
  const { ctx, call, agentOf, root, team, project, state, stop } = await start({ services: { ...services, workingDirectory: service } })
  t.after(stop)
  const link = join(root, 'team-link')
  symlinkSync(team, link, 'junction')
  ctx.workspaceRegistry.get('w1').path = link
  mkdirSync(join(team, 'site'))
  // The team workspace widens nothing, so nobody is asked, also for a folder inside it.
  assert.equal((await call('update-bot', { id: 'b', workDir: project })).ok, true)
  await until(() => state().bots.b.sessionId === 's1')
  assert.equal((await changeDirectory(ctx, service, agentOf('s1'), join(team, 'site'))).ran, true)
  assert.equal(state().bots.b.workDir, join(team, 'site'))

  assert.equal((await call('update-bot', { id: 'b', workDir: project })).ok, true)
  await until(() => state().bots.b.workDir === project)
  const back = await changeDirectory(ctx, service, agentOf('s1'), team)
  assert.equal(back.ran, true)
  assert.equal(state().bots.b.workDir, undefined)
  assert.equal(requests.length, 0)
})
