import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSource } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'

// The requests the actions send, and how many of them read the team again after.
function bench() {
  const sent = []
  let pulls = 0
  const call = async (name, body) => { sent.push([name, body]); return { ok: name } }
  const after = promise => promise.then((value) => { pulls++; return value })
  const ui = createSource({ settings: null, menu: 'open', palette: null, newChat: null })
  const actions = teamActions({ call, after, partFor: id => id, roster: createSource({}), ui })
  return { actions, sent, ui, pulls: () => pulls }
}

test('every window reaches the host model providers, and key changes read the team again', async () => {
  const { actions, sent, pulls } = bench()
  await actions.providers()
  await actions.setProviderKey('deepseek-official', 'sk-test-ok')
  await actions.setProviderKey('deepseek-official', null)
  await actions.addProvider({ provider: 'router', key: 'k' })
  await actions.providerModels({ baseURL: 'https://gateway.example/v1', api: 'openai-completions', key: '' })
  await actions.removeProvider('router')
  assert.deepEqual(sent, [
    ['providers', undefined],
    ['provider-key', { provider: 'deepseek-official', value: 'sk-test-ok' }],
    ['provider-key', { provider: 'deepseek-official', value: null }],
    ['provider-add', { provider: 'router', key: 'k' }],
    ['provider-models', { baseURL: 'https://gateway.example/v1', api: 'openai-completions', key: '' }],
    ['provider-remove', { provider: 'router' }],
  ])
  // Reads (the list and a model discovery) leave the team as it is.
  assert.equal(pulls(), 4)
})

test('Retry after a failed turn asks the host to resume the Bot, with nothing but its id', async () => {
  const { actions, sent, pulls } = bench()
  await actions.resume('chief')
  assert.deepEqual(sent, [['resume', { botId: 'chief' }]])
  assert.equal(pulls(), 1)
})

test('openModels opens DS Bot settings on the Models page and closes the menus', () => {
  const { actions, ui } = bench()
  actions.openModels()
  assert.deepEqual(ui.getSnapshot().settings, { page: 'models', id: null })
  assert.equal(ui.getSnapshot().menu, null)
  actions.openSettings()
  assert.deepEqual(ui.getSnapshot().settings, { page: 'general', id: null })
})
