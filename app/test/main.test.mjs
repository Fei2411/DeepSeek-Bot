// The main process of the app: the window hides instead of closing, the tray is the way
// back to it, and a window that is gone for good is built anew and talks to the Host that
// runs. The Electron parts are test doubles: no display, no DSH, no data of the user.
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { handOff, startApp, teamWindows, trayMenu, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

before(async () => { await startApp() })

test('the app starts with a window and a tray', async () => {
  await waitFor(() => window() !== undefined, 'open the window')
  await waitFor(() => state.tray !== undefined, 'build the tray')
  assert.equal(state.tray.tooltip, 'DeepSeek Bot')
  assert.equal(state.quits, 0, 'the app goes on')
})

test('the first window trades the launch URL for the Host\'s cookie', async () => {
  const win = window()
  hostState.release()
  await waitFor(() => win.loaded.some(url => url.includes('token=')), 'reach the Host')
  assert.equal(win.loaded.filter(url => url.includes('token=')).length, 1, 'the token is used once')
  assert.equal(state.cookies.length, 1, 'the Host left a cookie for its address')
  // The team view is ready: the start window hands over to the team window.
  await handOff()
})

test('a window that is gone for good is built anew and talks to the same Host', async () => {
  const first = window()
  first.destroy()
  trayMenu()[0].click()
  await waitFor(() => teamWindows().length === 2, 'build a new window')
  const second = window()
  await waitFor(() => second.loaded.some(url => url.startsWith('http://127.0.0.1:')), 'reach the Host')
  assert.equal(second.loaded.filter(url => url.includes('token=')).length, 0, 'the token is not used again')
  assert.equal(hostState.starts, 1, 'no second Host was started')
})

test('closing the window hides it; the app goes on', async () => {
  const win = window()
  win.close()
  await waitFor(() => win.visible === false, 'hide the window')
  assert.equal(win.isDestroyed(), false, 'the window is there')
  assert.equal(state.quits, 0, 'the app goes on')
  assert.equal(hostState.stops, 0, 'the Host goes on')
  assert.equal(state.dialogs.length, 0, 'the notice was answered already')
})

test('the tray opens the window again', async () => {
  const win = window()
  trayMenu()[0].click()
  await waitFor(() => win.visible === true, 'show the window')
  assert.equal(win.focused > 0, true, 'the window has the focus')
})

test('the tray quit ends the app and stops the Host', async () => {
  trayMenu().at(-1).click()
  await waitFor(() => state.quits > 0, 'end the app')
  await waitFor(() => hostState.stops === 1, 'stop the Host')
  await waitFor(() => state.tray.destroyed === true, 'take the tray away')
})
