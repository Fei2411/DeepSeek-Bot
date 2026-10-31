import { test } from 'node:test'
import assert from 'node:assert/strict'
import { base64Of, closingReplyText, preparationStep, requestPreparation, speechCatalog, transcribeWave, turnDetector, waveBytes } from '../src/client/speech.js'

const catalog = (phase, extra = {}) => ({
  providers: [{ id: 'sensevoice', preparation: { phase } }],
  selection: { providerId: 'sensevoice', language: 'auto' },
  maxAudioBytes: 1000,
  maxDurationSeconds: 30,
  ...extra,
})

test('waveBytes writes a 16 kHz mono PCM16 WAV', () => {
  const bytes = waveBytes(new Float32Array([0, 1, -1, 2]))
  const view = new DataView(bytes.buffer)
  const text = (at, length) => String.fromCharCode(...bytes.subarray(at, at + length))
  assert.equal(bytes.length, 44 + 8)
  assert.equal(text(0, 4), 'RIFF')
  assert.equal(text(8, 8), 'WAVEfmt ')
  assert.equal(view.getUint16(20, true), 1)
  assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint16(34, true), 16)
  assert.equal(view.getUint32(40, true), 8)
  assert.deepEqual([0, 1, 2, 3].map(index => view.getInt16(44 + index * 2, true)), [0, 32767, -32768, 32767])
})

test('base64Of matches Buffer for large input', () => {
  const bytes = new Uint8Array(100000).map((_, index) => index % 251)
  assert.equal(base64Of(bytes), Buffer.from(bytes).toString('base64'))
})

test('speechCatalog is usable only when the selected provider is ready', async () => {
  for (const [phase, usable] of [['ready', true], ['standby', true], ['waking', true], ['missing', false], ['preparing', false]]) {
    const speech = { catalog: async () => ({ ok: true, value: catalog(phase) }) }
    assert.equal((await speechCatalog(speech)).usable, usable, phase)
  }
  await assert.rejects(speechCatalog({ catalog: async () => ({ ok: false, error: { message: 'down' } }) }), /down/)
})

test('requestPreparation is false on a refused request and on a throw', async () => {
  let asked = 0
  const speech = { prepare: async () => { asked += 1; return { ok: true } } }
  assert.equal(await requestPreparation(speech, 'sensevoice'), true)
  assert.equal(asked, 1)
  // The remote reports refusal as a result, not a rejection: the pane must
  // leave 'preparing' or it would wait on a task that never started.
  assert.equal(await requestPreparation({ prepare: async () => ({ ok: false, error: { message: 'unavailable' } }) }), false)
  assert.equal(await requestPreparation({ prepare: async () => { throw new Error('gone') } }), false)
})

test('preparationStep maps every catalog phase to the pane step', () => {
  for (const phase of ['ready', 'standby', 'waking']) assert.equal(preparationStep(catalog(phase)).state, 'usable', phase)
  for (const phase of ['downloading', 'checking', 'loading', 'cancelling']) assert.equal(preparationStep(catalog(phase)).state, 'waiting', phase)
  // Every terminal non-usable state ends the wait so the setup step can retry.
  for (const phase of ['cancelled', 'unprepared']) assert.deepEqual(preparationStep(catalog(phase)), { state: 'done', failed: false }, phase)
  assert.deepEqual(preparationStep(catalog('failed')), { state: 'done', failed: true })
  // The selected provider gone from the catalog is done too.
  assert.deepEqual(preparationStep({ providers: [], selection: { providerId: 'sensevoice', language: 'auto' } }), { state: 'done', failed: false })
  assert.deepEqual(preparationStep(catalog('downloading', { providers: [{ id: 'sensevoice', preparation: { phase: 'downloading', completedBytes: 25, totalBytes: 100 } }] })), { state: 'waiting', pct: 25 })
  assert.deepEqual(preparationStep(catalog('downloading')), { state: 'waiting', pct: undefined })
})

test('transcribeWave sends the selection and returns trimmed text', async () => {
  let sent
  const speech = { transcribe: async (request) => { sent = request; return { ok: true, value: { text: '  你好  ' } } } }
  const text = await transcribeWave(speech, catalog('ready'), new Uint8Array([1, 2, 3]), new AbortController().signal)
  assert.equal(text, '你好')
  assert.deepEqual(sent, { audioBase64: 'AQID', providerId: 'sensevoice', language: 'auto' })
})

test('transcribeWave rejects audio over the limit and service failures', async () => {
  const speech = { transcribe: async () => ({ ok: false, error: { message: 'busy' } }) }
  await assert.rejects(transcribeWave(speech, catalog('ready'), new Uint8Array(1001)), error => error.kind === 'too-long')
  await assert.rejects(transcribeWave(speech, catalog('ready'), new Uint8Array(10)), error => error.kind === 'service')
})

test('closingReplyText reads the full closing text, not the preview', () => {
  const tail = (closing) => ({ data: { get: key => (key === 'turn-tail' ? { closing } : undefined) } })
  const chat = (...turns) => ({ timeline: { turns: new Map(turns) } })
  const full = 'The whole answer. '.repeat(300)
  assert.equal(closingReplyText(chat([3, tail({ blocks: [{ kind: 'text', text: full }] })]), 3), full)
  assert.equal(closingReplyText(chat([3, tail({ blocks: [{ kind: 'text', text: 'a' }, { kind: 'tool' }, { kind: 'text', text: 'b' }] })]), 3), 'a\n\nb')
  // Not materialized yet: the voice pane waits for the view's next change.
  assert.equal(closingReplyText(chat([3, tail(undefined)]), 3), undefined)
  assert.equal(closingReplyText(chat([2, tail({ blocks: [{ kind: 'text', text: 'older' }] })]), 3), undefined)
  assert.equal(closingReplyText(undefined, 3), undefined)
  assert.equal(closingReplyText(chat(), 3), undefined)
  // A turn that closed with no Assistant text goes back to listening silently.
  assert.equal(closingReplyText(chat([3, tail(null)]), 3), '')
  assert.equal(closingReplyText(chat([3, tail({ blocks: [] })]), 3), '')
})

test('turnDetector ends a turn after a pause that follows speech', () => {
  const detect = turnDetector({ loud: 0.1, quiet: 0.05, quietMs: 1000 })
  assert.equal(detect(0.01, 0), 'waiting')
  assert.equal(detect(0.3, 100), 'speech')
  assert.equal(detect(0.01, 200), 'speech')
  assert.equal(detect(0.01, 1100), 'speech')
  assert.equal(detect(0.3, 1150), 'speech')
  assert.equal(detect(0.01, 1200), 'speech')
  assert.equal(detect(0.01, 2200), 'done')
})
