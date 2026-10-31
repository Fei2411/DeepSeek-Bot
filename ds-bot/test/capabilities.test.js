import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { expandCapabilityNames, validateCapabilityName } from '../src/host/capabilities.js'
import { fakeContext } from './fake-ctx.js'

const makeHome = state => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-capabilities-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  return home
}
const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', capabilities: [], createdAt: 1 },
    worker: { id: 'worker', sessionId: 'worker', name: 'Worker', capabilities: [], createdAt: 2 },
    helper: { id: 'helper', sessionId: 'helper', name: 'Helper', capabilities: [], createdAt: 3 },
  },
  rooms: { room: { id: 'room', members: ['chief'], sessions: { chief: 'room-chief' }, admin: 'chief', mode: 'everyone' } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})
const mcp = (name, command = 'node') => ({ name, kind: 'mcp', description: 'Echo service', transport: 'stdio', command, args: [], env: {} })
const created = env => env.ctx.listeners.get('agent/created').find(listener => listener.name === 'prepareCapabilities')

function testAgent(id, mounts, skillsBySession, { awaitMount = async () => {} } = {}) {
  const disposers = []
  const skills = new Map()
  skillsBySession.set(id, skills)
  const agentCtx = {
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    plugin(plugin, config) {
      const record = { plugin, config, sessionId: id, disposed: false }
      mounts.push(record)
      if (plugin.inject?.includes('skills')) {
        const c = {
          skills: { register(skill) { skills.set(skill.name, skill); return () => skills.delete(skill.name) } },
          effect: execute => { record.cleanup = execute() },
        }
        plugin.apply(c)
      }
      return {
        await: () => awaitMount(record),
        dispose: () => { record.disposed = true; record.cleanup?.() },
      }
    },
    dispose() { for (const dispose of disposers.reverse()) dispose() },
  }
  return { id, session: { id }, ctx: agentCtx }
}

