// Turns: what each Bot Session is doing now (for its mascot), which turns another Bot
// triggered, the waiters and inboxes of group rounds, and routing a finished turn's reply.
//
// Turn tracking: which turns were triggered by another Bot, and what they said.
import { HANDOFF_ACK, MESSAGE_INLINE_MAX, REFERENCE_KIND, REPLY_KIND, SOURCE_KIND } from './constants.js'
import { absoluteLinks } from './links.js'
import { textOf } from './text.js'
import { reminderText } from './schedules.js'

// A failed turn's `LlmFailure`, kept to what can be shown and logged. Like DSH's own
// error row, an AUTH failure loses its message: providers may echo part of the key.
export function turnFailure(error) {
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'UNKNOWN'
  const message = code === 'AUTH' || typeof error?.message !== 'string' ? '' : error.message.trim().slice(0, 500)
  return {
    code,
    message,
    ...(typeof error?.status === 'number' ? { status: error.status } : {}),
    ...(typeof error?.requestId === 'string' ? { requestId: error.requestId } : {}),
  }
}

export const failureLine = failure => `${failure.code}${failure.status ? ` ${failure.status}` : ''}${failure.message ? `: ${failure.message.slice(0, 200)}` : ''}`

// The reply a sender waits for, sent the way a finished turn sends it: the work it was
// for closes, and the answer goes up to the Bot that asked. `id` is the Session the
// answer comes from; `source` is the trigger the turn answered.
export function answerSender(rt, id, source, text, long) {
  const back = rt.roomOf(source.senderRoomId)?.sessions?.[source.senderSessionId]
  const work = rt.closeWork?.(source.exchangeId, rt.botOf(rt.selfOf(id))?.name ?? 'The other Bot', text)
  void rt.deliver({
    fromId: rt.selfOf(id),
    toId: source.senderSessionId,
    ...(back ? { sessionId: back } : {}),
    text: long?.text ?? text,
    ...(long?.length === undefined ? {} : { files: long.files, length: long.length }),
    role: 'reply',
    replyTo: source.exchangeId,
    ...(work ? { work } : {}),
  }).catch(error => rt.warn('ds-bot: reply delivery failed: %s', error))
}

// A group's own Session never reaches a model, so the snapshot DSH prepared there
// rides with the user's queued message to the members who answer it.
export function attachReference(queued, source, text) {
  const post = queued?.findLast(item => item.botId === undefined && item.kickoff !== true)
  if (post === undefined || text === '') return
  const labels = (Array.isArray(source?.references) ? source.references : [])
    .map(reference => reference?.label).filter(label => typeof label === 'string' && label !== '')
  post.references = [...(post.references ?? []), { labels, text }]
}

// A tool call some models write into their text instead of making it (the XML-like
// form of their own chat template).
const WRITTEN_CALL = /<tool_call>\s*<function=|<function=[\w.-]+>\s*<parameter=/
export const writesToolCall = text => typeof text === 'string' && WRITTEN_CALL.test(text)
export const stripWrittenCalls = text => text
  .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, '')
  .replace(/<function=[\w.-]+>[\s\S]*?(?:<\/function>|$)/g, '')
  .trim()

// Under DSH's PTC presentation the model calls only this tool; the program's sub-calls
// are the tools it really runs.
const PROGRAM_TOOL = 'run_code'

const RETRY_TEXT = 'Your last reply wrote a tool call as plain text (<tool_call>…), so it did not run and nothing happened. Call the tool through the tool interface now, then reply as you meant to.'

