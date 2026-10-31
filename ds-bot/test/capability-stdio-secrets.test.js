import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

let rt

// The fixture stands in for an MCP server: it reports back the argv and env it was
// started with, so the test sees exactly what the plugin passed to the child process.
const FIXTURE = fileURLToPath(new URL('./fixtures/echo-argv-env.mjs', import.meta.url))

const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', capabilities: [], createdAt: 1 },
    worker: { id: 'worker', sessionId: 'worker', name: 'Worker', capabilities: [], createdAt: 2 },
  },
  rooms: {},
  agents: {},
  capabilities: { items: {} },
  exchanges: [],
  exchangeTurns: {},
  works: {},
  questions: {},
  prefs: {},
  revision: 1,
  whaleStored: true,
})

const secret = (name, value, scope = 'all') => ({ name, value, purpose: '', scope, requestedBy: null, createdAt: 1, updatedAt: 1 })

// An Agent whose plugin() really starts the configured command, like the mounted MCP
// client would, so the resolved args and env can be checked at the process boundary.
function spawningAgent(id, spawned) {
  const disposers = []
  return {
    id,
    session: { id },
    ctx: {
      effect(execute) {
        const dispose = execute()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
      plugin(plugin, config) {
        const record = { plugin, config, sessionId: id, disposed: false }
        spawned.push(record)
        if (config?.transport === 'stdio') {
          record.output = JSON.parse(execFileSync(config.command, config.args, {
            env: { ...process.env, ...config.env },
            encoding: 'utf8',
          }))
        }
        return { await: async () => {}, dispose: () => { record.disposed = true } }
      },
      dispose() { for (const dispose of disposers.reverse()) dispose() },
    },
  }
}

async function setup({ state = team(), secrets = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-stdio-secrets-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
  if (secrets.length > 0) writeFileSync(join(home, 'secrets.json'), JSON.stringify({ secrets }))
  const spawned = []
  const mcpPlugin = { name: 'mcp-client', apply() {} }
  const loader = { import: async () => ({ default: mcpPlugin }), unwrapExports: exports => exports.default }
  const ctx = fakeContext({ services: { loader } })
  rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  ctx.sessionTitle = { rename: async () => {} }
  rt.resolveAgent = async sessionId => ({ session: { id: sessionId } })
  await rt.load()
  return {
    home,
    ctx,
    rt,
    spawned,
    mcpPlugin,
    async dispose() {
      ctx.dispose()
      await rt.scheduleCapabilitiesReconcile()
      await new Promise(resolve => setImmediate(resolve))
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

// Saves a stdio MCP capability, attaches it to `botId`, and mounts it on that Bot's Agent.
async function mountStdio(env, { name, args, env: envMap, botId = 'chief' }) {
  const { ctx, rt, spawned } = env
  await rt.capabilitySave({ name, kind: 'mcp', description: '', transport: 'stdio', command: process.execPath, args, env: envMap }, { botId })
  await rt.capabilityEndpoint('capability-approve', { name })
  await rt.changeCapabilityAttachment('attach', { name }, botId)
  ctx.emit('agent/created', { agent: spawningAgent(botId, spawned) })
  await rt.scheduleCapabilitiesReconcile()
  return spawned.findLast(mount => mount.config?.serverName === name && mount.sessionId === botId)
}

test('stdio MCP args resolve secret references like env does, and the child process sees the values', async (t) => {
  const env = await setup({ secrets: [secret('MCP_TOKEN', 'fake-dummy-secret-125'), secret('MCP_REGION', 'fake-region-125')] })
  t.after(() => env.dispose())
  const mount = await mountStdio(env, {
    name: 'echo',
    args: [FIXTURE, '--token', '$DSH_SECRET_MCP_TOKEN', 'pre$DSH_SECRET_MCP_TOKEN/$DSH_SECRET_MCP_REGION-post', 'plain'],
    env: { ECHO_ARGV_ENV_NAMES: 'MCP_ENV', MCP_ENV: '$DSH_SECRET_MCP_REGION' },
  })
  assert.ok(mount, 'the capability was not mounted')
  assert.deepEqual(mount.config.args, [FIXTURE, '--token', 'fake-dummy-secret-125', 'prefake-dummy-secret-125/fake-region-125-post', 'plain'])
  // The child sees argv after its own program and script names: everything we passed.
  assert.deepEqual(mount.output.argv, mount.config.args.slice(1))
  assert.equal(mount.output.env.MCP_ENV, 'fake-region-125')
  // state.json and the views keep the references, never the resolved values.
  const saved = readFileSync(join(env.home, 'state.json'), 'utf8')
  assert.equal(saved.includes('fake-dummy-secret-125'), false)
  assert.equal(saved.includes('fake-region-125'), false)
  assert.equal(JSON.stringify(env.rt.capabilityLibraryView()).includes('fake-dummy-secret-125'), false)
  assert.equal(env.rt.capabilityStatusesView().chief.echo.state, 'ready')
})

test('a missing or forbidden secret in stdio args keeps the server from starting, without leaking values', async (t) => {
  const env = await setup({ secrets: [secret('MCP_TOKEN', 'fake-dummy-secret-125', ['chief']), secret('OTHER_KEY', 'other-secret-125')] })
  t.after(() => env.dispose())
  // MCP_TOKEN is scoped to chief, so worker's mount must fail before the process starts.
  const denied = await mountStdio(env, {
    name: 'denied',
    args: [FIXTURE, '$DSH_SECRET_MCP_TOKEN'],
    env: {},
    botId: 'worker',
  })
  assert.equal(denied, undefined)
  const deniedStatus = env.rt.capabilityStatusesView().worker.denied
  assert.equal(deniedStatus.state, 'error')
  assert.match(deniedStatus.error, /MCP_TOKEN/)
  assert.equal(deniedStatus.error.includes('fake-dummy-secret-125'), false)
  assert.equal(deniedStatus.error.includes('other-secret-125'), false)
  // A name that is not saved at all fails the same way.
  const missing = await mountStdio(env, {
    name: 'missing',
    args: [FIXTURE, 'x$DSH_SECRET_NO_SUCH_KEY'],
    env: {},
    botId: 'chief',
  })
  assert.equal(missing, undefined)
  const missingStatus = env.rt.capabilityStatusesView().chief.missing
  assert.equal(missingStatus.state, 'error')
  assert.match(missingStatus.error, /NO_SUCH_KEY/)
  assert.equal(missingStatus.error.includes('other-secret-125'), false)
})