async function setup({ state = team(), secret, beforeLoad } = {}) {
  const home = makeHome(state)
  if (secret) writeFileSync(join(home, 'secrets.json'), JSON.stringify({ secrets: [secret] }))
  const mounts = []
  const skills = new Map()
  const mcpPlugin = { name: 'mcp-client', apply() {} }
  const loader = { import: async () => ({ default: mcpPlugin }), unwrapExports: exports => exports.default }
  const ctx = fakeContext({ services: { loader } })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  ctx.sessionTitle = { rename: async () => {} }
  rt.resolveAgent = async sessionId => ({ session: { id: sessionId } })
  beforeLoad?.({ ctx, rt, mounts, skills, mcpPlugin })
  await rt.load()
  return {
    home,
    ctx,
    rt,
    mounts,
    skills,
    mcpPlugin,
    async dispose() {
      ctx.dispose()
      await rt.scheduleCapabilitiesReconcile()
      await new Promise(resolve => setImmediate(resolve))
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

test('capability names use the MCP and skill validator intersection', () => {
  assert.equal(validateCapabilityName('a'), 'a')
  assert.equal(validateCapabilityName('web-search-1'), 'web-search-1')
  for (const name of ['github', 'with_underscore', 'with--dash', '1tool', 'A', 'a'.repeat(33)]) assert.throws(() => validateCapabilityName(name))
})

test('packs expand only to MCP and skill items', () => {
  const items = { server: { kind: 'mcp' }, guide: { kind: 'skill' }, team: { kind: 'pack', items: ['server', 'guide'] } }
  assert.deepEqual(expandCapabilityNames(['team', 'server'], items), new Set(['server', 'guide']))
  assert.throws(() => expandCapabilityNames(['missing'], items), /No capability/)
  assert.throws(() => expandCapabilityNames(['bad'], { ...items, bad: { kind: 'pack', items: ['team'] } }), /unavailable capability/)
})

test('state migration adds an empty library and Bot attachment lists', async t => {
  const old = team()
  delete old.capabilities
  for (const bot of Object.values(old.bots)) delete bot.capabilities
  const env = await setup({ state: old })
  t.after(() => env.dispose())
  await env.rt.load()
  assert.deepEqual(env.rt.state.capabilities, { items: {} })
  assert.deepEqual(env.rt.state.bots.chief.capabilities, [])
  const saved = JSON.parse(await (await import('node:fs/promises')).readFile(join(env.home, 'state.json'), 'utf8'))
  assert.deepEqual(saved.capabilities, { items: {} })
  assert.deepEqual(saved.bots.chief.capabilities, [])
})

test('Bot saves enforce approval and ownership, and deletion cascades', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const { rt } = env
  const { state } = rt
  const created = await rt.capabilitySave(mcp('echo'), { botId: 'worker' })
  assert.equal(created.approved, false)
  const description = await rt.capabilitySave({ ...mcp('echo'), description: 'Updated' }, { botId: 'worker' })
  assert.equal(description.approved, false)
  await rt.capabilityEndpoint('capability-approve', { name: 'echo' })
  const approved = await rt.capabilitySave({ ...mcp('echo'), description: 'Another description' }, { botId: 'worker' })
  assert.equal(approved.approved, true)
  const changed = await rt.capabilitySave(mcp('echo', 'node-new'), { botId: 'worker' })
  assert.equal(changed.approved, false)
  await assert.rejects(
    rt.capabilitySave({ name: 'echo', kind: 'skill', description: 'Other kind', content: 'Instructions' }, { botId: 'worker' }),
    error => error.message === 'A capability cannot change its kind. Delete it and save a new one.',
  )
  await assert.rejects(rt.capabilitySave(mcp('echo'), { botId: 'helper' }), /creator or a Main Bot/)
  await assert.rejects(rt.capabilityDelete('echo', { botId: 'helper' }), /creator or a Main Bot/)
  await rt.capabilitySave({ name: 'guide', kind: 'skill', description: 'Guide', content: 'Do the work.' }, { botId: 'worker' })
  await rt.capabilitySave({ name: 'team', kind: 'pack', items: ['echo', 'guide'] }, { botId: 'worker' })
  state.bots.worker.capabilities = ['echo', 'team']
  await rt.capabilityDelete('echo', { botId: 'worker' })
  assert.equal(state.capabilities.items.echo, undefined)
  assert.deepEqual(state.capabilities.items.team.items, ['guide'])
  assert.deepEqual(state.bots.worker.capabilities, ['team'])
})

test('capability Bot tools refuse DSH Agent sessions', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const list = env.ctx.registeredTools.get('list_capabilities')
  assert.ok(list)
  assert.match(await list.execute({}, { agent: { id: 'outside' } }), /Only Bots on the team/)
})

test('capability tool descriptions and attach results explain approval', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const parameters = env.ctx.registeredTools.get('save_capability').parameters.properties
  assert.deepEqual(
    Object.fromEntries(['transport', 'command', 'args', 'env', 'url', 'headers', 'content'].map(name => [name, parameters[name].description])),
    {
      transport: 'How to reach an MCP server: a local command or an HTTP URL',
      command: 'Program that starts a local MCP server',
      args: 'Arguments for command',
      env: 'Environment variables for command; write $DSH_SECRET_<NAME> to insert a saved secret instead of the value',
      url: 'MCP server URL; write $DSH_SECRET_<NAME> in the path or query to insert a saved secret, URL-encoded. Prefer headers for keys',
      headers: 'HTTP headers; write $DSH_SECRET_<NAME> to insert a saved secret instead of the value',
      content: 'Skill instructions',
    },
  )
  await env.rt.capabilitySave(mcp('blocked'), { botId: 'worker' })
  const attached = await env.ctx.registeredTools.get('attach_capability').execute(
    { name: 'blocked' },
    { agent: { id: 'worker' } },
  )
  assert.ok(attached.endsWith(' The user must allow blocked in DS Bot settings before it can work.'))
})

