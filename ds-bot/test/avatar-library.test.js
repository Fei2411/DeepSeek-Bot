import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { format } from 'node:util'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Only the magic bytes matter to the reader; the rest of a fixture need not decode.
const file = (magic, size = 32) => Buffer.concat([magic, Buffer.alloc(size, 7)])
const PNG = file(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
const JPEG = file(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
const asDataUrl = (mime, bytes) => `data:${mime};base64,${bytes.toString('base64')}`
const pngUrl = asDataUrl('image/png', PNG)
const jpegUrl = asDataUrl('image/jpeg', JPEG)

function start(home) {
  const ctx = fakeContext()
  const workspaces = new Map()
  const sent = []
  let sessions = 0
  ctx.logger.warn = (...args) => sent.push(format(...args))
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async path => [...workspaces.values()].find(workspace => workspace.path === path),
      create: async path => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: () => {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const stop = async () => { await ctx.dispose() }
  return { call, stop, ctx }
}

const makeHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-avlib-'))

test('a photo imported once is kept, and the same photo again does not make a second entry', async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const { call, stop } = start(home)
  t.after(stop)

  const first = await call('avatar-import', { items: [{ name: 'team.png', image: pngUrl }] })
  assert.equal(first.ok, true)
  assert.equal(first.value.imported.length, 1)
  assert.equal(first.value.duplicates.length, 0)
  assert.equal(first.value.failed.length, 0)

  const library = (await call('avatar-library', {})).value
  assert.equal(library.items.length, 1)
  assert.equal(library.items[0].name, 'team.png')
  // The window gets the image itself, so it needs one request to draw the library.
  assert.equal(library.items[0].image, pngUrl)

  // The same picture again, even under another name, is the picture that is there.
  const again = await call('avatar-import', { items: [{ name: 'other.png', image: pngUrl }, { name: 'second.jpg', image: jpegUrl }] })
  assert.equal(again.value.imported.length, 1)
  assert.equal(again.value.duplicates.length, 1)
  assert.equal(again.value.duplicates[0].name, 'team.png')
  assert.equal(again.value.failed.length, 0)
  const after = (await call('avatar-library', {})).value
  assert.equal(after.items.length, 2)
  assert.deepEqual(after.items.map(item => item.name).sort(), ['second.jpg', 'team.png'])
})

test('a batch import partly succeeds: the good photos land, and the bad one is named', async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const { call, stop } = start(home)
  t.after(stop)

  const result = await call('avatar-import', {
    items: [
      { name: 'one.png', image: pngUrl },
      { name: 'notes.png', image: 'data:image/png;base64,bm90IGFuIGltYWdl' },
      { name: 'two.jpg', image: jpegUrl },
    ],
  })
  assert.equal(result.value.imported.length, 2)
  assert.equal(result.value.failed.length, 1)
  assert.equal(result.value.failed[0].name, 'notes.png')
  assert.match(result.value.failed[0].message, /must be a PNG, JPEG, WebP, or GIF image/)
  // The photos that were read are kept, and the library shows them.
  const library = (await call('avatar-library', {})).value
  assert.deepEqual(library.items.map(item => item.name).sort(), ['one.png', 'two.jpg'])

  // An image over the limit is refused by name too.
  const huge = asDataUrl('image/png', Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(200_000)]))
  const over = await call('avatar-import', { items: [{ name: 'huge.png', image: huge }] })
  assert.equal(over.value.imported.length, 0)
  assert.equal(over.value.failed.length, 1)
  assert.match(over.value.failed[0].message, /too large/)
  assert.equal((await call('avatar-library', {})).value.items.length, 2)
})

test('the library outlives a restart, a Bot that is deleted, and a Bot that changes its look', async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const first = start(home)
  await first.call('avatar-import', { items: [{ name: 'team.png', image: pngUrl }] })
  const entry = (await first.call('avatar-library', {})).value.items[0]

  // A Bot takes the photo from the library, and keeps its own copy of it.
  const created = await first.call('create-bot', { name: 'Writer', avatar: { shape: 'star', image: entry.image } })
  assert.equal(created.ok, true)
  const botId = created.value.id
  assert.equal((await first.call('state', {})).value.bots.find(bot => bot.id === botId).avatar.image, pngUrl)

  // The Bot changes its look and is deleted: the library keeps the photo.
  await first.call('update-bot', { id: botId, avatar: { shape: 'star' } })
  await first.call('delete-bot', { id: botId })
  assert.equal((await first.call('avatar-library', {})).value.items.length, 1)

  // A new host on the same data reads the library again.
  await first.stop()
  const second = start(home)
  t.after(second.stop)
  assert.equal((await second.call('avatar-library', {})).value.items.length, 1)
  assert.equal((await second.call('avatar-library', {})).value.items[0].image, pngUrl)
})

