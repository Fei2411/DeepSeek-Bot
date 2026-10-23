// OpenDesign's OpenAI-compatible endpoint, model DeepSeek V4.1 Flash. The key
// stays in the environment and is never written into a result, a log, or an error.
const BASE = (process.env.OPEN_DESIGN_BASE_URL || 'https://amr-link.open-design.ai/v1').replace(/\/$/, '')
const ENDPOINT = `${BASE}/chat/completions`
export const MODEL = 'deepseek-v4.1-flash'

export function deepseekKey() {
  return process.env.OPENDESIGN_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || ''
}

const stripImages = (messages) => messages.map(message => {
  if (!Array.isArray(message.content)) return message
  const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
  return { ...message, content: text || '(screenshot omitted)' }
})

export async function completeDeepseek({ messages, tools, model = MODEL, timeoutMs = 90_000 }) {
  const key = deepseekKey()
  if (!key) throw new Error('OPENDESIGN_API_KEY is not set')
  const send = async (payload, signal) => {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal,
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      const detail = body?.error?.message || response.statusText
      throw new Error(`DeepSeek ${response.status}: ${detail}`)
    }
    return body
  }
  const payload = { model, messages, max_tokens: 4096 }
  if (tools?.length) payload.tools = tools
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const body = await send(payload, controller.signal)
    return { ...body, vision: 'accepted' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/image|multimodal|vision|unsupported/i.test(message)) throw error
    const retry = new AbortController()
    const retryTimer = setTimeout(() => retry.abort(), timeoutMs)
    try {
      const body = await send({ ...payload, messages: stripImages(messages) }, retry.signal)
      return { ...body, vision: 'rejected' }
    } finally {
      clearTimeout(retryTimer)
    }
  } finally {
    clearTimeout(timer)
  }
}