test('a deleted Bot leaves no shared capability it alone held behind', async t => {
  const env = await setup({
    beforeLoad: ({ ctx }) => { ctx.workspaceRegistry = { archiveSession: async () => {} } },
  })
  t.after(() => env.dispose())
  const { rt } = env
  await rt.capabilitySave(mcp('echo'), { botId: 'chief' })
  await rt.capabilitySave(mcp('solo'), { botId: 'chief' })
  await rt.capabilitySave({ name: 'guide', kind: 'skill', description: 'Guide', content: 'Do the work.' }, { botId: 'chief' })
  await rt.capabilitySave({ name: 'team', kind: 'pack', items: ['echo', 'solo'] }, { botId: 'chief' })
  await rt.capabilitySave(mcp('shared'), { botId: 'chief' })
  await rt.capabilitySave(mcp('unused'), { ui: true })
  rt.state.bots.worker.capabilities = ['echo', 'guide', 'team']
  rt.state.bots.helper.capabilities = ['guide', 'shared']
  await rt.deleteBot('worker')
  // 'echo', 'solo' (only inside 'team') and 'team' had no other holder; the rest stay.
  assert.deepEqual(Object.keys(rt.state.capabilities.items).sort(), ['guide', 'shared', 'unused'])
  await assert.rejects(rt.capabilityEndpoint('capability-approve', { name: 'echo' }), /No unapproved stdio MCP/)
  const saved = JSON.parse(await (await import('node:fs/promises')).readFile(join(env.home, 'state.json'), 'utf8'))
  assert.deepEqual(Object.keys(saved.capabilities.items).sort(), ['guide', 'shared', 'unused'])
})

test('read-only secret reload does not requeue capability reconciliation', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  await env.rt.loadSecrets()
  await env.rt.scheduleCapabilitiesReconcile()
  env.rt.readOnly = () => 'The Bot team is open in another dsh.'
  let loads = 0
  const loadSecrets = env.rt.loadSecrets
  env.rt.loadSecrets = async () => {
    loads += 1
    return loadSecrets()
  }
  await env.rt.reconcileCapabilities()
  assert.equal(loads, 1)
})

test('startup and empty-to-nonempty attachments track existing Bot Agents', async t => {
  const state = team()
  state.capabilities = { items: { echo: { ...mcp('echo'), approved: true, createdBy: 'chief', createdAt: 1, updatedAt: 1 } } }
  state.bots.chief.capabilities = ['echo']
  const resolved = []
  const env = await setup({
    state,
    beforeLoad: ({ rt, mounts, skills }) => {
      const existing = Object.fromEntries(['chief', 'room-chief', 'worker', 'helper'].map(id => [id, testAgent(id, mounts, skills)]))
      rt.chatOf = botId => botId
      rt.groupSessionsOf = botId => botId === 'chief' ? ['room-chief', 'room-chief'] : []
      rt.resolveAgent = async sessionId => {
        if (Object.hasOwn(existing, sessionId)) resolved.push(sessionId)
        return existing[sessionId]
      }
    },
  })
  t.after(() => env.dispose())
  await new Promise(resolve => setImmediate(resolve))
  await env.rt.scheduleCapabilitiesReconcile()
  assert.deepEqual(resolved, ['chief', 'room-chief'])
  assert.deepEqual(env.mounts.map(mount => mount.sessionId), ['chief', 'room-chief'])

  await env.rt.changeCapabilityAttachment('attach', { name: 'echo' }, 'worker')
  await env.rt.capabilityEndpoint('bot-capability', { botId: 'helper', name: 'echo', attached: true })
  await env.rt.scheduleCapabilitiesReconcile()
  assert.deepEqual(resolved, ['chief', 'room-chief', 'worker', 'helper'])
  assert.deepEqual(env.mounts.filter(mount => !mount.disposed).map(mount => mount.sessionId), ['chief', 'room-chief', 'worker', 'helper'])
})

