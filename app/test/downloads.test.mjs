// The main window's will-download handler: a system save dialog picks the path,
// a cancelled dialog drops the download, other contents' downloads pass through.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { downloadSaver } from '../src/downloads.mjs'

const item = () => ({ getFilename: () => 'chart.png', path: undefined, setSavePath(path) { this.path = path } })
const event = () => ({ prevented: false, preventDefault() { this.prevented = true } })
const folders = { downloads: '/downloads', home: '/home/me' }
const getPath = name => folders[name]
const unresolved = name => { throw new Error(`Failed to get '${name}' path`) }

// The folder the save dialog starts in when the main window downloads chart.png.
function startPath({ getPath, homedir }) {
  const contents = {}
  let options
  const save = downloadSaver({ window: { webContents: contents }, dialog: { showSaveDialogSync: (_win, given) => { options = given; return '/picked/chart.png' } }, getPath, homedir })
  save(event(), item(), contents)
  return options.defaultPath
}

test('a download from the main window asks for a path and saves there', () => {
  const contents = {}
  const window = { webContents: contents }
  const calls = []
  const save = downloadSaver({
    window,
    dialog: { showSaveDialogSync: (win, options) => { calls.push({ win, options }); return '/picked/chart.png' } },
    getPath,
  })
  const ev = event()
  const download = item()
  save(ev, download, contents)
  assert.equal(download.path, '/picked/chart.png')
  assert.equal(ev.prevented, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].win, window)
  assert.equal(calls[0].options.defaultPath, join('/downloads', 'chart.png'), 'the dialog starts in the downloads folder')
})

test('the downloads folder is looked up for each download, not when the handler is made', () => {
  const asked = []
  const contents = {}
  const save = downloadSaver({ window: { webContents: contents }, dialog: { showSaveDialogSync: () => undefined }, getPath: (name) => { asked.push(name); return folders[name] } })
  assert.deepEqual(asked, [])
  save(event(), item(), contents)
  save(event(), item(), contents)
  assert.deepEqual(asked, ['downloads', 'downloads'])
})

test('a downloads folder that does not resolve falls back to the home folder', () => {
  const homeOnly = name => name === 'home' ? folders.home : unresolved(name)
  assert.equal(startPath({ getPath: homeOnly, homedir: () => '/os-home' }), join('/home/me', 'chart.png'))
  assert.equal(startPath({ getPath: unresolved, homedir: () => '/os-home' }), join('/os-home', 'chart.png'))
})

test('without any folder the dialog still opens, with only the file name', () => {
  const noHome = () => { throw new Error('no home') }
  assert.equal(startPath({ getPath: unresolved, homedir: noHome }), 'chart.png')
  assert.equal(startPath({ getPath: () => '', homedir: () => '' }), 'chart.png')
})

test('a cancelled dialog drops the download', () => {
  const contents = {}
  const save = downloadSaver({ window: { webContents: contents }, dialog: { showSaveDialogSync: () => undefined }, getPath })
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
    getPath,
  })
  const ev = event()
  const download = item()
  save(ev, download, { other: true })
  assert.equal(asked, false)
  assert.equal(download.path, undefined)
  assert.equal(ev.prevented, false)
})

test('the window is asked for at the moment of the download, because the app may build a new one', () => {
  const contents = {}
  const calls = []
  let window = { webContents: {} }
  const save = downloadSaver({
    window: () => window,
    dialog: { showSaveDialogSync: (win) => { calls.push(win); return '/picked/chart.png' } },
    getPath,
  })
  // A new window took the place of the old one.
  window = { webContents: contents }
  save(event(), item(), contents)
  assert.equal(calls.length, 1)
  assert.equal(calls[0], window, 'the dialog belongs to the current window')
})

test('a download without a window passes through', () => {
  let asked = false
  const save = downloadSaver({
    window: () => undefined,
    dialog: { showSaveDialogSync: () => { asked = true; return '/picked' } },
    getPath,
  })
  const ev = event()
  const download = item()
  save(ev, download, { webContents: {} })
  assert.equal(asked, false)
  assert.equal(download.path, undefined)
  assert.equal(ev.prevented, false)
})
