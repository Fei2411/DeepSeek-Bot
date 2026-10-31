// The update of the app belongs to the window: while the window is hidden or minimized, the
// box waits, and the answer the user gives when the window is back does the work itself.
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { app, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { state as updaterState, updater } from './helpers/fake-updater.mjs'
import { handOff, startApp, trayMenu, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

await installHooks()

// Exercise the Windows installer on every runner; macOS and Linux debs open a release page.
Object.defineProperty(process, 'platform', { value: 'win32' })

before(async () => { await startApp() })

test('the update waits for the window and is installed when the window comes back', async () => {
  await waitFor(() => window() !== undefined, 'open the window')
  await waitFor(() => state.tray !== undefined, 'build the tray')
  const win = window()
  hostState.release()
  // The team view is ready: the start window hands over to the team window.
  await handOff()
  // The window goes away, and the update is downloaded while it is gone.
  win.close()
  await waitFor(() => win.visible === false, 'hide the window')
  updater.emit('update-downloaded', { version: '9.9.9' })
  await new Promise(resolve => { setTimeout(resolve, 50) })
  assert.equal(state.dialogs.length, 0, 'the box waits for the window')

  // The user says yes when the window is back.
  state.dialogAnswer = { response: 0 }
  trayMenu()[0].click()
  await waitFor(() => updaterState.quitAndInstall.length === 1, 'install the update')
  assert.equal(hostState.stops, 1, 'the Host stops for the installer')
  assert.equal(updaterState.quitAndInstall[0].length, 2, 'the installer takes over')
})

test('the app ends after the update', async () => {
  app.quit()
  await waitFor(() => state.tray.destroyed === true, 'take the tray away')
})
