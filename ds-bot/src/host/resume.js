// Resume: Bot work that DeepSeek Harness dropped when it closed or restarted. DSH closes
// a turn it never finished as interrupted when the Session next opens, and a clean
// shutdown also cancels the messages still waiting in a Session's inbox; nothing would
// ever run either again, and whoever waited for them was not told. DS Bot notes each
// running Bot turn and each message it delivers until a turn takes it up, in
// inflight.json; what is still noted at the next start is picked up once.
//
// A turn that ends while DS Bot is not watching it (the plugin reloaded, DSH went on)
// is settled from the Session's durable log: an answer that was produced goes to the Bot
// that waits for it, and an outcome that cannot be read is said to be unknown. The
// request itself is never sent again there.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HISTORY_TIMEOUT_MS, MESSAGE_INLINE_MAX, SOURCE_KIND } from './constants.js'
import { answerSender, failureLine, turnFailure } from './turns.js'
import { textOf } from './text.js'

// Long enough for DSH to finish opening its workspaces after a start.
export const RESUME_DELAY_MS = 3000
// A delivery waiting longer than this was not lost to a restart.
const QUEUED_KEPT_MS = 24 * 60 * 60 * 1000
const QUEUED_MAX = 50

export const resumeText = record => [
  'DeepSeek Harness restarted while you were working on this, so your last turn stopped before it finished.',
  record.approval ? `You were waiting for the user's approval to run ${record.approval.tool || 'a tool'}${record.approval.reason ? ` (${record.approval.reason})` : ''}; that request is gone, so ask again if you still need it.` : '',
  'Check what is already done (files, commands, messages) before you repeat anything, then finish the task and give your reply.',
].filter(Boolean).join(' ')

// The turns of a Session's durable log, each with the exchanges it took up, what it
// said and how it ended.
export function turnsOf(events) {
  const turns = []
  let current
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data?.turn, took: [], texts: [], reason: undefined }
      turns.push(current)
      continue
    }
    if (current === undefined) continue
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.exchangeId !== undefined) current.took.push(source)
      continue
    }
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text !== '') current.texts.push(text)
      continue
    }
    if (event.type === 'turn/end') current.reason = event.data?.reason
  }
  return turns
}

// The last turn that took up an exchange: what it said and how it ended.
export function turnOf(events, exchangeId) {
  const turns = turnsOf(events)
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    if (turns[at].took.some(source => source.exchangeId === exchangeId)) return turns[at]
  }
  return undefined
}

// Whether a Session already holds the answer to an exchange.
export function answeredIn(events, exchangeId) {
  return events.some(event => event.type === 'user/message' && event.data?.source?.replyTo === exchangeId)
}

// The trigger fields a resumed turn needs to answer the same sender.
const triggerOf = info => ({
  role: info.role,
  ...(info.exchangeId ? { exchangeId: info.exchangeId } : {}),
  ...(info.senderSessionId ? { senderSessionId: info.senderSessionId } : {}),
  ...(info.roomId ? { roomId: info.roomId } : {}),
  ...(info.work ? { work: info.work } : {}),
  ...(info.audience ? { audience: info.audience } : {}),
  ...(info.askedBy ? { askedBy: info.askedBy } : {}),
  ...(info.senderRoomId ? { senderRoomId: info.senderRoomId } : {}),
})

const readNotes = (file) => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const object = value => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})
    return { turns: object(parsed?.turns), queued: object(parsed?.queued) }
  } catch {
    return { turns: {}, queued: {} }
  }
}