test('a photo that leaves the library leaves the Bots that use it alone', async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const { call, stop } = start(home)
  t.after(stop)

  await call('avatar-import', { items: [{ name: 'team.png', image: pngUrl }] })
  const entry = (await call('avatar-library', {})).value.items[0]
  const created = await call('create-bot', { name: 'Writer', avatar: { shape: 'star', image: entry.image } })
  const botId = created.value.id

  const removed = await call('avatar-delete', { id: entry.id })
  assert.equal(removed.ok, true)
  assert.equal(removed.value, true)
  assert.equal((await call('avatar-library', {})).value.items.length, 0)
  // The Bot keeps its own photo, so it still shows one.
  assert.equal((await call('state', {})).value.bots.find(bot => bot.id === botId).avatar.image, pngUrl)
  // A photo that is not there is not removed twice.
  assert.equal((await call('avatar-delete', { id: entry.id })).value, false)
})

test('the library files are named by their content, and none is left half-written', async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const { call, stop } = start(home)
  t.after(stop)

  await call('avatar-import', { items: [{ name: 'team.png', image: pngUrl }] })
  const files = readdirSync(join(home, 'avatars', 'files'))
  assert.equal(files.length, 1)
  assert.match(files[0], /^[0-9a-f]{64}\.png$/)
  // The index and the images are written whole, so no temp file is left behind.
  assert.deepEqual(readdirSync(join(home, 'avatars')).sort(), ['files', 'index.json'])
})

test('imports that overlap all land, and none is lost to another one', async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const { call, stop } = start(home)
  t.after(stop)

  // Ten imports at once: each reads the index and writes it back, so without a queue
  // the ones that overlap would drop each other's photos.
  const photos = Array.from({ length: 10 }, (_, index) => ({
    name: `photo-${index}.png`,
    image: asDataUrl('image/png', Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(index + 1, index + 1)])),
  }))
  const results = await Promise.all(photos.map(photo => call('avatar-import', { items: [photo] })))
  assert.equal(results.every(result => result.ok), true)
  const library = (await call('avatar-library', {})).value
  assert.equal(library.total, 10)
  assert.equal(library.items.length, 10)
  assert.deepEqual(library.items.map(item => item.name).sort(), photos.map(photo => photo.name).sort())
  // Every photo is on disk once, and the index names them all.
  assert.equal(readdirSync(join(home, 'avatars', 'files')).length, 10)
})

test('the library answers page by page, so a big library is not one huge reply', async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const { call, stop } = start(home)
  t.after(stop)

  const photos = Array.from({ length: 60 }, (_, index) => ({
    name: `photo-${index}.png`,
    image: asDataUrl('image/png', Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(index + 1, index + 1)])),
  }))
  await call('avatar-import', { items: photos })

  const first = (await call('avatar-library', {})).value
  assert.equal(first.total, 60)
  assert.ok(first.items.length <= 48, `the first answer carries ${first.items.length} photos, not the whole library`)
  // The newest come first.
  assert.equal(first.items[0].name, 'photo-59.png')
  // The next page starts where this one stopped.
  assert.equal(first.next, first.items.length)

  // The next page continues where the first stopped, and the two do not overlap.
  const second = (await call('avatar-library', { offset: first.next, limit: 10 })).value
  assert.equal(second.items.length, 10)
  assert.equal(second.total, 60)
  assert.equal(second.next, first.next + 10)
  const names = new Set(first.items.map(item => item.name))
  assert.equal(second.items.every(item => !names.has(item.name)), true)
  // A page past the end is empty, not an error.
  assert.equal((await call('avatar-library', { offset: 60 })).value.items.length, 0)
})

test('another dsh that holds the team cannot change the library, but may read it', async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  // The test runner's parent process: alive, on this host, and not this process.
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const { call, stop } = start(home)
  t.after(stop)

  // The window that only reads the team may look at the library.
  assert.equal((await call('avatar-library', {})).ok, true)
  // But it cannot change it.
  const refused = await call('avatar-import', { items: [{ name: 'team.png', image: pngUrl }] })
  assert.equal(refused.error.code, 'bot/read-only')
  assert.equal((await call('avatar-delete', { id: 'x' })).error.code, 'bot/read-only')
  assert.equal(existsSync(join(home, 'avatars')), false)
})

test('a Bot cannot reach the library: no tool offers it', async (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const { stop, ctx } = start(home)
  t.after(stop)

  const names = [...ctx.registeredTools.keys()]
  assert.equal(names.some(name => /avatar|library|photo/i.test(name)), false)
  // The tools that set a photo still take a path or a data URL.
  for (const name of ['create_bot', 'update_bot']) {
    const schema = ctx.registeredTools.get(name).parameters
    assert.equal(schema.properties.avatar?.type, 'string')
    assert.match(schema.properties.avatar.description, /local image path.*data URL/)
  }
  assert.equal(existsSync(join(home, 'avatars')), false)
})
