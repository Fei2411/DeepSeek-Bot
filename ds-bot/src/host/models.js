// Models. Every Bot runs on one model of its own, fixed when it is created and changed
// only in its settings or by a Main Bot. The team's first Main Bot has none until the
// user picks one in its chat. The Session keeps the selection durably.
import { normalize, splitRef } from './text.js'

const CATALOG_TTL_MS = 10_000
const ROUTE_WAIT_MS = 30_000
// The DeepSeek account's sign-in grant (dsh-deepseek-account-platform).
const ACCOUNT_RECORD = 'deepseek-account-platform/default'

export function install(rt) {
  const { ctx, state } = rt

  let modelsSynced = null
  let catalogCache = { at: 0, value: [] }
  // A model's thinking levels, resolved once and kept for a short while: they change
  // only with the provider, which also drops the catalog cache.
  const reasoningCache = new Map()
  const dropCatalog = () => { catalogCache = { at: 0, value: [] } }
  // A key set or a sign-in may be the user's fix for a Bot's failed turn (turns.js); a
  // key removed or a sign-out is not. A provider that registers or changes fixes
  // nothing by itself: providers register late at every start.
  ctx.on?.('llm/adapters-updated', () => { dropCatalog(); reasoningCache.clear() })
  ctx.on?.('credentials/reference-updated', async (ref) => {
    dropCatalog()
    if (await inPlace(credentials => credentials.describe(ref))) rt.unblockBots?.({ ref })
  })
  // A sign-in writes the account's record. A sign-out removes it, and so does a token
  // the provider refused, while the turn that failed on it still runs. Other plugins'
  // records (an OAuth token refresh) say nothing about the account.
  ctx.on?.('credentials/record-updated', async (key) => {
    dropCatalog()
    if (String(key) !== ACCOUNT_RECORD) return
    if (await inPlace(credentials => credentials.describeRecord(key))) rt.unblockBots?.({ signedIn: true })
  })
  ctx.on?.('settings/document-updated', dropCatalog)

  // Whether a credential is there after a change. One that cannot be read counts as
  // there, so a fix is not missed.
  async function inPlace(describe) {
    const credentials = ctx.get?.('credentials')
    if (credentials === undefined) return true
    try { return (await describe(credentials))?.configured !== false } catch { return true }
  }

  // The thinking levels a model serves: `{efforts: [{id, name, description?}],
  // defaultEffort?}`, or undefined when it has none or the provider cannot say.
  async function reasoningOf(ref) {
    const cached = reasoningCache.get(ref)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value
    const route = splitRef(ref)
    const info = route === undefined ? undefined : await ctx.llm.resolveModelInfo?.(route.provider, route.model).catch(() => undefined)
    const value = info?.reasoning === undefined ? undefined : {
      efforts: (info.reasoning.efforts ?? []).map(effort => ({ id: effort.id, name: effort.name ?? effort.id, ...(effort.description ? { description: effort.description } : {}) })),
      ...(info.reasoning.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort }),
    }
    reasoningCache.set(ref, { at: Date.now(), value })
    return value
  }

  // A provider's model list can change in DSH settings without any event, so a picker
  // that is about to be used asks for a `fresh` one. Entries for models a Bot uses
  // also carry their `reasoning`, so the picker can offer thinking levels.
  async function catalog({ fresh = false } = {}) {
    if (!fresh && Date.now() - catalogCache.at < CATALOG_TTL_MS && catalogCache.value.length > 0) return catalogCache.value
    const entries = []
    for (const provider of ctx.llm.listProviders()) {
      let models = []
      try { models = await ctx.llm.listModels(provider.id) } catch { continue }
      for (const model of models) {
        entries.push({
          ref: `${provider.id}/${model.id}`,
          provider: provider.id,
          providerName: provider.name ?? provider.id,
          id: model.id,
          name: model.name ?? model.id,
          ...(model.inputModalities ? { input: [...model.inputModalities] } : {}),
        })
      }
    }
    // DSH serves a provider's models whether or not its key is set; without one, every
    // turn on them fails.
    const missing = await rt.missingKeys?.([...new Set(entries.map(entry => entry.provider))]) ?? new Set()
    for (const entry of entries) if (missing.has(entry.provider)) entry.needsKey = true
    // A key can arrive without an event (an environment variable at the next start), so
    // a provider listed with its key again lifts what its missing key blocked.
    rt.unblockBots?.({ keyed: new Set(entries.filter(entry => !entry.needsKey).map(entry => entry.provider)) })
    const used = new Set(Object.values(state.bots ?? {}).flatMap(bot => [bot.model, bot.appliedModel].filter(Boolean)))
    await Promise.all(entries.filter(entry => used.has(entry.ref)).map(async (entry) => {
      const reasoning = await reasoningOf(entry.ref)
      if (reasoning !== undefined) entry.reasoning = reasoning
    }))
    catalogCache = { at: Date.now(), value: entries }
    return entries
  }

  // The profile default model of DSH as set, served or not.
  const defaultRef = () => {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    return selection?.provider && selection?.model ? `${selection.provider}/${selection.model}` : undefined
  }
  // A model whose provider has no key fails every turn, so no Bot is given one unasked.
  const usableOf = entries => entries.filter(entry => entry.needsKey !== true)
  // By the catalog as last listed, without waiting for a fresh one.
  const isUsable = ref => usableOf(catalogCache.value).some(entry => entry.ref === ref)
  // The profile default model of DSH, when it is served and usable; else the first
  // usable model; else none.
  function pickDefault(entries) {
    const usable = usableOf(entries)
    const ref = defaultRef()
    return usable.find(entry => entry.ref === ref)?.ref ?? usable[0]?.ref
  }
  const defaultModel = async () => pickDefault(await catalog())

  // A full `provider/model` ref, or a model id or name that only one provider serves.
  async function resolveModel(text) {
    const entries = await catalog({ fresh: true })
    const wanted = String(text ?? '').trim()
    const exact = entries.find(entry => entry.ref === wanted)
    if (exact) return exact.ref
    const key = normalize(wanted)
    const named = entries.filter(entry => normalize(entry.id) === key || normalize(entry.name) === key)
    if (named.length === 1) return named[0].ref
    const known = entries.map(entry => entry.ref).join(', ') || 'none'
    throw new Error(named.length > 1
      ? `Model ${wanted} is served by more than one provider; use one of ${named.map(entry => entry.ref).join(', ')}`
      : `Model ${wanted} is not available. Available models: ${known}`)
  }

  // A Bot with no model yet waits for the user to pick one and changes nothing. A
  // model that is no longer served falls back to the last one it ran on, then the
  // default; a fallback is never one that needs a key.
  async function desiredModel(bot) {
    if (!bot.model) return undefined
    const entries = await catalog()
    if (entries.some(entry => entry.ref === bot.model)) return bot.model
    return usableOf(entries).some(entry => entry.ref === bot.appliedModel) ? bot.appliedModel : pickDefault(entries)
  }

  // The thinking level a Bot asked for, when the model it runs on serves it; else the
  // model's own default applies. A level the model does not have is ignored, never
  // sent: an explicit effort a provider does not know is a hard refusal there.
  async function desiredEffort(bot, ref) {
    if (bot.effort === undefined || ref === undefined) return undefined
    const reasoning = await reasoningOf(ref)
    return reasoning?.efforts?.some(effort => effort.id === bot.effort) ? bot.effort : undefined
  }

  // A thinking level id, or a name only one level of the model has, like resolveModel.
  async function resolveEffort(ref, text) {
    const wanted = String(text ?? '').trim()
    if (wanted === '') return undefined
    const reasoning = await reasoningOf(ref)
    const efforts = reasoning?.efforts ?? []
    if (efforts.length === 0) throw new Error(`Model ${ref} has no thinking levels`)
    const key = normalize(wanted)
    const named = efforts.filter(effort => normalize(effort.id) === key || normalize(effort.name) === key)
    if (named.length === 1) return named[0].id
    throw new Error(`Thinking level ${wanted} is not available for ${ref}. Available: ${efforts.map(effort => effort.name).join(', ')}`)
  }

  // The profile default model's thinking level, when the model a Bot starts on
  // serves it. A level the model does not know is ignored, like an inherited
  // `bot.effort` — the model's own default applies instead.
  async function defaultEffort(ref) {
    const wanted = ctx.get?.('agentDefaultModel')?.currentSelection?.()?.reasoningEffort
    if (ref === undefined || wanted === undefined) return undefined
    return resolveEffort(ref, wanted).catch(() => undefined)
  }

  // DSH's selectModel also saves the selection as the profile default model, in the
  // background. A Bot's model is its own, so the user's default is written back after
  // it. Selections run one at a time and wait for the write-back: profile writes land in
  // submission order, so the next one reads the user's default, not a Bot's.
  let selecting = Promise.resolve()
  function selectSessionModel(sessionId, { provider, model, reasoningEffort }) {
    const run = selecting.then(async () => {
      const defaults = ctx.get?.('agentDefaultModel')
      const before = defaults?.currentSelection?.()
      const result = await ctx.sessionController.selectModel({
        sessionId, provider, model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
      const saved = result?.selected ?? { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
      if (before?.provider && before?.model && !sameSelection(before, saved)) {
        await defaults.saveSelection(before).catch(error => rt.warn('ds-bot: the default model was not restored: %s', error))
      }
      return result
    })
    selecting = run.catch(() => {})
    return run
  }

  const sameSelection = (a, b) => a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort

  // `force` re-selects even when the record says it is applied: the composer's own
  // model picker can move the Session without telling this plugin.
  async function applyModel(bot, { force = false } = {}) {
    const ref = await desiredModel(bot)
    if (ref === undefined) return ref
    const effort = await desiredEffort(bot, ref)
    if (!force && bot.appliedModel === ref && (bot.appliedEffort ?? undefined) === effort) return ref
    const route = { ...splitRef(ref), ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    await selectSessionModel(rt.chatOf(bot.id), route)
    for (const sessionId of rt.groupSessionsOf(bot.id)) {
      await selectSessionModel(sessionId, route)
        .catch(error => rt.warn('ds-bot: model for %s in a group not applied: %s', bot.name, error))
    }
    bot.appliedModel = ref
    if (effort === undefined) delete bot.appliedEffort
    else bot.appliedEffort = effort
    await rt.save()
    return ref
  }

  // A provider may register after the plugin starts; a greeting waits for its Bot's
  // model instead of failing with "no adapter registered".
  async function waitForModel(bot, ms = ROUTE_WAIT_MS) {
    const deadline = Date.now() + ms
    for (;;) {
      if (!bot.model) return undefined
      catalogCache = { at: 0, value: [] }
      const served = new Set((await catalog()).map(entry => entry.ref))
      if (served.has(bot.model) || Date.now() >= deadline) return desiredModel(bot)
      await new Promise((resolve) => {
        const timer = setTimeout(done, Math.min(2000, deadline - Date.now()))
        const off = ctx.on?.('llm/adapters-updated', done)
        function done() { clearTimeout(timer); off?.(); resolve() }
      })
    }
  }

  // Sequential, and again whenever the served models change: a provider that
  // registers late still gets its Bots' models selected.
  let syncedKey
  const syncModels = () => {
    const key = catalogCache.value.map(entry => entry.ref).join(',')
    if (key !== syncedKey) { syncedKey = key; modelsSynced = modelsSynced?.then(syncAll, syncAll) ?? syncAll() }
    return modelsSynced
  }
  async function syncAll() {
    for (const bot of Object.values(state.bots)) {
      await applyModel(bot).catch(error => rt.warn('ds-bot: model for %s not applied: %s', bot.name, error))
    }
  }

  Object.assign(rt, {
    catalog, cachedCatalog: () => catalogCache.value, cachedDefault: () => pickDefault(catalogCache.value),
    defaultRef, defaultModel, defaultEffort, isUsable, resolveModel, desiredModel, reasoningOf, resolveEffort, desiredEffort,
    selectSessionModel, applyModel, waitForModel, syncModels, dropCatalog,
  })
}