export function install(rt) {
  const { ctx, state } = rt

  // The retry goes where the turn's trigger came from: a group round's waiter or a
  // Bot's request keeps its exchange; anything else is a nudge in the Bot's own chat.
  const retryWrittenCall = (id, info) => {
    const keeps = info !== undefined && (info.role === 'room' || expectsReply(info))
    return rt.deliver({
      ...(keeps && info.senderSessionId ? { fromId: info.senderSessionId } : {}),
      toId: rt.selfOf(id),
      sessionId: id,
      role: keeps ? info.role : 'retry',
      ...(keeps && info.roomId ? { roomId: info.roomId } : {}),
      ...(keeps && info.exchangeId ? { exchangeId: info.exchangeId } : {}),
      ...(info?.work ? { work: info.work } : {}),
      ...(keeps && info.audience ? { audience: info.audience } : {}),
      ...(keeps && info.askedBy ? { askedBy: info.askedBy } : {}),
      ...(keeps && info.senderRoomId ? { fromRoomId: info.senderRoomId } : {}),
      note: 'your tool call did not run',
      retried: true,
      text: RETRY_TEXT,
    })
  }

  /** @type {Map<string, {turn?:number, pending?:any, info?:any, texts:string[], opened?:boolean, joined?:{info:any, from:number}[]}>} */
  const live = new Map()
  /** @type {Map<string, {sessionId:string, resolve:(text:string|null)=>void, fail:(failure:any)=>void, touch:()=>void, approval:()=>void}>} member turn waiters keyed by exchange id */
  const roomWaiters = new Map()
  /** @type {Map<string, {roomId:string, replies:any[], members:string[], speaking:string|null}>} */
  const roomProgress = new Map()
  /** @type {Map<string, {text:string, botId?:string, name?:string, reportBack?:boolean, kickoff?:boolean, references?:{labels:string[], text:string}[]}[]>} messages a room's next relay posts */
  const roomInbox = new Map()
  const queueRoomMessage = (roomId, item) => roomInbox.set(roomId, [...(roomInbox.get(roomId) ?? []), item])
  // Member turns of a group round the user stopped: what they end with stays out of the group.
  const stoppedRoomTurns = new Set()

  // A stopped round stops the member work it started: the turn that answers it, or the
  // delivery still waiting for the member's Session. An earlier turn there keeps going.
  // An exchange whose turn already ended stays in the set, so it is bounded.
  const STOPPED_KEPT = 200
  async function stopRoomTurn(sessionId, exchangeId) {
    stoppedRoomTurns.add(exchangeId)
    if (stoppedRoomTurns.size > STOPPED_KEPT) stoppedRoomTurns.delete(stoppedRoomTurns.values().next().value)
    const agent = await rt.resolveAgent(sessionId).catch(() => undefined)
    if (agent === undefined) return
    const entry = live.get(sessionId)
    if (entry?.turn !== undefined && entry.info?.exchangeId === exchangeId) {
      agent.cancel({ kind: 'hook', reason: 'ds-bot/stopped' })
      return
    }
    for (const message of [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])]) {
      if (message.source?.exchangeId === exchangeId && agent.inbox.remove(message.id)) stoppedRoomTurns.delete(exchangeId)
    }
  }

  const liveOf = id => {
    let entry = live.get(id)
    if (entry === undefined) live.set(id, entry = { texts: [], shown: 0 })
    return entry
  }

  // What each running Bot is doing right now, for its mascot. Process-local: it is
  // rebuilt from live events and never saved.
  /** @type {Record<string, string>} */
  let activity = {}
  const activityOf = (tool) => {
    if (/^(message_bot|stop_bot|create_bot|update_bot|create_group|update_group|delete_group|post_to_group)$/.test(tool)) return 'sending'
    if (tool === 'group_relay') return 'orbit'
    if (/search|fetch|browse|browser|read|grep|glob|list/i.test(tool)) return 'searching'
    return 'working'
  }
  const setActivity = (id, value) => {
    if (activity[id] === value) return
    const next = { ...activity }
    if (value === undefined) delete next[id]
    else next[id] = value
    activity = next
  }
  // The newest call still running, a program's sub-calls included, is what the Session
  // is doing.
  const showCall = (id, entry) => {
    const name = [...(entry.calls?.values() ?? [])].at(-1)?.name
    entry.tool = name
    if (name !== undefined) setActivity(id, name === 'ask_user' || name === 'show_view' ? undefined : activityOf(name))
    else if (entry.turn !== undefined) setActivity(id, 'thinking')
  }
  const startCall = (id, entry, callId, name, args) => {
    if (typeof callId === 'string') (entry.calls ??= new Map()).set(callId, { name, args })
    showCall(id, entry)
  }
  const endCall = (id, entry, callId) => {
    entry.calls?.delete(callId)
    showCall(id, entry)
  }

  const markExchangeTurn = (sessionId, turn) => {
    const turns = state.exchangeTurns[sessionId] ??= []
    if (!turns.includes(turn)) {
      turns.push(turn)
      if (turns.length > 400) turns.splice(0, turns.length - 400)
      void rt.save().catch(() => {})
    }
  }
  const unmarkExchangeTurn = (sessionId, turn) => {
    const turns = state.exchangeTurns[sessionId] ?? []
    if (!turns.includes(turn)) return
    state.exchangeTurns[sessionId] = turns.filter(other => other !== turn)
    void rt.save().catch(() => {})
  }

  // A request whose audience is the user is answered in the recipient's own chat: that
  // turn stays visible there and its reply is not routed back to the sender.
  const answersUser = info => info.role === 'request' && info.audience === 'user'
  // Roles whose turn owes the sender a reply: a 'stopped' notice asks the Bot to
  // acknowledge, exactly like a request.
  const expectsReply = info => info.role === 'request' || info.role === 'stopped'
  // A group Session speaks only in its group, so what its turns write goes there, also
  // for turns that a finished background job or a fresh part starts; a Bot's private
  // message to it is answered privately.
  const speaksInGroup = (id, info) => rt.groupOwners.has(id) && !(info !== undefined && expectsReply(info))

  // The group hears what the member says while it works. A text with a tool call goes
  // on at once; one without may be the turn's last, so it waits for the next text or the
  // turn's end, which shows the rest as the turn's reply.
  const showSteps = (id, entry, upTo) => {
    const info = entry.info
    if (!speaksInGroup(id, info) || (info?.role === 'room' && stoppedRoomTurns.has(info.exchangeId))) return
    for (; entry.shown < upTo; entry.shown += 1) {
      const text = stripWrittenCalls(entry.texts[entry.shown])
      if (text !== '') void rt.roomStepText?.(id, info, text, entry.shown === 0)?.catch(error => rt.warn('ds-bot: step text from %s not posted: %s', id, error))
    }
  }

  // The reply a sender waits for, also when it wrote from a group, where it gets the
  // reply in its Session there while it is still a member. A sender that asked for it
  // while working on another Bot's request goes on with that work when it reads it.
  // `long`: the text as attachLong sends it, when it went as a file.
  const tellSender = (id, source, text, long) => answerSender(rt, id, source, text, long)

  // Runs before a deleted Bot leaves the team. Its Sessions stop with it, and the
  // turn/end that follows is no longer the team's, so their activity and turn records go
  // now. Every Bot still waiting for its reply hears that it was deleted: the turn's
  // trigger, requests that joined the turn, and requests it has not read yet.
  async function releaseBot(botId, sessionIds) {
    const text = `${rt.botOf(botId)?.name ?? 'The other Bot'} was deleted before it could answer your message.`
    const waiting = new Map()
    for (const id of sessionIds) {
      const entry = live.get(id)
      const held = [entry?.info, entry?.pending, ...(entry?.joined ?? []).map(joined => joined.info)]
      if (entry?.turn !== undefined) {
        const agent = await rt.resolveAgent(id).catch(() => undefined)
        held.push(...[...(agent?.inbox?.nextStep ?? []), ...(agent?.inbox?.nextTurn ?? [])].map(message => message.source))
      }
      for (const source of held) {
        if (source?.kind === SOURCE_KIND && expectsReply(source) && !answersUser(source)) waiting.set(source.exchangeId, [id, source])
      }
      live.delete(id)
      setActivity(id, undefined)
    }
    // Work it was asked for and still waits on, outside any running turn.
    for (const source of rt.forgetBotWork?.(botId) ?? []) {
      if (!waiting.has(source.exchangeId)) waiting.set(source.exchangeId, [rt.chatOf(botId), source])
    }
    for (const [id, source] of waiting.values()) tellSender(id, source, text)
  }

  // A group Session is hidden as a whole, so its turns need no marking. A handoff
  // package that only opens a part is acknowledged with a fixed line, also hidden.
  const claimTrigger = (sessionId, entry, info) => {
    entry.info = info
    // A turn that was stopped for a part switch brings its joined requests along.
    if (Array.isArray(info.joined) && info.joined.length > 0) {
      entry.joined = info.joined.filter(item => item?.info !== undefined && item.info !== null)
    }
    if (rt.groupOwners.has(sessionId)) return
    if ((expectsReply(info) && !answersUser(info)) || info.role === 'room' || (info.role === 'handoff' && info.resume !== true)) {
      markExchangeTurn(sessionId, entry.turn)
    }
  }

  // Activity is tracked per Session; a Bot's mascot shows its own chat's, else a group's.
  const activityView = () => {
    const merged = {}
    for (const [id, value] of Object.entries(activity)) {
      if (!rt.groupOwners.has(id)) merged[rt.chatOwners.get(id) ?? id] = value
    }
    for (const [id, value] of Object.entries(activity)) {
      const owner = rt.groupOwners.get(id)
      if (owner !== undefined) merged[owner.botId] ??= value
    }
    // A Bot writing its handoff note is thinking.
    for (const job of rt.switchJobs()) {
      if (job.roomId === undefined) merged[job.botId] = 'thinking'
      else merged[job.botId] ??= 'thinking'
    }
    for (const approval of rt.approvalsView?.() ?? []) merged[approval.botId] = 'alert'
    // Waiting for work it handed on shows only while no turn of the Bot runs.
    for (const botId of Object.keys(rt.waitingView?.() ?? {})) merged[botId] ??= 'waiting'
    return merged
  }

  // What the newest running call does, in its own words: what the Bot said in the step
  // that made it, the call's description, or the file, search or site it works on.
  const doingOf = (entry) => {
    const call = [...(entry.calls?.values() ?? [])].at(-1)
    if (call === undefined) return {}
    const said = entry.step?.replace(/\s+/g, ' ').trim().slice(0, 160)
    let args
    try { args = JSON.parse(call.args || '{}') } catch { args = {} }
    const first = keys => keys.map(key => args?.[key]).find(value => typeof value === 'string' && value.trim() !== '')?.replace(/\s+/g, ' ').trim()
    const note = first(['description', 'justification'])
    const path = first(['file_path', 'path'])
    const url = first(['url'])
    let site
    try { site = url && new URL(url).host } catch { site = undefined }
    const target = path?.split(/[\\/]/).filter(Boolean).at(-1) ?? first(['query', 'pattern']) ?? site
    return { tool: call.name, ...(said ? { said } : {}), ...(note ? { note: note.slice(0, 120) } : {}), ...(target ? { target: target.slice(0, 80) } : {}) }
  }

  // Per Bot, the turn it is running and what it is doing; its own chat wins over a
  // group. A Bot writing its handoff note shows that.
  const workView = () => {
    const bots = {}
    for (const [id, entry] of live) {
      if (entry.turn === undefined) continue
      const owner = rt.groupOwners.get(id)
      const botId = owner?.botId ?? rt.chatOwners.get(id)
      if (botId === undefined || (owner !== undefined && bots[botId] !== undefined)) continue
      bots[botId] = { since: entry.since, ...doingOf(entry), ...(owner ? { roomId: owner.roomId } : {}) }
    }
    for (const job of rt.switchJobs()) {
      // `folder` marks the switch the chat must name: the working folder changed.
      const work = { since: job.since, switching: true, ...(job.folder === true ? { folder: true } : {}), ...(job.roomId ? { roomId: job.roomId } : {}) }
      if (job.roomId === undefined) bots[job.botId] = work
      else bots[job.botId] ??= work
    }
    return bots
  }

  // Per Session, when its running turn began.
  const turnsView = () => Object.fromEntries([...live]
    .filter(([, entry]) => entry.turn !== undefined && entry.since !== undefined)
    .map(([id, entry]) => [id, entry.since]))

  // Per group, the members whose turn there is running or who move on to a fresh part;
  // the round's current speaker is marked, since its round shows it.
  const roomWorkView = () => {
    const speaking = new Set([...roomProgress.values()].map(round => `${round.roomId}:${round.speaking}`))
    const rooms = {}
    const add = (roomId, botId, work) => {
      if (rooms[roomId]?.some(item => item.botId === botId)) return
      rooms[roomId] = [...(rooms[roomId] ?? []), { botId, ...work, ...(speaking.has(`${roomId}:${botId}`) ? { speaking: true } : {}) }]
    }
    for (const [id, entry] of live) {
      const owner = rt.groupOwners.get(id)
      if (entry.turn !== undefined && owner !== undefined) add(owner.roomId, owner.botId, { since: entry.since, ...doingOf(entry) })
    }
    for (const job of rt.switchJobs()) {
      if (job.roomId !== undefined) add(job.roomId, job.botId, { since: job.since, switching: true, ...(job.folder === true ? { folder: true } : {}) })
    }
    return rooms
  }

  // What a running tool call is about, for an approval card: its own description and
  // the command, path or address it acts on.
  const callDetail = (sessionId, callId) => {
    let args
    try { args = JSON.parse(live.get(sessionId)?.calls?.get(callId)?.args ?? '{}') } catch { args = {} }
    const first = keys => keys.map(key => args?.[key]).find(value => typeof value === 'string' && value.trim() !== '')
    const text = first(['description', 'justification'])
    const code = first(['command', 'cmd', 'file_path', 'path', 'url', 'query'])
    return { ...(text ? { text: text.trim().slice(0, 300) } : {}), ...(code ? { code: code.trim().slice(0, 400) } : {}) }
  }

  // Where a Session speaks, for the diagnostics log.
  const placeOf = (id) => {
    const room = rt.roomOf(rt.groupOwners.get(id)?.roomId) ?? rt.roomOf(id)
    return room ? `group "${room.name}"` : 'own chat'
  }
  const noteTurnFailure = (id, failure) => {
    rt.noteFailure({
      source: 'turn',
      text: failure.message || 'the model call failed',
      code: failure.code,
      status: failure.status,
      requestId: failure.requestId,
      bot: rt.botOf(rt.selfOf(id))?.name ?? (rt.roomOf(id) ? undefined : 'unknown Bot'),
      where: placeOf(id),
      sessionId: id,
    })
  }

  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    if (!rt.isBotSession(id) && !rt.roomOf(id)) {
      // A deleted Bot's Session can still be ending its turn; nothing of it stays.
      if (live.delete(id)) setActivity(id, undefined)
      return
    }
    const entry = liveOf(id)
    if (rt.groupOwners.has(id)) rt.touchRoomTurn?.(id)
    switch (event.type) {
      case 'tool/call': {
        const name = String(event.data?.name ?? '')
        startCall(id, entry, event.data?.callId, name, String(event.data?.arguments ?? ''))
        // A program is as quick as the tools it runs, so its sub-calls decide.
        if (rt.groupOwners.has(id) && name !== PROGRAM_TOOL) rt.workRoomTurn?.(id, name)
        break
      }
      case 'tool/ptc-dispatch-start': {
        const name = String(event.data?.name ?? '')
        startCall(id, entry, event.data?.subCallId, name, JSON.stringify(event.data?.arguments ?? {}))
        if (rt.groupOwners.has(id)) rt.workRoomTurn?.(id, name)
        break
      }
      case 'tool/ptc-dispatch':
        endCall(id, entry, event.data?.subCallId)
        break
      case 'tool/result':
        endCall(id, entry, event.data?.callId)
        break
      case 'turn/start':
        setActivity(id, 'thinking')
        entry.turn = event.data.turn
        entry.since = event.time ?? Date.now()
        entry.texts = []
        entry.shown = 0
        entry.step = undefined
        entry.info = undefined
        // A turn turned away before its first step may end without a turn/end.
        entry.switched = false
        entry.answers = false
        entry.opened = false
        entry.joined = []
        entry.later = []
        if (entry.pending !== undefined) {
          claimTrigger(id, entry, entry.pending)
          entry.pending = undefined
        }
        break
      case 'user/message': {
        const source = event.data?.source
        // A result that came back counts as taken once a turn reads it.
        if (source?.kind === SOURCE_KIND && source.work !== undefined && source.replyTo !== undefined) rt.takenWork?.(source.work, source.replyTo)
        // A message that shares a step with a bare handoff package is what the turn
        // answers, so the turn is not a hidden acknowledgement.
        const bare = info => info?.handoff === true && info.resume !== true
        // Whether the turn was already opened by an earlier message decides what a
        // Bot relay that lands inside it may claim: the first message of a turn
        // still claims it as today, a later one only joins it.
        const opened = entry.opened === true
        if (entry.turn !== undefined && !bare(source)
          && (source?.kind === 'user' || source?.kind === REPLY_KIND || source?.kind === 'schedule' || source?.kind === SOURCE_KIND)) {
          entry.opened = true
        }
        if (entry.turn !== undefined && (source?.kind === 'user' || source?.kind === REPLY_KIND || source?.kind === SOURCE_KIND)) {
          if (bare(source)) {
            if (entry.answers) break
          } else {
            entry.answers = true
            if (bare(entry.info)) {
              unmarkExchangeTurn(id, entry.turn)
              entry.info = undefined
            }
          }
        }
        if (source?.kind === SOURCE_KIND && source.role === 'post' && rt.roomOf(id)) {
          // A long post comes as a file (attachLong), which stays with its line.
          const files = (Array.isArray(event.data.content) ? event.data.content : []).filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment)
          queueRoomMessage(id, {
            text: textOf(event.data.content).replace(/^\[Group post from (?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, ''),
            ...(files.length > 0 ? { files } : {}),
            botId: source.senderSessionId,
            name: source.senderName,
            reportBack: source.reportBack === true,
            ...(source.member ? { member: true } : {}),
            ...(source.sub ? { sub: source.sub } : {}),
            ...(source.late ? { late: true } : {}),
            ...(source.progress ? { progress: true } : {}),
            ...(source.quiet ? { quiet: true } : {}),
            ...(source.failed ? { failed: source.failed } : {}),
            ...(source.resumed ? { resumed: true } : {}),
            ...(source.again ? { again: true } : {}),
            ...(source.stopped ? { stopped: true } : {}),
            ...(source.done ? { done: true } : {}),
            ...(source.askedBy ? { askedBy: source.askedBy } : {}),
            // A post written into a running round already carries its log seq, or true
            // when its event needed none; the relay must not write it again.
            ...(source.logged !== undefined ? { logged: source.logged } : {}),
          })
        } else if (source?.kind === SOURCE_KIND && source.role === 'kickoff' && rt.roomOf(id)) {
          queueRoomMessage(id, { text: '', kickoff: true })
        } else if (source?.kind === SOURCE_KIND && source.role === 'resume' && rt.roomOf(id)) {
          queueRoomMessage(id, { text: '', resume: true })
        } else if (source?.kind === SOURCE_KIND) {
          if (entry.turn === undefined) entry.pending = source
          else if (!opened) claimTrigger(id, entry, source)
          else if (source.work !== undefined && source.work !== rt.workOf?.(entry.info) && !expectsReply(source)) {
            // A result for other work than this turn's informs it, and comes back in a
            // turn of its own once this one ends, which goes on with that work.
            entry.later = [...(entry.later ?? []), { info: source, text: textOf(event.data.content).replace(/^\[(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, '') }]
          } else if (expectsReply(source) && !answersUser(source)
            && source.exchangeId !== entry.info?.exchangeId
            && !(entry.joined ?? []).some(joined => joined.info.exchangeId === source.exchangeId)) {
            // A request that lands inside a running turn steers that work but is
            // answered in a hidden turn of its own once the work is done, so the
            // sender never gets the turn's text. A failed-switch resume message
            // re-sends the trigger's own source; the same exchangeId must not join twice.
            const text = textOf(event.data.content).replace(/^\[(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/, '')
            entry.joined = [...(entry.joined ?? []), { info: source, text }]
          }
          // A mid-turn relay that owes no reply only informs the turn: it neither
          // claims the running turn nor queues as the next one's trigger.
        } else if (source?.kind === 'schedule' && rt.roomOf(id)) {
          // A group's scheduled task reaches the group as the user's message.
          queueRoomMessage(id, { text: reminderText(textOf(event.data.content)) })
        } else if (source?.kind === REFERENCE_KIND && rt.roomOf(id)) {
          attachReference(roomInbox.get(id), source, textOf(event.data.content))
        } else if (source?.kind === 'user' || source?.kind === REPLY_KIND) {
          if (rt.roomOf(id) && source.kind === 'user') {
            const content = Array.isArray(event.data.content) ? event.data.content : []
            const images = content.filter(block => block?.type === 'image' && !block.offloaded).map(block => block.attachment)
            const files = content.filter(block => block?.type === 'file' && block.attachment !== undefined).map(block => block.attachment)
            queueRoomMessage(id, { text: textOf(event.data.content), ...(images.length > 0 ? { images } : {}), ...(files.length > 0 ? { files } : {}) })
          }
          const own = rt.chatOwners.get(id)
          if (own !== undefined) rt.dropKickoff(own)
          // Any user message answers or supersedes the open question card and view card.
          let dropped = false
          if (state.questions[id] !== undefined) {
            delete state.questions[id]
            dropped = true
          }
          if (state.views?.[id] !== undefined) {
            delete state.views[id]
            dropped = true
          }
          if (dropped) void rt.save().catch(() => {})
        }
        break
      }
      case 'assistant/message': {
        const content = event.data?.message?.content
        const text = textOf(content)
        const called = Array.isArray(content) && content.some(block => block?.type === 'tool-call')
        if (text !== '' && text !== HANDOFF_ACK) {
          // What a turn says goes on to the group or the sender, read from other folders.
          entry.texts.push(absoluteLinks(text, rt.sessionFolder?.(session)))
          if (entry.turn !== undefined) showSteps(id, entry, called ? entry.texts.length : entry.texts.length - 1)
        }
        entry.lastText = text
        entry.lastCalled = called
        entry.step = called && text !== HANDOFF_ACK ? stripWrittenCalls(text) || undefined : undefined
        break
      }
      case 'turn/end': {
        setActivity(id, undefined)
        const info = entry.info
        const joined = entry.joined ?? []
        // What the group already saw of the turn is not posted again.
        const texts = entry.texts.slice(entry.shown)
        const shown = entry.shown > 0
        const { lastText, lastCalled } = entry
        // A turn stopped for a switch goes on in the next part, which answers instead.
        const switched = entry.switched === true
        entry.turn = undefined
        entry.info = undefined
        entry.texts = []
        entry.shown = 0
        entry.step = undefined
        entry.switched = false
        entry.joined = []
        entry.since = undefined
        entry.tool = undefined
        entry.calls = undefined
        entry.lastText = undefined
        entry.lastCalled = undefined
        const later = entry.later ?? []
        entry.later = []
        for (const result of later) {
          void rt.deliver({
            fromId: result.info.senderSessionId,
            toId: rt.selfOf(id),
            text: result.text,
            role: result.info.role,
            exchangeId: result.info.exchangeId,
            replyTo: result.info.replyTo,
            work: result.info.work,
            ...(result.info.roomId ? { roomId: result.info.roomId } : {}),
            deferred: true,
          }).catch(error => rt.warn('ds-bot: handing back a result failed: %s', error))
        }
        const reason = event.data?.reason
        const failure = reason?.kind === 'error' && !switched ? turnFailure(reason.error) : undefined
        if (failure !== undefined) noteTurnFailure(id, failure)
        const held = rt.groupOwners.has(id) ? rt.takeRoomSteps?.(id) ?? '' : ''
        if (switched) break
        // A model that writes its tool call as text ends the turn as if it were done,
        // though nothing ran. It gets one more turn on the same trigger, so a waiting
        // round or sender gets the real answer; a second time, the text goes on without
        // the call.
        const wroteCall = failure === undefined && reason?.kind === 'completed' && lastCalled !== true && writesToolCall(lastText)
        const retry = wroteCall && info?.retried !== true && !(info?.role === 'room' && stoppedRoomTurns.has(info.exchangeId))
        if (retry) void retryWrittenCall(id, info).catch(error => rt.warn('ds-bot: asking %s to run its written tool call failed: %s', id, error))
        const replyText = () => {
          const reply = (wroteCall ? texts.map(stripWrittenCalls) : texts).join('\n\n').trim()
          return wroteCall && reply === '' ? 'Tried to run a tool but wrote the call as text, so it did not run.' : reply
        }
        const groupReply = () => rt.withRoomSteps?.(held, replyText()) ?? replyText()
        // Whoever the turn answers gets the same three-way rule: a failure notice,
        // the turn's text (or a stopped-before-answer line), or nothing.
        const name = rt.botOf(rt.selfOf(id))?.name ?? 'The other Bot'
        const answer = (source, reply) => {
          if (!expectsReply(source) || answersUser(source)) return
          if (failure !== undefined) {
            // The sender was told a reply comes later; without this it would wait forever.
            tellSender(id, source, `${name} could not answer your message: its model call failed (${failureLine(failure)}). Tell the user if it matters; do not retry right away.`)
          } else if (reply !== '' || reason?.kind === 'aborted') {
            // A turn stopped before it could answer still owes the sender a line,
            // or it would wait forever for a reply that never comes.
            tellSender(id, source, reply !== '' ? reply : `${name} was stopped before it could answer your message.`)
          }
        }
        // Work a Bot asked for, also when what came back for it opens the turn: while
        // anything handed on for it is still out, the answer waits; then it goes up with
        // what came back. A failed or stopped turn answers at once.
        const finish = (source, reply) => {
          const work = rt.workOf?.(source)
          if (!rt.ownsWork?.(rt.selfOf(id), work)) return answer(source, reply)
          const asker = rt.workAsker(work)
          if (failure !== undefined || reason?.kind === 'aborted') return answer(asker, reply)
          if (rt.waitsWork(work)) return rt.holdWork(work, reply)
          // With what came back, the answer may pass what one message carries.
          const text = rt.answerText(work, reply, name)
          if (text.length <= MESSAGE_INLINE_MAX) return tellSender(id, asker, text)
          void rt.attachLong(text, `Answer from ${name}.txt`)
            .then(long => tellSender(id, asker, text, long))
            .catch(error => rt.warn('ds-bot: answer from %s not sent: %s', name, error))
        }
        // A retried turn answers the same waiter or sender, so this one passes nothing on.
        if (!retry && info?.role === 'room') {
          const waiter = roomWaiters.get(info.exchangeId)
          roomWaiters.delete(info.exchangeId)
          const stopped = stoppedRoomTurns.delete(info.exchangeId)
          if (waiter !== undefined) {
            if (failure !== undefined) waiter.fail(failure)
            else waiter.resolve(reason?.kind === 'aborted' ? null : groupReply())
          } else if (!stopped && reason?.kind !== 'aborted') {
            // The round moved on without this member; how its turn ends still reaches the group.
            if (failure !== undefined) void rt.lateRoomFailure?.(id, info, failure)
            else void rt.lateRoomReply?.(id, info, groupReply(), { shown })
          }
        } else if (!retry && speaksInGroup(id, info)) {
          // A turn that failed before it took any input (DSH can turn it down before its
          // first step) never names its call, so the call waiting on this Session fails.
          const inRound = failure !== undefined && info === undefined && rt.failRoomTurn?.(id, failure) === true
          if (failure !== undefined) { if (!inRound) void rt.lateRoomFailure?.(id, info ?? {}, failure) }
          else if (reason?.kind !== 'aborted') void rt.lateRoomReply?.(id, info ?? {}, groupReply(), { shown })
        } else if (!retry && info !== undefined) {
          finish(info, replyText())
        }
        for (const request of joined) {
          // A failed or stopped turn closes the request like any other; a finished
          // one hands it back to the Bot to answer next.
          if (failure !== undefined || reason?.kind === 'aborted') {
            answer(request.info, '')
            continue
          }
          void rt.deliver({
            fromId: request.info.senderSessionId,
            toId: rt.selfOf(id),
            sessionId: id,
            text: request.text,
            role: 'request',
            exchangeId: request.info.exchangeId,
            ...(request.info.senderRoomId ? { fromRoomId: request.info.senderRoomId } : {}),
            deferred: true,
          }).catch(error => rt.warn('ds-bot: deferred request delivery failed: %s', error))
        }
        break
      }
    }
  })

  Object.assign(rt, { live, liveOf, roomWaiters, roomProgress, roomInbox, activityView, workView, roomWorkView, turnsView, callDetail, doingOf, stopRoomTurn, releaseBot })
}
