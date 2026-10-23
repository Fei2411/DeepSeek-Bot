import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, createRuntime } from '../index.js'
import { gateScope } from '../src/host/browser/gate.js'
import { systemPrompt as refsPrompt, toolDefs as refsTools } from '../src/host/browser/refs.js'
import { fakeApproval, fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotId: 'm1',
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', lab: 'deepseek', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', instructions: '', createdAt: 2 },
  },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function start(config, { services = {}, team = TEAM } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-browser-plugin-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext({ services })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home, ...config })
  return {
    ctx,
    rt,
    call: async (endpoint, payload) => {
      const response = await route.fetch(new Request('http://localhost/api/bot', {
        method: 'POST',
        body: JSON.stringify({ endpoint, payload }),
      }))
      return response.json()
    },
    stop: () => {
      rmSync(home, { recursive: true, force: true })
    },
  }
}

const WRITE_ACTION = {
  kind: 'post',
  label: 'Publish update',
  origin: 'https://shop.example.com',
  host: 'shop.example.com',
}

function browserWriter() {
  let runs = 0
  let action = WRITE_ACTION
  return {
    runs: () => runs,
    setAction: value => { action = value },
    plugin: {
      id: 'refs',
      tools: [{
        name: 'browser_write',
        needsBrowser: false,
        async execute() {
          await gateScope.getStore()?.(action)
          runs += 1
          return 'written'
        },
      }],
    },
  }
}

const permissionService = defaultPreset => ({
  catalog: () => ({ options: [], defaultPreset }),
})

function browserExec(botId = 'b2', sessionId = botId) {
  return {
    name: 'browser_write',
    callId: 'call-1',
    signal: new AbortController().signal,
    agent: { id: botId, session: { header: { id: sessionId } } },
  }
}

test('no browser plugin is mounted unless one is selected for the team', (t) => {
  const { ctx, stop } = start({})
  t.after(stop)
  assert.equal(ctx.calls.includes('effect ds-bot: browser plugin'), false)
  assert.equal(ctx.registeredTools.has('browser_open'), false)
  assert.equal(ctx.registeredTools.has('browser_exec'), false)
  assert.equal(ctx.registeredTools.has('browser_task'), false)
})

test('the selected plugin is the same for every Bot, and profiles stay apart', async (t) => {
  const seen = []
  const { ctx, stop } = start({
    browserPlugin: 'refs',
    browserPluginApi: {
      id: 'refs',
      tools: [
        {
          name: 'browser_snapshot',
          description: 'Read the page',
          parameters: {},
          async execute(_args, toolCtx) {
            seen.push(toolCtx.botId)
            return toolCtx.profileDir
          },
        },
      ],
    },
  })
  t.after(stop)
  assert.ok(ctx.calls.includes('effect ds-bot: browser plugin'))
  const tool = ctx.registeredTools.get('browser_snapshot')
  const writer = await tool.execute({}, { agent: { id: 'b2' } })
  const chief = await tool.execute({}, { agent: { id: 'm1' } })
  assert.deepEqual(seen, ['b2', 'm1'])
  assert.ok(writer.endsWith(join('browser-profiles', 'b2')))
  assert.ok(chief.endsWith(join('browser-profiles', 'm1')))
  assert.equal(await tool.execute({}, { agent: { id: 'stranger' } }), 'Only Bots on the team have a browser.')
})

