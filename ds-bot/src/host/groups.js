// Group chats: the room log, members' group Sessions, rounds and @mentions, round
// reports, and the group tools (group_relay, read_own_chat, read_group_chat).
//
// Group chat rounds. "@Name" calls a member, and the members one message calls start
// at the same time: a call takes effect as soon as the message that makes it is
// posted, whether the user wrote it, a member said it while working, or a Bot posted
// it while the round runs. Each turn shows everything that arrived since that member
// last looked, and who else is answering. A plain message goes to the admin alone in
// admin mode; otherwise every member answers it in turn, admin first, each after the
// one before has posted or passed, so a discussion or a count-off stays in order. A
// member answers one call at a time. The user's own messages are always answered.
// Bots may call each other for as long as the work needs; the user stops a group from
// its details.
//
// Work does not hold a round up: a member that is still busy with tools a little after
// it started, or that is called while still at earlier work, lets the round go on. Its
// turn keeps running in its group Session, and what it ends with is posted to the group,
// where the member that asked for it answers.
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GROUP_LINE_READ, ROOM_IDLE_RELAY_LIMIT, ROOM_REPLY_TIMEOUT_MS, ROOM_STEP_GAP_MS, ROOM_WORK_GRACE_MS, SOURCE_KIND, TEAM_TOOLS, TEXT_KEPT } from './constants.js'
import { escapeRegExp, headOf, splitRef, textOf } from './text.js'
import { mentionSpans, speakerOf } from '../shared/mentions.js'
import { GROUP_REF, output } from './tools.js'
import { failureLine } from './turns.js'

const ROOM_LOG_MAX = 60
const ROOM_FIRST_LOOK = 12
const ROOM_DELTA_MAX = 24
const ROOM_EARLIER_MAX = 8

// A reply that hands back an unresolved decision to the admin or caller without @Name (#619).
const NEEDS_CALLER_DECISION = /需要.*(?:决定|拍板|确认|指示|裁决|定夺)|请.*(?:管理员|负责人|组长|拍板|决定|指示|确认)|等.*(?:管理员|负责人|决定|拍板|指示)|\b(?:need|needs|waiting\s+for|requires)\s+(?:the\s+)?(?:admin|lead|leader|chief|you)\s+to\s+(?:decide|confirm|choose|approve|pick)\b/i
const needsCallerDecision = text => typeof text === 'string' && NEEDS_CALLER_DECISION.test(text)

