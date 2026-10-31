// The recognizer of DSH's Voice Input plugin (local SenseVoice). Its `speech` Remote
// exists only while that plugin is on; the browser's own speech service stays the
// fallback. The plugin takes one complete 16 kHz mono PCM16 WAV per request.
export const VOICE_BUNDLE = '@deepseek-ai/dsh-experimental-voice-input-bundle'
const USABLE = new Set(['ready', 'standby', 'waking'])

export async function speechCatalog(speech) {
  const result = await speech.catalog()
  if (!result?.ok) throw new Error(result?.error?.message ?? 'Speech catalog failed')
  const catalog = result.value
  const provider = catalog.providers.find(item => item.id === catalog.selection.providerId)
  return { catalog, usable: USABLE.has(provider?.preparation?.phase) }
}

// Ask the provider to prepare. A refused request resolves as a result, not a
// rejection, so both shapes come back as false: no preparation task started.
export async function requestPreparation(speech, providerId) {
  try {
    const result = await speech.prepare(providerId)
    return result?.ok !== false
  } catch {
    return false
  }
}

// One catalog poll while the voice pane waits on preparation: 'usable' starts
// listening; 'done' is a terminal state that left the provider unusable —
// cancelled, failed, back at unprepared, or the provider gone — where the
// setup step shows again and can be retried; anything else keeps waiting,
// 'pct' carrying download progress when the provider reports byte totals.
export function preparationStep(catalog) {
  const preparation = catalog.providers.find(item => item.id === catalog.selection.providerId)?.preparation
  if (preparation === undefined) return { state: 'done', failed: false }
  if (USABLE.has(preparation.phase)) return { state: 'usable' }
  if (preparation.phase === 'failed' || preparation.phase === 'cancelled' || preparation.phase === 'unprepared') {
    return { state: 'done', failed: preparation.phase === 'failed' }
  }
  const pct = preparation.phase === 'downloading' && preparation.totalBytes
    ? Math.floor((preparation.completedBytes / preparation.totalBytes) * 100)
    : undefined
  return { state: 'waiting', pct }
}

export function waveBytes(samples, rate = 16000) {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (at, text) => { for (let index = 0; index < text.length; index += 1) bytes[at + index] = text.charCodeAt(index) }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((sample, index) => {
    const value = Math.max(-1, Math.min(1, sample))
    view.setInt16(44 + index * 2, value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff), true)
  })
  return bytes
}

export function base64Of(bytes) {
  let text = ''
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(text)
}

const captureError = (kind, cause) => Object.assign(new Error(kind), { kind, cause })

// One microphone recording. level() reads the live loudness (0–1); finish() returns
// the WAV, or null when nothing was recorded; cancel() drops it.
export async function openCapture() {
  const devices = navigator.mediaDevices
  if (!devices?.getUserMedia || typeof MediaRecorder === 'undefined') throw captureError('unavailable')
  let stream
  try {
    stream = await devices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
  } catch (error) {
    throw captureError(error?.name === 'NotAllowedError' ? 'blocked' : 'failed', error)
  }
  const audio = new AudioContext()
  const analyser = audio.createAnalyser()
  analyser.fftSize = 512
  audio.createMediaStreamSource(stream).connect(analyser)
  const frame = new Float32Array(analyser.fftSize)
  const recorder = new MediaRecorder(stream)
  const chunks = []
  recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
  recorder.start()
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    if (recorder.state !== 'inactive') recorder.stop()
    stream.getTracks().forEach(track => track.stop())
    void audio.close().catch(() => {})
  }
  return {
    level() {
      if (closed) return 0
      analyser.getFloatTimeDomainData(frame)
      let sum = 0
      for (const sample of frame) sum += sample * sample
      return Math.min(1, Math.sqrt(sum / frame.length) * 4)
    },
    cancel: close,
    async finish(maxSeconds) {
      if (closed || recorder.state === 'inactive') { close(); return null }
      try {
        await new Promise((resolve) => { recorder.onstop = resolve; recorder.stop() })
        stream.getTracks().forEach(track => track.stop())
        const blob = new Blob(chunks, { type: recorder.mimeType })
        if (blob.size === 0) return null
        const decoded = await audio.decodeAudioData(await blob.arrayBuffer())
        const length = Math.max(1, Math.floor(Math.min(decoded.duration, maxSeconds) * 16000))
        const offline = new OfflineAudioContext(1, length, 16000)
        const source = offline.createBufferSource()
        source.buffer = decoded
        source.connect(offline.destination)
        source.start()
        return waveBytes((await offline.startRendering()).getChannelData(0))
      } finally { close() }
    },
  }
}

export async function transcribeWave(speech, catalog, wave, signal) {
  if (wave.byteLength > catalog.maxAudioBytes) throw captureError('too-long')
  const result = await speech.transcribe({ audioBase64: base64Of(wave), ...catalog.selection }, signal)
  if (!result?.ok) throw Object.assign(new Error(result?.error?.message ?? 'Transcription failed'), { kind: 'service' })
  return String(result.value?.text ?? '').trim()
}

// The full closing Assistant text of a finished turn: what voice chat speaks.
// undefined while the chat view has not materialized the turn; '' when the turn
// closed without assistant text.
export function closingReplyText(chat, turn) {
  const location = chat?.timeline?.turns?.get(turn)
  if (location === undefined) return undefined
  const closing = location.data?.get('turn-tail')?.closing
  if (closing === undefined) return undefined
  if (closing === null) return ''
  return (closing.blocks ?? []).filter(block => block.kind === 'text' && block.text.trim() !== '').map(block => block.text).join('\n\n')
}

// Voice activity on the loudness of each animation frame: speech starts above
// `loud`, and the turn ends after `quietMs` below `quiet`.
export function turnDetector({ loud = 0.12, quiet = 0.06, quietMs = 1200 } = {}) {
  let spokeAt = 0
  let quietSince = 0
  return (level, now) => {
    if (level >= loud) { spokeAt ||= now; quietSince = 0; return 'speech' }
    if (!spokeAt) return 'waiting'
    if (level < quiet) quietSince ||= now
    return quietSince && now - quietSince >= quietMs ? 'done' : 'speech'
  }
}