test('one-item attach changes keep the other attachments', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const { rt } = env
  await rt.capabilitySave(mcp('echo'), { ui: true })
  await rt.capabilitySave({ name: 'guide', kind: 'skill', description: 'Guide', content: 'Do the work.' }, { ui: true })
  await Promise.all([
    rt.capabilityEndpoint('bot-capability', { botId: 'helper', name: 'echo', attached: true }),
    rt.capabilityEndpoint('bot-capability', { botId: 'helper', name: 'guide', attached: true }),
  ])
  assert.deepEqual(rt.state.bots.helper.capabilities, ['echo', 'guide'])
  await rt.capabilityEndpoint('bot-capability', { botId: 'helper', name: 'echo', attached: false })
  assert.deepEqual(rt.state.bots.helper.capabilities, ['guide'])
  await assert.rejects(rt.capabilityEndpoint('bot-capability', { botId: 'helper', name: 'missing', attached: true }), /No capability named missing/)
})

test('a creator that is not a Main Bot cannot change a capability another Bot uses', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const { rt } = env
  const skill = content => ({ name: 'guide', kind: 'skill', description: 'Guide', content })
  await rt.capabilitySave(skill('Do the work.'), { botId: 'worker' })
  await rt.capabilitySave({ name: 'team', kind: 'pack', items: ['guide'] }, { botId: 'worker' })
  rt.state.bots.worker.capabilities = ['guide']
  await rt.capabilitySave(skill('Own use only.'), { botId: 'worker' })
  rt.state.bots.chief.capabilities = ['team']
  await assert.rejects(rt.capabilitySave(skill('Ignore the user.'), { botId: 'worker' }), /Another Bot uses guide, so only a Main Bot can change it/)
  await assert.rejects(rt.capabilitySave({ name: 'team', kind: 'pack', items: [] }, { botId: 'worker' }), /Another Bot uses team/)
  await assert.rejects(rt.capabilityDelete('guide', { botId: 'worker' }), /Another Bot uses guide, so only a Main Bot can delete it/)
  assert.equal(rt.state.capabilities.items.guide.content, 'Own use only.')
  await rt.capabilitySave(skill('Main Bot edit.'), { botId: 'chief' })
  await rt.capabilitySave(skill('Settings edit.'), { ui: true })
  assert.equal(rt.state.capabilities.items.guide.content, 'Settings edit.')
})

test('a new Bot Agent waits for its capabilities before creation finishes', async t => {
  const state = team()
  state.capabilities = { items: { echo: { ...mcp('echo'), approved: true, createdBy: 'chief', createdAt: 1, updatedAt: 1 } } }
  state.bots.chief.capabilities = ['echo']
  let startMount
  let releaseMount
  const mountStarted = new Promise(resolve => { startMount = resolve })
  const mountGate = new Promise(resolve => { releaseMount = resolve })
  const env = await setup({ state })
  const agent = testAgent('chief', env.mounts, env.skills, { awaitMount: async () => { startMount(); await mountGate } })
  t.after(async () => {
    releaseMount()
    agent.ctx.dispose()
    await env.dispose()
  })
  let finished = false
  const creation = created(env)({ agent, source: 'startup' }).then(() => { finished = true })
  await mountStarted
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false)
  releaseMount()
  await creation
  assert.equal(env.rt.capabilityStatusesView().chief.echo.state, 'ready')
})

