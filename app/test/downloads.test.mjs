// The main window's will-download handler: a system save dialog picks the path,
// a cancelled dialog drops the download, other contents' downloads pass through.
import assert from 'node:assert/strict'
import test from 'node:test'
import { downloadSaver } from '../src/downloads.mjs'

const item = () => ({ getFilename: () => 'chart.png', path: undefined, setSavePath(path) { this.path = path } })
const event = () => ({ prevented: false, preventDefault() { this.prevented = true } })

test('a download from the main window asks for a path and saves there', () => {
  const contents = {}
  const window = { webContents: contents }
  const calls = []
  const save = downloadSaver({
    window,
    dialog: { showSaveDialogSync: (win, options) => { calls.push({ win, options }); return '/picked/chart.png' } },
    downloads: '/downloads',
  })
  const ev = event()
  const download = item()
  save(ev, download, contents)
  assert.equal(download.path, '/picked/chart.png')
  assert.equal(ev.prevented, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].win, window)
  assert.match(calls[0].options.defaultPath, /chart\.png$/)
  assert.ok(calls[0].options.defaultPath.includes('downloads'), 'the dialog starts in the downloads folder')
})

test('a cancelled dialog drops the download', () => {
  const contents = {}
  const save = downloadSaver({ window: { webContents: contents }, dialog: { showSaveDialogSync: () => undefined }, downloads: '/downloads' })
  const ev = event()
  const download = item()
  save(ev, download, contents)
  assert.equal(ev.prevented, true)
  assert.equal(download.path, undefined)
})

test('a download from another contents passes through', () => {
  let asked = false
  const save = downloadSaver({
    window: { webContents: {} },
    dialog: { showSaveDialogSync: () => { asked = true; return '/picked' } },
    downloads: '/downloads',
  })
  const ev = event()
  const download = item()
  save(ev, download, { other: true })
  assert.equal(asked, false)
  assert.equal(download.path, undefined)
  assert.equal(ev.prevented, false)
})
