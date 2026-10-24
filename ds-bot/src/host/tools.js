// Team tools: the roster, bot-to-bot messages, group chat settings and posts, and the
// question and view cards. Group rounds and reading chats are in groups.js.
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readAvatar } from './avatar.js'
import { COLORS, EXTRA_COLORS, MESSAGE_INLINE_MAX, ROOM_MODES, SOURCE_KIND } from './constants.js'
import { within } from './folders.js'
import { absoluteLinks } from './links.js'
import { NAME_MAX } from './requests.js'
import { unquote } from './text.js'
import { mentionSpans } from '../shared/mentions.js'
import { checkShownView } from '../shared/views.js'

export const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
export const GROUP_REF = { type: 'string', required: true, description: 'Exact group chat name from list_bots' }
const BLOCKING_QUESTION_TOOL = 'ask_user_question'
// DS Bot carries no goal across conversation parts, so Bot Sessions do not run DSH goals.
const GOAL_TOOLS = ['create_goal', 'update_goal', 'get_goal']
const HIDDEN_TOOLS = [BLOCKING_QUESTION_TOOL, ...GOAL_TOOLS]
const GOAL_REFUSAL = 'DS Bot does not run goals. Ask the Bot in a message instead.'
const MODE_PARAM = {
  type: 'string',
  enum: ROOM_MODES,
  description: '"everyone": every member answers a plain message in turn, admin first. "admin" (the default): a plain message goes to the admin, who calls others with @Name. @mentions always choose who answers.',
}
const WORK_DIR_PARAM = { type: 'string', description: 'Full path of the folder to work in, where commands and file tools start. Only when the user asks for it' }
const AVATAR_PARAM = {
  type: 'string',
  description: 'Profile picture: a local image path (a relative path starts in your working folder) or a data URL. PNG, JPEG, WebP, or GIF; square, 256x256 recommended, up to 120 KB. Images are not resized.',
}
const WORKING_DIRECTORY_TOOL = 'working_directory'

