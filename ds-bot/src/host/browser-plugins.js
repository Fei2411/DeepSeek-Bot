// The whole team uses one browser plugin. Each Bot still gets its own profile
// directory, including the group Sessions where that Bot speaks.
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { completeDeepseek } from './browser/deepseek.js'
import { mountBrowserPlugin } from './browser/mount.js'
import * as refs from './browser/refs.js'
import * as script from './browser/script.js'
import * as task from './browser/task.js'

export const browserPlugins = { refs, script, task }
export function appBrowserEndpoint(botId, downloadRoots) {
  if (typeof process.send !== 'function') throw new Error('The app browser relay is unavailable.')
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      process.off('message', receive)
      reject(new Error('The app browser relay did not respond.'))
    }, 10_000)
    const receive = message => {
      if (message?.type !== 'ds-bot:browser-endpoint-response' || message.id !== id) return
      clearTimeout(timeout)
      process.off('message', receive)
      if (typeof message.url === 'string') resolve(message.url)
      else reject(new Error(message.error || 'The app browser relay is unavailable.'))
    }
    process.on('message', receive)
    process.send({ type: 'ds-bot:browser-endpoint', id, botId, downloadRoots }, error => {
      if (error) receive({ type: 'ds-bot:browser-endpoint-response', id, error: error.message })
    })
  })
}

const NAMES = Object.keys(browserPlugins)
const GRANT_KINDS = new Set(['post', 'upload', 'download', 'delete'])

function optionalString(config, key) {
  const value = config[key]
  if (value !== undefined && typeof value !== 'string') throw new TypeError(`${key} must be a string`)
  return value
}

function grantAllows(bot, action) {
  return (Array.isArray(bot.browserGrants) ? bot.browserGrants : []).some(grant => {
    if (!grant || typeof grant.site !== 'string' || !Array.isArray(grant.kinds)) return false
    if (grant.until !== undefined
      && (typeof grant.until !== 'number' || !Number.isFinite(grant.until) || grant.until <= Date.now())) return false
    const site = grant.site.toLowerCase()
    const host = action.host.toLowerCase()
    const siteMatches = site === '*' || host === site || host.endsWith(`.${site}`)
    return GRANT_KINDS.has(action.kind) && siteMatches && (grant.kinds.includes('*') || grant.kinds.includes(action.kind))
  })
}

async function authorizeBrowserAction(rt, exec, botId, action) {
  await rt.load()
  const bot = rt.botOf(botId)
  if (bot === undefined) throw new Error('Unknown Bot')
  if (action.kind === 'payment') {
    throw new Error(`This looks like a payment ("${action.label}" on ${action.host}). The user makes payments themselves: call browser_handoff with reason "payment" and stop. Nothing was done.`)
  }
  if (!GRANT_KINDS.has(action.kind) || grantAllows(bot, action)) return

  const approval = rt.ctx.get?.('approval')
  const agent = exec.agent
  if (approval === undefined || agent?.session === undefined) {
    throw new Error(`This action needs the user's approval, and there is no way to ask here, so nothing was done.`)
  }
  const verbs = {
    post: { en: 'post', zh: '发布内容' },
    upload: { en: 'upload files', zh: '上传文件' },
    download: { en: 'download a file', zh: '下载文件' },
    delete: { en: 'delete something', zh: '删除内容' },
  }
  const verb = verbs[action.kind]
  const reason = `Let ${bot.name} ${verb.en} on ${action.host}: "${action.label}"?`
  const displayReason = {
    en: reason,
    zh: `允许${bot.name}在 ${action.host} 上${verb.zh}“${action.label}”吗？`,
  }
  let outcome
  try {
    outcome = await approval.request({
      agent,
      toolName: exec.name,
      ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
      reason,
      displayReason,
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
  } catch {
    throw new Error('The approval service was unavailable. Nothing was done.')
  }
  if (outcome === 'allowed-once') return
  if (outcome === 'rejected') {
    throw new Error(`The user did not approve ${action.label} on ${action.host}. Do not try this action again unless the user asks. Nothing was done.`)
  }
  if (outcome === 'cancelled') throw new Error('The approval was cancelled. Nothing was done.')
  throw new Error('The approval could not be obtained. Nothing was done.')
}

export function install(rt) {
  const name = rt.config.browserPlugin
  const injected = rt.config.browserPluginApi
  if (!name && !injected) return
  const plugin = injected ?? browserPlugins[name]
  if (!plugin) throw new Error(`Unknown browser plugin "${name}". Choose ${NAMES.join(', ')}.`)
  const playwrightUrl = optionalString(rt.config, 'playwrightUrl')
  const executablePath = optionalString(rt.config, 'browserExecutablePath')
  const headless = typeof rt.config.browserHeadless === 'boolean'
    ? rt.config.browserHeadless
    : !process.env.DISPLAY
  const downloadRoot = join(rt.home, 'browser-downloads')
  async function downloadRoots(botId) {
    await rt.load()
    const team = rt.teamFolder()
    const requested = rt.workDirOf({ botId })
    const working = requested !== undefined && await rt.isFolder(requested) ? requested : team
    return [...new Set([working, team].filter(root => typeof root === 'string' && isAbsolute(root)))]
  }
  mountBrowserPlugin(rt.ctx, {
    toolDefs: plugin.tools ?? plugin.toolDefs,
    defineTool,
    profileRoot: join(rt.home, 'browser-profiles'),
    downloadRoot,
    downloadRoots,
    async uploadRoots(botId) {
      const roots = await downloadRoots(botId)
      return [...new Set([...roots, join(downloadRoot, botId)])]
    },
    headless,
    playwrightUrl,
    executablePath,
    connect: process.env.DS_BOT_APP === '1' && typeof process.send === 'function' ? appBrowserEndpoint : undefined,
    getHold: botId => rt.browserChannel?.holdOf(botId) ?? null,
    onHold: (botId, hold) => rt.browserChannel?.setHold(botId, hold),
    subscribeHolds: listener => rt.browserChannel?.subscribeHolds?.(listener),
    authorize: (exec, botId, action) => authorizeBrowserAction(rt, exec, botId, action),
    complete: rt.config.browserComplete ?? completeDeepseek,
    async keyOf(exec) {
      await rt.load()
      const id = rt.selfOf(exec.agent?.session?.header?.id ?? exec.agent?.id)
      if (id === undefined || rt.botOf(id) === undefined) return undefined
      return id
    },
  })
  rt.browserPlugin = plugin.id ?? name
}