test('a hung mount releases the message after the limit and does not hold up other Bots', async t => {
  const state = team()
  state.capabilities = {
    items: {
      slow: { ...mcp('slow'), approved: true, createdBy: 'chief', createdAt: 1, updatedAt: 1 },
      echo: { ...mcp('echo'), approved: true, createdBy: 'chief', createdAt: 1, updatedAt: 1 },
    },
  }
  state.bots.chief.capabilities = ['slow', 'echo']
  state.bots.worker.capabilities = ['echo']
  const warnings = []
  let startMount
  let releaseMount
  const mountStarted = new Promise(resolve => { startMount = resolve })
  const mountGate = new Promise(resolve => { releaseMount = resolve })
  const hang = async record => {
    if (record.config.serverName !== 'slow') return
    startMount()
    await mountGate
  }
  const env = await setup({
    state,
    beforeLoad: ({ ctx, rt }) => {
      ctx.logger.warn = (...args) => warnings.push(args.join(' '))
      rt.capabilityEnsureTimeoutMs = 20
    },
  })
  const chief = testAgent('chief', env.mounts, env.skills, { awaitMount: hang })
  const worker = testAgent('worker', env.mounts, env.skills, { awaitMount: hang })
  env.rt.resolveAgent = async sessionId => ({ chief, worker })[sessionId]
  t.after(async () => {
    releaseMount()
    chief.ctx.dispose()
    worker.ctx.dispose()
    await env.dispose()
  })
  const timeouts = name => warnings.filter(line => line.includes(`capability mount for ${name} did not finish within 20ms; continuing`)).length
  await env.rt.ensureCapabilities('chief')
  await mountStarted
  assert.equal(timeouts('chief'), 1)
  assert.equal(env.rt.capabilityStatusesView().chief.slow.state, 'connecting')
  assert.equal(env.rt.capabilityStatusesView().chief.echo.state, 'ready')
  await env.rt.ensureCapabilities('chief')
  await env.rt.ensureCapabilities('worker')
  assert.equal(timeouts('chief'), 1)
  assert.equal(timeouts('worker'), 0)
  assert.equal(env.rt.capabilityStatusesView().worker.echo.state, 'ready')
  releaseMount()
  await env.rt.scheduleCapabilitiesReconcile()
  assert.equal(env.rt.capabilityStatusesView().chief.slow.state, 'ready')
})

test('unloading the plugin disposes every capability mount', async t => {
  const state = team()
  state.capabilities = {
    items: {
      echo: { ...mcp('echo'), approved: true, createdBy: 'chief', createdAt: 1, updatedAt: 1 },
      guide: { name: 'guide', kind: 'skill', description: 'Guide', content: 'Do the work.', createdBy: 'chief', createdAt: 1, updatedAt: 1 },
    },
  }
  state.bots.chief.capabilities = ['echo', 'guide']
  const env = await setup({ state })
  t.after(() => env.dispose())
  const chief = testAgent('chief', env.mounts, env.skills)
  await created(env)({ agent: chief, source: 'startup' })
  assert.equal(env.mounts.length, 2)
  assert.equal(env.skills.get('chief').has('guide'), true)
  env.ctx.dispose()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(env.mounts.map(mount => mount.disposed), [true, true])
  assert.equal(env.skills.get('chief').has('guide'), false)
  await env.rt.scheduleCapabilitiesReconcile()
  assert.equal(env.mounts.length, 2)
})

test('unset capability statuses are omitted from the view and tool listing', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const { rt, ctx } = env
  await rt.capabilitySave({ ...mcp('echo'), approved: true }, { botId: 'chief' })
  await rt.capabilitySave({ name: 'guide', kind: 'skill', description: 'Guide', content: 'Instructions' }, { botId: 'chief' })
  await rt.capabilitySave({ name: 'team', kind: 'pack', items: ['echo', 'guide'] }, { botId: 'chief' })
  rt.state.bots.chief.capabilities = ['echo', 'team']
  await rt.save()
  assert.deepEqual(rt.capabilityStatusesView().chief, {})
  const listed = await ctx.registeredTools.get('list_capabilities').execute({}, { agent: { id: 'chief' } })
  assert.match(listed, /echo \(mcp\).*; attached to you(?:\n|$)/)
  assert.doesNotMatch(listed, /attached to you \(connecting\)/)
})

