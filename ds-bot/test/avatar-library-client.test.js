import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// The client half is bundled and run with a stub for react, as the other client tests do.
const bundle = await build({
  stdin: { contents: "export { importPhotos, loadLibrary } from './src/client/avatar-library.js'", resolveDir: dirname(dirname(fileURLToPath(import.meta.url))) },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [initial, () => {}], useEffect: () => {}, useRef: current => ({ current }), Fragment: 'fragment',
}
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: name => (name === 'react' ? react : {}) })
const { importPhotos, loadLibrary } = module.exports

const photos = count => Array.from({ length: count }, (_, index) => ({ name: `photo-${index}.png`, image: 'data:image/png;base64,AA' }))

test('a batch the host refuses does not stop the batches after it', async () => {
  const sent = []
  const actions = {
    importAvatars: async (chunk) => {
      sent.push(chunk.map(photo => photo.name))
      if (sent.length === 1) throw new Error('The Bot team is open in another dsh')
      return { imported: chunk.map(photo => ({ id: photo.name, name: photo.name })), duplicates: [], failed: [] }
    },
  }
  const result = await importPhotos(photos(25), actions)

  // The first batch was refused, the second one still went.
  assert.equal(sent.length, 2)
  assert.equal(sent[0].length, 20)
  assert.equal(sent[1].length, 5)
  assert.equal(result.imported.length, 5)
  assert.equal(result.imported.map(entry => entry.name).join(','), 'photo-20.png,photo-21.png,photo-22.png,photo-23.png,photo-24.png')
  // Every photo of the refused batch is named, so none of them is silently lost.
  assert.equal(result.failed.length, 20)
  assert.equal(result.failed[0].name, 'photo-0.png')
  assert.match(result.failed[0].message, /open in another dsh/)
  // And nothing was sent twice.
  assert.equal(new Set(sent.flat()).size, 25)
})

test('a photo the host names as failed is reported, and the batch still lands', async () => {
  const actions = {
    importAvatars: async chunk => ({
      imported: chunk.filter(photo => photo.name !== 'bad.png').map(photo => ({ id: photo.name, name: photo.name })),
      duplicates: [],
      failed: [{ name: 'bad.png', message: 'The avatar must be a PNG, JPEG, WebP, or GIF image.' }],
    }),
  }
  const result = await importPhotos([{ name: 'good.png', image: 'data:image/png;base64,AA' }, { name: 'bad.png', image: 'data:image/png;base64,AA' }], actions)
  assert.equal(result.imported.length, 1)
  assert.equal(result.imported[0].name, 'good.png')
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].name, 'bad.png')
  assert.match(result.failed[0].message, /must be a PNG/)
})

test('the library is asked for page by page', async () => {
  const asked = []
  const actions = { avatarLibrary: async options => { asked.push(options); return { items: [{ id: 'a', name: 'a.png' }], total: 60 } } }
  const page = await loadLibrary(actions, { offset: 24 })
  assert.equal(asked.length, 1)
  assert.equal(asked[0].offset, 24)
  assert.equal(asked[0].limit, 24)
  assert.equal(page.total, 60)
  assert.equal(page.items.length, 1)
  assert.equal(page.next, 25)
  // A host that answers without a total still gives the window its photos.
  const bare = await loadLibrary({ avatarLibrary: async () => ({ items: [{ id: 'b' }] }) })
  assert.equal(bare.total, 1)
  assert.equal(bare.next, 1)
})
