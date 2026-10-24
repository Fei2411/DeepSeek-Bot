// Store: the saved team (state.json), its migrations, the lock that keeps a second dsh
// host on the same data from writing it, and the indexes that map a Session to the Bot
// or group chat it belongs to.
import { mkdirSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LEGACY_THEMES, MAX_EXCHANGES, ROOM_MODES, TEXT_KEPT } from './constants.js'
import { replaceFile } from './files.js'
import { homeLock } from './home-lock.js'
import { currentColor, headOf, normalize, unquote } from './text.js'

// A table read that sees only the keys the table holds itself. Ids that come from
// outside (a request body, a tool argument, a name a model gives) go through this, so
// "__proto__" and other inherited names read as "not there" instead of returning
// Object.prototype.
export const own = (table, key) => (table != null && Object.hasOwn(table, key) ? table[key] : undefined)

export function install(rt) {
  const { ctx, home, statePath } = rt

  /** @type {{version:1, workspaceId?:string, mainBotIds:string[], bots:Record<string,any>, rooms:Record<string,any>, agents:Record<string,any>, capabilities:{items:Record<string,any>}, exchanges:any[], exchangeTurns:Record<string,number[]>, revision:number}} */
  const state = { version: 1, mainBotIds: [], bots: {}, rooms: {}, agents: {}, capabilities: { items: {} }, exchanges: [], exchangeTurns: {}, works: {}, requests: {}, questions: {}, views: {}, prefs: {}, switching: {}, revision: 0 }
  let loaded = null
  let writing = Promise.resolve()
  const { warn } = rt

  const EMPTY = JSON.stringify(state)
  // The other dsh host that holds state.lock while this one only reads (see home-lock.js);
  // undefined while this host may write.
  let holder
  let lockBroken = false
  let stuck
  let warnedReadOnly = false
  let stopped = false
  // mtime and size of the state.json this host last read or wrote.
  let seen = ''
  const stamp = () => {
    try {
      const { mtimeMs, size } = statSync(statePath)
      return `${mtimeMs}:${size}`
    } catch {
      return ''
    }
  }
  const lock = homeLock(join(home, 'state.lock'))
  const claimLock = () => {
    if (lockBroken) return
    try {
      mkdirSync(home, { recursive: true })
      holder = lock.claim()
    } catch (error) {
      // An unusable lock (a read-only or odd file system) must not stop the team; a
      // save that then cannot write still rejects.
      lockBroken = true
      holder = undefined
      warn('ds-bot: cannot lock %s, so another dsh on the same data could undo changes: %s', home, error)
    }
  }
  const readOnly = () => {
    if (stuck !== undefined) return `The Bot team file ${statePath} could not be read (${stuck}). DS Bot does not change it; fix or move the file and reload.`
    if (holder === undefined) return undefined
    const where = holder.pid ? `pid ${holder.pid}${holder.host ? ` on ${holder.host}` : ''}` : 'unknown process'
    return `The Bot team in ${home} is open in another dsh (Web or Desktop, ${where}). This window shows the team but cannot change it; close the other one and reload.`
  }

  const readFileState = async () => {
    let contents
    try {
      contents = await readFile(statePath, 'utf8')
    } catch (error) {
      seen = stamp()
      if (error?.code === 'ENOENT') {
        stuck = undefined
        return undefined
      }
      stuck = error?.code ?? error?.message ?? String(error)
      warn('ds-bot: unreadable state %s: %s', statePath, error)
      return undefined
    }
    seen = stamp()
    let parsed
    try {
      parsed = JSON.parse(contents)
    } catch (error) {
      const backup = `${statePath}.broken-${Date.now()}`
      try {
        await copyFile(statePath, backup)
        stuck = undefined
        warn('ds-bot: unreadable state %s: %s; backed up as %s', statePath, error, backup)
      } catch (copyError) {
        stuck = copyError?.code ?? copyError?.message ?? error?.message ?? String(error)
        warn('ds-bot: unreadable state %s: %s; backup failed: %s', statePath, error, copyError)
      }
      return undefined
    }
    if (parsed?.version === 1) {
      stuck = undefined
      return parsed
    }
    stuck = 'saved by a newer DS Bot; update DS Bot'
    return undefined
  }

  // Fill `state` from the saved file and bring an older team up to date. Returns the
  // groups whose Session titles still need the new name.
  const adopt = (parsed) => {
    const hadCapabilities = parsed !== null && parsed !== undefined && Object.hasOwn(parsed, 'capabilities')
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, JSON.parse(EMPTY), parsed ?? {})
    state.prefs ??= {}
    // Teams saved before the DSH Agent existed carry no `agents`; corrupt values reset.
    if (state.agents === null || typeof state.agents !== 'object' || Array.isArray(state.agents)) state.agents = {}
    let migrated = !hadCapabilities
    if (state.capabilities === null || typeof state.capabilities !== 'object' || Array.isArray(state.capabilities)) {
      state.capabilities = { items: {} }
      migrated = true
    } else if (state.capabilities.items === null || typeof state.capabilities.items !== 'object' || Array.isArray(state.capabilities.items)) {
      state.capabilities.items = {}
      migrated = true
    }
    for (const bot of Object.values(state.bots)) {
      if (!Array.isArray(bot.capabilities)) {
        bot.capabilities = []
        migrated = true
      }
      if (bot.color !== currentColor(bot.color)) {
        bot.color = currentColor(bot.color)
        migrated = true
      }
      // LEGACY: Bots saved with a lab ran on that lab's default model; the model they
      // last ran on becomes their own, so dropping the lab changes nothing for them.
      if ('lab' in bot) {
        if (!bot.model && bot.appliedModel) bot.model = bot.appliedModel
        delete bot.lab
        migrated = true
      }
    }
    // A team from before several Main Bots were allowed names a single one.
    if (!Array.isArray(state.mainBotIds)) state.mainBotIds = []
    if ('mainBotId' in state) {
      if (state.mainBotId && !state.mainBotIds.includes(state.mainBotId)) state.mainBotIds.unshift(state.mainBotId)
      delete state.mainBotId
      migrated = true
    }
    state.mainBotIds = state.mainBotIds.filter(id => state.bots[id])
    // Teams from before the whale was stored at setup: their first Bot, while still a
    // Main Bot, gets it once wherever it has no look of its own. After that the whale is
    // an ordinary look the user can change, and it never passes to another Bot.
    if (state.whaleStored !== true) {
      const first = Object.values(state.bots).reduce((best, bot) => (best === undefined || (bot.createdAt ?? 0) < (best.createdAt ?? 0) ? bot : best), undefined)
      if (first !== undefined && state.mainBotIds.includes(first.id)) {
        if (!first.avatar?.shape && !first.avatar?.image) first.avatar = { ...first.avatar, shape: 'whale' }
        if (!first.color) first.color = 'deepseek'
      }
      state.whaleStored = true
      if (first !== undefined) migrated = true
    }
    if (Object.hasOwn(LEGACY_THEMES, state.prefs.theme ?? '')) {
      state.prefs.theme = LEGACY_THEMES[state.prefs.theme]
      migrated = true
    }
    if (state.works === null || typeof state.works !== 'object' || Array.isArray(state.works)) state.works = {}
    if (state.requests === null || typeof state.requests !== 'object' || Array.isArray(state.requests)) state.requests = {}
    if (state.views === null || typeof state.views !== 'object' || Array.isArray(state.views)) state.views = {}
    // LEGACY: aside cards lived in this file only before the feature shipped;
    // they are kept under btw/ per part now. A saved copy is dropped, not moved.
    if ('btwCards' in state) {
      delete state.btwCards
      migrated = true
    }
    const writer = holder === undefined && stuck === undefined
    // LEGACY: Bots no longer count the rounds they start in a group.
    for (const room of Object.values(state.rooms)) {
      if (!('botRounds' in room)) continue
      delete room.botRounds
      migrated = true
    }
    // LEGACY: the late-round limit went with the round caps; a group counts relays to
    // its pause now.
    for (const room of Object.values(state.rooms)) {
      if (room.lateRounds === undefined && room.quietNoticed === undefined && room.quietShown === undefined) continue
      delete room.lateRounds
      delete room.quietNoticed
      delete room.quietShown
      migrated = true
    }
    // Groups from before group settings existed reply in turn, led by a Main Bot member.
    for (const room of Object.values(state.rooms)) {
      if (room.admin !== undefined && ROOM_MODES.includes(room.mode)) continue
      if (room.admin === undefined) room.admin = room.members.find(id => state.mainBotIds.includes(id)) ?? null
      if (!ROOM_MODES.includes(room.mode)) room.mode = 'everyone'
      room.notice ??= ''
      migrated = true
    }
    // A Bot deleted while a group was made or changed could stay listed in it, even as its
    // admin; it leaves the group now.
    for (const room of Object.values(state.rooms)) {
      const members = room.members.filter(id => state.bots[id])
      const admin = members.includes(room.admin) ? room.admin : null
      if (members.length === room.members.length && admin === room.admin) continue
      room.members = members
      room.admin = admin
      migrated = true
    }
    // Teams from before #206 kept every long message whole in this file, written whole on
    // every save. A message between Bots is whole in its recipient's Session; a group
    // line's whole text moves to a file of its own, which only the writing host makes.
    for (const entry of state.exchanges) {
      if (typeof entry.text !== 'string' || entry.text.length <= TEXT_KEPT || entry.length !== undefined) continue
      entry.length = entry.text.length
      entry.text = headOf(entry.text, TEXT_KEPT)
      migrated = true
    }
    for (const room of writer ? Object.values(state.rooms) : []) {
      if (!Array.isArray(room.log)) continue
      const log = room.log.map(line => (typeof line.text === 'string' && line.length === undefined && typeof line.seq === 'number' ? rt.keepGroupLine(room.id, line, line.text) : line))
      if (log.some((line, index) => line !== room.log[index])) {
        room.log = log
        migrated = true
      }
    }
    // Unnamed groups from before names followed their members may still list old names.
    const stale = Object.values(state.rooms).filter(room => !room.named && room.name !== rt.autoRoomName(room.members))
    for (const room of stale) room.name = rt.autoRoomName(room.members)
    indexSessions()
    return { migrated: migrated || stale.length > 0, stale }
  }

  const load = () => loaded ??= (async () => {
    claimLock()
    if (holder !== undefined) warn('ds-bot: %s', readOnly())
    const { migrated, stale } = adopt(await readFileState())
    if (holder !== undefined) return
    if (migrated && stuck === undefined) {
      // A failed write must not poison `loaded`: the migrated state stays in
      // memory and the next save() writes it.
      try {
        await save()
      } catch (error) {
        warn('ds-bot: saving the migrated Bot team failed: %s', error)
      }
    }
    // Not awaited: renaming a session must not hold up the first roster read.
    for (const room of stale) void rt.retitleRoom(room)
  })()

  // A reading host follows the file and takes over once the other host has gone.
  const refresh = async () => {
    await load()
    const hadHolder = holder !== undefined
    if (hadHolder) {
      claimLock()
      if (holder === undefined) {
        warn('ds-bot: the other dsh has closed; this one now saves the Bot team')
        warnedReadOnly = false
        adopt(await readFileState())
        return
      }
    } else if (!lockBroken && !lock.owns()) {
      // A cached "writer" is stale once the lock file no longer names this host:
      // another dsh may have taken it over, or the file may just be gone. Re-claim
      // and re-check instead of trusting the flag.
      claimLock()
      if (lockBroken) return
      if (holder === undefined) {
        // The lock was free: still the writer, but the file may carry changes
        // written while no host held it.
        warnedReadOnly = false
        adopt(await readFileState())
        return
      }
      warn('ds-bot: %s', readOnly())
    }
    if ((stuck !== undefined || holder !== undefined) && stamp() !== seen) adopt(await readFileState())
  }

  const warnReadOnly = () => {
    if (!warnedReadOnly) {
      warnedReadOnly = true
      warn('ds-bot: not saving the Bot team: %s', readOnly())
    }
    return false
  }
  const writable = () => {
    if (stuck !== undefined) return warnReadOnly()
    if (lockBroken) return true
    if (holder === undefined && lock.owns()) return true
    // Lost the lock: retake it when nobody else holds it (its file was deleted), else
    // another host took it over and this one stops writing.
    if (holder === undefined) {
      claimLock()
      if (holder === undefined) return true
    }
    return warnReadOnly()
  }

  const save = () => {
    if (stopped) return writing
    indexSessions()
    // A reading host keeps the file's revision, so its window does not skip the next change.
    if (!writable()) return writing
    state.revision += 1
    state.exchanges = state.exchanges.slice(-MAX_EXCHANGES)
    const snapshot = JSON.stringify(state)
    const run = writing.then(async () => {
      const temp = `${statePath}.${process.pid}.tmp`
      try {
        await mkdir(home, { recursive: true })
        const ensureLock = () => {
          if (lockBroken) return
          if (!lock.owns()) {
            const error = new Error('ds-bot lost the state lock to another dsh')
            error.code = 'ELOCKLOST'
            throw error
          }
        }
        ensureLock()
        await writeFile(temp, snapshot, 'utf8')
        ensureLock()
        await replaceFile(temp, statePath, ensureLock)
        seen = stamp()
        rt.capabilitiesStateSaved?.()
        rt.stateSaved?.()
      } catch (error) {
        await unlink(temp).catch(() => {})
        throw error
      }
    })
    writing = run.catch(() => {})
    return run.catch(error => {
      warn('ds-bot: state write failed: %s', error)
      throw error
    })
  }

  ctx.effect(() => () => {
    stopped = true
    return writing.finally(() => lock.release())
  }, 'ds-bot: state lock')

  const botOf = id => (id === undefined ? undefined : own(state.bots, id))
  const roomOf = id => (id === undefined ? undefined : own(state.rooms, id))
  const isMain = id => id !== undefined && state.mainBotIds.includes(id)

  // Group Sessions. A member speaks in each group from a hidden Session of its own,
  // `room.sessions[botId]`, that renders the same system prompt and tools as its own
  // chat: the provider's prefix cache is shared, and a group turn never re-reads the
  // member's private context. Created on the member's first turn in the group.
  //
  // Segments. A long conversation moves to a fresh Session at a context line (see
  // parts.js). A Bot's id is the Session id of its first own-chat segment and
  // never changes; `bot.sessionId` is the current one. Earlier segments, of the own
  // chat (`bot.segments`) and of each group Session (`room.segments[botId]`), are
  // archived and stay readable.
  /** @type {Map<string, string>} */
  const chatOwners = new Map()
  /** @type {Map<string, {botId:string, roomId:string}>} */
  const groupOwners = new Map()
  /** @type {Map<string, {botId:string, roomId?:string}>} */
  const pastOwners = new Map()
  const chatOf = botId => botOf(botId)?.sessionId ?? botId
  const indexSessions = () => {
    chatOwners.clear()
    groupOwners.clear()
    pastOwners.clear()
    for (const bot of Object.values(state.bots)) {
      for (const segment of bot.segments ?? []) pastOwners.set(segment.sessionId, { botId: bot.id })
      chatOwners.set(chatOf(bot.id), bot.id)
    }
    for (const room of Object.values(state.rooms)) {
      for (const [botId, segments] of Object.entries(room.segments ?? {})) {
        for (const segment of segments) pastOwners.set(segment.sessionId, { botId, roomId: room.id })
      }
      for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) groupOwners.set(sessionId, { botId, roomId: room.id })
    }
    // The agents module owns the DSH Agent session index; it installs after this.
    rt.indexAgents?.()
  }
  // The Bot a Session speaks for: its own chat, one of its group Sessions, or an
  // earlier segment of either.
  const selfOf = id => chatOwners.get(id) ?? groupOwners.get(id)?.botId ?? pastOwners.get(id)?.botId
  // A Session where the Bot speaks now, as opposed to an archived segment.
  const isBotSession = id => chatOwners.has(id) || groupOwners.has(id)
  const groupSessionsOf = botId => Object.values(state.rooms).map(room => room.sessions?.[botId]).filter(Boolean)
  const dropGroupSession = (room, botId) => {
    const sessionId = room.sessions?.[botId]
    if (sessionId === undefined) return
    delete room.sessions[botId]
    for (const segment of room.segments?.[botId] ?? []) delete state.switching[segment.sessionId]
    if (room.segments !== undefined) delete room.segments[botId]
    delete state.switching[sessionId]
    groupOwners.delete(sessionId)
    rt.cancelApprovals?.(sessionId)
    // A plain archive refuses a running Session, which would go on working for a group
    // that no longer has it.
    void ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true }).catch(() => {})
  }
  // A group Session DSH can no longer open is set aside; the member's earlier parts in
  // the group stay, and its next turn there starts a new Session.
  const retireGroupSession = (room, botId) => {
    const sessionId = room.sessions?.[botId]
    if (sessionId === undefined) return
    delete room.sessions[botId]
    groupOwners.delete(sessionId)
    rt.cancelApprovals?.(sessionId)
    void ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true }).catch(() => {})
  }
  const findBot = (ref) => {
    if (ref === undefined) return undefined
    const byId = own(state.bots, ref)
    if (byId) return byId
    const wanted = normalize(ref).replace(/^@/, '')
    return Object.values(state.bots).find(bot => normalize(bot.name) === wanted)
  }
  // Every group chat whose id or name matches; callers refuse an ambiguous name.
  const findRooms = (ref) => {
    if (ref === undefined || ref === null) return []
    const byId = own(state.rooms, ref)
    if (byId) return [byId]
    const wanted = normalize(unquote(ref))
    return Object.values(state.rooms).filter(room => normalize(room.name) === wanted)
  }
  const isAdminOf = (room, id) => id !== undefined && room.admin === id

  Object.assign(rt, {
    state, load, save, refresh, readOnly, own,
    botOf, roomOf, isMain, chatOf, selfOf, isBotSession,
    chatOwners, groupOwners, pastOwners,
    groupSessionsOf, dropGroupSession, retireGroupSession, findBot, findRooms, isAdminOf,
  })
}