export function install(rt) {
  const { ctx, state } = rt

  const callerBot = (exec) => rt.botOf(rt.selfOf(exec.agent?.id))
  const callerRoom = (exec) => {
    const roomId = rt.groupOwners.get(exec.agent?.id)?.roomId
    return roomId ? { fromRoomId: roomId } : {}
  }

  const roomLine = (room, self) => {
    const members = room.members.map(rt.botOf).filter(Boolean)
      .map(bot => `${bot.name}${bot.id === room.admin ? ' (admin)' : ''}${bot.id === self ? ' (you)' : ''}`)
    const parts = [
      `members: ${members.join(', ')}`,
      room.mode === 'admin' && room.admin ? 'plain messages go to the admin first' : 'every member replies in turn',
      room.notice ? `notice: ${room.notice.split('\n')[0].slice(0, 100)}` : '',
      room.workDir ? `members work in ${room.workDir} here` : '',
      room.permission ? `members work with the ${room.permission} permissions here` : '',
    ].filter(Boolean)
    return `- "${room.name}" — ${parts.join('; ')}`
  }
  // Main Bots see every group; other Bots see the groups they are in.
  const visibleRooms = self => Object.values(state.rooms).filter(room => rt.isMain(self) || room.members.includes(self))

  ctx.tools.register(defineTool({
    name: 'list_bots',
    description: 'List every Bot on the user\'s team with its role, what it does and what it is doing right now, and the group chats you can see.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const lines = Object.values(state.bots).map(bot => {
        const model = bot.appliedModel ?? bot.model
        const tags = [bot.role, model ? `model ${model}` : '', bot.workDir ? `works in ${bot.workDir}` : '', rt.isMain(bot.id) ? 'Main Bot' : '', bot.id === self ? 'you' : ''].filter(Boolean).join(', ')
        const job = bot.instructions ? ` — ${bot.instructions.split('\n')[0].slice(0, 120)}` : ''
        const now = bot.id === self ? '' : `\n  now: ${rt.statusOf(bot.id)}`
        return `- ${bot.name}${tags ? ` (${tags})` : ''}${job}${now}`
      })
      if (lines.length === 0) return 'No Bots yet.'
      const rooms = visibleRooms(self)
      return [
        'Bots:',
        ...lines,
        '',
        rooms.length === 0 ? 'Group chats: none you can see.' : 'Group chats:',
        ...rooms.map(room => roomLine(room, self)),
      ].join('\n')
    },
  }))

  // Sessions a Bot is running in right now: its own chat plus each group Session
  // with a live turn. An idle Bot reports just its own chat.
  const activeSessions = (botId) => {
    const running = [...new Set([rt.chatOf(botId), ...rt.groupSessionsOf(botId)])]
      .filter(sessionId => rt.live.get(sessionId)?.turn !== undefined)
    return { running, idle: running.length === 0 }
  }
  const whereOf = (sessionId) => {
    const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
    return room ? `group "${room.name}"` : 'its own chat'
  }
  // A Bot request still in the inbox: no step or turn has taken it out yet.
  const unreadRequest = (agent, senderId, toUser) => {
    for (const [message, steered] of [...(agent.inbox?.nextStep ?? []).map(message => [message, true]), ...(agent.inbox?.nextTurn ?? []).map(message => [message, false])]) {
      const source = message.source
      if (source?.kind === SOURCE_KIND && source.role === 'request' && source.senderSessionId === senderId
        && (source.audience === 'user') === toUser && !source.deferred && !source.resumed) return { message, steered }
    }
    return undefined
  }
  // A message's own words and files, without its header line.
  const bodyOf = (message) => {
    const content = Array.isArray(message.content) ? message.content : []
    const first = content.find(block => block?.type === 'text')?.text ?? ''
    return { text: first.slice(first.indexOf('\n') + 1), files: content.filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment) }
  }

  // A tool that throws shows as failed in the chat, instead of as sent or stopped.
  const refuse = (message) => { throw new Error(message) }

  // The works (handoffs.js) the calling turn does: what it answers, and the requests
  // that joined it.
  const worksOf = (exec) => {
    const turn = rt.live.get(exec.agent?.id)
    return [rt.workOf(turn?.info), ...(turn?.joined ?? []).map(joined => rt.workOf(joined.info))].filter(Boolean)
  }
  const tooLong = text => `Not sent: the message has ${text.length} characters, more than ${MESSAGE_INLINE_MAX}, and this DeepSeek Harness cannot send it as a file. Write it to a file in your working folder and send its path instead.`

  // Work for a group stays in it: from a group Session, message_bot calls a member there
  // exactly as an "@Name" line would, and never reaches a Bot outside the group.
  const groupRefusal = (room, sender, target) => {
    if (room.members.includes(target.id)) return undefined
    const add = rt.isMain(sender.id) || rt.isAdminOf(room, sender.id) ? ', or add it yourself with update_group first' : ''
    return `Not sent: ${target.name} is not in "${room.name}", and work for this group stays in it. Ask the user to add ${target.name} to the group${add}.`
  }

  const callInGroup = async (exec, room, sender, target, message) => {
    const call = `@${target.name}`
    await rt.roomStepText(exec.agent.id, rt.live.get(exec.agent.id)?.info, message.startsWith(call) ? message : `${call} ${message}`, false)
    return `Called ${target.name} in "${room.name}" with your message, as writing "${call}" there does: it works on it in the group, and you answer its result there. Nothing went to its own chat.`
  }

  // The Bots each Session's post_to_group called by name in its current turn, so that
  // turn does not also send them the same work in their own chats.
  const calledInPosts = new Map()
  const turnOf = exec => rt.live.get(exec.agent?.id)?.turn

  ctx.tools.register(defineTool({
    name: 'message_bot',
    description: 'Send a message to another Bot on the team. If that Bot is working, it reads your message at its next step and can change course, then answers once that work is done; if it is idle, it starts on it right away. Its reply arrives later as a new message to you; with reply_to "user" it answers the user in its own chat instead. In a group chat it reaches only members of that group, as writing "@Name" there does. With request_id you name the request yourself: a repeat of that name with the same message is not sent again, but gives the receipt of the first call back.',
    parameters: {
      to: { type: 'string', required: true, description: 'Exact Bot name from list_bots' },
      message: { type: 'string', required: true, description: 'Self-contained message; the other Bot cannot see this conversation' },
      reply_to: {
        type: 'string',
        enum: ['me', 'user'],
        description: '"me" (default): the reply comes back to you and the user does not see it. "user": the Bot answers the user in its own chat, where the user reads it, and nothing comes back to you. Use "user" whenever the user wants to hear from that Bot directly or asks Bots to say something in their own chats.',
      },
      when: {
        type: 'string',
        enum: ['now', 'queue'],
        description: '"now" (default): a working Bot reads your message at its next step, between its current actions, and answers once its current work is done; use it for questions, information it needs, corrections and warnings. "queue": it reads your message only after its current work is done, as a separate task; use it only for a new task unrelated to what it is doing now. With reply_to "user" the message always queues.',
      },
      request_id: {
        type: 'string',
        description: `Your own name for this request, up to ${NAME_MAX} characters, so that a repeat of it is not sent twice. Send the same request_id with the same message when you repeat a call: the receipt of the first call comes back and nothing is sent again. A request_id names one request: with other content it is refused.`,
      },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const sender = callerBot(exec)
      if (sender === undefined) return 'Only Bots on the team can use message_bot.'
      const target = rt.findBot(args.to)
      if (target === undefined) return `No Bot named ${args.to}. Team: ${Object.values(state.bots).map(bot => bot.name).join(', ')}`
      if (target.id === sender.id) return 'You cannot message yourself.'
      if (String(args.message ?? '').trim() === '') return 'Write a message to send.'
      const name = typeof args.request_id === 'string' ? args.request_id.trim() : ''
      if (name.length > NAME_MAX) return `The request_id is ${name.length} characters long; a request name is at most ${NAME_MAX}.`
      const text = absoluteLinks(String(args.message), rt.sessionFolder?.(exec.agent?.session ?? exec.agent))
      const room = rt.roomOf(rt.groupOwners.get(exec.agent?.id)?.roomId)
      // The request the caller named: it is admitted once, and a repeat of it is not sent again.
      const request = name === '' ? undefined : rt.requestIdentity({
        caller: sender.id,
        context: room === undefined ? 'chat' : `room:${room.id}`,
        name,
        payload: {
          to: target.id,
          message: String(args.message ?? '').replace(/\r\n?/g, '\n').trim(),
          reply_to: args.reply_to === 'user' ? 'user' : 'me',
          when: args.when === 'queue' ? 'queue' : 'now',
        },
      })
      // What the caller gets for a request that was admitted before.
      const answer = (outcome) => {
        if (outcome.status === 'replay') return outcome.receipt
        if (outcome.status === 'conflict') refuse(`Not sent: request_id "${name}" was already used for a different request. A request_id names one request; send this one under a new name.`)
        if (outcome.status === 'uncertain') refuse(`Not sent again: the outcome of request_id "${name}" is not known (the delivery failed, or DS Bot restarted while it was in flight), so it was not sent again. Check whether ${target.name} got it before sending it under a new name.`)
        if (outcome.status === 'expired') return `Nothing was sent again: request_id "${name}" was admitted before, but its receipt is no longer kept, so only the fact that it was sent is left. Send the work under a new request_id if it must be done again.`
        if (outcome.status === 'readonly') refuse(`Not sent: this window cannot save the Bot team, so it cannot record the request_id "${name}". Send it from the window that owns the team, or leave the request_id out.`)
        return outcome.receipt
      }
      if (request !== undefined) {
        const seen = await rt.knownRequest(request)
        if (seen !== undefined) return answer(seen)
      }
      if (room !== undefined) {
        const refusal = groupRefusal(room, sender, target)
        if (refusal !== undefined) refuse(refusal)
        const send = () => callInGroup(exec, room, sender, target, text.trim())
        return request === undefined ? await send() : answer(await rt.admitRequest(request, send))
      }
      const posted = calledInPosts.get(exec.agent?.id)
      const postedIn = posted !== undefined && posted.turn === turnOf(exec) ? posted.calls.get(target.id) : undefined
      if (postedIn !== undefined) refuse(`Not sent: you called ${target.name} in "${postedIn}" in this turn, and it works on that there. Send each task one way only; to add to it, post in that group.`)
      // Whoever waits for this work gets the answer by itself; a message there only
      // sends the work round in a circle. Not a failed call: the turn goes on with
      // the work, and the result says where its answer goes instead of showing a
      // bare error the Bot cannot act on.
      const works = worksOf(exec)
      if (rt.upstreamOf(works).has(target.id)) {
        return `Not sent: ${target.name} is waiting for the result of the work you are doing, and your answer reaches it by itself once everything you handed on is back. Finish the work and end your turn; to ask ${target.name} something, end your turn with the question.`
      }
      const send = async () => {
        const toUser = args.reply_to === 'user'
        const work = toUser ? undefined : works[0]
        const chat = rt.chatOf(target.id)
        const agent = await rt.resolveAgent(chat)
        const status = rt.statusOf(target.id)
        // A request it has not read yet, sent for the same work, takes this one in, so
        // messages to a Bot that cannot read them do not pile up.
        const earlier = unreadRequest(agent, sender.id, toUser)
        const joinable = earlier !== undefined && (toUser || rt.sameWork(earlier.message.source.exchangeId, work))
        const before = joinable ? bodyOf(earlier.message) : undefined
        let long = await rt.attachLong(before ? `${before.text}\n\n${text}` : text, `Message from ${sender.name}.txt`)
        if (long === undefined) return tooLong(text)
        const joins = before !== undefined && agent.inbox?.remove?.(earlier.message.id) === true
        if (before !== undefined && !joins) long = await rt.attachLong(text, `Message from ${sender.name}.txt`) ?? long
        const working = rt.live.get(chat)?.turn !== undefined
        const steer = (args.when !== 'queue' && !toUser) || (joins && earlier.steered)
        const exchangeId = joins ? earlier.message.source.exchangeId : randomUUID()
        if (joins) rt.forgetDelivery?.(exchangeId)
        else if (!toUser) rt.openWork(exchangeId, { from: sender.id, to: target.id, parent: work })
        try {
          await rt.deliver({ fromId: sender.id, toId: target.id, text: long.text, files: [...long.files, ...(joins ? before.files : [])], length: long.length, role: 'request', steer, exchangeId, ...(joins ? { merged: true } : {}), ...(toUser ? { audience: 'user' } : {}) })
        } catch (error) {
          if (!joins) rt.dropWork(exchangeId)
          throw error
        }
        const sent = toUser
          ? `Delivered to ${target.name}. It will answer the user in its own chat; nothing comes back to you, so point the user to ${target.name}'s chat instead of relaying.`
          : working && steer
            ? `Delivered to ${target.name} while it is working: it reads your message at its next step and answers once that work is done. Its reply will arrive later as a new message; do not wait for it.`
            : working
              ? `Queued for ${target.name}: it reads your message after its current work. Its reply will arrive later as a new message; do not wait for it.`
              : `Delivered to ${target.name}. Its reply will arrive later as a new message; do not wait for it.`
        const asker = rt.ownsWork(sender.id, work) ? rt.botOf(state.works[work].from)?.name : undefined
        const notes = [
          joins ? `${target.name} had not read your earlier message yet, so this one was added to it, and it answers both at once.` : '',
          status === 'idle' ? '' : `${target.name} now: ${status}.`,
          asker ? `When you have handed on everything, end your turn: each reply brings you back to this work, and your answer goes to ${asker} once all of it is back.` : '',
        ].filter(Boolean)
        const out = [sent, ...notes].join(' ')
        // Messages reach a Bot's own chat only; work in a group goes on without them.
        const groups = activeSessions(target.id).running.filter(sessionId => sessionId !== chat)
        if (groups.length === 0) return out
        const stop = rt.isMain(sender.id) ? ' If it must not go on there, use stop_bot.' : ''
        return `${out} Your message does not reach its work in ${groups.map(whereOf).join(' and ')}.${stop}`
      }
      return request === undefined ? await send() : answer(await rt.admitRequest(request, send))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'stop_bot',
    description: 'Main Bot only. Stop another Bot\'s running turn immediately — when it must not finish a dangerous action and a message_bot warning is not enough. Its queued messages are dropped with the turn. It is then told why in a new turn, whose reply comes back to you.',
    parameters: {
      bot: { type: 'string', required: true, description: 'Exact Bot name from list_bots' },
      reason: { type: 'string', description: 'Why it was stopped; it reads this afterwards' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const sender = callerBot(exec)
      if (sender === undefined || !rt.isMain(sender.id)) refuse('Only a Main Bot can stop other Bots.')
      const target = rt.findBot(args.bot)
      if (target === undefined) refuse(`No Bot named ${args.bot}. Team: ${Object.values(state.bots).map(bot => bot.name).join(', ')}`)
      if (target.id === sender.id) refuse('You cannot stop yourself.')
      const { running } = activeSessions(target.id)
      if (running.length === 0) refuse(`${target.name} is not running right now, so there is nothing to stop. Use message_bot to reach it.`)
      for (const sessionId of running) {
        const agent = await rt.resolveAgent(sessionId)
        agent.cancel({ kind: 'hook', reason: 'ds-bot/stopped' })
      }
      const why = String(args.reason ?? '').trim() || 'Stop what you are doing; the previous turn was ended on purpose. Acknowledge briefly.'
      await rt.deliver({ fromId: sender.id, toId: target.id, text: why, role: 'stopped', ...callerRoom(exec) })
      return `Stopped ${target.name} in ${running.map(whereOf).join(' and ')}. It is told why in a new turn, whose reply comes back to you.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'create_bot',
    description: 'Main Bot only. Create a new Bot on the user\'s team. It appears in the sidebar and greets the user.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short display name, e.g. "Researcher" or "Editor"' },
      role: { type: 'string', required: true, description: 'Two-to-four character role label shown under the name' },
      instructions: { type: 'string', required: true, description: 'What this Bot is responsible for and how it should work' },
      brief: { type: 'string', description: 'Why the user wants it, passed to the new Bot as its first context' },
      model: { type: 'string', description: 'Model the Bot runs on, as provider/model or a model id. Only when the user names one; otherwise the model you run on.' },
      effort: { type: 'string', description: 'Thinking level for the model, as list_models shows it. Only when the user names one.' },
      work_dir: WORK_DIR_PARAM,
      avatar: AVATAR_PARAM,
    },
    output,
    async execute(args, exec) {
      await rt.load()
      if (!rt.isMain(rt.selfOf(exec.agent?.id))) return 'Only the Main Bot can create Bots. Ask the Main Bot instead.'
      try {
        const avatar = args.avatar ? await readAvatar(String(args.avatar), { baseDir: rt.sessionFolder?.(exec.agent?.session ?? exec.agent), isData: rt.inData }) : undefined
        const workDir = args.work_dir ? await rt.cleanWorkDir(args.work_dir) : undefined
        const name = String(args.name ?? '').trim()
        await rt.approveFolder(exec, { path: workDir, who: { en: `the new Bot ${name}`, zh: `新 Bot ${name} ` } })
        // Without a named model the new Bot takes its creator's: the DSH default may be
        // a provider that has no key, and then the new Bot fails on its first reply.
        const creator = callerBot(exec)
        const served = creator?.model && (await rt.catalog()).some(entry => entry.ref === creator.model)
        const model = args.model || (served ? creator.model : undefined)
        const bot = await rt.createBot({ ...args, avatar: avatar === undefined ? undefined : { image: avatar }, model, workDir, effort: args.effort, createdBy: creator?.id })
        return `Created ${bot.name}${workDir ? `, working in ${workDir}` : ''}. It is greeting the user now.`
      } catch (error) {
        return `Could not create the Bot: ${error.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'update_bot',
    description: 'Change a Bot\'s name, role, color, profile picture, model, thinking level, working folder, or instructions. Every Bot may change itself; only a Main Bot may change another Bot.',
    parameters: {
      bot: { type: 'string', description: 'Current name of the Bot to change; leave out to change yourself' },
      name: { type: 'string', description: 'New name' },
      role: { type: 'string', description: 'New role label' },
      instructions: { type: 'string', description: 'Replacement instructions' },
      color: { type: 'string', description: `One of ${[...COLORS, ...EXTRA_COLORS].join(', ')}` },
      avatar: { ...AVATAR_PARAM, description: `${AVATAR_PARAM.description} An empty string removes the photo and shows the Bot's character again.` },
      model: { type: 'string', description: 'Move the Bot to another model, as provider/model or a model id' },
      effort: { type: 'string', description: 'Thinking level for the Bot\'s model, as list_models shows; an empty string returns to the model\'s default' },
      work_dir: { ...WORK_DIR_PARAM, description: `${WORK_DIR_PARAM.description}; an empty string returns it to the team workspace` },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const caller = rt.botOf(self)
      if (caller === undefined) return 'Only Bots on the team can use update_bot.'
      const bot = args.bot ? rt.findBot(args.bot) : caller
      if (bot === undefined) return `No Bot named ${args.bot}.`
      if (bot.id !== caller.id && !rt.isMain(self)) return 'Only a Main Bot can change another Bot. Leave out bot to change yourself, or ask a Main Bot with message_bot.'
      try {
        const { name: newName, role, instructions, color, model, effort } = args
        let image
        if (args.avatar !== undefined) {
          const input = typeof args.avatar === 'string' ? args.avatar.trim() : args.avatar
          image = input === null || input === '' ? null : await readAvatar(String(input), { baseDir: rt.sessionFolder?.(exec.agent?.session ?? exec.agent), isData: rt.inData })
        }
        const moving = typeof args.work_dir === 'string'
        const workDir = moving ? await rt.cleanWorkDir(args.work_dir) : undefined
        if (moving && workDir !== bot.workDir) await rt.approveFolder(exec, { path: workDir, sessions: rt.sessionsOfBot(bot.id), who: { en: bot.name, zh: ` ${bot.name} ` } })
        // The photo rides on the Bot's other avatar fields, as the settings page's upload
        // does: setting one keeps a custom character, and clearing removes only the image.
        // They are read here, after the waits above, so a change made meanwhile stays.
        const avatar = image === undefined ? undefined : { ...rt.botOf(bot.id)?.avatar, image }
        const next = await rt.updateBot(bot.id, { name: newName, role, instructions, color, ...(avatar !== undefined ? { avatar } : {}), ...(model ? { model } : {}), ...(effort === undefined ? {} : { effort }), ...(moving ? { workDir: workDir ?? '' } : {}) })
        if (!moving) return `Updated ${next.name}.`
        const folder = workDir ?? 'the team workspace'
        return bot.id === caller.id ? `Updated ${next.name}. From your next step on, you work in ${folder}.` : `Updated ${next.name}. It now works in ${folder}.`
      } catch (error) {
        return `Could not update the Bot: ${error.message}`
      }
    },
  }))

  // DSH's working_directory changes a Session's folder in place, and the next part starts in
  // the Bot's working folder again. A Bot that changes to a folder outside its working folder
  // sets its working folder instead, with update_bot's checks, and goes on in a fresh part
  // there; a folder inside it only moves this Session there.
  ctx.on('tools/execute', async (exec, next) => {
    // Resolved as DSH gets it, untrimmed, so that both mean the same folder.
    const cd = exec.name === WORKING_DIRECTORY_TOOL && typeof exec.arguments?.cd === 'string' ? exec.arguments.cd : ''
    const session = exec.agent?.session
    if (cd === '' || session === undefined) return next()
    await rt.load()
    const bot = callerBot(exec)
    if (bot === undefined) return next()
    const room = rt.roomOf(rt.groupOwners.get(exec.agent.id)?.roomId)
    const home = rt.workDirOf({ botId: bot.id, roomId: room?.id }) ?? rt.teamFolder()
    const target = await rt.folderAt(rt.sessionFolder(session), cd)
    if (target === undefined || !(await rt.isFolder(target)) || home === undefined || within(target, await rt.real(home))) return next()
    if (room?.workDir) throw new Error(`Every member of "${room.name}" works in ${room.workDir} here, so you stay inside it. The user or a Main Bot can change the group's folder.`)
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(`Your working folder cannot change now: ${readOnly}`)
    // Saved folders are trimmed like typed ones, so such a name would save another folder.
    if (unquote(target) !== target) throw new Error(`${JSON.stringify(target)} cannot be a working folder: its name starts or ends with a space or a quote mark.`)
    const workDir = await rt.workFolder(target)
    await rt.approveFolder(exec, { path: workDir, sessions: rt.sessionsOfBot(bot.id), who: { en: bot.name, zh: ` ${bot.name} ` } })
    const result = await next()
    if (result?.isError !== true) await rt.updateBot(bot.id, { workDir: workDir ?? '' })
    return result
  })

  ctx.tools.register(defineTool({
    name: 'list_models',
    description: 'List the models a Bot can run on, as provider/model refs for create_bot and update_bot. A model in use also lists the thinking levels it serves.',
    parameters: {},
    output,
    async execute() {
      const models = await rt.catalog({ fresh: true })
      if (models.length === 0) return 'No models are configured. Ask the user to add one in Settings → Models.'
      const fallback = rt.defaultRef()
      // Only catalog entries that already carry `reasoning` (models a Bot runs on)
      // show levels; asking every model for its levels would take a call each.
      return models.map((entry) => {
        const levels = entry.reasoning?.efforts?.map(effort => effort.id) ?? []
        const thinking = levels.length > 0 ? `, thinking: ${levels.join(', ')}${entry.reasoning.defaultEffort === undefined ? '' : ` (default: ${entry.reasoning.defaultEffort})`}` : ''
        return `- ${entry.ref}${entry.name !== entry.id ? ` (${entry.name})` : ''}${entry.input?.includes('image') ? ', reads images' : ''}${entry.ref === fallback ? ', default' : ''}${thinking}`
      }).join('\n')
    },
  }))

  // Group tools take Bot names as an array, or as one comma-separated string from
  // models that flatten it.
  const nameList = value => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，、]/) : [])
    .map(item => String(item ?? '').trim()).filter(Boolean)
  const resolveBots = (refs) => {
    const bots = []
    const unknown = []
    for (const ref of nameList(refs)) {
      const bot = rt.findBot(ref)
      if (bot === undefined) unknown.push(ref)
      else if (!bots.includes(bot)) bots.push(bot)
    }
    return { bots, unknown }
  }
  const teamNames = () => Object.values(state.bots).map(bot => bot.name).join(', ')
  const groupNames = self => visibleRooms(self).map(room => `"${room.name}"`).join(', ') || 'none'
  const pickRoom = (ref, self) => {
    const matches = rt.findRooms(ref).filter(room => visibleRooms(self).includes(room))
    if (matches.length === 1) return { room: matches[0] }
    if (matches.length > 1) return { error: `Several group chats are called "${unquote(ref)}". Rename one first.` }
    return { error: `No group chat called "${unquote(ref)}" that you can see. Groups: ${groupNames(self)}.` }
  }

  ctx.tools.register(defineTool({
    name: 'create_group',
    description: 'Main Bot only. Create a group chat with the user and some Bots. You join it as its admin unless you name another member.',
    parameters: {
      members: { type: 'array', required: true, items: { type: 'string' }, description: 'Exact names of the other Bots to add; you are added automatically' },
      name: { type: 'string', description: 'Group name; defaults to the member names' },
      notice: { type: 'string', description: 'Shared instructions every member reads before speaking in this group' },
      admin: { type: 'string', description: 'Member who leads the group; defaults to you' },
      mode: MODE_PARAM,
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.isMain(self)) return 'Only a Main Bot can create group chats. Ask a Main Bot instead.'
      const { bots, unknown } = resolveBots(args.members)
      if (unknown.length > 0) return `No Bot named ${unknown.join(', ')}. Team: ${teamNames()}`
      const admin = args.admin ? rt.findBot(args.admin) : rt.botOf(self)
      if (admin === undefined) return `No Bot named ${args.admin}. Team: ${teamNames()}`
      const members = [...new Set([self, ...bots.map(bot => bot.id), admin.id])]
      try {
        const room = await rt.createRoom({ members, name: args.name, notice: args.notice, mode: args.mode, admin: admin.id, createdBy: self })
        return `Created group "${room.name}" with ${room.members.map(id => rt.botOf(id).name).join(', ')}. ${admin.id === self ? 'You are' : `${admin.name} is`} its admin. It is in the user's sidebar; use post_to_group to start a discussion there.`
      } catch (error) {
        return `Could not create the group: ${error.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'update_group',
    description: 'Change a group chat: rename it, set its notice, add or remove members, change its admin or reply mode. Main Bots may change any group; a group\'s admin may change its own group.',
    parameters: {
      group: GROUP_REF,
      name: { type: 'string', description: 'New group name; an empty string names it after its members again' },
      notice: { type: 'string', description: 'Replacement notice, the shared instructions every member reads; an empty string clears it' },
      add_members: { type: 'array', items: { type: 'string' }, description: 'Exact names of Bots to add' },
      remove_members: { type: 'array', items: { type: 'string' }, description: 'Exact names of Bots to remove' },
      admin: { type: 'string', description: 'Member to make the admin; "none" leaves the group without one (Main Bots only)' },
      mode: MODE_PARAM,
      work_dir: { ...WORK_DIR_PARAM, description: `${WORK_DIR_PARAM.description}. Every member works there in this group; an empty string lets each member work in its own folder again (Main Bots only)` },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can use update_group.'
      const { room, error } = pickRoom(args.group, self)
      if (error) return error
      const moving = typeof args.work_dir === 'string'
      if (moving && !rt.isMain(self)) return `Only a Main Bot can set the folder of "${room.name}".`
      const add = resolveBots(args.add_members)
      const remove = resolveBots(args.remove_members)
      const unknown = [...add.unknown, ...remove.unknown]
      if (unknown.length > 0) return `No Bot named ${unknown.join(', ')}. Team: ${teamNames()}`
      let admin
      if (args.admin !== undefined && args.admin !== '') {
        if (/^(none|nobody|null|无|没有)$/i.test(String(args.admin).trim())) admin = null
        else {
          admin = rt.findBot(args.admin)?.id
          if (admin === undefined) return `No Bot named ${args.admin}. Team: ${teamNames()}`
        }
      }
      try {
        const workDir = moving ? await rt.cleanWorkDir(args.work_dir) : undefined
        // A Bot that joins a group with a folder works there from its first turn.
        const joining = add.bots.filter(bot => !room.members.includes(bot.id))
        if (moving && workDir !== room.workDir) {
          const members = [...room.members, ...joining.map(bot => bot.id)]
          await rt.approveFolder(exec, { path: workDir, sessions: members.map(id => room.sessions?.[id]).filter(Boolean), who: { en: `every member of "${room.name}"`, zh: `群聊「${room.name}」的成员` } })
        } else if (joining.length > 0) {
          const names = joining.map(bot => bot.name)
          await rt.approveFolder(exec, { path: room.workDir, sessions: joining.map(bot => room.sessions?.[bot.id]).filter(Boolean), who: { en: names.join(', '), zh: ` ${names.join('、')} ` } })
        }
        const { room: next, changes } = await rt.updateRoom(room.id, {
          name: args.name,
          notice: args.notice,
          mode: args.mode,
          admin,
          add: add.bots.map(bot => bot.id),
          remove: remove.bots.map(bot => bot.id),
          ...(moving ? { workDir: workDir ?? '' } : {}),
        }, self)
        return changes.length === 0 ? `Nothing changed in "${next.name}".` : `Updated "${next.name}": ${changes.join('; ')}.`
      } catch (failure) {
        return `Could not update "${room.name}": ${failure.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'delete_group',
    description: 'Main Bot only. Delete a group chat; its history is archived. Only when the user asks.',
    parameters: { group: GROUP_REF },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.isMain(self)) return 'Only a Main Bot can delete group chats.'
      const { room, error } = pickRoom(args.group, self)
      if (error) return error
      if (rt.roomBusy(room.id)) return `"${room.name}" is in the middle of a round. Delete it after the round ends.`
      await rt.deleteRoom(room.id)
      return `Deleted "${room.name}". Its history is archived.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'post_to_group',
    description: 'Post a message into a group chat as yourself. A Main Bot may post into any group, any other Bot into a group it is in. A Main Bot\'s or the group admin\'s post starts a round: members reply in the group, where the user reads them. Another member\'s post calls only the members it names with "@Name"; without one it is only written into the group.',
    parameters: {
      group: GROUP_REF,
      message: { type: 'string', required: true, description: 'What to say; write "@Name" to choose who answers, and a name without "@" to only mention a member' },
      report_back: { type: 'boolean', description: 'Also send the members\' replies back to you as a new message when the round ends' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const sender = rt.botOf(self)
      if (sender === undefined) return 'Only Bots on the team can use post_to_group.'
      const { room, error } = pickRoom(args.group, self)
      if (error) return error
      // An ordinary member's post calls only the members it names (openingSpeakers).
      const member = !rt.isMain(self) && !rt.isAdminOf(room, self)
      const info = rt.live.get(exec.agent?.id)?.info
      if (info?.role === 'room' && info.roomId === room.id) return `You are speaking in "${room.name}" right now. Write your message as your reply instead.`
      const text = absoluteLinks(String(args.message ?? '').trim(), rt.sessionFolder?.(exec.agent?.session ?? exec.agent))
      if (text === '') return 'Write a message to post.'
      const named = mentionSpans(text, room.members.map(rt.botOf).filter(Boolean)).flatMap(span => (span.bot && span.bot.id !== self ? [span.bot.id] : []))
      const reportBack = args.report_back === true
      if (member && reportBack && named.length === 0) {
        return 'Nobody would answer: your post only calls the members you name. Write "@Name" for each member who should answer, or post without report_back.'
      }
      const long = await rt.attachLong(text, `Post from ${sender.name}.txt`)
      if (long === undefined) return tooLong(text)
      // Replies the poster waits for, while it works on what a Bot asked it for, are
      // work handed on for that request (handoffs.js).
      const work = reportBack ? worksOf(exec).find(id => rt.ownsWork(self, id)) : undefined
      const sub = work === undefined ? undefined : randomUUID()
      if (sub !== undefined) rt.openWork(sub, { from: self, room: room.id, parent: work })
      try {
        await rt.postToRoom(room, sender, long.text, { ...(reportBack ? { reportBack: true } : {}), ...(member ? { member: true } : {}), ...(sub ? { sub } : {}), ...(long.length ? { length: long.length } : {}) }, long.files)
      } catch (failure) {
        if (sub !== undefined) rt.dropWork(sub)
        return `Could not post in "${room.name}": ${failure.message}`
      }
      if (member && named.length === 0) return `Posted in "${room.name}", where the user and its members read it. Nobody answers it: your post only calls the members you name with @Name.`
      if (named.length > 0) {
        const turn = turnOf(exec)
        const earlier = calledInPosts.get(exec.agent?.id)
        const calls = new Map(earlier !== undefined && earlier.turn === turn ? earlier.calls : [])
        for (const id of named) calls.set(id, room.name)
        calledInPosts.set(exec.agent?.id, { turn, calls })
      }
      const asker = sub === undefined ? undefined : rt.botOf(state.works[work]?.from)?.name
      const waits = asker ? ` End your turn when you have handed on everything: the replies bring you back to this work, and your answer goes to ${asker} once all of it is back.` : ''
      return `Posted in "${room.name}". Members reply there, where the user reads them${reportBack ? '; their replies also come back to you as a new message when the round ends' : ', and nothing comes back to you'}.${waits}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ask_user',
    description: 'Show the user a short multiple-choice question card in the chat (the user can also type their own answer). Calling it ends your turn; the chosen answer arrives later as the user\'s next message.',
    parameters: {
      question: { type: 'string', required: true, description: 'One short question' },
      options: {
        type: 'array',
        required: true,
        description: 'Two to four answers',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', required: true, description: 'Short answer shown on the option' },
            description: { type: 'string', description: 'Optional one-line explanation under the label' },
          },
        },
      },
      detail: { type: 'string', description: 'Optional one-line context shown under the question' },
      multiSelect: { type: 'boolean', description: 'Allow choosing several options' },
      allowCustom: { type: 'boolean', description: 'Also offer a field for an answer in the user\'s own words' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const id = exec.agent?.id
      if (rt.groupOwners.has(id)) return 'Question cards only work in your own chat. In a group, ask in your message instead.'
      if (!rt.chatOwners.has(id)) return `Only Bots on the team can use ask_user. Use ${BLOCKING_QUESTION_TOOL} if it is available in this session, or ask the user in your reply.`
      const options = (Array.isArray(args.options) ? args.options : [])
        .map(option => (typeof option === 'string' ? { label: option } : option ?? {}))
        .map(option => ({
          label: String(option.label ?? '').trim(),
          ...(option.description ? { description: String(option.description).trim() } : {}),
        }))
        .filter(option => option.label !== '')
        .slice(0, 6)
      if (options.length === 0) return 'Give at least one option.'
      // A hidden Bot-to-Bot turn shows none of its calls, so its card goes to the
      // composer dock, which takes questions without a call.
      const turn = rt.live.get(id)?.turn
      const hidden = turn !== undefined && (state.exchangeTurns[id] ?? []).includes(turn)
      state.questions[id] = {
        id: randomUUID(),
        ...(exec.callId && !hidden ? { callId: exec.callId } : {}),
        question: String(args.question ?? '').trim(),
        ...(args.detail ? { detail: String(args.detail).trim() } : {}),
        options,
        multiSelect: args.multiSelect === true,
        ...(args.allowCustom === true ? { allowCustom: true } : {}),
        askedAt: Date.now(),
      }
      await rt.save()
      exec.concludeTurn?.()
      return 'The card is on screen; the user\'s answer arrives as their next message.'
    },
  }))

  ctx.tools.register(defineTool({
    name: 'show_view',
    description: 'Draw a view in your own chat as part of your reply: a chart, key numbers, a table, a small calculator the user can try values in, or a choice, confirmation or short form. Text you write before and after the call shows around it. Use a view when it answers better than text: a chart to compare values or show a trend, inputs with formulas to let the user try numbers (worked out in the page, no new turn), options to let the user pick. Plain rows and columns read fine as a Markdown table, and one number needs no view. Give the answer first, then the view. Never invent data; mark sample numbers and assumptions as such. Do not repeat the same data as text, chart and table. Add only the controls the user needs. A view with options, confirm, form or submit ends your turn, and the answer arrives as the user\'s next message. Never collect a key, token or password. Keep the view under 8 KB.',
    parameters: {
      title: { type: 'string', description: 'Optional short heading shown above the view' },
      view: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description: 'One component { type, ...props }. Layout: stack (children, top to bottom) and row (children, side by side, wraps when narrow), 1 to 16 children; the outermost may define let: { name: "formula" }. Display: text ({ text: Markdown, tone?: "muted" }), metric ({ label, value, tone?: good|warn|bad, caption? }), table ({ columns: [{ key, label }], rows: [[cells]] }), chart ({ kind?: bar|hbar|line|area|donut, categories: [labels], series: [{ name?, values: [numbers] }], unit?, caption? }; donut takes one series), progress ({ label?, percent 0-100, or value with max, valueLabel?, tone? }), callout ({ text, tone?: info|good|warn|bad }), sources ({ items: [{ label, url }] }), html ({ html, summary, height? }: only for what nothing else can draw; it runs sandboxed with no network, cannot submit, and should use the CSS variables --bt-ink, --bt-ink-2, --bt-line, --bt-card, --bt-accent, --bt-green, --bt-star, --bt-danger). Inputs, which keep their value in the page: slider ({ id, label, min, max, step?, value, unit? }), number ({ id, label, value, min?, max?, step?, unit? }), choice ({ id, label, options: [{ label, value }], value? }), toggle ({ id, label, value? }); an input id is a plain name such as price. A metric value, caption or tone, a text, a progress field, a callout, a table cell or a chart value may be a formula { "=": "expression" } over input ids and let names: numbers, \'text\', + - * / %, < <= > >= == !=, && || !, a ? b : c, and min max abs floor ceil sqrt pow round clamp fixed(x, digits) format(x, digits) percent(x, digits). Answers, which end your turn: options ({ id, options: [{ label, description? }], multi? }), confirm ({ id, confirmLabel?, cancelLabel? }), form ({ id, fields: [{ id, label, placeholder? }], submitLabel? }), submit ({ id, label }: sends the inputs\' values to you).',
      },
      await_reply: { type: 'boolean', description: 'Wait for the user to submit the view. A view with options, confirm, form or submit always waits; a view without them cannot.' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const id = exec.agent?.id
      if (rt.groupOwners.has(id)) return 'View cards only work in your own chat. In a group, ask in your message instead.'
      if (!rt.chatOwners.has(id)) return `Only Bots on the team can use show_view. Use ${BLOCKING_QUESTION_TOOL} if it is available in this session, or ask the user in your reply.`
      const checked = checkShownView(args.title, args.view)
      if (checked.error !== undefined) return checked.error
      const title = checked.title
      const view = checked.view
      if (!checked.interactive && args.await_reply === true) return 'This view has nothing to submit; call show_view with await_reply: false.'
      if (checked.interactive && args.await_reply === false) return 'This view has controls to submit, so it waits for the user\'s answer; call show_view without await_reply: false.'
      const awaitReply = args.await_reply ?? checked.interactive
      if (!awaitReply) return 'The view is on screen.'
      // A hidden Bot-to-Bot turn shows none of its calls, so its card goes to the
      // composer dock, which takes a card without a call.
      const turn = rt.live.get(id)?.turn
      const hidden = turn !== undefined && (state.exchangeTurns[id] ?? []).includes(turn)
      state.views[id] = {
        id: randomUUID(),
        ...(exec.callId && !hidden ? { callId: exec.callId } : {}),
        title,
        view,
        askedAt: Date.now(),
      }
      await rt.save()
      exec.concludeTurn?.()
      return 'The view is on screen; the user\'s answer arrives as their next message.'
    },
  }))

  // dsh's own question tool holds the turn open until the user answers, and every
  // message from another Bot or a group round queues behind it. Bot Sessions ask
  // through ask_user instead, so the tool is taken out of their tool list, as are the
  // goal tools.
  const hiddenTools = new WeakSet()
  const hideBotUnusedTools = (agent) => {
    if (agent === undefined || hiddenTools.has(agent) || !rt.isBotSession(agent.session?.id)) return
    if (typeof agent.ctx?.tools?.restrict !== 'function') return
    try {
      // restrict() throws on a name this profile does not serve.
      const served = new Set(ctx.tools.schemas(agent).map(schema => schema.name))
      const deny = HIDDEN_TOOLS.filter(name => served.has(name))
      if (deny.length === 0) return
      agent.ctx.tools.restrict({ deny })
      hiddenTools.add(agent)
    } catch (error) {
      rt.warn('ds-bot: %s stay in the tool list of %s: %s', HIDDEN_TOOLS.join(', '), agent.session?.id, error)
    }
  }
  // A new Bot, part, or group Session gets its Agent before ds-bot records it, so the
  // list is only trimmed once ds-bot resolves that Agent again; meanwhile the guard
  // refuses the question tool in any Bot Session, and a goal made there is blocked.
  ctx.tools.guard(exec => (exec.name === BLOCKING_QUESTION_TOOL && rt.isBotSession(exec.agent?.id)
    ? `Bots cannot use ${BLOCKING_QUESTION_TOOL}. Ask with ask_user in your own chat, or ask in your reply.`
    : undefined))
  // Creation waits for this listener, so the Agent's first step already lacks the tool.
  ctx.on('agent/created', async ({ agent }) => {
    try {
      await rt.load()
      hideBotUnusedTools(agent)
    } catch (error) {
      rt.warn('ds-bot: hiding %s on agent/created failed: %s', HIDDEN_TOOLS.join(', '), error)
    }
  })

  // The /goal command stays open in every Session, so a goal started in a Bot chat or a
  // group is blocked at once; DSH's round driver then starts no round for it.
  let goals = null
  const attachGoals = (sub) => {
    const own = sub.goals
    goals = own
    sub.effect(() => () => { if (goals === own) goals = null }, 'ds-bot: goal service')
  }
  if (typeof ctx.inject === 'function') ctx.inject(['goals'], attachGoals)
  else if (ctx.get?.('goals') !== undefined) attachGoals({ goals: ctx.get('goals'), effect: (execute, label) => ctx.effect(execute, label) })
  const blockGoal = async (sessionId) => {
    const service = goals
    if (service === null) return
    try {
      const agent = await rt.resolveAgent(sessionId)
      const goal = service.get(agent)
      if (goal?.phase !== 'active') return
      service.block(agent, { id: goal.id, revision: goal.revision }, { code: 'not-supported', message: GOAL_REFUSAL })
    } catch (error) {
      rt.warn('ds-bot: blocking the goal in %s failed: %s', sessionId, error)
    }
  }
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'goal/change' || event.data?.goal?.phase !== 'active') return
    const id = session?.id
    if (!rt.isBotSession(id) && rt.roomOf(id) === undefined) return
    // block() appends to the same log, so it waits until every listener has seen this change.
    setTimeout(() => void blockGoal(id), 0)
  })

  ctx.tools.register(defineTool({
    name: 'list_capabilities',
    description: 'List shared MCP servers, skills, and packs, plus the capabilities attached to you.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      const bot = rt.botOf(self)
      if (!bot) return 'Only Bots on the team can use list_capabilities.'
      const items = Object.values(state.capabilities?.items ?? {})
      if (items.length === 0) return 'No shared capabilities are saved yet.'
      const statuses = rt.capabilityStatusesView()[bot.id] ?? {}
      const lines = items.map(item => {
        const extra = item.kind === 'pack' ? `; includes ${(item.items ?? []).join(', ') || 'nothing'}`
          : item.kind === 'mcp' && item.transport === 'stdio' ? `; ${item.approved ? 'allowed' : 'needs user approval'}` : ''
        const itemStatus = statuses[item.name]
        const state = itemStatus ? ` (${itemStatus.state}${itemStatus.error ? `: ${itemStatus.error}` : ''})` : ''
        const status = bot.capabilities?.includes(item.name) ? `; attached to you${state}` : ''
        return `- ${item.name} (${item.kind})${item.description ? ` — ${item.description}` : ''}${extra}${status}`
      })
      return ['Shared capabilities:', ...lines].join('\n')
    },
  }))
  ctx.tools.register(defineTool({
    name: 'save_capability',
    description: 'Create or update a shared MCP server, skill, or pack. Changes apply from your next message.',
    parameters: {
      name: { type: 'string', required: true, description: 'Lowercase letters, digits, and single hyphens, up to 32 characters; "github" is reserved' },
      kind: { type: 'string', required: true, enum: ['mcp', 'skill', 'pack'] },
      description: { type: 'string', description: 'What this capability provides' },
      transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: 'How to reach an MCP server: a local command or an HTTP URL' },
      command: { type: 'string', description: 'Program that starts a local MCP server' },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments for command' },
      env: { type: 'object', additionalProperties: true, description: 'Environment variables for command; write $DSH_SECRET_<NAME> to insert a saved secret instead of the value' },
      url: { type: 'string', description: 'MCP server URL; write $DSH_SECRET_<NAME> in the path or query to insert a saved secret, URL-encoded. Prefer headers for keys' },
      headers: { type: 'object', additionalProperties: true, description: 'HTTP headers; write $DSH_SECRET_<NAME> to insert a saved secret instead of the value' },
      content: { type: 'string', description: 'Skill instructions' },
      items: { type: 'array', items: { type: 'string' }, description: 'MCP server and skill names in the pack' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.botOf(self)) return 'Only Bots on the team can use save_capability.'
      try {
        const item = await rt.capabilitySave(args, { botId: self })
        const approval = item.kind === 'mcp' && item.transport === 'stdio' && !item.approved
          ? ' The user must allow this MCP server in DS Bot settings before it can work.'
          : ''
        return `Saved ${item.name}. Bots with it attached use the change from their next message.${approval}`
      } catch (error) { return error.message }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'delete_capability',
    description: 'Remove a shared capability and detach it from every Bot and pack.',
    parameters: { name: { type: 'string', required: true } },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.botOf(self)) return 'Only Bots on the team can use delete_capability.'
      try {
        await rt.capabilityDelete(args.name, { botId: self })
        return `Deleted ${args.name}; it was removed from every Bot and pack. The change applies from their next message.`
      } catch (error) { return error.message }
    },
  }))
  for (const [name, endpoint, verb] of [['attach_capability', 'attach', 'Attached'], ['detach_capability', 'detach', 'Detached']]) {
    ctx.tools.register(defineTool({
      name,
      description: `${verb} a shared capability to yourself, or to another Bot if you are a Main Bot.`,
      parameters: {
        name: { type: 'string', required: true, description: 'Capability name from list_capabilities' },
        bot: { type: 'string', description: 'Optional Bot name; only a Main Bot may change another Bot' },
      },
      output,
      async execute(args, exec) {
        await rt.load()
        const self = rt.selfOf(exec.agent?.id)
        if (!rt.botOf(self)) return `Only Bots on the team can use ${name}.`
        try {
          const result = await rt.changeCapabilityAttachment(endpoint, args, self)
          const attached = rt.own(state.capabilities.items, args.name)
          const members = attached?.kind === 'pack'
            ? (attached.items ?? []).map(child => rt.own(state.capabilities.items, child)).filter(Boolean)
            : attached ? [attached] : []
          const approvals = members
            .filter(item => item.kind === 'mcp' && item.transport === 'stdio' && item.approved !== true)
            .map(item => ` The user must allow ${item.name} in DS Bot settings before it can work.`)
            .join('')
          return `${verb} ${args.name} ${args.bot ? `to ${result.bot}` : 'to yourself'}. Changes apply from ${result.bot}'s next message.${endpoint === 'attach' ? approvals : ''}`
        } catch (error) { return error.message }
      },
    }))
  }

  Object.assign(rt, { pickRoom, hideBotUnusedTools })
}
