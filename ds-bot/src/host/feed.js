// The live feed: a Server-Sent Events stream of what changes, for a window that draws
// the team itself (the desktop app) instead of polling.
//   revision  the team was saved: ask for `state` again
//   live      work changed without a new revision: ask for `state` again
//   message   a new entry of a Bot's own chat, as the `chat` endpoint returns it
//   stream    the reply a Bot is writing: a start, its text as it comes, an end
//   notice    something a client that is not looking should hear about (mobile.js)
//   room      a group chat changed: ask for `room-chat` again
// `hello` carries the team's revision and, for the mobile API, its version and the
// latest notice, so a client that reconnects knows what it missed.
import { ROUTE } from './constants.js'

export const FEED_ROUTE = `${ROUTE}/feed`
// A comment line now and then keeps an idle connection open.
const KEEPALIVE_MS = 20_000
// Status changes come in bursts (a turn starts several Sessions); one notice covers them.
const LIVE_DELAY_MS = 150
// A window that stops reading is dropped once this many events wait for it; it
// reconnects and catches up from `hello`.
const MAX_QUEUED = 512

export function install(rt) {
  const { ctx, state } = rt
  const encoder = new TextEncoder()
  /** @type {Set<ReadableStreamDefaultController<Uint8Array>>} */
  const clients = new Set()
  const send = (controller, chunk) => {
    if ((controller.desiredSize ?? 0) < -MAX_QUEUED) {
      leave(controller)
      return
    }
    try { controller.enqueue(chunk) } catch { clients.delete(controller) }
  }
  // Readers of the Remote stream `dsBot/feed` (remote.js), which a relay can carry.
  /** @type {Set<(event: string, data: unknown) => void>} */
  const listeners = new Set()
  const watched = () => clients.size > 0 || listeners.size > 0
  const publish = (event, data) => {
    const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    for (const controller of clients) send(controller, chunk)
    for (const listener of listeners) listener(event, data)
  }
  const hello = () => ({ revision: state.revision, ...(rt.noticeCursor ? { api: rt.apiVersion, ...rt.noticeCursor() } : {}) })
  // The same events as the HTTP feed, starting with its `hello`; returns the unsubscribe.
  rt.subscribeFeed = (listener) => {
    listeners.add(listener)
    listener('hello', hello())
    return () => {
      listeners.delete(listener)
      if (!watched()) writing.clear()
    }
  }

  rt.stateSaved = () => {
    if (watched()) publish('revision', { revision: state.revision })
  }
  rt.publishFeed = (event, data) => {
    if (watched()) publish(event, data)
  }

  let liveTimer
  const live = () => {
    if (!watched() || liveTimer !== undefined) return
    liveTimer = setTimeout(() => {
      liveTimer = undefined
      publish('live', {})
    }, LIVE_DELAY_MS)
  }
  ctx.on('agent/status', ({ agent }) => {
    if (rt.selfOf(agent.id) !== undefined) live()
  })

  ctx.on('session/event', (session, event) => {
    if (!watched()) return
    const botId = rt.chatOwners.get(session.id)
    if (botId === undefined) return
    for (const item of rt.displayItems(session.id, [event])) publish('message', { botId, sessionId: session.id, item })
    if (event.type === 'tool/call') live()
  })

  // Attempts being streamed, by id. A turn that answers another Bot is hidden from the
  // chat (turns.js marks it before the model is called), so its text is not streamed.
  const writing = new Map()
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') {
      const botId = rt.chatOwners.get(agent.id)
      if (!watched() || botId === undefined || (state.exchangeTurns[agent.id] ?? []).includes(frame.turn)) return
      writing.set(frame.attemptId, { botId, sessionId: agent.id })
      publish('stream', { botId, sessionId: agent.id, attemptId: frame.attemptId, phase: 'start' })
      return
    }
    const target = writing.get(frame.attemptId)
    if (target === undefined) return
    if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta') publish('stream', { ...target, attemptId: frame.attemptId, text: frame.chunk.text })
    else if (frame.type === 'end') {
      writing.delete(frame.attemptId)
      publish('stream', { ...target, attemptId: frame.attemptId, phase: 'end' })
    }
  })

  const leave = (controller) => {
    clients.delete(controller)
    if (!watched()) writing.clear()
    try { controller.close() } catch { /* already closed or errored */ }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: FEED_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let controller
      const body = new ReadableStream({
        start(own) {
          controller = own
          clients.add(own)
          send(own, encoder.encode(`event: hello\ndata: ${JSON.stringify(hello())}\n\n`))
        },
        cancel() { leave(controller) },
      })
      request.signal.addEventListener('abort', () => leave(controller), { once: true })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } })
    },
  }), 'ds-bot: live feed route')

  ctx.effect(() => {
    const keepalive = setInterval(() => {
      if (clients.size > 0) for (const controller of clients) send(controller, encoder.encode(': keepalive\n\n'))
    }, KEEPALIVE_MS)
    keepalive.unref?.()
    return () => {
      clearInterval(keepalive)
      clearTimeout(liveTimer)
      for (const controller of clients) leave(controller)
    }
  }, 'ds-bot: live feed')
}