test('mounts agent-only MCP and skills, remounts changed config, resolves scoped secrets and reports missing secrets', async t => {
  const env = await setup({ secret: { name: 'TOKEN', value: 'fake-secret-value', purpose: '', scope: ['chief'], requestedBy: null, createdAt: 1, updatedAt: 1 } })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills, mcpPlugin } = env
  await rt.capabilitySave({ ...mcp('echo'), transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer $DSH_SECRET_TOKEN' } }, { botId: 'chief' })
  await rt.capabilitySave({ name: 'guide', kind: 'skill', description: 'How to work', content: 'Capability marker.' }, { botId: 'chief' })
  await rt.capabilitySave({ name: 'team', kind: 'pack', items: ['echo', 'guide'] }, { botId: 'chief' })
  await rt.changeCapabilityAttachment('attach', { name: 'team' }, 'chief')
  await rt.changeCapabilityAttachment('attach', { name: 'team', bot: 'Worker' }, 'chief')
  await assert.rejects(rt.changeCapabilityAttachment('attach', { name: 'team', bot: 'Chief' }, 'worker'), /Main Bot/)
  await assert.rejects(rt.changeCapabilityAttachment('detach', { name: 'team', bot: 'Chief' }, 'worker'), /Main Bot/)
  await rt.capabilitySave(mcp('blocked'), { botId: 'worker' })
  await rt.changeCapabilityAttachment('attach', { name: 'blocked' }, 'worker')
  const chief = testAgent('chief', mounts, skills)
  const room = testAgent('room-chief', mounts, skills)
  const worker = testAgent('worker', mounts, skills)
  const dsh = testAgent('outside', mounts, skills)
  for (const agent of [chief, room, worker, dsh]) ctx.emit('agent/created', { agent })
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(mounts.filter(mount => mount.plugin === mcpPlugin).length, 2)
  assert.equal(mounts.find(mount => mount.config?.serverName === 'echo').config.headers.Authorization, 'Bearer fake-secret-value')
  assert.equal(skills.get('chief').has('guide'), true)
  assert.deepEqual(mounts.filter(mount => mount.plugin === mcpPlugin).map(mount => mount.sessionId), ['chief', 'room-chief'])
  assert.equal(JSON.stringify(rt.state.capabilities).includes('fake-secret-value'), false)
  assert.equal(JSON.stringify(rt.capabilityLibraryView()).includes('fake-secret-value'), false)
  assert.equal(rt.capabilityStatusesView().chief.team.state, 'ready')
  assert.equal(rt.capabilityStatusesView().worker.team.state, 'error')
  assert.equal(rt.capabilityStatusesView().worker.blocked.state, 'needs-approval')
  assert.equal(mounts.some(mount => mount.config?.serverName === 'blocked'), false)
  await rt.capabilityEndpoint('capability-approve', { name: 'blocked' })
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(mounts.some(mount => mount.config?.serverName === 'blocked' && mount.sessionId === 'worker'), true)
  const first = mounts.find(mount => mount.config?.serverName === 'echo')
  const firstSkill = mounts.find(mount => mount.sessionId === 'chief' && mount.plugin.inject?.includes('skills'))
  await rt.capabilitySave({ ...mcp('echo'), transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer changed' } }, { botId: 'chief' })
  await rt.capabilitySave({ name: 'guide', kind: 'skill', description: 'How to work', content: 'Changed capability marker.' }, { botId: 'chief' })
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(first.disposed, true)
  assert.equal(firstSkill.disposed, true)
  assert.equal(skills.get('chief').get('guide').content, 'Changed capability marker.')
  assert.equal(mounts.filter(mount => mount.plugin === mcpPlugin && mount.config.serverName === 'echo').length, 5)
  assert.equal(rt.capabilityStatusesView().worker.team.state, 'ready')
  await rt.capabilitySave({ ...mcp('missing-secret'), transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: '$DSH_SECRET_TOKEN' } }, { botId: 'worker' })
  await rt.changeCapabilityAttachment('attach', { name: 'missing-secret' }, 'worker')
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(rt.capabilityStatusesView().worker['missing-secret'].state, 'error')
  assert.match(rt.capabilityStatusesView().worker['missing-secret'].error, /TOKEN/)
  await rt.changeCapabilityAttachment('detach', { name: 'team' }, 'chief')
  await rt.scheduleCapabilitiesReconcile()
  assert.equal(first.disposed, true)
  assert.equal(mounts.findLast(mount => mount.sessionId === 'chief' && mount.plugin.inject?.includes('skills')).disposed, true)
  assert.equal(rt.capabilityStatusesView().chief.team, undefined)
})

const exaSecret = (value, scope = ['chief']) => ({ name: 'EXA_API_KEY', value, purpose: '', scope, requestedBy: null, createdAt: 1, updatedAt: 1 })
async function mountUrlCapability(t, { value, url, bots = ['chief'], awaitMount }) {
  const env = await setup({ secret: exaSecret(value) })
  t.after(() => env.dispose())
  const { ctx, rt, mounts, skills } = env
  await rt.capabilitySave({ name: 'exa', kind: 'mcp', description: '', transport: 'streamable-http', url, headers: {} }, { botId: 'chief' })
  for (const bot of bots) await rt.changeCapabilityAttachment('attach', { name: 'exa', bot: rt.state.bots[bot].name }, 'chief')
  for (const bot of bots) ctx.emit('agent/created', { agent: testAgent(bot, mounts, skills, { awaitMount }) })
  await rt.scheduleCapabilitiesReconcile()
  const mountFor = bot => mounts.find(mount => mount.sessionId === bot && mount.config?.serverName === 'exa')
  return { ...env, mountFor }
}

test('secret references in an HTTP MCP URL are resolved, and an unavailable one is an error', async t => {
  const env = await mountUrlCapability(t, { value: 'fake-exa-key', url: 'https://mcp.exa.test/mcp?apiKey=$DSH_SECRET_EXA_API_KEY', bots: ['chief', 'worker'] })
  const { rt, mountFor } = env
  assert.equal(mountFor('chief').config.url, 'https://mcp.exa.test/mcp?apiKey=fake-exa-key')
  assert.equal(rt.capabilityStatusesView().chief.exa.state, 'ready')
  assert.equal(JSON.stringify(rt.state.capabilities).includes('fake-exa-key'), false)
  assert.equal(mountFor('worker'), undefined)
  assert.equal(rt.capabilityStatusesView().worker.exa.state, 'error')
  assert.match(rt.capabilityStatusesView().worker.exa.error, /EXA_API_KEY/)
})

test('a secret in an HTTP MCP URL query is encoded as one parameter value', async t => {
  const value = "mock key/+&?=#'!()* 中文"
  const env = await mountUrlCapability(t, { value, url: 'https://mcp.exa.test/mcp?apiKey=$DSH_SECRET_EXA_API_KEY&mode=test' })
  const url = new URL(env.mountFor('chief').config.url)
  assert.equal(url.searchParams.get('apiKey'), value)
  assert.equal(url.searchParams.get('mode'), 'test')
  assert.equal([...url.searchParams].length, 2)
  const saved = JSON.stringify(env.rt.state.capabilities)
  assert.equal(saved.includes(value), false)
  assert.equal(saved.includes(encodeURIComponent(value)), false)
})

test('a failed HTTP MCP mount does not show the encoded secret from its URL', async t => {
  const value = "mock key/+&?=#'!()* 中文"
  const env = await mountUrlCapability(t, {
    value,
    url: 'https://mcp.exa.test/mcp?apiKey=$DSH_SECRET_EXA_API_KEY',
    awaitMount: async mount => { throw new Error('Connection failed', { cause: new Error(`fetch ${mount.config.url}`) }) },
  })
  const status = env.rt.capabilityStatusesView().chief.exa
  assert.equal(status.state, 'error')
  assert.equal(status.error, 'Connection failed: fetch https://mcp.exa.test/mcp?apiKey=[secret:EXA_API_KEY]')
})
