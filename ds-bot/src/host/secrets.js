// Secrets: keys the user types into a card for a Bot. A value lives only in
// secrets.json (mode 600) and in this process; Bots use it as $DSH_SECRET_<NAME> in
// their shell, tool results lose it before they are saved, and every model request
// has it replaced by [secret:<NAME>] before it leaves.
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { replaceFile } from './files.js'
import { output } from './tools.js'

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
export const ENV_PREFIX = 'DSH_SECRET_'
// A short value (a PIN, a short password) would also hit ordinary words if it were
// replaced wherever it appears, so below WHOLE_VALUE it is replaced only where it
// stands alone: no letter or digit right before or after it.
export const MIN_VALUE = 4
export const WHOLE_VALUE = 8
export const MAX_VALUE = 16384
const MAX_REQUESTS = 20
const USED_SAVE_MS = 5000

export const envName = name => `${ENV_PREFIX}${name}`
export const canUse = (secret, botId) => secret !== undefined && botId !== undefined
  && (secret.scope === 'all' || (Array.isArray(secret.scope) && secret.scope.includes(botId)))

export function normalizeName(raw) {
  return String(raw ?? '').trim().replace(/^\$(env:)?/i, '').replace(/^DSH_SECRET_/i, '').replace(/[\s-]+/g, '_').toUpperCase()
}

// encodeURIComponent leaves ' as is, but new URL() turns it into %27 in a query, so the
// URL sent out would hold a form the redactor does not know. Encoding these characters
// too keeps the sent URL equal to the text the redactor looks for.
export const encodeUrlComponent = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

// One function that replaces every known value in a string, longest first so a value
// that contains another is replaced whole. JSON-escaped and URL-encoded forms are covered too.
export function redactor(entries) {
  const pairs = []
  for (const { name, value } of entries) {
    if (typeof value !== 'string' || value.length < MIN_VALUE) continue
    const label = `[secret:${name}]`
    const short = value.length < WHOLE_VALUE
    pairs.push([value, label, short])
    const escaped = JSON.stringify(value).slice(1, -1)
    if (escaped !== value) pairs.push([escaped, label, short])
    // encodeURIComponent throws on a lone surrogate; such a value cannot sit in a URL anyway.
    const encoded = value.isWellFormed() ? encodeUrlComponent(value) : value
    if (encoded !== value && encoded !== escaped) pairs.push([encoded, label, short])
  }
  pairs.sort((a, b) => b[0].length - a[0].length)
  if (pairs.length === 0) return text => text
  // One pass, so a label already written is never matched again.
  const labels = new Map()
  for (const [value, label] of pairs) if (!labels.has(value)) labels.set(value, label)
  const quote = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(pairs.map(([value, , short]) => (short ? `(?<![\\p{L}\\p{N}])${quote(value)}(?![\\p{L}\\p{N}])` : quote(value))).join('|'), 'gu')
  return (text) => {
    if (typeof text !== 'string' || !pairs.some(([value]) => text.includes(value))) return text
    return text.replace(pattern, match => labels.get(match) ?? match)
  }
}

// Returns the same reference when nothing changed, so callers can tell cheaply.
export function redactDeep(value, redact) {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const replaced = redactDeep(item, redact)
      if (replaced !== item) changed = true
      return replaced
    })
    return changed ? next : value
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    let changed = false
    const next = {}
    for (const [key, item] of Object.entries(value)) {
      const replaced = redactDeep(item, redact)
      if (replaced !== item) changed = true
      next[key] = replaced
    }
    return changed ? next : value
  }
  return value
}

