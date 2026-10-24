import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { RPC_NAMESPACE, createRemoteService, feedEvents } from '../src/host/remote.js'

// A feed the test drives: subscribers get `hello` at once, then what `emit` sends.
function fakeFeed() {
  const listeners = new Set()
  return {
    listeners,
    subscribe(listener) {
      listeners.add(listener)
      listener('hello', { revision: 1, api: 1, boot: 'b', seq: 0 })
      return () => listeners.delete(listener)
    },
    emit: (event, data) => { for (const listener of listeners) listener(event, data) },
  }
}

test('the Remote service exports dsBot/call and the dsBot/feed stream to the Gateway', async (t) => {
  const feed = fakeFeed()
  const calls = []
  const rt = {
    channelCall: async (endpoint, payload) => {
      calls.push([endpoint, payload])
      return { ok: true, value: { endpoint, kept: payload.kept, dropped: undefined } }
    },
    subscribeFeed: feed.subscribe,
  }
  const ctx = new Context()
  const DsBotRemote = createRemoteService(rt)
  const fiber = ctx.plugin(DsBotRemote)
  await fiber
  t.after(() => fiber.dispose?.())
  const service = ctx.get(RPC_NAMESPACE)
  assert.ok(service, 'the service is registered under its namespace')
  // What the Gateway's source mode reads: the binding and the markers.
  assert.equal(service.typertRemote.namespace, RPC_NAMESPACE)
  assert.deepEqual(remoteMethods(service).map(marker => [marker.method, marker.mode ?? 'unary']), [['call', 'unary'], ['feed', 'stream']])

  // The answer is the channel's, as JSON: an undefined field does not cross.
  assert.deepEqual(await service.call('hello', { kept: 1 }), { ok: true, value: { endpoint: 'hello', kept: 1 } })
  assert.deepEqual(await service.call(undefined, undefined), { ok: true, value: { endpoint: '' } })
  assert.deepEqual(calls, [['hello', { kept: 1 }], ['', {}]])

  const abort = new AbortController()
  const iterator = service.feed(abort.signal)[Symbol.asyncIterator]()
  assert.deepEqual((await iterator.next()).value, { event: 'hello', data: { revision: 1, api: 1, boot: 'b', seq: 0 } })
  feed.emit('notice', { seq: 1, kind: 'message', text: 'hi', extra: undefined })
  assert.deepEqual((await iterator.next()).value, { event: 'notice', data: { seq: 1, kind: 'message', text: 'hi' } })
  const pending = iterator.next()
  abort.abort()
  assert.equal((await pending).done, true)
  assert.equal(feed.listeners.size, 0, 'an ended stream unsubscribes')
})

test('a reader that falls far behind is ended, and catches up when it opens the feed again', async () => {
  const feed = fakeFeed()
  const iterator = feedEvents(feed.subscribe, new AbortController().signal)[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.event, 'hello')
  for (let index = 0; index < 600; index += 1) feed.emit('live', {})
  let count = 0
  while (!(await iterator.next()).done) count += 1
  assert.equal(count > 0 && count <= 512, true)
  assert.equal(feed.listeners.size, 0)
})
