import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { completeDeepseek } from '../../ds-bot/src/host/browser/deepseek.js'
import { mountBrowserPlugin } from '../../ds-bot/src/host/browser/mount.js'
import { id, label, systemPrompt, toolDefs } from '../../ds-bot/src/host/browser/task.js'

export { id, label, systemPrompt, toolDefs }
export const name = 'ds-bot-browser-task'

export function apply(ctx, config = {}) {
  mountBrowserPlugin(ctx, {
    toolDefs,
    defineTool,
    profileRoot: config.profileRoot ?? join(tmpdir(), 'ds-bot-browser-task'),
    headless: config.headless !== false,
    playwrightUrl: config.playwrightUrl,
    complete: completeDeepseek,
    async keyOf(exec) {
      return config.botId ?? exec.agent?.session?.header?.id ?? exec.agent?.id ?? 'session'
    },
  })
}
