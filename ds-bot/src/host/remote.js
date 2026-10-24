// The client API as DSH Remote methods, for a client that reaches the host only through
// a carrier that forwards Remote methods and not Fetch routes, such as a relay
// (docs/plans/2026-10-24-mobile-api.md, "Remote methods").
//
//   dsBot/call {endpoint, payload}  one call of the api/bot channel; answers {ok, value | error}
//   dsBot/feed {}                   stream: the live feed's events as {event, data}, hello first
//
// A plain-JS plugin has no Typert generator, so the Gateway serves these methods from
// their `@Remote` markers (its source mode): simple parameter names, JSON values.
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export const RPC_NAMESPACE = 'dsBot'
// A reader that falls this far behind is ended; it opens the stream again and catches up.
const MAX_QUEUED = 512

// `@Remote` applied by hand: the decorator records its marker when an instance is made.
function decorate(Class, name, decorator) {
  const initializers = []
  decorator(Class.prototype[name], {
    kind: 'method', name, static: false, private: false, metadata: {}, addInitializer: initializer => initializers.push(initializer),
  })
  return initializers
}

// A JSON copy: the Gateway accepts only JSON values, and an answer may hold `undefined`.
const plain = value => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

// The feed as an async iterable that ends when `signal` aborts.
export async function* feedEvents(subscribe, signal) {
  const queue = []
  let wake
  let overflow = false
  const unsubscribe = subscribe((event, data) => {
    if (queue.length >= MAX_QUEUED) overflow = true
    else queue.push({ event, data: plain(data) })
    wake?.()
  })
  const aborted = () => wake?.()
  signal?.addEventListener('abort', aborted, { once: true })
  try {
    while (signal?.aborted !== true && !overflow) {
      if (queue.length === 0) await new Promise((resolve) => { wake = resolve })
      wake = undefined
      while (queue.length > 0 && signal?.aborted !== true) yield queue.shift()
    }
  } finally {
    signal?.removeEventListener('abort', aborted)
    unsubscribe()
  }
}

export function createRemoteService(rt) {
  class DsBotRemote extends TypertRemoteService {
    constructor(ctx) {
      super(ctx, RPC_NAMESPACE)
      for (const initializer of initializers) initializer.call(this)
    }

    async call(endpoint, payload) {
      return plain(await rt.channelCall(String(endpoint ?? ''), payload ?? {}))
    }

    feed(signal) {
      return feedEvents(rt.subscribeFeed, signal)
    }
  }
  const initializers = [...decorate(DsBotRemote, 'call', Remote), ...decorate(DsBotRemote, 'feed', Remote({ mode: 'stream' }))]
  return DsBotRemote
}

// Mounted only where a Typert Gateway serves Remote methods (DSH Web and Desktop); a
// test context has none.
export function install(rt) {
  const { ctx } = rt
  if (typeof ctx.inject !== 'function') return
  // The fork is not returned: Cordis would await a returned fiber before the Service it starts.
  ctx.inject(['typertGateway'], (gatewayCtx) => { gatewayCtx.plugin(createRemoteService(rt)) })
}