export function install(rt) {
  const { ctx, home, state } = rt
  const path = join(home, 'secrets.json')

  /** @type {Map<string, {name:string, value:string, purpose:string, scope:'all'|string[], requestedBy:string|null, createdAt:number, updatedAt:number, lastUsedAt?:number}>} */
  const secrets = new Map()
  let loaded = null
  let writing = Promise.resolve()
  let redact = text => text
  let refreshEnv = () => {}

  const changed = () => {
    redact = redactor([...secrets.values()])
    refreshEnv()
    rt.secretsChanged?.()
  }

  // Error messages from JSON.parse quote the file, so only the code or name is logged.
  const reason = error => error?.code ?? error?.name ?? 'error'

  // While another dsh holds the team, that host writes secrets.json, so a reading host
  // reads it again each time; a copy read then is also read again after taking over,
  // before this host saves anything.
  let loadedReadOnly = false
  // An existing secrets file that cannot be read is not an empty one: writing over it
  // would lose every key in it. While `blocked` holds the reason nothing is written,
  // and each load reads the file again (a busy file may only be briefly unreadable).
  let blocked
  const loadSecrets = () => {
    if (loaded !== null && (loadedReadOnly || rt.readOnly() !== undefined || blocked !== undefined)) loaded = null
    return loaded ??= readSecrets()
  }
  const readSecrets = async () => {
    loadedReadOnly = rt.readOnly() !== undefined
    let contents
    try {
      contents = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        blocked = undefined
        secrets.clear()
      } else {
        blocked = reason(error)
        rt.warn('ds-bot: unreadable secrets file %s (%s)', path, blocked)
      }
      changed()
      return
    }
    let parsed
    try {
      parsed = JSON.parse(contents)
    } catch {
      parsed = null
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.secrets)) {
      // A file that is not a secrets file is kept aside, like a broken state.json, then
      // the store goes on with an empty one.
      const backup = `${path}.broken-${Date.now()}`
      try {
        await copyFile(path, backup)
        blocked = undefined
        secrets.clear()
        rt.warn('ds-bot: unreadable secrets file %s; backed up as %s', path, backup)
      } catch (error) {
        blocked = reason(error)
        rt.warn('ds-bot: unreadable secrets file %s; backup failed: %s', path, error)
      }
      changed()
      return
    }
    blocked = undefined
    secrets.clear()
    for (const entry of parsed.secrets) {
      if (!SECRET_NAME.test(entry?.name ?? '') || typeof entry.value !== 'string') continue
      secrets.set(entry.name, {
        name: entry.name,
        value: entry.value,
        purpose: typeof entry.purpose === 'string' ? entry.purpose : '',
        scope: entry.scope === 'all' ? 'all' : Array.isArray(entry.scope) ? entry.scope.filter(id => typeof id === 'string') : 'all',
        requestedBy: typeof entry.requestedBy === 'string' ? entry.requestedBy : null,
        createdAt: Number(entry.createdAt) || Date.now(),
        updatedAt: Number(entry.updatedAt) || Date.now(),
        ...(Number.isFinite(entry.lastUsedAt) ? { lastUsedAt: entry.lastUsedAt } : {}),
      })
    }
    if (!loadedReadOnly) await chmod(path, 0o600).catch(() => {})
    changed()
  }

  // Resolves once secrets.json holds the current map; rejects when the write failed.
  const persist = () => {
    if (blocked !== undefined) return Promise.reject(new Error(`The secrets file ${path} could not be read (${blocked}). DS Bot does not change it; fix or move the file and reload.`))
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) return Promise.reject(new Error(readOnly))
    const snapshot = JSON.stringify({ version: 1, secrets: [...secrets.values()] }, null, 2)
    const job = writing.then(async () => {
      await mkdir(home, { recursive: true })
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 })
        await chmod(temp, 0o600)
        await replaceFile(temp, path)
      } catch (error) {
        await unlink(temp).catch(() => {})
        throw error
      }
    })
    writing = job.catch(error => rt.warn('ds-bot: secrets write failed (%s)', reason(error)))
    return job
  }

  let usedTimer = null
  const noteUsed = () => {
    if (usedTimer !== null) return
    usedTimer = setTimeout(() => {
      usedTimer = null
      if (loadedReadOnly || rt.readOnly() !== undefined || blocked !== undefined) return
      void persist().then(() => rt.save()).catch(() => {})
    }, USED_SAVE_MS)
    usedTimer.unref?.()
  }

  // A Bot's pending secret cards, keyed by its id. A key that is not a real Bot (and
  // never an inherited name like "__proto__", which a plain assignment would not even
  // set as a key) gets a throwaway list instead of a stored one.
  const requestsOf = (botId) => {
    const requests = (state.secretRequests ??= {})
    if (!Object.hasOwn(requests, botId) && rt.botOf(botId) === undefined) return []
    return (requests[botId] ??= [])
  }
  const findRequest = (id) => {
    for (const [botId, list] of Object.entries(state.secretRequests ?? {})) {
      const request = list.find(entry => entry.id === id)
      if (request !== undefined) return { botId, request }
    }
    return undefined
  }
  const trimRequests = (list) => {
    while (list.length > MAX_REQUESTS) {
      const settled = list.findIndex(entry => entry.status !== 'pending')
      list.splice(settled === -1 ? 0 : settled, 1)
    }
  }

  const scopeText = (scope) => {
    if (scope === 'all') return 'every Bot'
    const names = scope.map(id => rt.botOf(id)?.name).filter(Boolean)
    return names.length === 0 ? 'no Bot' : names.join(', ')
  }
  const usage = name => `$${envName(name)} in bash, or $env:${envName(name)} in PowerShell`

  async function tell(botId, text) {
    if (rt.botOf(botId) === undefined) return
    await rt.deliver({ toId: botId, role: 'secret', text })
      .catch(error => rt.warn('ds-bot: secret note to %s failed: %s', botId, error))
  }
  const savedNote = (name, lead) => [
    `${lead} Use it as ${usage(name)}.`,
    'You cannot see the value. Never print, echo, or log it, and never ask the user to paste it into the chat. Carry on with what you needed it for.',
  ].join(' ')

  function settle(botId, request, status) {
    request.status = status
    request.settledAt = Date.now()
    if (status === 'saved' || status === 'allowed') request.scope = secrets.get(request.name)?.scope ?? 'all'
  }

  // After any change to `name`, every pending card for it either resolves (its Bot can
  // use the key now) or shows the form that still applies.
  function reconcile(name, notes, except) {
    const secret = secrets.get(name)
    for (const [botId, list] of Object.entries(state.secretRequests ?? {})) {
      for (const request of list) {
        if (request.status !== 'pending' || request.name !== name || request === except) continue
        if (canUse(secret, botId)) {
          settle(botId, request, 'saved')
          notes.push([botId, savedNote(name, `The user saved ${name}, and you may use it now.`)])
        } else {
          request.kind = secret ? 'allow' : 'fill'
        }
      }
    }
  }

  async function commit(notes) {
    changed()
    await persist()
    await rt.save()
    for (const [botId, text] of notes) await tell(botId, text)
  }

  const cleanValue = (raw) => {
    if (typeof raw !== 'string') throw new Error('Type the key first')
    const value = raw.trim()
    if (value.length < MIN_VALUE) throw new Error(`A key must have at least ${MIN_VALUE} characters`)
    if (value.length > MAX_VALUE) throw new Error(`A key can have at most ${MAX_VALUE} characters`)
    return value
  }
  const cleanScope = (raw) => {
    if (raw === 'all') return 'all'
    if (!Array.isArray(raw)) throw new Error('Choose every Bot or a list of Bots')
    return [...new Set(raw.filter(id => typeof id === 'string' && rt.botOf(id) !== undefined))]
  }
  const pendingRequest = (id) => {
    const found = findRequest(String(id ?? ''))
    if (found === undefined) throw new Error('This request is gone')
    if (found.request.status !== 'pending') throw new Error('This request was already answered')
    return found
  }

  const secretView = secret => ({
    name: secret.name,
    purpose: secret.purpose,
    scope: secret.scope,
    requestedBy: secret.requestedBy,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
    ...(secret.lastUsedAt !== undefined ? { lastUsedAt: secret.lastUsedAt } : {}),
  })
  const secretsView = () => [...secrets.values()].sort((a, b) => a.name.localeCompare(b.name)).map(secretView)

  const endpoints = {
    // From a card (requestId) or from the settings page (name).
    async 'secret-set'(body) {
      const value = cleanValue(body.value)
      const now = Date.now()
      const notes = []
      if (body.requestId !== undefined) {
        const { botId, request } = pendingRequest(body.requestId)
        const existing = secrets.get(request.name)
        let scope
        if (existing === undefined || request.kind === 'fill') scope = body.scope === 'bot' ? [botId] : 'all'
        else scope = existing.scope === 'all' ? 'all' : [...new Set([...existing.scope, botId])]
        secrets.set(request.name, {
          name: request.name,
          value,
          purpose: existing?.purpose || request.purpose,
          scope,
          requestedBy: existing?.requestedBy ?? botId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          ...(existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
        })
        settle(botId, request, 'saved')
        notes.push([botId, savedNote(request.name, `The user saved ${request.name} for ${scopeText(scope)}.`)])
        reconcile(request.name, notes, request)
        await commit(notes)
        return secretView(secrets.get(request.name))
      }
      const name = normalizeName(body.name)
      if (!SECRET_NAME.test(name)) throw new Error('A name uses capitals, digits, and underscores, and starts with a letter')
      const existing = secrets.get(name)
      secrets.set(name, {
        name,
        value,
        purpose: typeof body.purpose === 'string' && body.purpose.trim() !== '' ? body.purpose.trim().slice(0, 300) : existing?.purpose ?? '',
        scope: body.scope !== undefined ? cleanScope(body.scope) : existing?.scope ?? 'all',
        requestedBy: existing?.requestedBy ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
      })
      reconcile(name, notes)
      await commit(notes)
      return secretView(secrets.get(name))
    },
    async 'secret-allow'(body) {
      const { botId, request } = pendingRequest(body.requestId)
      const secret = secrets.get(request.name)
      if (secret === undefined) throw new Error(`${request.name} is not saved yet`)
      if (!canUse(secret, botId)) secret.scope = [...new Set([...secret.scope, botId])]
      secret.updatedAt = Date.now()
      settle(botId, request, 'allowed')
      const notes = [[botId, savedNote(request.name, `The user let you use ${request.name}.`)]]
      reconcile(request.name, notes, request)
      await commit(notes)
      return secretView(secret)
    },
    async 'secret-cancel'(body) {
      const { botId, request } = pendingRequest(body.requestId)
      settle(botId, request, 'canceled')
      await rt.save()
      await tell(botId, `The user canceled your request for ${request.name}. Do not ask for it again unless the user brings it up; carry on without it, or tell the user what you cannot do without it.`)
      return true
    },
    async 'secret-update'(body) {
      const secret = secrets.get(normalizeName(body.name))
      if (secret === undefined) throw new Error('No such key')
      if (body.scope !== undefined) secret.scope = cleanScope(body.scope)
      if (typeof body.purpose === 'string') secret.purpose = body.purpose.trim().slice(0, 300)
      secret.updatedAt = Date.now()
      const notes = []
      reconcile(secret.name, notes)
      await commit(notes)
      return secretView(secret)
    },
    async 'secret-delete'(body) {
      const name = normalizeName(body.name)
      if (!secrets.delete(name)) throw new Error('No such key')
      const notes = []
      reconcile(name, notes)
      await commit(notes)
      return true
    },
  }

  async function secretEndpoint(endpoint, body) {
    await loadSecrets()
    return endpoints[endpoint](body ?? {})
  }

  // A deleted Bot leaves every list it was on, and its cards go with it.
  async function forgetBotSecrets(botId) {
    await loadSecrets()
    if (state.secretRequests !== undefined) delete state.secretRequests[botId]
    let touched = false
    for (const secret of secrets.values()) {
      if (Array.isArray(secret.scope) && secret.scope.includes(botId)) {
        secret.scope = secret.scope.filter(id => id !== botId)
        touched = true
      }
    }
    if (touched) {
      changed()
      await persist().catch(() => {})
    }
  }

  const callerOf = exec => rt.selfOf(exec.agent?.session?.header?.id ?? exec.agent?.id)

  rt.teamTools.push(defineTool({
    name: 'request_secret',
    description: 'Ask the user for a key, token, or password through a secure card in your own chat. The user types it into the card; you never see the value. It reaches your shell as an environment variable. When the key is already saved for you, this only tells you its variable. Showing a card ends your turn; a note arrives when the user saves or cancels.',
    parameters: {
      name: { type: 'string', required: true, description: 'Key name in capitals, digits, and underscores, e.g. GITHUB_TOKEN' },
      purpose: { type: 'string', required: true, description: 'One short line for the user: what you need it for' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      await loadSecrets()
      const id = exec.agent?.id
      const bot = rt.botOf(callerOf(exec))
      if (bot === undefined) return 'Only Bots on the team can use request_secret.'
      const name = normalizeName(args.name)
      if (!SECRET_NAME.test(name)) return 'Name the key with capitals, digits, and underscores, starting with a letter (for example GITHUB_TOKEN).'
      const secret = secrets.get(name)
      if (canUse(secret, bot.id)) return `${name} is already saved and you may use it: ${usage(name)}. You cannot see the value; never print it.`
      if (rt.groupOwners.has(id)) return 'Secret cards only work in your own chat. Tell the group you will ask the user in your own chat, and call request_secret there.'
      if (!rt.chatOwners.has(id)) return 'Secret cards only work in your current own chat.'
      const readOnly = rt.readOnly()
      if (readOnly !== undefined) return `No card can be shown now. ${readOnly}`
      const list = requestsOf(bot.id)
      const now = Date.now()
      for (const request of list) {
        if (request.status === 'pending' && request.name === name) {
          request.status = 'canceled'
          request.settledAt = now
        }
      }
      list.push({
        id: randomUUID(),
        ...(exec.callId ? { callId: exec.callId } : {}),
        sessionId: id,
        name,
        purpose: String(args.purpose ?? '').trim().slice(0, 300),
        kind: secret ? 'allow' : 'fill',
        status: 'pending',
        askedAt: now,
      })
      trimRequests(list)
      await rt.save()
      exec.concludeTurn?.()
      return secret
        ? `The card asking the user to let you use ${name} is on screen. A note arrives when the user answers; you will not see the value.`
        : `The card asking the user for ${name} is on screen. A note arrives when the user saves or cancels; you will not see the value.`
    },
  }))

  rt.teamTools.push(defineTool({
    name: 'list_secrets',
    description: 'List the keys the user saved for the team: name, purpose, which Bots may use them, and whether you may. Values are never shown.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      await loadSecrets()
      const self = callerOf(exec)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can use list_secrets.'
      if (secrets.size === 0) return 'No keys are saved yet. Ask for one with request_secret.'
      return [
        'Saved keys (values are never shown):',
        ...secretsView().map(secret => `- ${secret.name}${secret.purpose ? ` — ${secret.purpose}` : ''} — for ${scopeText(secret.scope)} — ${canUse(secrets.get(secret.name), self) ? `you may use it as $${envName(secret.name)}` : 'you may not use it; ask with request_secret'}`),
      ].join('\n')
    },
  }))

  // Tool results lose the values before the registry renders and saves them: a fresh
  // result object is re-rendered from its value, so the model content, the saved
  // `tool/result`, and the tool card's presentation all come from the redacted value.
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (secrets.size === 0 || result === null || typeof result !== 'object') return result
    if (result.isError) {
      const content = redactDeep(result.content, redact)
      const meta = redactDeep(result.meta, redact)
      const error = redactDeep(result.error, redact)
      if (content === result.content && meta === result.meta && error === result.error) return result
      return { ...result, content, error, ...(meta !== undefined ? { meta } : {}) }
    }
    const value = redactDeep(result.value, redact)
    if (value === result.value) return result
    return { isError: false, value, ...(result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {}) }
  })

  // Anything that still carries a value (the user pasted it, an earlier part kept it)
  // is replaced before the request leaves. `next` cannot take new options, so the
  // request starts over; it then carries no value and passes through here.
  // A value that is part of its own label would be replaced again on every pass, so a
  // request this listener rewrote passes straight through.
  const rewritten = new WeakSet()
  ctx.on('llm/stream', (options, next) => {
    if (secrets.size === 0 || rewritten.has(options.messages)) return next()
    const messages = redactDeep(options.messages, redact)
    const system = redactDeep(options.system, redact)
    if (messages === options.messages && system === options.system) return next()
    const fresh = [...(messages ?? [])]
    rewritten.add(fresh)
    rt.carryUsageTag(options.messages, fresh)
    return ctx.llm.stream({ ...options, messages: fresh, ...(system !== undefined ? { system } : {}) })
  })

  function resolveEnv(execution) {
    const botId = rt.selfOf(execution?.agent?.session?.header?.id ?? execution?.agent?.id)
    if (rt.botOf(botId) === undefined) return {}
    const command = typeof execution.arguments?.command === 'string' ? execution.arguments.command : ''
    const values = {}
    let used = false
    for (const secret of secrets.values()) {
      if (!canUse(secret, botId)) continue
      values[envName(secret.name)] = secret.value
      if (command.includes(envName(secret.name))) {
        secret.lastUsedAt = Date.now()
        used = true
      }
    }
    if (used) noteUsed()
    return values
  }

  // Keys must be declared up front, so the contribution is registered again whenever
  // the set of names (or a purpose, which describes the key) changes.
  function attachShellEnv(sub) {
    let unregister = null
    let declared = ''
    refreshEnv = () => {
      const list = [...secrets.values()].sort((a, b) => a.name.localeCompare(b.name))
      const key = list.map(secret => `${secret.name}\u0000${secret.purpose}`).join('\n')
      if (key === declared) return
      unregister?.()
      unregister = null
      declared = key
      if (list.length === 0) return
      try {
        unregister = sub.shellEnv.register({
          name: 'ds-bot-secrets',
          variables: Object.fromEntries(list.map(secret => [envName(secret.name), { description: `DS Bot secret ${secret.name}${secret.purpose ? `: ${secret.purpose}` : ''}` }])),
          resolve: resolveEnv,
        })
      } catch (error) {
        declared = ''
        rt.warn('ds-bot: secrets not offered to the shell: %s', error?.message ?? error)
      }
    }
    refreshEnv()
    sub.effect(() => () => {
      unregister?.()
      unregister = null
      declared = ''
      refreshEnv = () => {}
    }, 'ds-bot: secrets shell env')
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['shellEnv'], sub => attachShellEnv(sub))
  } else if (ctx.get?.('shellEnv') !== undefined) {
    attachShellEnv({ shellEnv: ctx.get('shellEnv'), effect: (execute, label) => ctx.effect(execute, label) })
  }

  ctx.effect(() => {
    void loadSecrets()
    return () => { if (usedTimer !== null) clearTimeout(usedTimer) }
  }, 'ds-bot: load secrets')

  Object.assign(rt, {
    secretsView,
    secretValue: name => secrets.get(name)?.value,
    canUseSecret: (name, botId) => canUse(secrets.get(name), botId),
    secretEndpoint,
    forgetBotSecrets,
    loadSecrets,
    redactSecrets: text => redact(text),
  })
}
