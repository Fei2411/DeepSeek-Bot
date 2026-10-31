import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPayload, freshBotName, startModel } from '../src/client/bot-draft.js'

const models = [
  { ref: 'ollama/ds-flash', name: 'DS Flash', providerName: 'Ollama' },
  { ref: 'cloud/qwen-max', name: 'Qwen Max', providerName: 'Cloud' },
]

test('the form starts on the DSH default model, else the first served one', () => {
  assert.equal(startModel({ models, defaultModel: 'cloud/qwen-max' }), 'cloud/qwen-max')
  assert.equal(startModel({ models, defaultModel: 'gone/model' }), 'ollama/ds-flash')
  assert.equal(startModel({ models, defaultModel: null }), 'ollama/ds-flash')
  assert.equal(startModel({ models: [], defaultModel: 'cloud/qwen-max' }), '')
})

test('the form never starts on a model whose provider has no key, and starts on none when no model is usable', () => {
  const keyless = [{ ...models[0], needsKey: true }, models[1]]
  assert.equal(startModel({ models: keyless, defaultModel: 'ollama/ds-flash' }), 'cloud/qwen-max')
  assert.equal(startModel({ models: keyless, defaultModel: null }), 'cloud/qwen-max')
  const none = models.map(model => ({ ...model, needsKey: true }))
  assert.equal(startModel({ models: none, defaultModel: null }), '')
  assert.equal(startModel({ models: none, defaultModel: 'cloud/qwen-max' }), '')
  // With no model the payload leaves it out, and the host lets the new Bot wait for a pick.
  assert.equal('model' in createPayload({ name: 'A', look: { shape: 'star', color: 'blue' }, model: startModel({ models: none, defaultModel: null }) }), false)
})

test('the payload carries the look, the chosen model, and the brief', () => {
  const look = { shape: 'star', color: 'blue' }
  assert.deepEqual(createPayload({ name: 'A', look, model: 'cloud/qwen-max' }), { name: 'A', color: 'blue', avatar: { shape: 'star' }, model: 'cloud/qwen-max' })
  assert.deepEqual(createPayload({ name: 'A', look, model: '', brief: 'hi', image: 'data:image/png;base64,AA' }),
    { name: 'A', color: 'blue', avatar: { shape: 'star', image: 'data:image/png;base64,AA' }, brief: 'hi' })
})

test('the suggested name skips taken names', () => {
  const roster = { bots: [{ name: 'New Bot' }, { name: 'Kimi' }] }
  assert.equal(freshBotName(roster), 'New Bot 2')
  assert.equal(freshBotName(roster, 'Kimi'), 'Kimi 2')
  assert.equal(freshBotName(roster, 'Writer'), 'Writer')
})
