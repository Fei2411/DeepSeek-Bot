// Hand-offs: the work Bots give each other, and what each Bot is doing right now.
//
// A Bot's request to another Bot is a piece of work. What the recipient hands on while
// it works on it hangs below it, and the recipient's answer goes up only once all of
// that came back, together with what came back. Results find their way up by
// themselves, so no Bot needs to message one that waits for it, and that is the one
// hand-off refused. The open works are kept in state.json so a restart waits on.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TEXT_KEPT } from './constants.js'
import { headOf } from './text.js'

const minutes = since => {
  const count = Math.floor((Date.now() - since) / 60_000)
  return count < 1 ? 'for less than a minute' : `for ${count} min`
}

export function install(rt) {
  const { state } = rt
  const works = () => (state.works ??= {})
  // What came back, whole; state.json keeps the start of each.
  const whole = new Map()
  const save = () => void rt.save().catch(() => {})
  const nameOf = id => rt.botOf(id)?.name

  // The whole result of a work, in a file of its own: state.json is written whole on
  // every save, so it keeps only the start of a long result, and a restart would cut
  // that result short before it reached the Bot that asked for it.
  const resultsDir = join(rt.home, 'handoff-results')
  const resultPath = name => join(resultsDir, name)
  // A work id is a UUID, but a saved team could carry any name: it stays inside the
  // folder, and one that is not plain falls back to a hash of the id.
  const resultName = id => {
    const text = String(id)
    return `${/^[A-Za-z0-9_-]{1,80}$/.test(text) ? text : createHash('sha256').update(text).digest('hex')}.txt`
  }
  const keptName = file => (typeof file === 'string' && /^[A-Za-z0-9_-]+\.txt$/.test(file) ? file : undefined)
  const writes = () => rt.readOnly?.() === undefined

  // The result of a work, whole, in a file of its own. The file is written before the
  // team file names it, so a result that is claimed to exist is there.
  function keepResult(id, text) {
    if (text.length <= TEXT_KEPT || !writes()) return undefined
    const name = resultName(id)
    const path = resultPath(name)
    const temp = `${path}.${process.pid}.tmp`
    try {
      mkdirSync(resultsDir, { recursive: true })
      writeFileSync(temp, text, 'utf8')
      renameSync(temp, path)
      return name
    } catch (error) {
      rt.warn('ds-bot: result of work %s not kept whole: %s', id, error)
      try {
        rmSync(temp, { force: true })
      } catch {}
      return undefined
    }
  }

  // The copy of a result that is not needed any more: the answer it went into has it.
  const dropResult = file => {
    const name = keptName(file)
    if (name === undefined || !writes()) return
    try {
      // save() can resolve without writing during shutdown. Check the durable
      // references too, so an old state can still recover its result after restart.
      const saved = JSON.parse(readFileSync(join(rt.home, 'state.json'), 'utf8'))
      if (Object.values(saved.works ?? {}).some(work => (work.results ?? []).some(result => result.file === name))) return
      rmSync(resultPath(name), { force: true })
    } catch {}
  }

  // What came back for a work: the whole result if it is still to be found, else the
  // start of it. A result that a restart cut, or whose file is gone, is reported as
  // such and not passed on as if it were whole.
  function resultText(result) {
    if (whole.has(result.id)) return { text: whole.get(result.id), whole: true }
    if (result.length === undefined) return { text: result.text ?? '', whole: true }
    const name = keptName(result.file)
    if (name !== undefined) {
      try {
        const text = readFileSync(resultPath(name), 'utf8')
        if (text.length === result.length) return { text, whole: true }
      } catch {
        // The file is gone or unreadable: the start of the result is all there is.
      }
    }
    return { text: result.text ?? '', whole: false }
  }

  // The work a turn does: the request it answers, or the work a result that came back
  // (or a turn picked up again) goes on with.
  const workOf = info => (info === undefined ? undefined
    : info.role === 'request' && info.audience !== 'user' ? info.exchangeId : info.work)

  // `parent`: the work the sender was doing when it sent this one.
  function openWork(id, { from, to, parent, fromRoom, room }) {
    const above = parent === undefined ? undefined : works()[parent]
    works()[id] = { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(room ? { room } : {}), ...(above ? { parent } : {}), ...(fromRoom ? { fromRoom } : {}), open: [], results: [], at: Date.now() }
    if (above !== undefined) above.open.push(id)
    save()
  }

  // The answer to work `id` is on its way, with `result` from `name`. Returns the work
  // it goes on with. That work keeps waiting until a turn reads the answer (`taken`).
  function closeWork(id, name, text) {
    const work = works()[id]
    if (work === undefined) return undefined
    delete works()[id]
    // What it still waits for comes back to it alone.
    for (const child of Object.values(works())) if (child.parent === id) delete child.parent
    const above = works()[work.parent]
    if (above !== undefined) {
      // The whole result goes into a file of its own before the team file names it.
      const file = keepResult(id, text)
      above.results.push({ id, name, text: headOf(text, TEXT_KEPT), ...(text.length > TEXT_KEPT ? { length: text.length } : {}), ...(file ? { file } : {}) })
      whole.set(id, text)
    }
    for (const result of work.results ?? []) whole.delete(result.id)
    // Old state can still name these files until the replacement state lands.
    // A failed save must leave them available to the next host.
    void rt.save().then(() => {
      for (const result of work.results ?? []) dropResult(result.file)
    }).catch(() => {})
    return above === undefined ? undefined : work.parent
  }
  const dropWork = (id) => {
    const work = works()[id]
    if (work === undefined) return
    const { parent } = work
    delete works()[id]
    const above = works()[parent]
    if (above !== undefined) above.open = above.open.filter(other => other !== id)
    for (const result of work.results ?? []) whole.delete(result.id)
    void rt.save().then(() => {
      for (const result of work.results ?? []) dropResult(result.file)
    }).catch(() => {})
  }

  function taken(workId, id) {
    const work = works()[workId]
    if (work === undefined || !work.open.includes(id)) return
    work.open = work.open.filter(other => other !== id)
    save()
  }

  const owns = (botId, workId) => workId !== undefined && works()[workId]?.to === botId
  const waits = workId => (works()[workId]?.open.length ?? 0) > 0
  function hold(workId, text) {
    const work = works()[workId]
    if (work === undefined || text === '') return
    work.held = headOf(text, TEXT_KEPT)
    save()
  }
  // Who asked for the work, as the turn that answers a request sees its trigger.
  const askedBy = workId => {
    const work = works()[workId]
    return work === undefined ? undefined : { kind: 'bot', role: 'request', exchangeId: workId, senderSessionId: work.from, ...(work.fromRoom ? { senderRoomId: work.fromRoom } : {}) }
  }
  // The answer that goes up: what the Bot said last for this work, then what came back.
  function answerText(workId, reply, botName) {
    const work = works()[workId]
    const said = reply !== '' ? reply : work?.held ?? ''
    const results = (work?.results ?? []).map(result => {
      const { text, whole } = resultText(result)
      const cut = whole ? '' : `\n[cut; ${result.length} characters in all, the rest was not kept]`
      return `${result.name}:\n${text}${cut}`
    })
    if (results.length === 0) return said || `${botName} finished without a reply.`
    return [said || `${botName} finished and wrote nothing more.`, `[Handed back to ${botName} for this work]`, ...results].join('\n\n')
  }

  // The Bots waiting for the result of these works: whoever asked for each, and on up.
  function upstreamOf(workIds) {
    const bots = new Set()
    for (const workId of workIds) {
      const seen = new Set()
      for (let id = workId; id !== undefined && !seen.has(id) && works()[id] !== undefined; id = works()[id].parent) {
        seen.add(id)
        if (works()[id].from) bots.add(works()[id].from)
      }
    }
    return bots
  }

  // Two requests from one sender belong to the same work when they were sent for it.
  const sameWork = (id, parent) => (works()[id]?.parent ?? undefined) === (works()[parent] === undefined ? undefined : parent)

  // The works their Bots wait on, outside a turn that does them (`busy`): each with what
  // it handed on that has not come back yet. One that came back waits only to be read.
  const held = busy => Object.entries(works())
    .filter(([id, work]) => work.to !== undefined && work.open.length > 0 && !busy.has(id))
    .map(([id, work]) => ({ id, work, out: work.open.map(childId => works()[childId]).filter(Boolean) }))
  const busyWith = sessionIds => new Set(sessionIds.map(sessionId => rt.live.get(sessionId)).filter(entry => entry?.turn !== undefined).map(entry => workOf(entry.info)).filter(Boolean))

  // Per Bot, the Bots and groups it waits for, and the Bots it does that work for.
  function waitingView() {
    const view = {}
    const add = (list, id) => { if (id !== undefined && !list.includes(id)) list.push(id) }
    for (const { work, out } of held(busyWith([...rt.live.keys()]))) {
      if (out.length === 0) continue
      const entry = view[work.to] ??= { bots: [], rooms: [], for: [] }
      for (const child of out) add(child.room ? entry.rooms : entry.bots, child.room ?? child.to)
      add(entry.for, work.from)
    }
    return view
  }

  // A deleted Bot answers no more work and waits for none.
  function forgetBot(botId) {
    const waiting = Object.entries(works()).filter(([, work]) => work.to === botId).map(([id]) => askedBy(id))
    for (const [id, work] of Object.entries(works())) if (work.from === botId && work.to !== botId) dropWork(id)
    return waiting
  }

  // What a Bot is doing, in one line for the Bots that work with it.
  function statusOf(botId) {
    const chat = rt.chatOf(botId)
    const sessions = [...new Set([chat, ...(rt.groupSessionsOf?.(botId) ?? [])])]
    const place = sessionId => {
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      return room ? `in group "${room.name}"` : 'in its own chat'
    }
    const forWhom = (sessionId, info) => {
      if (rt.groupOwners.has(sessionId)) return info?.askedBy && nameOf(info.askedBy) ? `, for ${nameOf(info.askedBy)}` : ''
      const asker = info?.role === 'request' || info?.role === 'stopped' ? info.senderSessionId : works()[workOf(info)]?.from
      if (asker !== undefined) return nameOf(asker) ? `, for ${nameOf(asker)}` : ''
      return info === undefined ? ', for the user' : ''
    }
    const doing = (entry) => {
      const what = rt.doingOf?.(entry) ?? {}
      if (what.tool) return `: running ${what.tool}${what.target ? ` on ${what.target}` : ''}`
      return what.said ? `: "${what.said.slice(0, 100)}"` : ''
    }
    const lines = []
    const approval = (rt.approvalsView?.() ?? []).find(entry => entry.botId === botId)
    const switching = [...(rt.switchJobs?.() ?? [])].find(job => job.botId === botId)
    const running = sessions.filter(sessionId => rt.live.get(sessionId)?.turn !== undefined)
    if (approval !== undefined) lines.push(`waiting for the user's approval to run ${approval.tool || 'a tool'} ${place(approval.sessionId)} (${minutes(approval.at)})`)
    else if (switching !== undefined) lines.push(`moving on to a fresh part of its ${switching.roomId ? `conversation in group "${rt.roomOf(switching.roomId)?.name ?? '?'}"` : 'own chat'}`)
    for (const sessionId of approval === undefined && switching === undefined ? running : []) {
      const entry = rt.live.get(sessionId)
      lines.push(`working ${place(sessionId)} ${minutes(entry.since ?? Date.now())}${forWhom(sessionId, entry.info)}${doing(entry)}`)
    }
    for (const { work, out } of held(busyWith(running))) {
      if (work.to !== botId) continue
      const forName = nameOf(work.from) ? `, for ${nameOf(work.from)}` : ''
      const on = [...new Set(out.map(child => (child.room ? `group "${rt.roomOf(child.room)?.name ?? 'a group'}"` : nameOf(child.to) ?? 'a teammate')))]
      lines.push(on.length > 0 ? `waiting for ${on.join(' and ')} to hand back work${forName}` : `about to go on with work${forName}, whose results came back`)
    }
    if (lines.length === 0) lines.push('idle')
    if (state.questions?.[chat] !== undefined) lines.push('a question card in its own chat waits for the user\'s answer')
    if (state.views?.[chat] !== undefined) lines.push('a view card in its own chat waits for the user\'s answer')
    const unread = new Map()
    for (const args of rt.unreadOf?.(chat) ?? []) {
      const name = nameOf(args.fromId)
      if (name !== undefined) unread.set(name, (unread.get(name) ?? 0) + 1)
    }
    if (unread.size > 0) lines.push(`not read yet: ${[...unread].map(([name, count]) => `${count} from ${name}`).join(', ')}`)
    return lines.join('; ')
  }

  Object.assign(rt, { workOf, openWork, closeWork, dropWork, takenWork: taken, ownsWork: owns, waitsWork: waits, holdWork: hold, workAsker: askedBy, answerText, upstreamOf, sameWork, forgetBotWork: forgetBot, statusOf, waitingView })
}
