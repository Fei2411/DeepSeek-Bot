import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

let rt

// #200, #205: a group change read the team, waited (for a Session or a folder check), and
// then wrote what it had read. A Bot deleted, or another change made, in that wait was undone.
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Coder', role: 'Code', sessionId: 'c', createdAt: 3 },
    d: { id: 'd', name: 'Tester', role: 'Test', sessionId: 'd', createdAt: 4 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', named: true, members: ['a', 'b'], admin: 'a', mode: 'admin', notice: '' } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

async function start(team = TEAM) {
  // The project folder sits beside the team's data, which no Bot may work in.
  // The native realpath: on Windows the JS one keeps 8.3 short names.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-room-races-')))
  const home = join(root, 'bot')
  const folder = join(root, 'project')
  for (const dir of [home, folder]) mkdirSync(dir)
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext()
  const archived = []
  let sessions = 0
  // While `hold` is set, the next Session waits until it is let go.
  let hold
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id: 'w1', path: home } : undefined),
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async (sessionId) => { archived.push(sessionId) },
    },
    sessionController: {
      create: async () => {
        const sessionId = `s${++sessions}`
        if (hold !== undefined) await hold.promise
        return { sessionId }
      },
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId }, followup() {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  rt = createRuntime(ctx, { home })
  await rt.load()
  const held = () => {
    let release
    hold = { promise: new Promise(resolve => { release = resolve }) }
    return () => { hold = undefined; release() }
  }
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async () => {
    await ctx.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, ctx, home, folder, archived, held, saved, stop }
}

test('a Bot deleted while its group is made stays out of it, and so does the admin role it was given', async (t) => {
  const { rt, held, stop } = await start()
  t.after(stop)
  const release = held()
  const making = rt.createRoom({ name: 'Trio', members: ['a', 'b', 'c'], admin: 'c' })
  await rt.deleteBot('c')
  release()
  const room = await making
  assert.deepEqual(room.members, ['a', 'b'])
  // The lead goes to the Main Bot member, as for a group made without a chosen admin.
  assert.equal(room.admin, 'a')
})

test('a group left with one Bot by a deletion while it is made is not made', async (t) => {
  const { rt, held, archived, stop } = await start()
  t.after(stop)
  const release = held()
  const making = rt.createRoom({ name: 'Pair', members: ['b', 'c'] })
  await rt.deleteBot('c')
  release()
  await assert.rejects(making, /A group chat needs at least two Bots/)
  assert.deepEqual(Object.keys(rt.state.rooms), ['r1'])
  // Its Session was made already, so it is archived, not left over.
  assert.ok(archived.includes('s1'))
})

test('a change that waits for its folder keeps the member another change added meanwhile', async (t) => {
  const { rt, folder, saved, stop } = await start()
  t.after(stop)
  const moving = rt.updateRoom('r1', { add: ['c'], workDir: folder })
  const adding = rt.updateRoom('r1', { add: ['d'] })
  const [moved, added] = await Promise.all([moving, adding])
  assert.deepEqual(added.changes, ['added Tester'])
  assert.deepEqual(moved.changes, ['added Coder', `every member now works in ${folder} here`])
  assert.deepEqual(saved().rooms.r1.members, ['a', 'b', 'd', 'c'])
})

test('a Bot deleted while a change waits for its folder is not added back', async (t) => {
  const { rt, folder, saved, stop } = await start()
  t.after(stop)
  const moving = rt.updateRoom('r1', { add: ['c'], workDir: folder })
  const deleting = rt.deleteBot('c')
  const [moved] = await Promise.all([moving, deleting])
  assert.deepEqual(moved.changes, [`every member now works in ${folder} here`])
  assert.deepEqual(saved().rooms.r1.members, ['a', 'b'])
})

test('a group deleted while a change waits for its folder stays deleted', async (t) => {
  const { rt, folder, saved, stop } = await start()
  t.after(stop)
  const refused = assert.rejects(rt.updateRoom('r1', { workDir: folder }), /Unknown group chat/)
  await rt.deleteRoom('r1')
  await refused
  assert.deepEqual(saved().rooms, {})
})

test('a group left with one Bot can still change its settings, but not lose another member', async (t) => {
  const { rt, stop } = await start()
  t.after(stop)
  await rt.deleteBot('b')
  assert.deepEqual(rt.state.rooms.r1.members, ['a'])
  assert.deepEqual((await rt.updateRoom('r1', { notice: 'Ship on Friday' })).changes, ['updated the notice'])
  assert.deepEqual((await rt.updateRoom('r1', { add: ['c'] })).changes, ['added Coder'])
  await assert.rejects(rt.updateRoom('r1', { remove: ['c'] }), /A group chat needs at least two Bots/)
})

test('a team saved with a deleted Bot in a group, even as its admin, loads without it', async (t) => {
  const team = { ...TEAM, rooms: { r1: { ...TEAM.rooms.r1, members: ['a', 'b', 'gone'], admin: 'gone' } } }
  const { rt, saved, stop } = await start(team)
  t.after(stop)
  assert.deepEqual([rt.state.rooms.r1.members, rt.state.rooms.r1.admin], [['a', 'b'], null])
  assert.deepEqual([saved().rooms.r1.members, saved().rooms.r1.admin], [['a', 'b'], null])
})