// Short ack/thanks/closing phrases with no new content, used by the 0-tool idle loop guard.
const IDLE_ACK_BODY = /^(?:(?:收到|好的|好|明白|明白了|了解|了解了|没问题|谢谢|多谢|感谢|辛苦了|辛苦|不客气|不用谢|完毕|完成|好嘞|行|ok|okay|got\s+it|understood|noted|thanks|thank\s+you|you\s+are\s+welcome|you're\s+welcome|welcome|np|no\s+problem|roger|ack|done|all\s+good|sounds\s+good)(?:[\s，,、。.!！~～：:]+|$))+$/i
const normalizeRelayBody = (text, everyone) => {
  let out = String(text ?? '')
  for (const bot of everyone) {
    out = out.replace(new RegExp(`@${escapeRegExp(bot.name)}\\b`, 'gi'), '')
    out = out.replaceAll(`@${bot.name}`, '')
  }
  return out.replace(/@(?:all|everyone|所有人|全体)/gi, '').replace(/[\s，,、。.!！?？;；:：'"“”‘’()（）[\]【】~～-]+/g, ' ').trim().toLowerCase()
}
const isIdleRelayText = (text, everyone, priorBodies) => {
  const norm = normalizeRelayBody(text, everyone)
  if (norm === '' || (norm.length <= 45 && IDLE_ACK_BODY.test(norm))) return true
  return priorBodies.some(prev => prev !== '' && (prev === norm || (prev.length >= 8 && norm.length >= 8 && (prev.includes(norm) || norm.includes(prev)))))
}

// Logs written before rooms were versioned get sequence numbers in place.
const ensureRoomLog = (room) => {
  if (typeof room.seq !== 'number') {
    room.log = (room.log ?? []).map((line, index) => ({ ...line, seq: index + 1 }))
    room.seq = room.log.length
  }
  room.seen ??= {}
}

// A member's own lines are already in its Session, so only the others' are news.
const unseenLines = (room, memberId) => {
  const since = room.seen[memberId]
  if (since === undefined) return room.log.slice(-ROOM_FIRST_LOOK)
  return room.log.filter(line => line.seq > since && line.botId !== memberId).slice(-ROOM_DELTA_MAX)
}

// A notice keeps its fields, not a finished sentence: the line members read is written
// when it is read, so old entries still say what happened when the wording or the
// constants move on.
const noticeText = (line) => {
  if (line.reason === 'missed') return `${(line.names ?? []).join(' and ')} did not answer within ${line.minutes} minutes, so this round moved on without it. If it is still working, it posts its result later as a late reply; if it is urgent, the user can write here or the admin can follow up.`
  if (line.reason === 'paused') return `Paused: Bots have called each other ${line.limit} times since the user last wrote here. The calls to @${(line.names ?? []).join(' and @')} wait until the user continues or writes here; do not call them again.`
  if (line.reason === 'admin-passed') return `${(line.names ?? []).join(' and ') || 'The admin'} did not answer or call anyone; call a member with @Name.`
  return line.text ?? ''
}
// `text` is what to show of a message line, by default what the log keeps of it.
export const lineText = (line, text = line.text) => {
  if (line.kind === 'lookup') return `[${speakerOf(line)} looked up its own chat${line.text ? ` for "${line.text}"` : ''}]`
  if (line.kind === 'resumed') return `[${speakerOf(line)}'s work here was cut off when DeepSeek Harness restarted; it is picking it back up and posts when done]`
  if (line.kind === 'cut') return `[${speakerOf(line)}'s work here was cut off by a restart again, so it stopped; ask it to go on if it still matters]`
  if (line.kind === 'stopped') return `[The user stopped ${speakerOf(line)}'s work here]`
  if (line.kind === 'done') return `[${speakerOf(line)} finished the work it was asked for]`
  if (line.kind === 'notice') return `[${noticeText(line)}]`
  return `${speakerOf(line)}: ${text}`
}
const transcript = (lines, textOfLine = line => line.text) => lines.map(line => lineText(line, textOfLine(line))).join('\n')

// Models often echo the transcript format ("Name: …") despite the instruction.
export const stripOwnName = (name, text) => text.replace(new RegExp(`^\\s*\\**${escapeRegExp(name)}\\**\\s*[:：]\\s*`), '').trim()
export const isPass = text => text === '' || /^\s*[[【(（]\s*pass\s*[\]】)）]|^\s*pass\s*[.。!！]?\s*$/i.test(text)

// Who "@" calls, in order, by the same rule the bubbles draw. `references` are the
// round's referenced conversations: each one's "@label" is a reference, not a call.
// Pass every member, the speaker too, so "@新 Bot 2" said by 新 Bot 2 is never read as
// a call to 新 Bot; the caller drops the speaker.
export const mentionsIn = (text, members, references = []) => {
  const found = []
  let all = false
  for (const span of mentionSpans(text, members, { references: references.flatMap(reference => reference.labels) })) {
    if (span.all) all = true
    else if (!found.includes(span.bot)) found.push(span.bot)
  }
  return { all, found }
}

// What the user referenced in this round, for a member that has not been shown it yet.
export const referenceNote = references => (references?.length
  ? `Conversations the user referenced in this round:\n\n${references.map(reference => reference.text).join('\n\n')}`
  : '')

const ROOM_REPLY = 'Reply with your message for the group, no name prefix: in a discussion, one or two short messages. When you are asked to do something, call your first tool in the same step as your opening note — if you stop without a tool call, your turn ends and no work runs. The group does not wait for you and sees what you write while you work: say what you will do, write again only when something matters, and end with the result, never a promise to do it later. Reply [PASS] to stay silent when you have nothing new to add or the message is for someone else.'
const ROOM_CALLS = 'Writing "@Name" calls that member at once, to answer or to do what you ask, as soon as your message is posted: call members before you start on your own part. Members called in one message start together and do not see each other\'s replies until they post, so when one needs another\'s result, call the first and ask it to call the next. When a member finishes work you gave it, you answer its result. To only mention a member, write its name without "@".'

const slotLabel = (slot, self) => {
  if (slot.status === 'speaking') return slot === self ? `${slot.name} (you, now)` : `${slot.name} (answering now)`
  if (slot.status === 'posted') return `${slot.name} (posted)`
  if (slot.status === 'passed') return `${slot.name} (passed)`
  if (slot.status === 'missed') return `${slot.name} (no answer)`
  if (slot.status === 'working') return `${slot.name} (working on it; posts when done)`
  if (slot.status === 'waiting-approval') return `${slot.name} (waiting for the user's approval; posts when done)`
  if (slot.status === 'failed') return `${slot.name} (could not answer: error)`
  if (slot.status === 'left') return `${slot.name} (left the group)`
  return slot.name
}

const adminNote = room => [
  'You are this group\'s admin.',
  room.mode === 'admin' ? 'Plain messages come to you first: answer them, or call the members who should answer with @Name.' : '',
  '"@all" calls every member. When the user asks, change the group with update_group.',
].filter(Boolean).join(' ')

// The opening turn of a group the user just made without a first message.
const roomKickoff = language => `The user just created this group and has not written yet. Greet the user in one short message and ask what they want this group to work on. Do not call members with @ yet, and do not reply [PASS]. No name prefix. Write in ${language ?? 'the user\'s language if known; otherwise Chinese'}.`

const ROOM_READ_MAX = 30

// DSH cannot open the Session at all: it is gone, or its stored log is corrupt. DSH
// reports a corrupt log only in the message of a generic failure.
const lostSession = error => error?.code === 'session/not-found' || /\bis corrupt\b|\bcorrupt session log\b/i.test(String(error?.message ?? ''))
const fileLine = file => `[File "${file.name}" (${file.bytes} bytes) attached]`

export function install(rt) {
  const { ctx } = rt

  // A long line keeps its start in state.json, which is written whole on every save,
  // and what a member reads of it (GROUP_LINE_READ) in a file of its own: written once,
  // before the state that names it, and removed with the line. All of it stays in the
  // group's Session, where the group chat shows it.
  const linesDir = join(rt.home, 'group-lines')
  const lineFile = (roomId, seq) => join(linesDir, roomId, `${seq}.txt`)
  const wholeLines = new Map()
  const lineKey = (roomId, seq) => `${roomId}/${seq}`
  const writes = () => rt.readOnly?.() === undefined

  function keepGroupLine(roomId, line, text) {
    const kept = headOf(text, TEXT_KEPT)
    if (kept.length === text.length) return line
    const read = headOf(text, GROUP_LINE_READ)
    wholeLines.set(lineKey(roomId, line.seq), read)
    if (writes()) {
      try {
        mkdirSync(join(linesDir, roomId), { recursive: true })
        writeFileSync(lineFile(roomId, line.seq), read, 'utf8')
      } catch (error) {
        rt.warn('ds-bot: group line %s/%s not kept whole: %s', roomId, line.seq, error)
      }
    }
    return { ...line, text: kept, length: text.length }
  }

  function dropGroupLine(roomId, line) {
    if (line.length === undefined) return
    wholeLines.delete(lineKey(roomId, line.seq))
    if (writes()) void rm(lineFile(roomId, line.seq), { force: true }).catch(() => {})
  }

  function dropGroupLines(roomId) {
    for (const key of wholeLines.keys()) if (key.startsWith(`${roomId}/`)) wholeLines.delete(key)
    if (writes()) void rm(join(linesDir, roomId), { recursive: true, force: true }).catch(() => {})
  }

  // After a restart the whole lines are read back before a member reads them.
  const loadGroupLines = room => Promise.all(room.log
    .filter(line => line.length !== undefined && !wholeLines.has(lineKey(room.id, line.seq)))
    .map(line => readFile(lineFile(room.id, line.seq), 'utf8').then(text => { wholeLines.set(lineKey(room.id, line.seq), text) }, () => {})))

  // What a member reads of a line: all of it, up to GROUP_LINE_READ.
  const memberText = room => (line) => {
    const read = line.length === undefined ? line.text : wholeLines.get(lineKey(room.id, line.seq))
    if (read === undefined) return `${line.text}… (cut; ${line.length} characters in all, the rest was not kept)`
    const length = line.length ?? read.length
    const shown = headOf(read, GROUP_LINE_READ)
    return length > shown.length ? `${shown}… (cut; ${length} characters in all)` : shown
  }

  const appendRoom = (room, line) => {
    room.seq += 1
    const log = [...room.log, keepGroupLine(room.id, { ...line, seq: room.seq }, line.text ?? '')]
    for (const gone of log.slice(0, -ROOM_LOG_MAX)) dropGroupLine(room.id, gone)
    room.log = log.slice(-ROOM_LOG_MAX)
  }
  Object.assign(rt, { keepGroupLine, dropGroupLines })

  // A member's group Session, created on its first turn there. A new one starts with
  // a fresh look at the log and a brief of the member's own chat; the brief is the
  // first message, so it stays fixed and the prefix stays cacheable.
  async function groupSessionFor(room, member) {
    room.sessions ??= {}
    const known = room.sessions[member.id]
    if (known !== undefined) {
      await rt.ensureCapabilities(known)
      return { id: known, brief: undefined }
    }
    const id = await rt.createSession(`${member.name} · ${room.name}`, { dir: rt.workDirOf({ botId: member.id, roomId: room.id }) })
    // While the Session was made the member may have left or been deleted, the group been
    // deleted, or another turn made the member's Session first: the new one is not kept.
    // Undefined means the member is gone from the group.
    const gone = rt.roomOf(room.id) !== room || !room.members.includes(member.id) || rt.botOf(member.id) === undefined
    if (gone || room.sessions?.[member.id] !== undefined) {
      void ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })
        .catch(error => rt.warn('ds-bot: unused group Session of %s in %s not archived: %s', member.name, room.name, error))
      return gone ? undefined : groupSessionFor(room, member)
    }
    room.sessions[member.id] = id
    rt.groupOwners.set(id, { botId: member.id, roomId: room.id })
    delete room.seen[member.id]
    const ref = await rt.desiredModel(member)
    if (ref !== undefined) {
      const effort = await rt.desiredEffort(member, ref)
      await rt.selectSessionModel(id, { ...splitRef(ref), ...(effort === undefined ? {} : { reasoningEffort: effort }) })
        .catch(error => rt.warn('ds-bot: model for %s in %s not applied: %s', member.name, room.name, error))
    }
    await rt.applyPermission(member, id, room)
      .catch(error => rt.warn('ds-bot: permission for %s in %s not applied: %s', member.name, room.name, error))
    await rt.save()
    // The Session was resolved before the group owned it, so its scoped tools land now.
    await rt.resolveAgent(id)
      .catch(error => rt.warn('ds-bot: scoped tools for %s in %s not applied: %s', member.name, room.name, error))
    await rt.ensureCapabilities(id)
    return { id, brief: await rt.ownChatBrief(member) }
  }

  // Lines from before the round's opening message are kept apart from this round, so
  // an earlier round (an old count-off, say) never reads as part of the current one.
  // `files` are the files of the lines shown, which go to the member with the prompt.
  function roomPrompt(room, member, round, slot) {
    const peers = room.members.filter(id => id !== member.id).map(rt.botOf).filter(Boolean)
      .map(bot => `${bot.name}${rt.isAdminOf(room, bot.id) ? ' (admin)' : ''}`)
    const leads = rt.isAdminOf(room, member.id)
    const lines = unseenLines(room, member.id)
    const earlier = lines.filter(line => line.seq < round.startSeq).slice(-ROOM_EARLIER_MAX)
    const current = lines.filter(line => line.seq >= round.startSeq)
    const spokeThisRound = (room.seen[member.id] ?? 0) >= round.startSeq
    const members = `Members: the user${peers.length ? `, ${peers.join(', ')}` : ''} and you${leads ? ' (admin)' : ''}. ${ROOM_CALLS}`
    const notice = room.notice ? `Group notice (shared instructions for every member):\n${room.notice}` : ''
    if (round.kickoff) return { text: [members, notice, leads ? adminNote(room) : '', roomKickoff(rt.uiLanguage?.())].filter(Boolean).join('\n\n'), files: [] }
    // Members answering in this round are named with the round below.
    const answering = new Set(round.slots.filter(other => other.status === 'speaking').map(other => other.id))
    const working = workingIn(room).filter(item => item.bot.id !== member.id && !answering.has(item.bot.id))
      .map(item => ({ ...item, unread: unreadCount(room, item.bot.id) }))
    const text = [
      members,
      notice,
      leads ? adminNote(room) : '',
      earlier.length ? `Earlier in the group, before this round (context only):\n${transcript(earlier, memberText(room))}` : '',
      current.length
        ? `This round so far${spokeThisRound ? ', since your last message' : ', starting with the new message'} (oldest first):\n${transcript(current, memberText(room))}`
        : 'Nothing new in this round since your last message.',
      round.shown?.includes(member.id) ? '' : referenceNote(round.references),
      working.length > 0 ? `Still at work on what they were asked; each posts here when done: ${working.map(item => `${item.bot.name} (${minutesSince(item.since)} min${item.unread > 0 ? `, with ${item.unread} group message(s) it has not read yet` : ''})`).join(', ')}.` : '',
      ...placeLines(round, slot),
      ROOM_REPLY,
    ].filter(Boolean).join('\n\n')
    return { text, files: [...earlier, ...current].flatMap(line => line.files ?? []) }
  }

  // Where a turn stands in its round: its place in the order when members take turns,
  // or who was called with it and answers at the same time; then the others' latest
  // calls in this round.
  function placeLines(round, slot) {
    const lines = []
    if (slot.ordered) {
      const order = round.slots.filter(other => other.ordered)
      const index = order.indexOf(slot)
      const after = order.length - index - 1
      lines.push(`Members answer this message one at a time: ${order.map(other => slotLabel(other, slot)).join(' → ')}.`,
        `You are number ${index + 1} of ${order.length}. ${index === 0 ? 'Nobody spoke before you' : `${index} went before you`}${after === 0 ? ', and you are the last.' : `; ${after} after you will see your message.`}`)
    } else {
      const together = round.slots.filter(other => other !== slot && other.batch === slot.batch && other.id !== slot.id)
      if (together.length > 0) lines.push(`Called together with you: ${together.map(other => other.name).join(', ')}. You answer at the same time and do not see each other's replies until they post.`)
    }
    const latest = new Map()
    for (const other of round.slots) if (other.id !== slot.id && !(slot.ordered && other.ordered)) latest.set(other.id, other)
    if (latest.size > 0) lines.push(`Also in this round: ${[...latest.values()].map(other => slotLabel(other, slot)).join(', ')}.`)
    return lines
  }

  // Members whose turn or DSH subagent in this group is running, and since when.
  const workingIn = room => room.members.flatMap((id) => {
    const sessionId = room.sessions?.[id]
    const entry = rt.live.get(sessionId)
    const bot = rt.botOf(id)
    if (bot === undefined) return []
    if (entry?.turn !== undefined) return [{ bot, since: entry.since ?? Date.now() }]
    if (sessionId !== undefined && rt.hasSubagents?.(sessionId)) {
      const subSince = rt.roomWorkView?.()?.[room.id]?.find(item => item.botId === id)?.since
      return [{ bot, since: subSince ?? Date.now() }]
    }
    return []
  })
  // How many group lines a member has not been shown yet, counted the same way a
  // round counts the lines it carries over (unseenLines), so the number a speaker
  // reads is the number the member would get. A turn the reply timeout cut short
  // may leave them unread, and the member is never called again: the next speaker
  // is told, so it knows the hand-off it waits on sits behind unread lines.
  const unreadCount = (room, botId) => unseenLines(room, botId).length
  const minutesSince = at => Math.max(1, Math.round((Date.now() - at) / 60000))

  // Active Bot-to-Bot call batches in groups: when Bot `by` calls one or more members
  // together (`@B @C`), the batch tracks which callees are still working so:
  // 1) a callee that finishes tool work within the round (< 15s) without writing `@by`
  //    still hands the result back to `by` (#619), and
  // 2) when multiple callees work in parallel, `by` is woken once when the last callee
  //    in the batch finishes rather than woken piecemeal on every early reply.
  const roomBatches = new Map()
  const memberBatch = new Map()
  const batchKeyOf = (roomId, botId) => `${roomId}:${botId}`

  const activeInRoom = (room, botId) => {
    const sessionId = room.sessions?.[botId]
    if (sessionId !== undefined && (rt.live.get(sessionId)?.turn !== undefined || rt.hasSubagents?.(sessionId) === true)) return true
    return [...rt.roomProgress.values()].some(round => round.roomId === room.id
      && round.slots.some(slot => slot.id === botId && (slot.status === 'waiting' || slot.status === 'speaking')))
  }

  const registerBatch = (roomId, by, callees) => {
    if (by === undefined || callees.length === 0) return undefined
    const batch = {
      key: randomUUID(),
      roomId,
      by,
      pending: new Set(callees.map(peer => peer.id)),
      done: [],
      worked: false,
      answered: false,
    }
    roomBatches.set(batch.key, batch)
    for (const peer of callees) {
      const mKey = batchKeyOf(roomId, peer.id)
      const prev = memberBatch.get(mKey)
      if (prev !== undefined) {
        prev.pending.delete(peer.id)
        if (prev.pending.size === 0) roomBatches.delete(prev.key)
      }
      memberBatch.set(mKey, batch)
    }
    return batch.key
  }

  const markBatchWorked = (roomId, botId) => {
    const batch = memberBatch.get(batchKeyOf(roomId, botId))
    if (batch !== undefined) batch.worked = true
  }

  const pruneBatchPending = (room, batch) => {
    for (const otherId of batch.pending) {
      if (!room.members.includes(otherId) || !activeInRoom(room, otherId)) {
        batch.pending.delete(otherId)
        if (memberBatch.get(batchKeyOf(room.id, otherId)) === batch) memberBatch.delete(batchKeyOf(room.id, otherId))
      }
    }
  }

  const dropMemberFromBatch = (room, botId) => {
    const mKey = batchKeyOf(room.id, botId)
    const batch = memberBatch.get(mKey)
    if (batch === undefined) return undefined
    memberBatch.delete(mKey)
    batch.pending.delete(botId)
    pruneBatchPending(room, batch)
    if (batch.pending.size === 0) roomBatches.delete(batch.key)
    return batch
  }

  // A member's message in the round: in the log, for the members after it, and in the
  // round's replies, for the user.
  const postInRound = (room, round, member, text, duration) => {
    appendRoom(room, { who: member.name, botId: member.id, text })
    round.replies.push({ botId: member.id, name: member.name, color: member.color, text, time: Date.now(), ...(duration === undefined ? {} : { duration }) })
    void rt.save().catch(() => {})
  }

  // One member turn inside the room; resolves to its final text, `{ failure }` when its
  // model call failed, `{ missed }` when it went quiet for too long, `{ approval }` when
  // it waits for the user's approval, `{ working }` when it goes on working without the
  // round, or null when the round was stopped. The wait restarts on each event of the
  // member's Session, so a member at work is never cut off. `by` is the member that
  // called it, which answers what the turn posts after the round moved on. What the
  // member writes before its last step is posted at once and collected in `said`, and
  // `heard` takes each such line once it is posted.
  async function roomTurn(room, member, sessionId, { text, files }, note, signal, round, by, said = [], heard = () => {}, onWork = () => {}) {
    if (signal.aborted) return null
    const startedAt = Date.now()
    const exchangeId = randomUUID()
    const turn = { botId: member.id, sessionId, exchangeId }
    const { started } = round
    started.push(turn)
    // The read position is the one of this turn's start, and moves only when the
    // delivery lands: a delivery that failed leaves the member where it was.
    const seenAt = room.seq
    // Checked before the delivery, which may start the turn at once.
    const busy = rt.live.get(sessionId)?.turn !== undefined || rt.hasSubagents?.(sessionId) === true
    const done = new Promise((resolve) => {
      let timer
      let grace
      const finish = (value) => {
        clearTimeout(timer)
        clearTimeout(grace)
        rt.roomWaiters.delete(exchangeId)
        resolve(value)
      }
      const touch = () => {
        clearTimeout(timer)
        timer = setTimeout(() => finish({ missed: true }), ROOM_REPLY_TIMEOUT_MS)
      }
      const work = () => {
        onWork()
        grace ??= setTimeout(() => finish({ working: true }), ROOM_WORK_GRACE_MS)
      }
      const say = (raw) => {
        const step = stripOwnName(member.name, raw)
        if (isPass(step)) return
        said.push(step)
        postInRound(room, round, member, step, Date.now() - startedAt)
        heard(step)
      }
      touch()
      rt.roomWaiters.set(exchangeId, { sessionId, botId: member.id, roomId: room.id, resolve: finish, fail: failure => finish({ failure }), touch, work, say, approval: () => finish({ approval: true }) })
      signal.addEventListener('abort', () => finish(null), { once: true })
    })
    try {
      await rt.deliver({ fromId: undefined, toId: member.id, sessionId, role: 'room', roomId: room.id, exchangeId, note, text, files, steer: busy, ...(by ? { askedBy: by } : {}) })
      // The prompt reached the member: its read position moves on.
      room.seen[member.id] = seenAt
      // Still held by an earlier request: this turn cannot start until the user answers.
      if (rt.waitsForApproval?.(sessionId)) rt.roomWaiters.get(exchangeId)?.approval()
      // Still at earlier work: the call steers it at its next step; the round goes on.
      else if (busy) rt.roomWaiters.get(exchangeId)?.resolve({ working: true })
    } catch (error) {
      rt.warn('ds-bot: group delivery to %s failed: %s', member.name, error)
      // A delivery that failed is not a pass: the round shows it. Nothing here can
      // repair a lost Session, so the member's next turn in the group starts a new one.
      const lost = lostSession(error)
      if (lost && room.sessions?.[member.id] === sessionId) {
        rt.retireGroupSession(room, member.id)
        void rt.save().catch(() => {})
      }
      rt.roomWaiters.get(exchangeId)?.fail({ code: lost ? 'SESSION_RESET' : 'SESSION', message: String(error?.message ?? error).slice(0, 300) })
    }
    const reply = await done
    // A turn that ended leaves nothing for a stop to cancel.
    if ((typeof reply === 'string' || reply?.failure !== undefined) && !rt.hasSubagents?.(sessionId)) started.splice(started.indexOf(turn), 1)
    if (reply === null || typeof reply === 'object') return reply
    return stripOwnName(member.name, String(reply ?? '').trim())
  }

  // A member that reaches its context limit mid-turn goes on in a fresh Session, so a
  // waiter is also found by the member and group that Session now speaks for.
  const waitersOf = (sessionId) => {
    const owner = rt.groupOwners.get(sessionId)
    return [...rt.roomWaiters.values()].filter(waiter => waiter.sessionId === sessionId
      || (owner !== undefined && waiter.botId === owner.botId && waiter.roomId === owner.roomId))
  }
  rt.touchRoomTurn = (sessionId) => { for (const waiter of waitersOf(sessionId)) waiter.touch() }
  rt.failRoomTurn = (sessionId, failure) => {
    const waiters = waitersOf(sessionId)
    for (const waiter of waiters) waiter.fail(failure)
    return waiters.length > 0
  }
  rt.yieldRoomTurn = (sessionId) => { for (const waiter of waitersOf(sessionId)) waiter.approval() }
  // The team's own tools are quick; any other tool is the start of work.
  const QUICK_TOOLS = new Set(TEAM_TOOLS)
  rt.workRoomTurn = (sessionId, tool) => {
    if (QUICK_TOOLS.has(tool)) return
    const owner = rt.groupOwners.get(sessionId)
    if (owner !== undefined) markBatchWorked(owner.roomId, owner.botId)
    for (const waiter of waitersOf(sessionId)) waiter.work()
  }
  // The group Session's inbox changed: a running round looks for the user's messages
  // once DSH has finished the change.
  rt.nudgeRoom = (roomId) => {
    for (const round of rt.roomProgress.values()) {
      if (round.roomId === roomId) setImmediate(() => round.nudge?.())
    }
  }

  // Calls members into a round; the members one call names share a batch. Ordered calls
  // (a plain message everyone answers in turn) go ahead of the ordered calls still
  // waiting, in their own order; the others start as soon as their member is free. A
  // member still waiting is called once, with the newest note: an ordered call moves
  // it up the order, any other call lets it start at once. `by` is the calling member,
  // if a member called.
  function callIn(round, callees, note, by, { ordered = false } = {}) {
    if (callees.length === 0) return
    round.batches = (round.batches ?? 0) + 1
    const batchKey = registerBatch(round.roomId, by, callees)
    let last
    for (const peer of callees) {
      const waiting = round.slots.findIndex(slot => slot.id === peer.id && slot.status === 'waiting')
      const moves = waiting === -1 || (ordered && round.slots[waiting].ordered === true)
      const slot = waiting === -1 ? { id: peer.id, name: peer.name, status: 'waiting' } : round.slots[waiting]
      if (moves && waiting !== -1) round.slots.splice(waiting, 1)
      slot.note = note
      slot.batch = round.batches
      if (batchKey !== undefined) slot.batchKey = batchKey
      if (by === undefined) delete slot.by
      else slot.by = by
      if (!moves) slot.ordered = false
      else if (!ordered) round.slots.push(slot)
      else {
        slot.ordered = true
        const queue = round.slots.findIndex(other => other.ordered && other.status === 'waiting')
        round.slots.splice(last ? round.slots.indexOf(last) + 1 : queue === -1 ? round.slots.length : queue, 0, slot)
        last = slot
      }
    }
    round.nudge?.()
  }

  // Whether a waiting call can start now: its member answers nothing else in this
  // round, and an ordered call waits for the ordered calls before it.
  const startable = (round, slot) => {
    if (slot.status !== 'waiting' || round.slots.some(other => other.id === slot.id && other.status === 'speaking')) return false
    if (!slot.ordered) return true
    const at = round.slots.indexOf(slot)
    return round.slots.every((other, index) => !other.ordered || other === slot || (other.status !== 'speaking' && !(other.status === 'waiting' && index < at)))
  }

  // LEGACY: groups used to park Bot calls past a relay limit until the user went on.
  // Calls still parked from then (or by the idle ping-pong guard) run in the group's
  // next round, with its opening speakers; one already waiting in the round is not
  // called twice.
  const releaseParked = (room, round) => {
    const parked = room.paused ?? []
    delete room.paused
    for (const entry of parked) {
      if (round.slots.some(slot => slot.id === entry.id && slot.status === 'waiting')) continue
      const peer = rt.botOf(entry.id)
      const batchKey = peer && entry.by !== undefined ? registerBatch(room.id, entry.by, [peer]) : undefined
      round.batches = (round.batches ?? 0) + 1
      round.slots.push({
        id: entry.id, name: entry.name, status: 'waiting', batch: round.batches,
        ...(batchKey !== undefined ? { batchKey } : {}),
        ...(entry.note !== undefined ? { note: entry.note } : {}),
        ...(entry.by !== undefined ? { by: entry.by } : {}),
      })
    }
  }

  // The user's messages waiting in the group Session's inbox while a round runs, from
  // the composer whether it queued or steered them. Images and chat references are
  // only read when the Session takes the message itself, so a message with either
  // stays for the next round, and so does everything after it in that list.
  const waitingLines = agent => ['nextStep', 'nextTurn'].flatMap((list) => {
    const lines = []
    for (const message of agent?.inbox?.[list] ?? []) {
      if (message.source?.kind !== 'user') continue
      const content = Array.isArray(message.content) ? message.content : []
      const text = textOf(content)
      if (text === '' || content.some(block => block?.type !== 'text') || text.includes('dsh-session:')) break
      lines.push({ id: message.id, text })
    }
    return lines
  })

  // Messages the user sent while this round is running post into the log at once, so
  // every turn that starts from now on sees them. The members the message's own round
  // would open with answer it inside this round, as soon as they are free. Each message
  // leaves the Session's inbox, so it does not open another round when this one ends.
  function drainRoomInbox(room, round, agent) {
    // The greeting's prompt tells the admin the user has not written yet.
    if (round.kickoff) return
    const lines = waitingLines(agent).filter(line => agent.inbox.remove(line.id))
    if (lines.length === 0) return
    round.idleRelays = 0
    const members = room.members.map(rt.botOf).filter(Boolean)
    for (const line of lines) {
      appendRoom(room, { who: 'User', text: line.text })
      round.replies.push({ kind: 'user', text: line.text, time: Date.now() })
      const { all, found } = mentionsIn(line.text, members)
      const note = all || found.length > 0 ? 'the user mentioned you' : 'new message from the user'
      const { speakers, ordered } = openingCall(room, { text: line.text })
      callIn(round, speakers, note, undefined, { ordered })
    }
    void rt.save().catch(() => {})
  }

  // The members a member's message calls: those it names with @, or everyone when the
  // admin writes "@all" (only the admin, so a member cannot set off a storm). A turn
  // calls each member once, however many of its lines name it.
  // When Bots bounce 0-tool repetitive or ack-only messages back and forth for
  // ROOM_IDLE_RELAY_LIMIT consecutive turns, the next call is parked in `room.paused`
  // with a notice until the user writes.
  function callFrom(room, round, member, text, called, { worked = false, byBot = false } = {}) {
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const others = everyone.filter(other => other.id !== member.id)
    const { all, found: named } = mentionsIn(text, everyone)
    const found = named.filter(other => other.id !== member.id)
    const callees = (rt.isAdminOf(room, member.id) && all ? [...found, ...others.filter(other => !found.includes(other))] : found)
      .filter(peer => !called.has(peer.id))
    for (const peer of callees) called.add(peer.id)
    if (callees.length === 0) return
    if (worked) {
      round.idleRelays = 0
    } else if (byBot) {
      const history = round.botBodies?.get(member.id) ?? []
      if (isIdleRelayText(text, everyone, history)) round.idleRelays = (round.idleRelays ?? 0) + 1
      else round.idleRelays = 0
      const norm = normalizeRelayBody(text, everyone)
      if (norm !== '') (round.botBodies ??= new Map()).set(member.id, [...history, norm])
      if ((round.idleRelays ?? 0) >= ROOM_IDLE_RELAY_LIMIT) {
        const parked = room.paused ?? []
        for (const peer of callees) {
          if (!parked.some(entry => entry.id === peer.id)) {
            parked.push({ id: peer.id, name: peer.name, note: `${member.name} mentioned you`, by: member.id })
          }
        }
        room.paused = parked
        const names = callees.map(peer => peer.name)
        appendRoom(room, { who: 'DS Bot', kind: 'notice', reason: 'paused', limit: ROOM_IDLE_RELAY_LIMIT, names })
        round.replies.push({ kind: 'paused', count: ROOM_IDLE_RELAY_LIMIT, limit: ROOM_IDLE_RELAY_LIMIT, names, time: Date.now() })
        void rt.save().catch(() => {})
        return
      }
    } else {
      const norm = normalizeRelayBody(text, everyone)
      if (norm !== '') (round.botBodies ??= new Map()).set(member.id, [...(round.botBodies?.get(member.id) ?? []), norm])
    }
    callIn(round, callees, `${member.name} mentioned you`, member.id)
  }

  // A round runs every call that can start, and wakes when a turn ends, a call comes
  // in, the user writes or the round is stopped. It ends when no turn runs and no call
  // or message waits. The inbox check keeps a message sent during the last turn inside
  // this round.
  async function runRound(room, round, signal, agent) {
    const turns = new Set()
    let due = true
    let wake = () => {}
    round.nudge = () => { due = true; wake() }
    signal.addEventListener('abort', round.nudge, { once: true })
    while (!signal.aborted) {
      if (!due) await new Promise((resolve) => { wake = resolve })
      due = false
      if (signal.aborted) break
      drainRoomInbox(room, round, agent)
      for (const slot of round.slots) {
        if (!startable(round, slot)) continue
        const turn = memberTurn(room, round, slot, signal)
          .catch(error => rt.warn('ds-bot: group turn of %s in %s failed: %s', slot.name, room.name, error))
          .finally(() => { turns.delete(turn); round.nudge() })
        turns.add(turn)
      }
      // The greeting round leaves the user's messages for a round of their own.
      if (turns.size === 0 && !round.slots.some(slot => slot.status === 'waiting') && (round.kickoff || waitingLines(agent).length === 0)) break
    }
    await Promise.allSettled([...turns])
    delete round.nudge
    // The admin was alone with the user's message and passed: the round ends with
    // nothing said. The group says so once, so the user knows to call a member.
    const alone = round.soleAdmin !== undefined && round.slots.find(slot => slot.id === round.soleAdmin.id)?.status === 'passed'
    // An answer that came, or is still coming, means the round is not left silent.
    const answered = round.slots.some(slot => ['posted', 'working', 'waiting-approval'].includes(slot.status))
    if (alone && !answered) {
      appendRoom(room, { who: 'DS Bot', kind: 'notice', reason: 'admin-passed', names: [round.soleAdmin.name] })
      // The round the user watched shows the same notice as one line of its replies.
      round.replies.push({ kind: 'admin-passed', botId: round.soleAdmin.id, name: round.soleAdmin.name, color: round.soleAdmin.color, time: Date.now() })
      await rt.save()
    }
  }

  // One call's turn in the round. Its status says how it ended; what it says calls
  // members as soon as each line is posted.
  async function memberTurn(room, round, slot, signal) {
    const member = rt.botOf(slot.id)
    // Settings may change mid-round, for example when the admin removes someone.
    if (member === undefined || !room.members.includes(slot.id)) {
      slot.status = 'left'
      dropMemberFromBatch(room, slot.id)
      return
    }
    slot.status = 'speaking'
    let session
    try {
      session = await groupSessionFor(room, member)
    } catch (error) {
      rt.warn('ds-bot: group Session for %s in %s failed: %s', member.name, room.name, error)
      slot.status = 'failed'
      dropMemberFromBatch(room, member.id)
      round.failed.push(member.name)
      round.replies.push({ kind: 'failed', botId: member.id, name: member.name, color: member.color, code: 'SESSION', text: String(error?.message ?? error).slice(0, 300), time: Date.now() })
      return
    }
    if (session === undefined) {
      slot.status = 'left'
      dropMemberFromBatch(room, member.id)
      return
    }
    await loadGroupLines(room)
    const prompt = roomPrompt(room, member, round, slot)
    round.shown?.push(member.id)
    const text = session.brief === undefined ? prompt.text : `${session.brief}\n\n${prompt.text}`
    const said = []
    const called = new Set()
    const startedAt = Date.now()
    let worked = false
    const onWork = () => {
      worked = true
      slot.worked = true
      round.idleRelays = 0
      markBatchWorked(room.id, member.id)
    }
    const reply = await roomTurn(
      room, member, session.id, { text, files: prompt.files }, slot.note ?? 'your turn', signal, round, slot.by, said,
      line => callFrom(room, round, member, line, called, { worked, byBot: slot.by !== undefined }),
      onWork,
    )
    const final = typeof reply === 'string' && !isPass(reply) ? reply : undefined
    const subRunning = rt.hasSubagents?.(session.id) === true
    if (reply?.failure !== undefined) {
      // Not a pass: the user sees why the member is silent, and the round goes on.
      slot.status = 'failed'
      round.failed.push(member.name)
      const { code, status, message } = reply.failure
      round.replies.push({ kind: 'failed', botId: member.id, name: member.name, color: member.color, code, ...(status ? { status } : {}), text: message, time: Date.now() })
    } else if (reply?.approval) {
      // The member's turn goes on in the background and posts when it ends.
      slot.status = 'waiting-approval'
      round.replies.push({ kind: 'approval', botId: member.id, name: member.name, color: member.color, time: Date.now() })
    } else if (reply?.working) {
      slot.status = 'working'
      markBatchWorked(room.id, member.id)
      round.replies.push({ kind: 'working', botId: member.id, name: member.name, color: member.color, time: Date.now() })
    } else if (subRunning) {
      if (final !== undefined) {
        postInRound(room, round, member, final, Date.now() - startedAt)
        callFrom(room, round, member, final, called, { worked: true, byBot: slot.by !== undefined })
      }
      slot.status = 'working'
      markBatchWorked(room.id, member.id)
      round.replies.push({ kind: 'working', botId: member.id, name: member.name, color: member.color, time: Date.now() })
    } else if (final !== undefined || (typeof reply === 'string' && said.length > 0)) {
      slot.status = 'posted'
      if (final !== undefined) {
        postInRound(room, round, member, final, Date.now() - startedAt)
        callFrom(room, round, member, final, called, { worked, byBot: slot.by !== undefined })
      }
    } else {
      slot.status = typeof reply === 'string' ? 'passed' : 'missed'
      round.passed.push(member.name)
      if (reply?.missed) {
        round.replies.push({ kind: 'missed', botId: member.id, name: member.name, color: member.color, time: Date.now() })
        // The round moved on without this member: the log shows the call and then
        // silence, which reads as a lost message. The group is told the baton was
        // dropped, and what brings the member back.
        appendRoom(room, { who: 'DS Bot', kind: 'notice', reason: 'missed', names: [member.name], minutes: Math.round(ROOM_REPLY_TIMEOUT_MS / 60000) })
      }
    }
    // Settle the member's place in its call batch when its work did not continue in the background.
    if (slot.status !== 'working') {
      const batch = (slot.batchKey ? roomBatches.get(slot.batchKey) : undefined) ?? memberBatch.get(batchKeyOf(room.id, member.id))
      if (batch !== undefined) {
        if (slot.status === 'posted') {
          batch.done.push(member.name)
          if (called.size > 0) batch.answered = true
          if (worked || needsCallerDecision(final)) batch.worked = true
        }
        dropMemberFromBatch(room, member.id)
        if (batch.pending.size === 0 && batch.done.length > 0 && batch.worked && !batch.answered && !signal.aborted) {
          const caller = rt.botOf(batch.by)
          if (caller !== undefined && room.members.includes(caller.id)
            && !round.slots.some(other => other.id === caller.id && (other.status === 'waiting' || other.status === 'speaking'))) {
            callIn(round, [caller], `${batch.done.join(' and ')} finished the work you asked for`, undefined)
          }
        }
      } else if (slot.status === 'posted' && called.size === 0 && needsCallerDecision(final) && room.mode === 'admin' && room.admin && room.admin !== member.id) {
        const admin = rt.botOf(room.admin)
        if (admin !== undefined && room.members.includes(admin.id)
          && !round.slots.some(other => other.id === admin.id && (other.status === 'waiting' || other.status === 'speaking'))) {
          callIn(round, [admin], `${member.name} finished the work and needs your decision`, undefined)
        }
      }
    }
  }

  ctx.tools.register(defineTool({
    name: 'group_relay',
    description: 'Group chat relay only. Deliver the latest user message to the Bots it calls in this group chat, and collect their replies.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(_args, exec) {
      await rt.load()
      const room = rt.roomOf(exec.agent?.id)
      if (room === undefined) return JSON.stringify({ error: 'Not a group chat' })
      ensureRoomLog(room)
      // Everything queued since the last relay is posted in order, so messages that the
      // Session folds into one turn are not lost; the newest one picks the speakers.
      const queued = rt.roomInbox.get(room.id) ?? []
      rt.roomInbox.delete(room.id)
      const posts = queued.length > 0 ? queued : [{ text: '' }]
      // A post a running round already logged stays inside the round this relay opens.
      const startSeq = Math.min(room.seq + 1, ...posts.map(post => post.logged).filter(seq => typeof seq === 'number'))
      // The opening greeting is a cue for the admin, not a line of the group; a member's
      // late failure, its work picked up after a restart, its work the user stopped, or
      // the end of work whose result it already posted is an event of the round.
      const event = item => item.failed || item.resumed || item.stopped || item.done
      for (const post of posts.filter(item => !item.kickoff && !event(item) && item.logged === undefined)) {
        // Image readings go into the log only; `@` names are picked from what the user typed.
        // A file stays with its line and reaches each member the line is shown to.
        const readings = post.images === undefined ? [] : await rt.imagesForGroup(post.images, room.id)
        const text = [post.text, ...readings, ...(post.files ?? []).map(fileLine)].filter(Boolean).join('\n')
        appendRoom(room, {
          ...(post.botId ? { who: rt.botOf(post.botId)?.name ?? post.name ?? 'Bot', botId: post.botId } : { who: 'User' }),
          text,
          ...(post.files === undefined ? {} : { files: post.files }),
        })
      }
      await rt.save()
      // An event post, and a member post that calls nobody, never pick the speakers
      // over a message queued with them. A post whose members an earlier round already
      // called (`called`) picks none.
      const callsNobody = post => post.member === true && openingSpeakers(room, post).length === 0
      const open = posts.filter(post => post.called !== true)
      const opener = open.findLast(post => !event(post) && !callsNobody(post)) ?? open.findLast(post => !event(post)) ?? open.at(-1) ?? { text: '', quiet: true }
      const references = posts.flatMap(post => post.references ?? [])
      // A member a Bot's post calls by name works for that Bot.
      const named = opener.botId === undefined ? [] : mentionsIn(opener.text ?? '', room.members.map(rt.botOf).filter(Boolean)).found
      const { speakers, ordered } = openingCall(room, opener)
      const calledByOpener = speakers.filter(member => named.includes(member))
      const openingBatchKey = opener.botId !== undefined && calledByOpener.length > 0 ? registerBatch(room.id, opener.botId, calledByOpener) : undefined
      // The admin alone with the user's message: when it passes, the round ends with
      // nothing said, and the group says so once.
      const admin = room.members.map(rt.botOf).filter(Boolean).find(bot => rt.isAdminOf(room, bot.id))
      const soleAdmin = opener.botId === undefined && !opener.kickoff && room.mode === 'admin' && admin !== undefined
        && speakers.length === 1 && speakers[0].id === admin.id
      const round = {
        roomId: room.id,
        members: room.members,
        startSeq,
        ...(opener.kickoff ? { kickoff: true } : {}),
        ...(references.length > 0 ? { references, shown: [] } : {}),
        slots: speakers.map(member => ({
          id: member.id, name: member.name, status: 'waiting', batch: 1,
          ...(ordered ? { ordered: true } : {}),
          ...(opener.kickoff ? { note: 'the group was just created' } : {}),
          ...(named.includes(member) ? { by: opener.botId, ...(openingBatchKey ? { batchKey: openingBatchKey } : {}) } : {}),
          ...(opener.done ? { note: `${opener.name ?? 'a member'} finished the work you asked for` } : {}),
        })),
        batches: 1,
        ...(soleAdmin ? { soleAdmin: { id: admin.id, name: admin.name, color: admin.color } } : {}),
        replies: [],
        passed: [],
        failed: [],
        started: [],
      }
      for (const post of posts.filter(item => item.failed && item.logged === undefined)) {
        const bot = rt.botOf(post.botId)
        const { code, status, message } = post.failed
        round.failed.push(bot?.name ?? post.name)
        round.replies.push({ kind: 'failed', botId: post.botId, name: bot?.name ?? post.name, color: bot?.color, code, ...(status ? { status } : {}), text: message, time: Date.now() })
      }
      // The log line tells the admin and the other members on their next turn.
      for (const post of posts.filter(item => (item.resumed || item.stopped || item.done) && item.logged === undefined)) {
        const bot = rt.botOf(post.botId)
        const name = bot?.name ?? post.name
        const kind = post.done ? 'done' : post.stopped ? 'stopped' : post.again ? 'cut' : 'resumed'
        appendRoom(room, { who: name, botId: post.botId, kind, text: '' })
        round.replies.push({ kind, botId: post.botId, name, color: bot?.color, time: Date.now() })
      }
      if (posts.some(post => post.resumed || post.stopped || post.done)) await rt.save()
      releaseParked(room, round)
      rt.roomProgress.set(exec.callId, round)
      try {
        await runRound(room, round, exec.signal, exec.agent)
      } catch (error) {
        rt.warn('ds-bot: group round in %s stopped: %s', room.name, error)
      } finally {
        rt.roomProgress.delete(exec.callId)
      }
      if (exec.signal?.aborted) {
        for (const turn of round.started) void rt.stopRoomTurn?.(room.sessions?.[turn.botId] ?? turn.sessionId, turn.exchangeId)
      }
      await rt.save()
      for (const post of open) {
        if (post.reportBack && rt.botOf(post.botId)) void reportRound(room, post, round)
      }
      // A post this round took in while it ran gets the replies of the members it called.
      for (const { post, ids, from } of round.reports ?? []) {
        if (!rt.botOf(post.botId)) continue
        const names = ids.map(id => rt.botOf(id)?.name).filter(Boolean)
        void reportRound(room, post, {
          replies: round.replies.slice(from).filter(reply => ids.includes(reply.botId)),
          passed: round.passed.filter(name => names.includes(name)),
          failed: round.failed.filter(name => names.includes(name)),
        })
      }
      exec.concludeTurn?.()
      return JSON.stringify({ replies: round.replies, passed: round.passed, ...(round.failed.length > 0 ? { failed: round.failed } : {}) })
    },
  }))

  // Private context enters a group only through this tool, and the group sees each use.
  ctx.tools.register(defineTool({
    name: 'read_own_chat',
    description: 'Read or search your own chat with the user, across all its parts, including earlier parts that left your working context. Each line starts with its anchor, such as [part 2 #1234 · 10-08 14:22]; long messages are cut. Pass the anchor as around to read that message in full, with what was said just before and after it. In a group chat the group sees that you looked, so share only what the group needs.',
    parameters: {
      query: { type: 'string', description: 'Words to look for in every part, separated by spaces. A message must have all of them; when none has, those with the most are shown. Omit for the latest messages' },
      around: { type: 'string', description: 'An anchor from an earlier result, such as "part 2 #1234": shows that message in full and the messages just before and after it' },
      part: { type: 'integer', description: 'Number of an earlier part: shows the handoff note you wrote when it ended' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const id = exec.agent?.id
      const owner = rt.groupOwners.get(id)
      const botId = owner?.botId ?? rt.chatOwners.get(id)
      if (botId === undefined) return 'Only Bots on the team can use read_own_chat.'
      const member = rt.botOf(botId)
      const room = rt.roomOf(owner?.roomId)
      const query = String(args.query ?? '').trim().slice(0, 80)
      const around = String(args.around ?? '').trim().slice(0, 40)
      const parts = rt.partsOf(botId)
      const number = Number.isInteger(args.part) ? args.part : undefined
      if (room !== undefined && member !== undefined) {
        ensureRoomLog(room)
        const text = query !== '' ? query : around !== '' ? `around ${around}` : number !== undefined ? `part ${number}` : ''
        appendRoom(room, { who: member.name, botId: member.id, kind: 'lookup', text })
        for (const round of rt.roomProgress.values()) {
          if (round.roomId === room.id) round.replies.push({ kind: 'lookup', botId: member.id, name: member.name, color: member.color, text, time: Date.now() })
        }
        void rt.save().catch(() => {})
      }
      const partsNote = parts.length > 1 ? `\n\nYour own chat has ${parts.length} parts: ${rt.partIndex(parts)}. Call read_own_chat with part N for the note that closed an earlier part, or with words to search all parts.` : ''
      if (query === '' && around !== '') {
        const found = await rt.aroundOwnChat(botId, around)
        if (found.error) return `${found.error}${partsNote}`
        if (found.lines.length === 0) return `Nothing was said around ${around}.${partsNote}`
        const heading = found.exact ? `around ${around}` : `with no message at ${around}; the nearest ones`
        return `Your own chat ${heading} (oldest first):\n${found.lines.join('\n')}${partsNote}`
      }
      if (query === '' && number !== undefined) {
        const part = parts[number - 1]
        if (part === undefined) return `Your own chat has no part ${number}.${partsNote}`
        if (part.endedAt === undefined) return `Part ${number} is the current one; it is in your context.${partsNote}`
        return `Part ${number} of your own chat (${rt.clock(part.startedAt)} – ${rt.clock(part.endedAt)}). The handoff note that closed it:\n${rt.noteText(part) ?? '(none: the part ended on a context overflow)'}${partsNote}`
      }
      if (query === '') {
        const lines = await rt.latestOwnChat(botId, { askingId: id })
        return lines.length === 0 ? `Your own chat is empty.${partsNote}` : `Your own chat (oldest first):\n${lines.join('\n')}${partsNote}`
      }
      const { lines, every } = await rt.searchOwnChat(botId, query, { askingId: id })
      if (lines.length === 0) return `Nothing in your own chat mentions "${query}".${partsNote}`
      const heading = every ? `messages mentioning "${query}"` : `no message has all of "${query}"; messages with the most of these words`
      return `Your own chat, ${heading} (oldest first):\n${lines.join('\n')}${partsNote}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'read_group_chat',
    description: 'Read the latest messages of a group chat, including what you said there. You speak in groups from separate conversations, so your own chat does not show them. Main Bots may read any group; others the groups they are in.',
    parameters: {
      group: GROUP_REF,
      seq: { type: 'integer', description: 'Read one message whole: the seq that a cut message names' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can read group chats.'
      const { room, error } = rt.pickRoom(args.group, self)
      if (error) return error
      ensureRoomLog(room)
      await loadGroupLines(room)
      if (args.seq !== undefined) {
        const line = room.log.find(entry => entry.seq === Number(args.seq))
        return line === undefined ? `"${room.name}" no longer keeps message ${args.seq}; it keeps its latest ${ROOM_LOG_MAX}.` : lineText(line, memberText(room)(line))
      }
      // Thirty whole lines could fill the context, so a long one shows its start.
      const short = (line) => {
        if (line.text === undefined) return ''
        const length = line.length ?? line.text.length
        return length <= TEXT_KEPT ? line.text : `${headOf(line.text, TEXT_KEPT)}… (cut; ${length} characters in all; read_group_chat with seq ${line.seq} reads it whole)`
      }
      const lines = room.log.slice(-ROOM_READ_MAX)
      return lines.length === 0 ? `"${room.name}" has no messages yet.` : `Latest in "${room.name}" (oldest first):\n${transcript(lines, short)}`
    },
  }))

  // A Bot that posts never answers its own post. @mentions choose the speakers; else
  // the admin answers alone in admin mode, or first of everyone. What a member posts
  // after its round moved on is answered by the member that asked for it; work the
  // user asked for is left for the user to read.
  // `ordered`: a plain message everyone answers in turn, admin first; any other call
  // starts its members at once.
  function openingCall(room, opener) {
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const members = everyone.filter(bot => bot.id !== opener.botId)
    const admin = members.find(bot => rt.isAdminOf(room, bot.id))
    const at = speakers => ({ speakers, ordered: false })
    if (opener.kickoff) return at(admin ? [admin] : [])
    if (opener.quiet) return at([])
    if (opener.done) return at(members.filter(bot => bot.id === opener.askedBy))
    const { all, found: named } = mentionsIn(opener.text, everyone, opener.references)
    const found = named.filter(bot => bot.id !== opener.botId)
    if (opener.progress) return at(found)
    if (opener.late) {
      if (found.length > 0) return at(found)
      const asked = members.filter(bot => bot.id === opener.askedBy)
      if (asked.length > 0) return at(asked)
      if (needsCallerDecision(opener.text) && room.mode === 'admin' && admin) return at([admin])
      return at([])
    }
    if (opener.member) return at(found)
    if (found.length > 0 && !all) return at(found)
    if (!all && room.mode === 'admin' && admin) return at([admin])
    const speakers = admin ? [admin, ...members.filter(bot => bot !== admin)] : members
    return { speakers, ordered: !all && speakers.length > 1 }
  }
  const openingSpeakers = (room, opener) => openingCall(room, opener).speakers

  // A Bot's post that lands while a round runs calls its members in that round at
  // once, as the relay it opens would. Returns whether it called anyone. A post that
  // wants the replies (`reportBack`) gets those of the members it called when the
  // round ends.
  function callPost(room, round, sender, text, extra) {
    if (extra.failed !== undefined && !extra.askedBy) return false
    if (extra.resumed || extra.stopped) return false
    const post = { ...extra, botId: sender.id, name: sender.name, text }
    const { speakers, ordered } = openingCall(room, post)
    if (speakers.length === 0) return false
    const named = mentionsIn(text, room.members.map(rt.botOf).filter(Boolean)).found
    const by = speakers.filter(peer => named.includes(peer))
    const rest = speakers.filter(peer => !named.includes(peer))
    const note = extra.done ? `${sender.name} finished the work you asked for` : undefined
    callIn(round, by, note ?? `${sender.name} mentioned you`, sender.id, { ordered })
    callIn(round, rest, note, undefined, { ordered })
    if (extra.reportBack) {
      (round.reports ??= []).push({ post: { botId: sender.id, name: sender.name, reportBack: true, ...(extra.sub ? { sub: extra.sub } : {}) }, ids: speakers.map(peer => peer.id), from: round.replies.length })
    }
    return true
  }

  // A Bot's message into the group's own Session, which relays it as a new round.
  // While a round runs, the post goes into the group's log and that round's replies at
  // once, and the members it calls start in that round, so it is not held back until
  // the round ends and never sits in the group Session's QueueDock (#663).
  async function postToRoom(room, sender, text, extra = {}, files = []) {
    const running = [...rt.roomProgress.values()].find(round => round.roomId === room.id && round.nudge !== undefined)
    if (running !== undefined) {
      ensureRoomLog(room)
      if (extra.failed !== undefined) {
        // A failed model call is an event of the round only: no log line, as the relay does it.
        const { code, status, message } = extra.failed
        running.failed.push(sender.name)
        running.replies.push({ kind: 'failed', botId: sender.id, name: sender.name, color: sender.color, code, ...(status ? { status } : {}), text: message, time: Date.now() })
      } else if (extra.resumed === true || extra.stopped === true || extra.done === true) {
        const kind = extra.done === true ? 'done' : extra.stopped === true ? 'stopped' : extra.again === true ? 'cut' : 'resumed'
        appendRoom(room, { who: sender.name, botId: sender.id, kind, text: '' })
        running.replies.push({ kind, botId: sender.id, name: sender.name, color: sender.color, time: Date.now() })
      } else {
        const line = [text, ...files.map(fileLine)].filter(Boolean).join('\n')
        appendRoom(room, { who: sender.name, botId: sender.id, text: line, ...(files.length > 0 ? { files } : {}) })
        running.replies.push({ botId: sender.id, name: sender.name, color: sender.color, text: line, time: Date.now() })
      }
      callPost(room, running, sender, text, extra)
      await rt.save()
      return
    }
    const agent = await rt.resolveAgent(room.id)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: `[Group post from ${sender.name}]\n${text}` }, ...files.map(attachment => ({ type: 'file', attachment }))],
      source: { kind: SOURCE_KIND, form: 'relay', role: 'post', exchangeId: randomUUID(), senderName: sender.name, senderSessionId: sender.id, roomId: room.id, ...extra },
    }))
    await ctx.sessions.flush(agent.session)
  }
  rt.postToRoom = postToRoom

  // A member the round moved on from (it went on working, went quiet or waited for an
  // approval) posts what its turn ended with. The member that asked for it and anyone
  // it names answer. When multiple members were called in one batch, each result posts
  // as soon as it is ready, and the caller is woken once when the last member in the
  // batch finishes.
  async function lateRoomReply(sessionId, info, reply, { shown = false } = {}) {
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info.roomId)
    const member = rt.botOf(owner?.botId)
    if (room === undefined || member === undefined || !room.members.includes(member.id)) return
    const text = stripOwnName(member.name, reply)
    // While a DSH subagent of this member is still running, the member's work is not
    // finished yet: post any non-empty text as a progress line and keep its batch open.
    if (rt.hasSubagents?.(sessionId) === true) {
      if (!isPass(text)) {
        const calls = callsIn(room, member, text)
        await postToRoom(room, member, text, { progress: true, ...(!calls ? { quiet: true } : {}) })
          .catch(error => rt.warn('ds-bot: subagent progress from %s failed: %s', member.name, error))
      }
      return
    }
    const currentBatch = memberBatch.get(batchKeyOf(room.id, member.id))
    const batch = currentBatch !== undefined && (info.role !== 'room' || info.askedBy === currentBatch.by) ? currentBatch : undefined
    const askedBy = info.role === 'room' ? info.askedBy : (info.askedBy ?? batch?.by)
    const named = mentionsIn(text, room.members.map(rt.botOf).filter(Boolean)).found.filter(bot => bot.id !== member.id)
    let waitingPeers = false
    let batchDoneBefore = false
    if (batch !== undefined) {
      if (named.length > 0) batch.answered = true
      if (!isPass(text) || shown) batch.done.push(member.name)
      dropMemberFromBatch(room, member.id)
      waitingPeers = batch.pending.size > 0
      batchDoneBefore = !waitingPeers && batch.done.length > 0 && !batch.answered
    }
    if (waitingPeers && named.length === 0) {
      if (!isPass(text)) {
        await postToRoom(room, member, text, { late: true, quiet: true })
          .catch(error => rt.warn('ds-bot: late group reply from %s failed: %s', member.name, error))
      }
      return
    }
    const done = isPass(text) && (shown || batchDoneBefore) && askedBy !== undefined
    if (isPass(text) && !done) return
    await postToRoom(room, member, done ? '' : text, { late: true, ...(done ? { done: true } : {}), ...(askedBy ? { askedBy } : {}) })
      .catch(error => rt.warn('ds-bot: late group reply from %s failed: %s', member.name, error))
  }
  rt.lateRoomReply = lateRoomReply

  const memberIn = (sessionId, info) => {
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info?.roomId)
    const member = rt.botOf(owner?.botId)
    return room !== undefined && member !== undefined && room.members.includes(member.id) ? { room, member } : undefined
  }
  const callsIn = (room, member, text) => mentionsIn(text, room.members.map(rt.botOf).filter(Boolean)).found.some(bot => bot.id !== member.id)
  rt.callsRoomMember = (sessionId, info, raw) => {
    const { room, member } = memberIn(sessionId, info) ?? {}
    return room !== undefined && member !== undefined && callsIn(room, member, stripOwnName(member.name, raw ?? ''))
  }

  // What a member says while it works, into the group. While the member holds its place
  // in a round, it joins that round. Later, it joins whatever round runs in the group, or
  // posts on its own. Only the members it calls with @ answer it; the member that asked
  // for the work answers the result.
  async function postStep(sessionId, info, text) {
    const waiter = info?.role === 'room' ? rt.roomWaiters.get(info.exchangeId) : undefined
    if (waiter !== undefined) return waiter.say(text)
    const { room, member } = memberIn(sessionId, info) ?? {}
    if (room === undefined) return
    ensureRoomLog(room)
    const calls = callsIn(room, member, text)
    const running = [...rt.roomProgress.values()].find(round => round.roomId === room.id)
    if (!calls && running !== undefined) {
      postInRound(room, running, member, text)
      return
    }
    const quiet = !calls
    await rt.save()
    await postToRoom(room, member, text, { progress: true, ...(quiet ? { quiet: true } : {}) })
  }

  // Lines a member writes close together reach the group as one message, so a burst of
  // steps does not come out as a string of messages. Its first line on work it was asked
  // for and a line that calls a member go at once; lines still held when the turn ends
  // open its result. Per group Session.
  const held = new Map()
  ctx.effect(() => () => { for (const entry of held.values()) clearTimeout(entry.timer) }, 'ds-bot: group step lines')
  const flushSteps = (sessionId) => {
    const entry = held.get(sessionId)
    clearTimeout(entry.timer)
    entry.timer = undefined
    if (entry.lines.length === 0) return undefined
    entry.last = Date.now()
    return postStep(sessionId, entry.info, entry.lines.splice(0).join('\n\n'))
  }
  rt.roomStepText = async (sessionId, info, raw, first) => {
    const { room, member } = memberIn(sessionId, info) ?? {}
    if (room === undefined) return
    const text = stripOwnName(member.name, raw)
    if (isPass(text)) return
    const entry = held.get(sessionId) ?? { last: 0, lines: [] }
    held.set(sessionId, entry)
    entry.info = info
    entry.lines.push(text)
    if ((first && info?.role === 'room') || callsIn(room, member, text) || Date.now() - entry.last >= ROOM_STEP_GAP_MS) return flushSteps(sessionId)
    entry.timer ??= setTimeout(() => void flushSteps(sessionId)?.catch(error => rt.warn('ds-bot: step lines from %s not posted: %s', member.name, error)), entry.last + ROOM_STEP_GAP_MS - Date.now())
  }
  rt.takeRoomSteps = (sessionId) => {
    const entry = held.get(sessionId)
    if (entry === undefined) return ''
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.last = Date.now()
    return entry.lines.splice(0).join('\n\n')
  }
  rt.withRoomSteps = (lines, reply) => (lines === '' ? reply : isPass(reply) ? lines : `${lines}\n\n${reply}`)

  // The user stops a member's work in this group from the group's details, including
  // any running DSH subagents it spawned (#701). Messages still waiting for that
  // member here go with it.
  async function stopMemberWork(roomId, botId) {
    await rt.load()
    const room = rt.roomOf(roomId)
    const member = rt.botOf(botId)
    const sessionId = rt.own(room?.sessions, botId)
    const turnRunning = sessionId !== undefined && rt.live.get(sessionId)?.turn !== undefined
    const subRunning = sessionId !== undefined && rt.hasSubagents?.(sessionId) === true
    if (room === undefined || member === undefined || sessionId === undefined || (!turnRunning && !subRunning)) return false
    dropMemberFromBatch(room, botId)
    await rt.stopSubagents?.(sessionId)
    if (turnRunning) {
      const agent = await rt.resolveAgent(sessionId)
      agent.cancel({ kind: 'user' })
    }
    await postToRoom(room, member, '', { quiet: true, stopped: true })
    return true
  }
  rt.stopMemberWork = stopMemberWork

  // The user stops everything at work in this group at once: the round the group's own
  // Session runs, which takes the member turns it started with it, then each member's
  // turn here. The round goes first, so it calls no one else meanwhile. Work the same
  // Bots do in their own chats or other groups goes on.
  async function stopRoomWork(roomId) {
    await rt.load()
    const room = rt.roomOf(roomId)
    if (room === undefined) return false
    const round = rt.roomBusy(room.id)
    if (round) (await rt.resolveAgent(room.id)).cancel({ kind: 'user' })
    let stopped = false
    for (const botId of room.members) stopped = (await stopMemberWork(room.id, botId)) || stopped
    return round || stopped
  }
  rt.stopRoomWork = stopRoomWork

  // The round said such a member posts when done; a failed model call is how it ended.
  // Nobody answers it unless other members of its batch already finished and waited on
  // the barrier for this member.
  async function lateRoomFailure(sessionId, info, failure) {
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info.roomId)
    const member = rt.botOf(owner?.botId)
    if (room === undefined || member === undefined || !room.members.includes(member.id)) return
    const batch = dropMemberFromBatch(room, member.id)
    const wakeCaller = batch !== undefined && batch.pending.size === 0 && batch.done.length > 0 && !batch.answered ? batch.by : undefined
    const { code, status, message } = failure
    await postToRoom(room, member, `Could not finish: its model call failed (${failureLine(failure)}).`, {
      late: true,
      ...(wakeCaller ? { askedBy: wakeCaller } : { quiet: true }),
      failed: { code, ...(status ? { status } : {}), message },
    }).catch(error => rt.warn('ds-bot: late group failure from %s failed: %s', member.name, error))
  }
  rt.lateRoomFailure = lateRoomFailure

  // A group the user just made opens with its admin asking what the group is for.
  async function greetRoom(roomId) {
    const room = rt.roomOf(roomId)
    if (!room?.admin) return
    const agent = await rt.resolveAgent(room.id)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '[Group chat created]' }],
      source: { kind: SOURCE_KIND, form: 'relay', role: 'kickoff', exchangeId: randomUUID(), senderName: 'You', roomId: room.id },
    }))
    await ctx.sessions.flush(agent.session)
  }
  rt.greetRoom = greetRoom

  async function reportRound(room, post, round) {
    const lines = round.replies.filter(reply => reply.kind === undefined).map(reply => `${reply.name}: ${reply.text}`)
    const waiting = round.replies.filter(reply => reply.kind === 'approval').map(reply => reply.name)
    const working = round.replies.filter(reply => reply.kind === 'working').map(reply => reply.name)
    const text = [
      lines.length > 0 ? `Replies to your post (oldest first):\n${lines.join('\n')}` : 'Nobody replied to your post.',
      working.length > 0 ? `Still working on it: ${working.join(', ')}. Each posts its result in the group when done, not to you; read_group_chat shows it.` : '',
      waiting.length > 0 ? `Waiting for the user's approval: ${waiting.join(', ')}. What they say afterwards is posted in the group, not sent to you; read_group_chat shows it.` : '',
      round.passed.length > 0 ? `Stayed silent: ${round.passed.join(', ')}.` : '',
      round.failed.length > 0 ? `Could not answer because their model call failed: ${round.replies.filter(reply => reply.kind === 'failed').map(reply => `${reply.name} (${failureLine({ code: reply.code, status: reply.status, message: reply.text })})`).join(', ')}.` : '',
    ].filter(Boolean).join('\n\n')
    // Replies the poster waited for go on with the work it posted for.
    const work = post.sub === undefined ? undefined : rt.closeWork(post.sub, `Group "${room.name}"`, text)
    await rt.deliver({ toId: post.botId, role: 'report', roomId: room.id, text, ...(work ? { work, replyTo: post.sub } : {}) })
      .catch(error => rt.warn('ds-bot: group report to %s failed: %s', post.name, error))
  }

  // A group chat's own Session never consults the model: models drift from "only call
  // group_relay" (they message one member directly when the user names it), so the
  // relay step is synthesized here. Auxiliary calls such as titles, and DS Bot's own
  // calls for the room such as image readings, still reach the model.
  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === undefined || options.purpose !== undefined || rt.ownRequest(options)) return next()
    return (async function* relayOrPass() {
      await rt.load()
      if (rt.roomOf(options.sessionId) === undefined) {
        yield* next()
        return
      }
      // Plugins append context as user-role messages (time, attachments), so only a
      // message from the user, a scheduled task, or a Bot's post after the last model or
      // tool step starts a relay.
      const opens = message => message.role === 'user'
        && (message.source?.kind === 'user' || message.source?.kind === 'schedule' || (message.source?.kind === SOURCE_KIND && (message.source.role === 'post' || message.source.role === 'kickoff')))
      const latest = [...options.messages].reverse()
        .find(message => message.role === 'assistant' || message.role === 'tool' || opens(message))
      if (latest?.role !== 'user') {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const id = `toolu_relay_${randomUUID().replace(/-/g, '')}`
      const declared = new Set((options.tools ?? []).map(tool => tool.name))
      // Only for a group made under the PTC preset, which can call nothing but run_code;
      // new group Sessions get the standard preset.
      const [name, args] = declared.has('run_code') && !declared.has('group_relay')
        ? ['run_code', JSON.stringify({ description: 'Relay the group chat to its Bots', code: 'return await tools.group_relay({})', timeoutMs: 600_000 })]
        : ['group_relay', '{}']
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })()
  })
}