export function install(rt) {
  const { ctx, home } = rt
  const file = join(home, 'inflight.json')

  // What the last run left; read before this run notes anything.
  let interrupted = readNotes(file)

  /** @type {Record<string, {botId:string, roomId?:string, since:number, trigger?:any, approval?:{tool:string, reason:string}, resumed?:boolean}>} */
  let turns = {}
  /** @type {Record<string, {at:number, args:any}[]>} deliveries no turn has taken up, by Session */
  let queued = {}
  let writing = Promise.resolve()
  let stopped = false
  let latest
  let due = false
  const persist = () => {
    // Only the host that saves the team runs its work again.
    if (stopped || rt.readOnly() !== undefined) return
    latest = JSON.stringify({ turns, queued })
    // One write waits at a time and takes the latest notes, so a busy round does not
    // write the file once per change.
    if (due) return
    due = true
    // Written in place: a rename over the file fails on Windows while anything reads
    // it, and a torn write only loses what one restart would pick up.
    writing = writing.then(async () => {
      due = false
      const snapshot = latest
      await mkdir(home, { recursive: true })
      await writeFile(file, snapshot, 'utf8')
    }).catch(error => rt.warn('ds-bot: noting running turns failed: %s', error))
  }
  const update = (id, change) => {
    const next = change(turns[id])
    if (next === turns[id]) return
    turns = { ...turns }
    if (next === undefined) delete turns[id]
    else turns[id] = next
    persist()
  }
  const forgetQueued = (exchangeId) => {
    for (const [sessionId, list] of Object.entries(queued)) {
      const at = list.findIndex(item => item.args.exchangeId === exchangeId)
      if (at === -1) continue
      const rest = list.toSpliced(at, 1)
      queued = { ...queued }
      if (rest.length === 0) delete queued[sessionId]
      else queued[sessionId] = rest
      persist()
      return
    }
  }

  const deliver = rt.deliver
  rt.deliver = async (args) => {
    const noted = { ...args, exchangeId: args.exchangeId ?? randomUUID() }
    const sessionId = noted.sessionId ?? rt.chatOf(noted.toId)
    // Noted before it is sent: a turn may take it up before the send returns.
    queued = { ...queued, [sessionId]: [...(queued[sessionId] ?? []), { at: Date.now(), args: noted }].slice(-QUEUED_MAX) }
    persist()
    try {
      return await deliver(noted)
    } catch (error) {
      forgetQueued(noted.exchangeId)
      throw error
    }
  }

  // What a Session was sent and no turn has read yet.
  rt.unreadOf = sessionId => (queued[sessionId] ?? []).map(item => item.args)
  rt.forgetDelivery = forgetQueued

  // A message is done with once a turn takes it up, or once it leaves the inbox untaken
  // while DS Bot runs: the user stopped the Bot, or DS Bot moved or withdrew it.
  ctx.on('agent/inbox/discarded', ({ message } = {}) => {
    if (message?.source?.kind === SOURCE_KIND && message.source.exchangeId) forgetQueued(message.source.exchangeId)
  })
  // Exchanges a turn took up since this start, until the resends are done, so a resend
  // never repeats one.
  let taken = Object.keys(interrupted.queued).length > 0 ? new Set() : undefined
  // The first turn event of each Session since this start, until the noted turns are
  // picked up. A turn that ends, or still runs, before one starts here outlived the
  // last run: only DS Bot restarted (the plugin reloaded) and DSH went on.
  let firstTurn = Object.keys(interrupted.turns).length > 0 ? new Map() : undefined
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (id === undefined) return
    if ((event.type === 'turn/start' || event.type === 'turn/end') && firstTurn?.has(id) === false) {
      firstTurn.set(id, { type: event.type, turn: event.data?.turn, reason: event.data?.reason })
    }
    if (event.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND && event.data.source.exchangeId) {
      taken?.add(event.data.source.exchangeId)
      forgetQueued(event.data.source.exchangeId)
    }
    if (!rt.isBotSession(id)) return
    switch (event.type) {
      case 'turn/start': {
        const owner = rt.groupOwners.get(id)
        const botId = owner?.botId ?? rt.chatOwners.get(id)
        update(id, () => ({ botId, ...(owner ? { roomId: owner.roomId } : {}), since: event.time ?? Date.now() }))
        break
      }
      case 'user/message': {
        if (event.data?.source?.kind !== SOURCE_KIND) break
        // turns.js, installed earlier, has already claimed the turn's trigger.
        const info = rt.live.get(id)?.info
        update(id, record => (record === undefined || record.trigger !== undefined || info === undefined ? record
          : { ...record, trigger: triggerOf(info), ...(info.resumed ? { resumed: true } : {}) }))
        break
      }
      case 'turn/end': {
        // DSH stops every turn as it shuts down; that one is picked up at the next start.
        const reason = event.data?.reason
        if (reason?.kind === 'aborted' && reason.reason?.kind === 'disposed') break
        update(id, () => undefined)
        break
      }
    }
  })

  // An approval the restart drops is named when the turn is picked up.
  rt.noteApproval = (sessionId, approval) => update(sessionId, record => (record === undefined ? record
    : approval === undefined ? (({ approval: _, ...rest }) => rest)(record) : { ...record, approval }))

  async function resumeTurn(sessionId, record) {
    const bot = rt.botOf(record.botId)
    if (bot === undefined) return
    const text = resumeText(record)
    if (record.roomId !== undefined) {
      const room = rt.roomOf(record.roomId)
      if (room === undefined || !room.members.includes(bot.id)) return
      await rt.postToRoom(room, bot, '', { resumed: true, quiet: true, ...(record.resumed ? { again: true } : {}) })
      // A turn already picked up once and cut off again stays stopped: a restart loop
      // must not run it forever.
      if (record.resumed) return
      await rt.deliver({ toId: bot.id, sessionId: room.sessions?.[bot.id] ?? sessionId, role: 'room', roomId: room.id, note: 'picking up after a restart', resumed: true, text, ...(record.trigger?.askedBy ? { askedBy: record.trigger.askedBy } : {}) })
      return
    }
    if (record.resumed) return
    const trigger = record.trigger
    if ((trigger?.role === 'request' || trigger?.role === 'stopped') && trigger.senderSessionId && trigger.audience !== 'user' && rt.botOf(trigger.senderSessionId)) {
      // The sender still waits for this turn's answer, so it goes on under the same exchange.
      await rt.deliver({ fromId: trigger.senderSessionId, toId: bot.id, role: trigger.role, ...(trigger.exchangeId ? { exchangeId: trigger.exchangeId } : {}), ...(trigger.senderRoomId ? { fromRoomId: trigger.senderRoomId } : {}), resumed: true, text })
      return
    }
    // A turn that went on with work another Bot asked for still owes that Bot its answer.
    await rt.deliver({ toId: bot.id, role: 'resume', resumed: true, text, ...(trigger?.work ? { work: trigger.work } : {}) })
  }

  // A hard stop keeps the inbox, which the Session runs once it wakes; only what DSH
  // cancelled is sent again.
  async function resendQueued(sessionId, list) {
    // A Session that moved on to a new part since is reached at its current one.
    const current = (args) => {
      if (rt.isBotSession(sessionId)) return sessionId
      return args.roomId === undefined ? rt.chatOf(args.toId) : rt.roomOf(args.roomId)?.sessions?.[args.toId]
    }
    const fresh = list.filter(item => Date.now() - item.at < QUEUED_KEPT_MS && rt.botOf(item.args?.toId) !== undefined
      && current(item.args) !== undefined && taken?.has(item.args.exchangeId) !== true)
    if (fresh.length === 0) return
    const target = current(fresh[0].args)
    const agent = await rt.resolveAgent(target)
    const waiting = new Set([...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])].map(message => message.source?.exchangeId))
    for (const { args } of fresh) {
      if (waiting.has(args.exchangeId) || taken?.has(args.exchangeId) === true) continue
      await rt.deliver({ ...args, sessionId: current(args), steer: false, resent: true })
    }
  }

  // A Session's durable log, as DSH keeps it: what happened there, and what it said.
  // Undefined when this DSH cannot read it, or when the Session is gone.
  async function logOf(sessionId) {
    const inspect = ctx.sessionController?.inspect
    if (typeof inspect !== 'function') return undefined
    const seen = await inspect(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS)).catch(() => undefined)
    return Array.isArray(seen?.events) ? seen.events : undefined
  }

  // A turn that ended while DS Bot was not watching it: its answer may exist and never
  // have gone to the Bot that waits for it. The Session's durable log says what it did;
  // the work it was for is settled once, the way a finished turn settles it.
  async function reconcileEnded(sessionId, record, ended) {
    const trigger = record.trigger
    if (trigger === undefined) return
    if (trigger.role !== 'request' || trigger.audience === 'user') return
    const exchangeId = trigger.exchangeId
    const sender = trigger.senderSessionId
    if (exchangeId === undefined || sender === undefined || rt.botOf(sender) === undefined) return
    // The work it was for: gone when the answer already went up.
    const work = rt.state.works?.[exchangeId]
    if (work === undefined) return
    const name = rt.botOf(rt.selfOf(sessionId))?.name ?? 'The other Bot'
    const asker = rt.workAsker(exchangeId)
    if (asker === undefined) return
    // DSH stopped that turn as it shut down: it is picked up at the next start.
    if (ended.reason?.kind === 'aborted' && ended.reason.reason?.kind === 'disposed') {
      update(sessionId, () => record)
      return
    }
    const events = await logOf(sessionId)
    if (events === undefined) {
      // The record of that work cannot be read: whether it answered cannot be
      // established. The sender is told that, and the work is not run again.
      const why = 'the record of that work could not be read'
      const text = `${name} could not answer your message: ${why}, so what it did is unknown (its session is ${sessionId}). It may have done part of the work. Tell the user if it matters; do not run the work again without asking.`
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      rt.noteFailure?.({
        level: 'warn',
        source: 'turn',
        text: `the result of the work ${name} was given is unknown`,
        bot: name,
        where: room === undefined ? 'own chat' : `group "${room.name}"`,
        sessionId,
      })
      answerSender(rt, sessionId, asker, text)
      return
    }
    const turn = turnOf(events, exchangeId)
    // The request was never taken up: it is still waiting, and the delivery that is
    // waiting for it keeps what it had.
    if (turn === undefined) return
    const said = turn.texts.join('\n\n')
    // The answer went up in another run: the work closes with what it said, and
    // nothing is sent twice.
    const back = rt.roomOf(trigger.senderRoomId)?.sessions?.[sender]
    const sent = await logOf(back ?? rt.chatOf(sender))
    if (sent !== undefined && answeredIn(sent, exchangeId)) {
      rt.closeWork?.(exchangeId, name, rt.answerText(exchangeId, said, name))
      return
    }
    const reason = turn.reason
    // A turn that went on to a fresh part goes on there; it is not settled here.
    if (reason?.kind === 'blocked') return
    // The turn was cut off before it finished: the work is picked up again, as after
    // a restart that cut it off.
    if (reason === undefined || reason.kind === 'interrupted') {
      await resumeTurn(sessionId, record)
      return
    }
    if (reason.kind === 'error') {
      const failure = turnFailure(reason.error)
      answerSender(rt, sessionId, asker, `${name} could not answer your message: its model call failed (${failureLine(failure)}). Tell the user if it matters; do not retry right away.`)
      return
    }
    if (reason.kind === 'aborted') {
      // The turn was stopped before it could answer: the sender is told, as it is told
      // when DS Bot watches the turn end.
      answerSender(rt, sessionId, asker, `${name} was stopped before it could answer your message.`)
      return
    }
    // The turn ended with what it said: the answer goes up the way a finished turn's
    // does, with the results that came back for it and the text it held. A work that
    // still waits for what it handed on keeps its part until that comes back.
    if (rt.waitsWork(exchangeId)) {
      rt.holdWork(exchangeId, said)
      return
    }
    const text = rt.answerText(exchangeId, said, name)
    const long = text.length > MESSAGE_INLINE_MAX ? await rt.attachLong(text, `Answer from ${name}.txt`) : undefined
    answerSender(rt, sessionId, asker, text, long)
  }

  async function resumeAll() {
    await rt.load()
    if (rt.readOnly() !== undefined) return
    const { turns: noted, queued: dropped } = interrupted
    interrupted = { turns: {}, queued: {} }
    // Taken up now, so another restart does not pick them up twice.
    persist()
    // Agents and inboxes are read before anything wakes their Sessions.
    const cut = []
    for (const [sessionId, record] of Object.entries(noted)) {
      const first = firstTurn.get(sessionId)
      if (first?.type === 'turn/end') {
        // The turn ended while DS Bot was not watching it: what it did is settled from
        // the Session's durable log.
        await reconcileEnded(sessionId, record, first).catch(error => rt.warn('ds-bot: settling the work of %s failed: %s', sessionId, error))
        continue
      }
      // Still running: noted again, as if it had started here.
      if (first === undefined && (await rt.resolveAgent(sessionId).catch(() => undefined))?.status === 'running') update(sessionId, () => record)
      else cut.push([sessionId, record])
    }
    firstTurn = undefined
    for (const [sessionId, list] of Object.entries(dropped)) {
      if (!Array.isArray(list)) continue
      await resendQueued(sessionId, list).catch(error => rt.warn('ds-bot: sending again what %s was sent failed: %s', sessionId, error))
    }
    taken = undefined
    for (const [sessionId, record] of cut) {
      await resumeTurn(sessionId, record).catch(error => rt.warn('ds-bot: picking up the turn of %s failed: %s', sessionId, error))
    }
  }

  ctx.effect(() => {
    const pending = Object.keys(interrupted.turns).length > 0 || Object.keys(interrupted.queued).length > 0
    const timer = pending ? setTimeout(() => void resumeAll().catch(error => rt.warn('ds-bot: picking up interrupted work failed: %s', error)), RESUME_DELAY_MS) : undefined
    timer?.unref?.()
    // What the turns stopped by this shutdown left stays as last noted.
    return () => {
      stopped = true
      clearTimeout(timer)
      return writing
    }
  }, 'ds-bot: resume interrupted turns')
}
