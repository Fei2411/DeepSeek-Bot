// Registers one browser plugin's tools. ds-bot passes a key function that resolves
// the Bot; a standalone package can pass the Session id instead.
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { openBotBrowser } from './session.js'
import { gateScope } from './gate.js'

export const browserOutput = {
  schema: {
    oneOf: [
      { type: 'string' },
      {
        type: 'object',
        properties: {
          text: { type: 'string', required: true },
          image: { type: 'string' },
          attachment: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              name: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      },
    ],
  },
  render(_args, value) {
    if (value && typeof value === 'object') {
      const blocks = [{ type: 'text', text: String(value.text ?? '') }]
      // Image blocks must reference a stored attachment; a raw base64 payload is
      // not a valid content block and breaks the session's transport encoding.
      if (value.attachment) blocks.push({ type: 'image', attachment: value.attachment })
      return blocks
    }
    return [{ type: 'text', text: String(value) }]
  },
}

// Tool bodies return screenshot bytes; the model-facing result must carry the
// stored attachment instead, since content blocks cannot inline image data.
async function saveShot(ctx, value) {
  if (!value || typeof value !== 'object' || typeof value.image !== 'string') return value
  const attachments = ctx.get('attachments')
  if (typeof attachments?.saveImage === 'function') {
    try {
      const attachment = await attachments.saveImage({
        mediaType: 'image/jpeg',
        data: Buffer.from(value.image, 'base64'),
        name: 'Browser screenshot',
      })
      return { text: value.text, attachment }
    } catch (error) {
      ctx.logger?.warn?.('ds-bot: screenshot could not be stored: %s', error?.message ?? error)
    }
  }
  return { text: `${value.text ?? ''} (The screenshot could not be attached.)` }
}

/**
 * @param {any} ctx
 * @param {{ toolDefs: any[], defineTool: Function, keyOf: (exec: any) => Promise<string|undefined>, profileRoot: string, downloadRoot?: string, downloadRoots?: (botId: string) => Promise<string[]>, uploadRoots?: (botId: string) => Promise<string[]>, headless: boolean, playwrightUrl?: string, executablePath?: string, actionTimeout?: number, authorize?: (exec: any, botId: string, action: any) => Promise<void>, completeFor?: (exec: any) => Function, connect?: (botId: string, downloadRoots?: string[]) => Promise<string>, getHold?: (botId: string) => any, onHold?: (botId: string, hold: any) => void, subscribeHolds?: (listener: (botId: string, hold: any) => void) => (() => void) | undefined, openSession?: typeof openBotBrowser, api?: object, register?: (tool: any) => void }} options
 */
export function mountBrowserPlugin(ctx, { toolDefs, defineTool, keyOf, profileRoot, downloadRoot, downloadRoots, uploadRoots, headless, playwrightUrl, executablePath, actionTimeout, authorize, completeFor, connect, getHold, onHold, subscribeHolds, openSession = openBotBrowser, api, register }) {
  const sessions = new Map()
  const names = new Set(toolDefs.map(tool => tool.name))
  // Tool results persist their rendered blocks, so changing render() cannot fix
  // old screenshots. Replace only this plugin's malformed image blocks through
  // DSH's public surface API, keeping the original log for the transcript.
  ctx.on?.('agent/pre-step', async ({ agent }, next) => {
    const session = agent.session
    let changed = false
    for (const seq of session.surface?.nodes ?? []) {
      const event = session.eventAt(seq)
      if (event.type !== 'tool/result') continue
      if (!event.sourceEventSeqs?.some(source => names.has(session.eventAt(source)?.data?.name))) continue
      const message = session.deriveEventMessage(event)
      if (!message.content.some(block => block.type === 'image' && !block.attachment && typeof block.data === 'string')) continue
      if (!await keyOf({ agent })) continue
      const content = []
      for (const block of message.content) {
        if (block.type !== 'image' || block.attachment || typeof block.data !== 'string') { content.push(block); continue }
        const saved = await saveShot(ctx, { text: '', image: block.data })
        content.push(saved.attachment
          ? { type: 'image', attachment: saved.attachment, ...(block.offloaded ? { offloaded: true } : {}) }
          : { type: 'text', text: saved.text.trim() })
      }
      session.append('tool/result', { ...event.data, message: { ...message, content } }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
      })
      changed = true
    }
    if (changed) await ctx.sessions.flush(session)
    return next()
  }, { prepend: true })
  const unsubscribeHolds = subscribeHolds?.((botId, hold) => {
    if (hold?.by !== 'user') return
    const session = sessions.get(botId)
    if (!session) return
    sessions.delete(botId)
    void Promise.resolve(session).then(s => s.close(), () => {}).catch(() => {})
  })
  ctx.effect(() => async () => {
    unsubscribeHolds?.()
    const open = [...sessions.values()]
    sessions.clear()
    await Promise.all(open.map(session => Promise.resolve(session).then(opened => opened.close(), () => {})))
  }, 'ds-bot: browser plugin')

  // Closes a Bot's browser and removes its profile directory; used when the Bot is deleted.
  async function drop(botId) {
    const session = sessions.get(botId)
    sessions.delete(botId)
    if (session !== undefined) await Promise.resolve(session).then(opened => opened.close(), () => {})
    await rm(join(profileRoot, botId), { recursive: true, force: true }).catch(() => {})
  }

  const registerTool = register ?? (tool => ctx.tools.register(tool))
  for (const spec of toolDefs) {
    registerTool(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters ?? {},
      output: browserOutput,
      async execute(args, exec) {
        const botId = await keyOf(exec)
        if (!botId) return 'Only Bots on the team have a browser.'
        if (getHold?.(botId)?.by === 'user') throw new Error('The user has taken over this browser. Wait for them to give it back.')
        let session = sessions.get(botId)
        if (spec.needsBrowser && session === undefined) {
          // Store the opening promise before resolving roots so concurrent calls share the launch.
          const opening = Promise.resolve().then(async () => {
            const roots = downloadRoots ? await downloadRoots(botId) : undefined
            return openSession({
              botId,
              profileRoot,
              downloadDir: roots === undefined
                ? join(downloadRoot ?? join(profileRoot, 'browser-downloads'), botId)
                : async () => (await downloadRoots(botId))[0],
              headless,
              playwrightUrl,
              executablePath,
              actionTimeout,
              connect: connect ? id => connect(id, roots ?? []) : undefined,
              getHold: () => getHold?.(botId),
              onHold: hold => onHold?.(botId, hold),
              uploadRoots: uploadRoots ? () => uploadRoots(botId) : undefined,
            })
          })
          sessions.set(botId, opening)
          opening.catch(() => {
            if (sessions.get(botId) === opening) sessions.delete(botId)
          })
          session = opening
        }
        session = await session
        const gate = authorize ? action => authorize(exec, botId, action) : undefined
        return saveShot(ctx, await gateScope.run(gate, () => spec.execute(args ?? {}, {
          botId,
          profileDir: join(profileRoot, botId),
          session,
          complete: completeFor?.(exec),
          origin: { ...(exec.callId !== undefined ? { callId: exec.callId } : {}), ...(exec.agent?.id !== undefined ? { sessionId: exec.agent.id } : {}) },
        })))
      },
    }))
  }

  // An object return would be collected as an effect by cordis, so the api is an out-param.
  if (api) api.drop = drop
}
