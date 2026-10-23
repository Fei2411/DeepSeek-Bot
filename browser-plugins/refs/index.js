import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { completeDeepseek } from '../../ds-bot/src/host/browser/deepseek.js'
import { mountBrowserPlugin } from '../../ds-bot/src/host/browser/mount.js'
import { id, label, systemPrompt, toolDefs } from '../../ds-bot/src/host/browser/refs.js'

export { id, label, systemPrompt, toolDefs }
export const name = 'ds-bot-browser-refs'

// Standalone DSH mounts this on the Session id. ds-bot mounts the same tools
// with the Bot id, so a new conversation part keeps the profile.
export function apply(ctx, config = {}) {
  mountBrowserPlugin(ctx, {
    toolDefs,
    defineTool,
    profileRoot: config.profileRoot ?? join(tmpdir(), 'ds-bot-browser-refs'),
    headless: config.headless !== false,
    playwrightUrl: config.playwrightUrl,
    complete: completeDeepseek,
    async keyOf(exec) {
      return config.botId ?? exec.agent?.session?.header?.id ?? exec.agent?.id ?? 'session'
    },
  })
}
