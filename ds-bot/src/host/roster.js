// Roster: creating, changing, and deleting Bots and group chats, the Main Bot role, and
// the first Main Bot of a new team.
import { mkdir } from 'node:fs/promises'
import { MAX_AVATAR_IMAGE, ROOM_MAX_MEMBERS, ROOM_MODES, ROOM_NAME_MAX, ROOM_NOTICE_MAX } from './constants.js'
import { currentColor, isColor, normalize, unquote } from './text.js'
import { nameProblem } from '../shared/mentions.js'

const BROWSER_GRANT_KINDS = new Set(['post', 'upload', 'download', 'delete', '*'])
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/

const OWN_RULES = 'Where your instructions say otherwise, follow them.'
const writeIn = language => `Write in ${language ?? 'the user\'s language if known; otherwise Chinese'}.`
// The first Main Bot's greeting when the user wrote before it had a model that works.
const AFTER_USER = 'You were just set up as the user\'s Main Bot. The user wrote to you before your model could answer; their message above has no answer yet. Answer it now, and say in one short sentence that you run their Bot team.'

function cleanBrowserGrants(input) {
  if (input === null) return null
  if (!Array.isArray(input) || input.length > 50) throw new Error('Browser grants must be an array of at most 50 entries')
  const grants = []
  const seen = new Set()
  for (const entry of input) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Each browser grant must have a site and kinds')
    }
    const until = entry.until
    if (until !== undefined) {
      if (typeof until !== 'number' || !Number.isFinite(until)) {
        throw new Error('Browser grant until must be a future epoch-millisecond timestamp')
      }
      if (until <= Date.now()) continue
    }
    const site = typeof entry.site === 'string' ? entry.site.trim().toLowerCase() : ''
    if (site !== '*' && !HOSTNAME.test(site)) throw new Error('Browser grant site must be * or a hostname')
    if (!Array.isArray(entry.kinds) || entry.kinds.length === 0
      || entry.kinds.some(kind => typeof kind !== 'string' || !BROWSER_GRANT_KINDS.has(kind))) {
      throw new Error('Browser grant kinds must be a non-empty subset of post, upload, download, delete, *')
    }
    const kinds = [...new Set(entry.kinds)].sort()
    const key = `${site}\0${kinds.join('\0')}\0${until ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    grants.push({ site, kinds, ...(until !== undefined ? { until } : {}) })
  }
  return grants
}

export function install(rt) {
  const { ctx, defaults, state } = rt

  let bootstrapping = null

  // The team folder is DS Bot's own: deleted, it is made again before a Session needs it.
  async function keepTeamFolder() {
    const team = rt.teamFolder()
    if (team !== undefined) await mkdir(team, { recursive: true }).catch(error => rt.warn('ds-bot: team folder %s not made again: %s', team, error))
    return team
  }

  async function ensureWorkspace() {
    if (state.workspaceId && ctx.workspaceRegistry.get(state.workspaceId)) {
      await keepTeamFolder()
      return state.workspaceId
    }
    const path = rt.defaultTeamFolder()
    await mkdir(path, { recursive: true })
    const workspace = await ctx.workspaceRegistry.resolveByPath(path) ?? await ctx.workspaceRegistry.create(path, 'DS Bot')
    state.workspaceId = workspace.id
    await rt.save()
    return workspace.id
  }

  // Under the PTC preset (DSH Desktop's default) a model may call only run_code, which
  // turns down the group_relay call that a group chat's Session is given. A Session
  // keeps the preset it is made with.
  async function botPreset() {
    const presets = ctx.get?.('agentPresets')
    if (presets === undefined) return {}
    const standard = (await presets.list()).some(preset => preset.id === 'standard' && preset.broken === undefined)
    return standard ? { agentPreset: 'standard' } : {}
  }

  // `dir` is a working folder outside the team workspace. Such a Session is made by cwd
  // alone, so it joins no DSH workspace and the user's own project lists stay as they are.
  async function createSession(title, { dir } = {}) {
    // A Bot's tools run here too; while another dsh holds the team, a new Session would
    // belong to no saved Bot.
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
    const usable = dir !== undefined && await rt.isFolder(dir)
    if (dir !== undefined && !usable) rt.warn('ds-bot: the working folder %s is gone; %s starts in the team workspace', dir, title)
    const place = usable ? { cwd: dir } : { workspaceId: await ensureWorkspace() }
    const { sessionId } = await ctx.sessionController.create({ ...place, ...await botPreset() })
    const agent = await rt.resolveAgent(sessionId)
    await ctx.sessionTitle.rename(agent.session, title)
    return sessionId
  }

  function cleanAvatar(input) {
    if (input === null || typeof input !== 'object') return undefined
    const avatar = {}
    if (typeof input.shape === 'string' && /^[a-z][\w-]{0,31}$/.test(input.shape)) avatar.shape = input.shape
    if (typeof input.image === 'string') {
      if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(input.image)) throw new Error('Avatar images must be PNG, JPEG, WebP, or GIF')
      if (input.image.length > MAX_AVATAR_IMAGE) throw new Error('Avatar image is too large')
      avatar.image = input.image
    }
    return Object.keys(avatar).length > 0 ? avatar : undefined
  }

  // A new Bot or group is written only after its Session is made, several awaits after
  // its name was checked. The name is held from the check until the create ends, so a
  // create or rename that runs meanwhile cannot take it too.
  const held = { bot: new Set(), room: new Set() }
  const isHeld = (kind, name) => held[kind].has(normalize(name))
  async function holdName(kind, name, work) {
    const key = normalize(name)
    if (key === '') return work()
    held[kind].add(key)
    try {
      return await work()
    } finally {
      held[kind].delete(key)
    }
  }
  const botNameTaken = name => rt.findBot(name) !== undefined || isHeld('bot', name)

  const freshName = (base) => {
    const stem = base.slice(0, 34)
    if (!botNameTaken(stem)) return stem
    let index = 2
    while (botNameTaken(`${stem} ${index}`)) index += 1
    return `${stem} ${index}`
  }

  // `pickModel` leaves the model to the user: the chat opens on a model card, and the
  // greeting waits until a model is chosen. So does a Bot made when no model it can
  // run on is served.
  async function createBot(options) {
    const cleanName = String(options.name ?? '').trim().slice(0, 40)
    const problem = nameProblem(cleanName)
    if (problem !== undefined) throw new Error(problem)
    if (botNameTaken(cleanName)) throw new Error(`A Bot named ${cleanName} already exists`)
    return holdName('bot', cleanName, () => buildBot(cleanName, options))
  }

  async function buildBot(cleanName, { role = '', instructions = '', color, brief = '', createdBy, main = false, avatar, model, effort, workDir, copyOf, pickModel = false }) {
    const cleanAvatarValue = cleanAvatar(avatar)
    // The model is fixed at creation, so a later change of the DSH default leaves it alone.
    const modelRef = model ? await rt.resolveModel(model) : pickModel ? undefined : await rt.defaultModel()
    // A thinking level needs a model to resolve against; with none it would be dropped
    // silently, so the create fails before a Session is made.
    if (effort && modelRef === undefined) throw new Error('Pick a model before choosing a thinking level')
    // An explicit level wins; an explicit Default (null) picks the model's own
    // level; an untouched pick inherits the profile default's level.
    const effortId = modelRef === undefined ? undefined
      : effort === null || effort === '' ? undefined
      : (await rt.resolveEffort(modelRef, effort)) ?? await rt.defaultEffort(modelRef)
    const dir = workDir === undefined || workDir === null ? undefined : await rt.cleanWorkDir(workDir)
    const clash = dir === undefined ? undefined : await rt.privateClash(dir)
    if (clash) throw new Error(`${dir} is in or around the folder of ${clash.name}, a private Bot, so ${cleanName} cannot work there`)
    const id = await createSession(cleanName, { dir })
    try {
      state.bots[id] = {
        id,
        name: cleanName,
        role: String(role).trim().slice(0, 24),
        // A color is only stored when the user picks one; otherwise the id picks it.
        ...(isColor(currentColor(color)) ? { color: currentColor(color) } : {}),
        ...(cleanAvatarValue ? { avatar: cleanAvatarValue } : {}),
        ...(modelRef ? { model: modelRef } : {}),
        ...(effortId ? { effort: effortId } : {}),
        ...(dir ? { workDir: dir } : {}),
        instructions: String(instructions).trim(),
        createdAt: Date.now(),
        createdBy: createdBy ?? null,
        capabilities: [],
      }
      if (main) state.mainBotIds.push(id)
      const creator = rt.botOf(createdBy)
      const original = rt.botOf(copyOf)
      const language = rt.uiLanguage?.()
      // The kickoff arrives as a user message, so it outranks the Bot's instructions
      // unless it gives way to them, and it names no tool those instructions may rule out.
      const kickoff = main
        ? `You were just set up as the user's Main Bot. Greet the user in one or two short messages: say you will run their Bot team and that they can come to you for anything that needs a decision. Then ask in one short question what they want the team to help with first. ${writeIn(language)}`
        : original
          ? `The user just made you as a copy of ${original.name}: same job, fresh memory. Greet the user in one short message, then ask in one short question what this copy should focus on.`
          : creator
            ? `${creator.name} just created you for the user.${brief ? ` Why you exist: ${brief}` : ''}\nGreet the user in one short message, then ask in one short question where to start. Keep it brief.`
            : brief
              ? `The user just created you and sent this first message:\n\n${brief}\n\nIntroduce yourself in one short line, then help with it.`
              : 'The user just created you. Greet the user in one short message, then ask in one short question what you should focus on.'
      const opener = `${kickoff}\n${OWN_RULES}`
      const text = !main && language ? `${opener}\nWrite in ${language}.` : opener
      const bot = state.bots[id]
      const greeting = { text, from: createdBy ?? null, ...(main ? { main: true } : {}) }
      // The Bot is saved by now; a failure here must not archive it in the catch below.
      const scopeTools = () => rt.resolveAgent(id)
        .catch(error => rt.warn('ds-bot: scoped tools for %s not applied: %s', cleanName, error))
      if (modelRef === undefined) {
        bot.kickoff = greeting
        await rt.save()
        // The Session was resolved before the Bot existed, so its scoped tools land now.
        await scopeTools()
        return bot
      }
      await rt.save()
      await scopeTools()
      // The greeting runs on the Bot's own model, once its provider is registered.
      void rt.waitForModel(bot)
        .then(() => rt.applyModel(bot).catch(error => rt.warn('ds-bot: model for %s not applied: %s', cleanName, error)))
        .then(() => sendKickoff(bot, greeting))
      return bot
    } catch (error) {
      // The Bot's Session was already made: archive it instead of leaving an orphan.
      delete state.bots[id]
      state.mainBotIds = state.mainBotIds.filter(other => other !== id)
      rt.chatOwners.delete(id)
      // A save that another change queued meanwhile still carries this Bot; a later
      // one writes the team without it.
      void rt.save().catch(() => {})
      await ctx.workspaceRegistry.archiveSession(id)
        .catch(archiveError => rt.warn('ds-bot: archiving the Session for %s failed: %s', cleanName, archiveError))
      throw error
    }
  }

  // Greetings sent, by Bot: one whose turn a key, a sign-in or a balance stops is held
  // again (turns.js), to go out once the user has fixed that.
  const sentKickoffs = new Map()
  function sendKickoff(bot, greeting) {
    sentKickoffs.set(bot.id, greeting)
    const text = greeting.afterUser ? `${AFTER_USER} ${writeIn(rt.uiLanguage?.())}\n${OWN_RULES}` : greeting.text
    void rt.deliver({ fromId: greeting.from ?? undefined, toId: bot.id, text, role: 'kickoff' })
      .catch(error => rt.warn('ds-bot: kickoff failed: %s', error))
  }

  // A held greeting goes out once its Bot has a model, on that model once its provider
  // is registered. False while the Bot has none.
  const releasing = new Set()
  async function releaseKickoff(bot) {
    const greeting = bot.kickoff
    if (greeting === undefined || !bot.model) return false
    delete bot.kickoff
    releasing.add(bot.id)
    await rt.save().catch((error) => { releasing.delete(bot.id); throw error })
    const send = () => { releasing.delete(bot.id); sendKickoff(bot, greeting) }
    void rt.waitForModel(bot).then(send, send)
    return true
  }

  // A greeting on its way to a Bot: released and waiting for its model, or sent to its
  // chat and not yet taken up by a turn there (resume.js notes what no turn took up).
  const greetingOut = botId => releasing.has(botId)
    || (rt.unreadOf?.(rt.chatOf(botId)) ?? []).some(args => args.role === 'kickoff')

  function holdKickoffAgain(botId) {
    const bot = rt.botOf(botId)
    const greeting = sentKickoffs.get(botId)
    sentKickoffs.delete(botId)
    if (bot === undefined || greeting === undefined || bot.kickoff !== undefined) return
    // "You are the Main Bot" must not go out after a demotion.
    if (greeting.main && !rt.isMain(botId)) return
    bot.kickoff = greeting
    void rt.save().catch(() => {})
  }

  // The user wrote in a Bot's own chat, so a held greeting would only interrupt. The
  // first Main Bot's stays while that Bot has no model it can run on, and a Bot that a
  // key, a sign-in or a balance blocks has none: once it has one, it answers the message
  // first, unless a turn answered it meanwhile (userAnswered). Read from the catalog as
  // last listed, so it is marked before that turn can end.
  function userWrote(botId) {
    const bot = rt.botOf(botId)
    const greeting = bot?.kickoff
    if (greeting === undefined || greeting.afterUser) return
    if (greeting.main && (bot.blocked !== undefined || !rt.isUsable(bot.model))) greeting.afterUser = true
    else delete bot.kickoff
    void rt.save().catch(() => {})
  }

  // A turn that answered the user in a Bot's own chat leaves nothing for a greeting held
  // for that message to answer.
  function userAnswered(botId) {
    const bot = rt.botOf(botId)
    if (bot?.kickoff?.afterUser !== true) return
    delete bot.kickoff
    void rt.save().catch(() => {})
  }

  async function duplicateBot(id) {
    const bot = rt.botOf(id)
    if (bot === undefined) throw new Error('Unknown Bot')
    if (bot.private === true) throw new Error(`${bot.name} is private, so it cannot be copied`)
    const served = (await rt.catalog()).some(entry => entry.ref === bot.model)
    // A folder that went away since leaves the copy in the team workspace.
    const workDir = bot.workDir !== undefined && await rt.isFolder(bot.workDir) ? bot.workDir : undefined
    // No await from here to createBot's check, so two copies at once get different names.
    return createBot({
      name: freshName(`${bot.name} copy`),
      role: bot.role,
      instructions: bot.instructions,
      color: bot.color,
      avatar: bot.avatar,
      model: served ? bot.model : undefined,
      // A copy of a Bot on the model's own default stays on it (null marks the
      // explicit Default pick); else the create would inherit the profile level.
      effort: served ? (bot.effort ?? null) : undefined,
      workDir,
      copyOf: bot.id,
    })
  }

  async function updateBot(id, patch, actorId, fromSessionId) {
    const bot = rt.botOf(id)
    if (bot === undefined) throw new Error('Unknown Bot')
    if (patch.browserGrants !== undefined && actorId !== undefined) {
      throw new Error(`Only the user can set what ${bot.name} may do in the browser`)
    }
    if (patch.private !== undefined && actorId !== undefined) {
      throw new Error(`Only the user can make ${bot.name} private or open`)
    }
    const browserGrants = patch.browserGrants === undefined ? undefined : cleanBrowserGrants(patch.browserGrants)
    // Checked first, so a folder, model or level that does not pass leaves the rest
    // unchanged too.
    const moving = patch.workDir !== undefined
    const workDir = moving ? await rt.cleanWorkDir(patch.workDir ?? '') : undefined
    const flag = patch.private === undefined ? undefined : patch.private === true
    await rt.checkPrivacyChange(bot, { flag, moving, workDir })
    const modelRef = patch.model === undefined ? undefined
      : patch.model === null || patch.model === '' ? null
      : await rt.resolveModel(patch.model)
    // A new level resolves against the model the Bot will run on: the new one, the
    // model it keeps, or — the model cleared — the one it last ran on.
    const effortRef = modelRef === undefined ? bot.model ?? bot.appliedModel : modelRef ?? bot.appliedModel
    let effortId
    if (patch.effort !== undefined) {
      if (patch.effort === null || patch.effort === '') effortId = null
      else {
        if (effortRef === undefined) throw new Error('Pick a model before choosing a thinking level')
        effortId = await rt.resolveEffort(effortRef, patch.effort)
      }
    }
    if (patch.name !== undefined) {
      const next = String(patch.name).trim().slice(0, 40)
      const clash = rt.findBot(next)
      const pending = isHeld('bot', next) && normalize(next) !== normalize(bot.name)
      if (next === '' || (clash && clash.id !== id) || pending) throw new Error(`Name ${next} is not available`)
      // A name saved before the rule stays usable until it changes.
      const problem = next === bot.name ? undefined : nameProblem(next)
      if (problem !== undefined) throw new Error(problem)
      bot.name = next
      const agent = await rt.resolveAgent(rt.chatOf(id))
      await ctx.sessionTitle.rename(agent.session, next)
      await followMemberNames(Object.values(state.rooms).filter(room => room.members.includes(id)))
    }
    const roleBefore = bot.role
    const instructionsBefore = bot.instructions
    if (patch.role !== undefined) bot.role = String(patch.role).trim().slice(0, 24)
    if (patch.instructions !== undefined) bot.instructions = String(patch.instructions).trim()
    let modelChanged = false
    if (patch.color !== undefined) {
      if (patch.color === null) delete bot.color
      else if (isColor(currentColor(patch.color))) bot.color = currentColor(patch.color)
    }
    if (patch.avatar !== undefined) {
      const avatar = cleanAvatar(patch.avatar)
      if (avatar) bot.avatar = avatar
      else delete bot.avatar
    }
    if (patch.model !== undefined) {
      // A failure that blocked the Bot was its old model's (turns.js).
      if ((modelRef ?? undefined) !== bot.model) delete bot.blocked
      if (modelRef === null) delete bot.model
      else bot.model = modelRef
      modelChanged = true
    }
    if (patch.effort !== undefined) {
      if (effortId === null) delete bot.effort
      else bot.effort = effortId
      modelChanged = true
    }
    if (patch.permission !== undefined) await rt.setPermission(bot, patch.permission)
    if (browserGrants !== undefined) {
      if (browserGrants === null) delete bot.browserGrants
      else bot.browserGrants = browserGrants
    }
    if (flag === true) bot.private = true
    else if (flag === false) delete bot.private
    const moved = moving && workDir !== bot.workDir
    if (moving) {
      if (workDir === undefined) delete bot.workDir
      else bot.workDir = workDir
    }
    await rt.save()
    // The system prompt reads the live profile every turn, but a Session with
    // several rounds behind it follows the old kickoff's pull until a message
    // lands; notify the Bot's chat so the next turn honors the new profile.
    const notes = []
    if (bot.role !== roleBefore) notes.push(`Your role is now "${bot.role || '(none)'}"`)
    if (bot.instructions !== instructionsBefore) notes.push(`Your instructions now read:\n${bot.instructions || '(none)'}`)
    // A held greeting means the model pick is still open: the kickoff it later sends
    // already reads the new profile, and a notice would start a turn before that.
    // A Bot editing itself in its own chat just got the tool result in the turn
    // that made the edit; a notice there would only buy it a second, unsolicited
    // reply. The same edit made from a group Session reaches no own-chat turn, so
    // the notice still goes out.
    const selfEditInChat = actorId === bot.id && fromSessionId === rt.chatOf(bot.id)
    if (notes.length > 0 && bot.kickoff === undefined && !selfEditInChat) {
      void rt.deliver({ toId: bot.id, text: notes.join('\n'), role: 'update' })
        .catch(error => rt.warn('ds-bot: profile update for %s not delivered: %s', bot.name, error?.message ?? error))
    }
    if (modelChanged) await rt.applyModel(bot, { force: true })
    if (moved) void rt.followFolder(bot.id)
    // A new model lifted what blocked the Bot; a new thinking level alone fixes nothing.
    if (modelChanged && bot.blocked === undefined) await releaseKickoff(bot)
    return bot
  }

  async function setFlags(id, { pinned, hidden }) {
    const entry = rt.botOf(id) ?? rt.roomOf(id) ?? rt.own(state.agents, id)
    if (entry === undefined) throw new Error('Unknown conversation')
    if (typeof pinned === 'boolean') entry.pinned = pinned
    if (typeof hidden === 'boolean') entry.hidden = hidden
    await rt.save()
    return entry
  }

  // ---------------------------------------------------------------------------
  // Group chat settings. The user and every Main Bot may change any group; a group's
  // admin may change its own group but not delete it. Only a member can be admin.

  const roomBusy = id => [...rt.roomProgress.values()].some(round => round.roomId === id)
  const autoRoomName = members => ['You', ...members.map(id => rt.botOf(id)?.name).filter(Boolean)].join(', ')
  const cleanNotice = text => String(text ?? '').trim().slice(0, ROOM_NOTICE_MAX)

  function cleanRoomName(text, selfId) {
    const next = unquote(text).replace(/\s+/g, ' ').slice(0, ROOM_NAME_MAX)
    if (next !== '' && (rt.findRooms(next).some(room => room.id !== selfId) || isHeld('room', next))) throw new Error(`Another group chat is already called "${next}"`)
    return next
  }

  async function retitleRoom(room) {
    try {
      const agent = await rt.resolveAgent(room.id)
      await ctx.sessionTitle.rename(agent.session, room.name)
    } catch (error) {
      rt.warn('ds-bot: group title for %s not updated: %s', room.name, error)
    }
  }

  // Groups without a chosen name are named after their members, so they follow renames.
  async function followMemberNames(rooms = Object.values(state.rooms)) {
    for (const room of rooms) {
      if (room.named) continue
      const next = autoRoomName(room.members)
      if (next === room.name) continue
      room.name = next
      await retitleRoom(room)
    }
  }

  function checkMembers(members) {
    if (members.length < 2) throw new Error('A group chat needs at least two Bots')
    if (members.length > ROOM_MAX_MEMBERS) throw new Error(`A group chat holds at most ${ROOM_MAX_MEMBERS} Bots`)
    rt.checkNoPrivate(members)
  }

  // A Main Bot leads the groups it makes; a group the user makes is led by a Main Bot
  // member when it has one.
  const defaultAdmin = (members, createdBy) => (members.includes(createdBy) ? createdBy : members.find(rt.isMain) ?? null)

  async function createRoom({ members: memberIds = [], name: roomName, notice, mode, admin, createdBy } = {}) {
    const members = [...new Set(memberIds)].filter(id => rt.botOf(id))
    checkMembers(members)
    const custom = cleanRoomName(roomName ?? '')
    const adminId = admin !== undefined ? admin : defaultAdmin(members, createdBy)
    if (adminId !== null && !members.includes(adminId)) throw new Error('The admin must be a member of the group')
    if (mode !== undefined && !ROOM_MODES.includes(mode)) throw new Error(`Reply mode must be one of ${ROOM_MODES.join(', ')}`)
    return holdName('room', custom, () => buildRoom({ members, custom, notice, mode, adminId, createdBy }))
  }

  async function buildRoom({ members, custom, notice, mode, adminId, createdBy }) {
    const title = custom || autoRoomName(members)
    // The group's own Session only relays, so it stays in the team workspace; the
    // group's folder is for its members' Sessions.
    const id = await createSession(title)
    try {
      // A member deleted while the Session was made stays out, and the group is checked
      // again as it is written.
      const live = members.filter(member => rt.botOf(member))
      checkMembers(live)
      const lead = adminId === null || live.includes(adminId) ? adminId : defaultAdmin(live, createdBy)
      const name = custom || autoRoomName(live)
      const room = {
        id,
        name,
        ...(custom ? { named: true } : {}),
        members: live,
        admin: lead,
        mode: mode ?? 'admin',
        notice: cleanNotice(notice),
        createdAt: Date.now(),
        createdBy: createdBy ?? null,
      }
      state.rooms[id] = room
      await rt.save()
      if (name !== title) await retitleRoom(room)
      return room
    } catch (error) {
      // The group's Session was already made: archive it instead of leaving an orphan.
      delete state.rooms[id]
      void rt.save().catch(() => {})
      await ctx.workspaceRegistry.archiveSession(id)
        .catch(archiveError => rt.warn('ds-bot: archiving the Session for %s failed: %s', title, archiveError))
      throw error
    }
  }

  // What a change would write to the group as it is now, or why it cannot be made. It
  // reads only the team, so updateRoom runs it to fail fast and again after its last
  // await: another change or a deleted Bot may have come in meanwhile, and `add` and
  // `remove` apply to the members the group has then.
  function planRoomChange(room, patch, actorId) {
    const byMain = actorId === undefined || rt.isMain(actorId)
    const byAdmin = !byMain && rt.isAdminOf(room, actorId)
    if (!byMain && !byAdmin) throw new Error(`Only the user, a Main Bot, or the admin of "${room.name}" can change it`)
    let members = Array.isArray(patch.members) ? [...new Set(patch.members)] : [...room.members]
    for (const member of patch.add ?? []) if (!members.includes(member)) members.push(member)
    members = members.filter(member => !(patch.remove ?? []).includes(member) && rt.botOf(member))
    // A group left with one Bot by a deletion can still change its other settings.
    const current = room.members.filter(member => rt.botOf(member))
    if (members.length !== current.length || members.some(member => !current.includes(member))) checkMembers(members)
    let admin = room.admin ?? null
    if (patch.admin !== undefined) {
      admin = patch.admin || null
      if (admin === null && byAdmin) throw new Error('Hand the admin role to another member instead of leaving the group without one')
      if (admin !== null && !members.includes(admin)) throw new Error(`${rt.botOf(admin)?.name ?? 'That Bot'} must be a member to be the admin`)
    }
    if (admin !== null && !members.includes(admin)) {
      if (byAdmin && admin === actorId) throw new Error('Hand the admin role to another member before leaving the group')
      admin = null
    }
    if (patch.mode !== undefined && !ROOM_MODES.includes(patch.mode)) throw new Error(`Reply mode must be one of ${ROOM_MODES.join(', ')}`)
    const notice = patch.notice === undefined ? undefined : cleanNotice(patch.notice)
    if (patch.workDir !== undefined && byAdmin) throw new Error(`Only the user or a Main Bot can set the folder of "${room.name}"`)
    // A Bot's own permissions are the user's to set, so a group's are too.
    if (patch.permission !== undefined && actorId !== undefined) throw new Error(`Only the user can set the permissions of "${room.name}"`)
    const permission = patch.permission === undefined ? undefined : rt.cleanRoomPermission(patch.permission)
    // The relay limit is the user's guard against a group that never stops; it is
    // not a member's to move, whatever its role.
    if (patch.relayLimit !== undefined && actorId !== undefined) throw new Error(`Only the user can set the relay limit of "${room.name}"`)
    let relayLimit
    if (patch.relayLimit === null) relayLimit = null
    else if (patch.relayLimit !== undefined) {
      if (!Number.isInteger(patch.relayLimit) || patch.relayLimit < 1 || patch.relayLimit > 200) throw new Error('Relay limit must be a whole number from 1 to 200')
      relayLimit = patch.relayLimit
    }
    // The second run is the last check before the change is written, so no other change
    // can take the name in between.
    const name = patch.name === undefined ? undefined : cleanRoomName(patch.name, room.id)
    return { members, admin, name, notice, permission, relayLimit }
  }

  // `actorId` is the Bot asking, or undefined for the user. Returns what changed, in words.
  async function updateRoom(id, patch, actorId) {
    const asked = rt.roomOf(id)
    if (asked === undefined) throw new Error('Unknown group chat')
    planRoomChange(asked, patch, actorId)
    const moving = patch.workDir !== undefined
    const workDir = moving ? await rt.cleanWorkDir(patch.workDir ?? '') : undefined
    const clash = workDir === undefined ? undefined : await rt.privateClash(workDir)
    if (clash) throw new Error(`${workDir} is in or around the folder of ${clash.name}, a private Bot, so a group cannot work there`)
    // No await from here until every change is written.
    const room = rt.roomOf(id)
    if (room === undefined) throw new Error('Unknown group chat')
    const { members, admin, name, notice, permission, relayLimit } = planRoomChange(room, patch, actorId)

    const changes = []
    const names = ids => ids.map(member => rt.botOf(member)?.name).filter(Boolean).join(', ')
    const added = members.filter(member => !room.members.includes(member))
    const removed = room.members.filter(member => !members.includes(member))
    if (added.length > 0) changes.push(`added ${names(added)}`)
    // A deleted Bot still listed goes without a word.
    if (names(removed) !== '') changes.push(`removed ${names(removed)}`)
    // A member who leaves and comes back starts from a fresh look at the log.
    for (const member of removed) {
      if (room.seen) delete room.seen[member]
      rt.dropGroupSession(room, member)
    }
    room.members = members
    if (admin !== (room.admin ?? null)) changes.push(admin ? `made ${rt.botOf(admin).name} the admin` : 'removed the admin')
    room.admin = admin
    if (patch.mode !== undefined && patch.mode !== room.mode) {
      room.mode = patch.mode
      changes.push(patch.mode === 'admin' ? 'plain messages now go to the admin first' : 'every member now replies in turn')
    }
    if (relayLimit !== undefined && relayLimit !== (room.relayLimit ?? null)) {
      if (relayLimit === null) delete room.relayLimit
      else room.relayLimit = relayLimit
      changes.push(relayLimit === null ? 'Bots pause at the default relay count again' : `Bots now pause after ${relayLimit} relays`)
    }
    if (notice !== undefined && notice !== (room.notice ?? '')) {
      room.notice = notice
      changes.push(notice ? 'updated the notice' : 'cleared the notice')
    }
    // Members' group conversations move on to the folder at their next turn there.
    if (moving && workDir !== room.workDir) {
      if (workDir === undefined) delete room.workDir
      else room.workDir = workDir
      changes.push(workDir ? `every member now works in ${workDir} here` : 'every member works in its own folder again')
    }
    const before = room.name
    if (name !== undefined) {
      if (name !== '') {
        room.named = true
        room.name = name
      } else {
        delete room.named
      }
    }
    if (!room.named) room.name = autoRoomName(room.members)
    // The preset is written before its first await; the members' Sessions follow it.
    if (permission !== undefined && await rt.setRoomPermission(room, permission)) {
      changes.push(permission ? `every member now works with the ${permission} permissions here` : 'every member uses its own permissions again')
    }
    if (room.name !== before) {
      changes.push(`renamed it "${room.name}"`)
      await retitleRoom(room)
    }
    await rt.save()
    return { room, changes }
  }

  async function deleteRoom(id) {
    const room = rt.roomOf(id)
    if (room === undefined) throw new Error('Unknown group chat')
    // Before the group's Sessions leave the state, which the archive reads.
    const archived = rt.archiveGroupMemory(room)
    for (const botId of Object.keys(room.sessions ?? {})) rt.dropGroupSession(room, botId)
    delete state.rooms[id]
    rt.roomInbox.delete(id)
    rt.dropGroupLines(id)
    await archived
    const failed = await saveForDelete()
    // Armed scheduled tasks refuse a plain archive and would keep delivering into
    // the deleted group; the session-stop that stopActivity runs removes them.
    await ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })
      .catch(error => rt.warn('ds-bot: group chat %s not archived: %s', room.name, error))
    if (failed !== undefined) throw failed
  }

  // The first Main Bot is the sidebar tile. `replace` gives a Main Bot's place to
  // another Bot in one step, so the team never has none; `primary` moves a Bot to the
  // front and keeps the others.
  async function setMain(id, main, { primary = false, replace } = {}) {
    const bot = rt.botOf(id)
    if (bot === undefined) throw new Error('Unknown Bot')
    if (main && bot.private === true) throw new Error(`${bot.name} is private, so it cannot be a Main Bot`)
    const others = state.mainBotIds.filter(other => other !== id)
    let next
    if (!main) {
      if (!rt.isMain(id)) return
      if (others.length === 0) throw new Error('The team needs at least one Main Bot')
      next = others
    } else if (replace !== undefined && replace !== id) {
      const at = others.indexOf(replace)
      if (at === -1) throw new Error('Only a Main Bot can be replaced')
      next = others.with(at, id)
    } else if (primary) {
      next = [id, ...others]
    } else {
      next = rt.isMain(id) ? state.mainBotIds : [...others, id]
    }
    // The sidebar shows every Main Bot, so a hidden Bot would vanish again once demoted.
    if (main) delete bot.hidden
    // A held setup greeting says "you are the Main Bot"; it must not go out after demotion.
    for (const other of state.mainBotIds.filter(other => !next.includes(other))) {
      if (rt.botOf(other)?.kickoff?.main) delete rt.botOf(other).kickoff
    }
    state.mainBotIds = next
    await rt.save()
  }

  async function deleteBot(id) {
    const bot = rt.botOf(id)
    if (bot === undefined) throw new Error('Unknown Bot')
    if (rt.isMain(id)) throw new Error('A Main Bot cannot be deleted; remove its Main Bot role first')
    // Before the Bot and its group Sessions leave the state, which the archive reads.
    const archived = rt.archiveBotMemory(id)
    const current = rt.chatOf(id)
    // Questions and exchange turns are kept per Session, so every part of the chat is cleared.
    const parts = new Set([id, current, ...(bot.segments ?? []).map(segment => segment.sessionId)])
    // `archiving` stands until the archive's path is known: the memory may already be
    // there, and no region of its own closes it yet.
    const closedArchive = bot.private === true ? {
      id: bot.id,
      name: bot.name,
      ...(bot.workDir === undefined ? {} : { workDir: bot.workDir }),
      sessionIds: [...parts, ...rt.groupSessionsOf(id)],
      archiving: true,
    } : undefined
    await rt.releaseBot(id, [...parts, ...rt.groupSessionsOf(id)])
    if (closedArchive !== undefined) state.privateArchives = [...(state.privateArchives ?? []).filter(entry => entry.id !== id), closedArchive]
    delete state.bots[id]
    for (const part of parts) {
      delete state.questions[part]
      if (state.views !== undefined) delete state.views[part]
      delete state.exchangeTurns[part]
      delete state.switching[part]
    }
    const touched = []
    for (const room of Object.values(state.rooms)) {
      if (!room.members.includes(id)) continue
      room.members = room.members.filter(member => member !== id)
      if (room.admin === id) room.admin = null
      rt.dropGroupSession(room, id)
      touched.push(room)
    }
    await followMemberNames(touched)
    await rt.forgetBotSecrets(id)
    const archivePath = await archived
    if (closedArchive !== undefined) {
      // No path means nothing was moved: a memory that stayed in place is a region already.
      if (archivePath !== undefined) closedArchive.archivePath = archivePath
      delete closedArchive.archiving
    }
    const failed = await saveForDelete()
    // Same as deleteRoom: stopActivity removes the Session's armed scheduled tasks.
    // Past parts are archived too: a part move can leave tasks on the old Session,
    // which otherwise stays armed and invisible. Already-archived ids are a no-op.
    for (const part of parts) {
      await ctx.workspaceRegistry.archiveSession(part, { stopActivity: true })
        .catch(error => rt.warn('ds-bot: Bot %s not archived: %s', bot.name, error))
    }
    if (failed !== undefined) throw failed
  }

  // A deletion whose save fails stays in memory, and the next save writes it, so its
  // Sessions are stopped anyway: left armed, their scheduled tasks would keep running
  // with nothing in the team to show or delete them. Only a host that lost the team
  // to another dsh keeps them, since the other host's copy still has them.
  async function saveForDelete() {
    try {
      await rt.save()
      return undefined
    } catch (error) {
      if (error?.code === 'ELOCKLOST' || rt.readOnly() !== undefined) throw error
      return error
    }
  }

  async function bootstrap() {
    await rt.load()
    void rt.syncModels()
    if (state.mainBotIds.some(id => rt.botOf(id))) return
    // Only the team's first Main Bot is stored as the DeepSeek whale; other Bots get a
    // look from their id, and a Bot made Main Bot later keeps its own.
    bootstrapping ??= createBot({ name: defaults.mainName, role: defaults.mainRole, main: true, color: 'deepseek', avatar: { shape: 'whale' }, pickModel: true })
      .finally(() => { bootstrapping = null })
    await bootstrapping
  }

  Object.assign(rt, {
    ensureWorkspace, keepTeamFolder, createSession, createBot, duplicateBot, updateBot, setFlags,
    roomBusy, autoRoomName, retitleRoom, createRoom, updateRoom, deleteRoom,
    setMain, deleteBot, bootstrap, releaseKickoff, greetingOut, holdKickoffAgain, userWrote, userAnswered,
  })
}