test('an unknown browser plugin is refused', () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-browser-plugin-'))
  try {
    assert.throws(() => createRuntime(fakeContext(), { home, browserPlugin: 'devtools' }), /Choose refs, script, task/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('refs exposes the ARIA snapshot tool contract', () => {
  assert.deepEqual(refsTools.map(tool => tool.name), [
    'browser_open',
    'browser_snapshot',
    'browser_click',
    'browser_upload',
    'browser_type',
    'browser_select',
    'browser_press',
    'browser_tabs',
    'browser_back',
    'browser_screenshot',
    'browser_handoff',
    'browser_resume',
  ])
  assert.equal(refsTools.some(tool => tool.name === 'browser_scroll'), false)
  assert.equal(refsTools.find(tool => tool.name === 'browser_type').parameters.submit.required, undefined)
  assert.equal(refsTools.find(tool => tool.name === 'browser_tabs').parameters.index.required, undefined)
  assert.equal(refsTools.find(tool => tool.name === 'browser_handoff').parameters.note.required, undefined)
  assert.ok(refsPrompt.includes('Posting, uploading, downloading, or deleting may need approval;'))
})

test('browserExecutablePath must be a string when configured', () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-browser-plugin-'))
  try {
    assert.throws(
      () => apply(fakeContext(), { home, browserPlugin: 'refs', browserExecutablePath: 42 }),
      /browserExecutablePath must be a string/,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a matching browser grant allows the write without asking', async (t) => {
  const approval = fakeApproval('rejected')
  const writer = browserWriter()
  const team = structuredClone(TEAM)
  team.bots.b2.browserGrants = [{ site: 'example.com', kinds: ['post'] }]
  const { ctx, stop } = start({
    browserPlugin: 'refs',
    browserPluginApi: writer.plugin,
  }, { services: { approval, permissionPresets: permissionService('workspace-write') }, team })
  t.after(stop)

  assert.equal(await ctx.registeredTools.get('browser_write').execute({}, browserExec()), 'written')
  assert.equal(writer.runs(), 1)
  assert.equal(approval.requests.length, 0)
})

test('approval is one-shot and each write requests it again', async (t) => {
  const approval = fakeApproval('allowed-once')
  const writer = browserWriter()
  const { ctx, stop } = start({
    browserPlugin: 'refs',
    browserPluginApi: writer.plugin,
  }, { services: { approval, permissionPresets: permissionService('workspace-write') } })
  t.after(stop)
  const tool = ctx.registeredTools.get('browser_write')

  assert.equal(await tool.execute({}, browserExec()), 'written')
  assert.equal(await tool.execute({}, browserExec()), 'written')
  assert.equal(writer.runs(), 2)
  assert.equal(approval.requests.length, 2)
  assert.match(approval.requests[0].reason, /shop\.example\.com/)
  assert.match(approval.requests[0].reason, /Publish update/)
  assert.equal(approval.requests[0].toolName, 'browser_write')
  assert.equal(approval.requests[0].callId, 'call-1')
  assert.match(approval.requests[0].displayReason.en, /^Let Writer post/)
  assert.match(approval.requests[0].displayReason.zh, /Writer/)
})

test('a rejected approval prevents the write', async (t) => {
  const approval = fakeApproval('rejected')
  const writer = browserWriter()
  const { ctx, stop } = start({
    browserPlugin: 'refs',
    browserPluginApi: writer.plugin,
  }, { services: { approval, permissionPresets: permissionService('workspace-write') } })
  t.after(stop)

  await assert.rejects(ctx.registeredTools.get('browser_write').execute({}, browserExec()), /Do not try this action again unless the user asks\..*Nothing was done\./)
  assert.equal(writer.runs(), 0)
})

test('browser grants match exact hosts, subdomains, and wildcard sites and kinds', async (t) => {
  const cases = [
    { site: 'example.com', host: 'shop.example.com', kinds: ['post'], allowed: true },
    { site: 'example.com', host: 'badexample.com', kinds: ['post'], allowed: false },
    { site: '*', host: 'unrelated.test', kinds: ['post'], allowed: true },
    { site: 'example.com', host: 'example.com', kinds: ['*'], allowed: true },
  ]
  for (const entry of cases) {
    const approval = fakeApproval('rejected')
    const writer = browserWriter()
    const team = structuredClone(TEAM)
    team.bots.b2.browserGrants = [{ site: entry.site, kinds: entry.kinds }]
    const { ctx, stop } = start({
      browserPlugin: 'refs',
      browserPluginApi: writer.plugin,
    }, { services: { approval, permissionPresets: permissionService('workspace-write') }, team })
    t.after(stop)
    const action = { ...WRITE_ACTION, host: entry.host }
    writer.setAction(action)
    const tool = ctx.registeredTools.get('browser_write')
    if (entry.allowed) {
      assert.equal(await tool.execute({}, browserExec()), 'written')
      assert.equal(approval.requests.length, 0)
    } else {
      await assert.rejects(tool.execute({}, browserExec()), /Nothing was done\./)
      assert.equal(approval.requests.length, 1)
    }
    await stop()
  }
})

test('read-only permissions use the ordinary approval path', async (t) => {
  const approval = fakeApproval('allowed-once')
  const writer = browserWriter()
  const team = structuredClone(TEAM)
  team.bots.b2.permission = 'read-only'
  const { ctx, stop } = start({
    browserPlugin: 'refs',
    browserPluginApi: writer.plugin,
  }, { services: { approval, permissionPresets: permissionService('workspace-write') }, team })
  t.after(stop)
  assert.equal(await ctx.registeredTools.get('browser_write').execute({}, browserExec()), 'written')
  assert.equal(writer.runs(), 1)
  assert.equal(approval.requests.length, 1)
})

test('missing approval service is reported without running the write', async (t) => {
  const writer = browserWriter()
  const { ctx, stop } = start({
    browserPlugin: 'refs',
    browserPluginApi: writer.plugin,
  }, { services: { permissionPresets: permissionService('workspace-write') } })
  t.after(stop)

  await assert.rejects(ctx.registeredTools.get('browser_write').execute({}, browserExec()), /needs the user's approval.*so nothing was done\./)
  assert.equal(writer.runs(), 0)
})

test('approval cancellation, service failure, and missing Sessions are explicit', async (t) => {
  const cases = [
    {
      approval: fakeApproval('cancelled'),
      exec: browserExec(),
      message: /approval was cancelled\. Nothing was done\./,
    },
    {
      approval: { async request() { throw new Error('service offline') } },
      exec: browserExec(),
      message: /approval service was unavailable\. Nothing was done\./,
    },
    {
      approval: fakeApproval('allowed-once'),
      exec: { name: 'browser_write', agent: { id: 'b2' } },
      message: /needs the user's approval.*no way to ask here, so nothing was done\./,
    },
  ]
  for (const entry of cases) {
    const writer = browserWriter()
    const { ctx, stop } = start({
      browserPlugin: 'refs',
      browserPluginApi: writer.plugin,
    }, { services: { approval: entry.approval, permissionPresets: permissionService('workspace-write') } })
    t.after(stop)
    await assert.rejects(ctx.registeredTools.get('browser_write').execute({}, entry.exec), entry.message)
    assert.equal(writer.runs(), 0)
  }
})

test('approval verbs cover every gated action', async (t) => {
  const approval = fakeApproval('allowed-once')
  const writer = browserWriter()
  const { ctx, stop } = start({
    browserPlugin: 'refs',
    browserPluginApi: writer.plugin,
  }, { services: { approval, permissionPresets: permissionService('workspace-write') } })
  t.after(stop)
  const tool = ctx.registeredTools.get('browser_write')
  for (const [kind, label, verb] of [
    ['post', 'Publish update', 'post'],
    ['upload', 'upload files', 'upload files'],
    ['download', 'download file', 'download a file'],
    ['delete', 'Delete item', 'delete something'],
  ]) {
    writer.setAction({ ...WRITE_ACTION, kind, label })
    assert.equal(await tool.execute({}, browserExec()), 'written')
    assert.match(approval.requests.at(-1).reason, new RegExp(verb))
  }
})

test('payment is refused even with a wildcard grant or full-access preset', async (t) => {
  for (const setup of [
    team => { team.bots.b2.browserGrants = [{ site: '*', kinds: ['*'] }] },
    team => { team.bots.b2.permission = 'danger-full-access' },
  ]) {
    const approval = fakeApproval('allowed-once')
    const writer = browserWriter()
    const team = structuredClone(TEAM)
    setup(team)
    writer.setAction({ ...WRITE_ACTION, kind: 'payment', label: 'Pay now' })
    const { ctx, stop } = start({
      browserPlugin: 'refs',
      browserPluginApi: writer.plugin,
    }, { services: { approval, permissionPresets: permissionService('workspace-write') }, team })
    t.after(stop)
    await assert.rejects(
      ctx.registeredTools.get('browser_write').execute({}, browserExec()),
      /call browser_handoff with reason "payment".*Nothing was done\./,
    )
    assert.equal(writer.runs(), 0)
    assert.equal(approval.requests.length, 0)
  }
})

test('expired grants do not authorize a write', async (t) => {
  const approval = fakeApproval('allowed-once')
  const writer = browserWriter()
  const team = structuredClone(TEAM)
  team.bots.b2.browserGrants = [{ site: 'example.com', kinds: ['post'], until: Date.now() - 1 }]
  const { ctx, stop } = start({
    browserPlugin: 'refs',
    browserPluginApi: writer.plugin,
  }, { services: { approval, permissionPresets: permissionService('workspace-write') }, team })
  t.after(stop)
  assert.equal(await ctx.registeredTools.get('browser_write').execute({}, browserExec()), 'written')
  assert.equal(writer.runs(), 1)
  assert.equal(approval.requests.length, 1)
})

test('browser grants are user-only, normalized, deduplicated, expiring, and clearable through api/bot', async (t) => {
  const { rt, call, stop } = start({})
  t.after(stop)
  await rt.load()
  await assert.rejects(
    rt.updateBot('b2', { browserGrants: [] }, 'b2'),
    { message: 'Only the user can set what Writer may do in the browser' },
  )
  await assert.rejects(
    rt.updateBot('b2', { browserGrants: [{ site: 'https://example.com/path', kinds: ['post'] }] }),
    /Browser grant site must be \* or a hostname/,
  )
  await assert.rejects(
    rt.updateBot('b2', { browserGrants: [{ site: 'example.com', kinds: ['post', 'unsafe'] }] }),
    /Browser grant kinds must be a non-empty subset/,
  )
  for (const legacy of ['submit', 'purchase']) {
    await assert.rejects(
      rt.updateBot('b2', { browserGrants: [{ site: 'example.com', kinds: [legacy] }] }),
      /Browser grant kinds must be a non-empty subset/,
    )
  }
  for (const until of ['later', Number.NaN, Infinity]) {
    await assert.rejects(
      rt.updateBot('b2', { browserGrants: [{ site: '*', kinds: ['post'], until }] }),
      /future epoch-millisecond timestamp/,
    )
  }
  const expiredGrant = { site: '*', kinds: ['post'], until: Date.now() - 1 }
  const expired = await call('update-bot', { id: 'b2', browserGrants: [expiredGrant] })
  assert.equal(expired.ok, true)
  assert.deepEqual(expired.value.browserGrants, [])
  const freshGrant = { site: 'fresh.example', kinds: ['delete'], until: Date.now() + 60_000 }
  const mixed = await call('update-bot', { id: 'b2', browserGrants: [expiredGrant, freshGrant] })
  assert.equal(mixed.ok, true)
  assert.deepEqual(mixed.value.browserGrants, [
    { site: 'fresh.example', kinds: ['delete'], until: freshGrant.until },
  ])
  await assert.rejects(
    rt.updateBot('b2', { browserGrants: Array.from({ length: 51 }, () => ({ site: '*', kinds: ['*'] })) }),
    /array of at most 50 entries/,
  )
  const saved = await call('update-bot', {
    id: 'b2',
    browserGrants: [
      { site: ' Example.COM ', kinds: ['post', 'upload', 'download', 'delete', 'post'] },
      { site: 'example.com', kinds: ['post', 'upload', 'download', 'delete'], until: Date.now() + 60_000 },
    ],
  })
  assert.equal(saved.ok, true)
  assert.deepEqual(saved.value.browserGrants, [
    { site: 'example.com', kinds: ['delete', 'download', 'post', 'upload'] },
    { site: 'example.com', kinds: ['delete', 'download', 'post', 'upload'], until: saved.value.browserGrants[1].until },
  ])
  const cleared = await call('update-bot', { id: 'b2', browserGrants: null })
  assert.equal(cleared.ok, true)
  assert.equal(Object.hasOwn(cleared.value, 'browserGrants'), false)
})
