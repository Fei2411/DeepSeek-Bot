import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Ids that name an inherited property: a lookup that misses Object.hasOwn would find
// these on every table and could write onto Object.prototype.
const BAD = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Lead', model: 'deepseek/v4', instructions: '', createdAt: 1, capabilities: [] },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Write', model: 'deepseek/v4', instructions: '', createdAt: 2, capabilities: [] },
  },
  rooms: {
    r1: { id: 'r1', name: 'Launch', named: true, members: ['m1', 'b2'], admin: 'm1', mode: 'everyone', notice: '', sessions: { b2: 'g2' }, seq: 0, log: [] },
  },
  agents: {},
  capabilities: { items: {} },
  exchanges: [],
  exchangeTurns: {},
  works: {},
  questions: {},
  prefs: {},
}

// An in-memory stand-in for DSH's schedule service, so schedule-create reaches the
// Bot/group lookup it does.
function scheduleService() {
  return {
    tasks: [],
    async create(sessionId, request) { this.tasks.push({ sessionId, request }); return { id: `s${this.tasks.length}` } },
    async list() { return [] },
    async catalog() { return [] },
    async delete() { return { deleted: false } },
  }
}

let rt
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-own-keys-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services: { schedule: scheduleService() } })
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({}),
    },
    sessionController: {
      create: async () => ({ sessionId: 'fresh' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: 1 }, followup() {} } }),
      selectModel: async () => {},
      prompt: async () => { throw new Error('no such session') },
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
  })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => (await ctx.route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const state = () => readFileSync(join(home, 'state.json'), 'utf8')
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, call, tool, state, stop }
}

// Each endpoint's answer for an inherited name must be the same as for an id that is
// simply not there; in particular never ok and never bot/internal unless an unknown
// id gets that too.
const ENDPOINTS = [
  ['update-bot', id => ({ id, role: 'x' })],
  ['delete-bot', id => ({ id })],
  ['duplicate-bot', id => ({ id })],
  ['set-flags', id => ({ id, pinned: true })],
  ['set-main', id => ({ id, main: false })],
  ['update-room', id => ({ id, name: 'Renamed' })],
  ['delete-room', id => ({ id })],
  ['stop-member-work', id => ({ roomId: id, botId: 'b2' })],
  ['stop-member-work', id => ({ roomId: 'r1', botId: id })],
  ['stop-room-work', id => ({ roomId: id })],
  ['schedule-create', id => ({ target: id, title: 't', prompt: 'p', when: { kind: 'every', minutes: 5 } })],
  ['dismiss-question', id => ({ sessionId: id })],
  ['answer-question', id => ({ sessionId: id, questionId: 'q1', answer: 'yes' })],
  ['dismiss-view', id => ({ sessionId: id })],
  ['view-reply', id => ({ sessionId: id, viewId: 'v1', action: 'pick', values: { selected: ['A'] } })],
  ['capability-delete', id => ({ name: id })],
  ['capability-approve', id => ({ name: id })],
  ['bot-capability', id => ({ botId: 'b2', name: id, attached: true })],
  ['bot-capability', id => ({ botId: id, name: 'x', attached: true })],
  ['create-room', id => ({ members: [id, 'b2'] })],
  ['chat', id => ({ botId: id })],
  ['earlier', id => ({ sessionId: id })],
  ['run-stats', id => ({ botId: id })],
  ['send', id => ({ sessionId: id, text: 'hi' })],
  ['agent-session', id => ({ agentId: id })],
  ['remove-agent', id => ({ agentId: id })],
]

test('api endpoints answer an inherited name like any unknown id and never write through it', async (t) => {
  const { call, state, stop } = start()
  t.after(stop)
  const prototypeNames = Object.getOwnPropertyNames(Object.prototype)
  const before = state()
  for (const [endpoint, payload] of ENDPOINTS) {
    const control = await call(endpoint, payload('id-that-is-not-there'))
    for (const id of BAD) {
      const result = await call(endpoint, payload(id))
      assert.equal(result.ok, control.ok, `${endpoint} ${id}: ${JSON.stringify(result)}`)
      assert.equal(result.error?.code, control.error?.code, `${endpoint} ${id}: ${JSON.stringify(result)}`)
      assert.notEqual(result.error?.code, 'bot/internal', `${endpoint} ${id}: ${JSON.stringify(result)}`)
    }
  }
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype), prototypeNames)
  assert.equal({}.role, undefined)
  assert.equal({}.hidden, undefined)
  assert.equal({}.name, undefined)
  assert.equal(state(), before)
})

test('tools answer an inherited Bot name like any unknown name', async (t) => {
  const { tool, state, stop } = start()
  t.after(stop)
  const prototypeNames = Object.getOwnPropertyNames(Object.prototype)
  const before = state()
  for (const id of BAD) {
    assert.equal(await tool('message_bot', { to: id, message: 'hi' }, 'm1'), `No Bot named ${id}. Team: Chief, Writer`)
    assert.equal(await tool('update_bot', { bot: id, role: 'x' }, 'm1'), `No Bot named ${id}.`)
    assert.match(await tool('create_group', { members: [id, 'Writer'] }, 'm1'), new RegExp(`^No Bot named ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    // Asking as a Bot named like this finds no caller either.
    assert.equal(await tool('update_bot', { name: 'King' }, id), 'Only Bots on the team can use update_bot.')
  }
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype), prototypeNames)
  assert.equal(state(), before)
})

test('a capability may be called constructor, and inherited names read as missing', async (t) => {
  const { call, stop } = start()
  t.after(stop)
  const prototypeNames = Object.getOwnPropertyNames(Object.prototype)
  const saved = await call('capability-save', { name: 'constructor', kind: 'skill', content: 'first' })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const updated = await call('capability-save', { name: 'constructor', kind: 'skill', content: 'second' })
  assert.equal(updated.ok, true, JSON.stringify(updated))
  assert.equal(updated.value.content, 'second')
  assert.equal((await call('capability-delete', { name: 'constructor' })).ok, true)
  for (const id of BAD) {
    const gone = await call('capability-delete', { name: id })
    assert.equal(gone.ok, false)
    assert.match(gone.error.message, /No capability named/)
    assert.notEqual(gone.error.code, 'bot/internal')
  }
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype), prototypeNames)
})
