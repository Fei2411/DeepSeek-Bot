import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { isNewer, RELEASES_URL, watchReleases, watchUpdates } from '../src/updates.mjs'

// electron-updater's AppUpdater, as far as the app uses it. `found` makes the answer of a
// check that finds a version, with the download that autoDownload starts.
class FakeUpdater extends EventEmitter {
  checks = 0
  feeds = []
  installs = []
  failCheck = false
  found = null
  // `wait` leaves the check pending, the way a slow answer from the feed would.
  wait = false
  checkForUpdates() {
    this.checks += 1
    this.emit('checking-for-update')
    if (this.failCheck) {
      const error = new Error('offline')
      this.emit('error', error)
      return Promise.reject(error)
    }
    if (this.wait) return new Promise(() => {})
    const result = this.found?.() ?? { isUpdateAvailable: false, updateInfo: { version: '0.1.7' } }
    this.emit(result.isUpdateAvailable ? 'update-available' : 'update-not-available', result.updateInfo)
    return Promise.resolve(result)
  }
  setFeedURL(options) { this.feeds.push(options) }
  quitAndInstall(...args) { this.installs.push(args) }
}

const finds = (version, download) => () => ({ isUpdateAvailable: true, updateInfo: { version }, downloadPromise: download() })

const quietLog = () => {
  const lines = []
  return { lines, info: (line) => { lines.push(line) }, error: (line) => { lines.push(line) } }
}

const release = (version, options = {}) => {
  const arch = options.arch ?? 'arm64'
  return {
    tag_name: `v${version}`,
    html_url: options.page ?? `https://github.com/Fei2411/DeepSeek-Bot/releases/tag/v${version}`,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    assets: options.assets ?? [{ name: `DeepSeek-Bot-${version}-mac-${arch}.zip` }],
  }
}

const releaseResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

describe('isNewer', () => {
  for (const [candidate, current, expected] of [
    ['0.1.8', '0.1.7', true],
    ['v0.2.0', '0.1.9', true],
    ['0.1.7', '0.1.7', false],
    ['0.1.6', '0.1.7', false],
    ['0.2.0', '0.2.0-rc.2', true],
    ['0.2.0-rc.2', '0.2.0', false],
    ['0.2.0-rc.10', '0.2.0-rc.2', true],
    ['0.1.10', '0.1.9', true],
    ['nightly', '0.1.7', false],
  ]) {
    test(`${candidate} compared with ${current}`, () => {
      assert.equal(isNewer(candidate, current), expected)
    })
  }
})

describe('watchReleases', () => {
  test('checks the latest release at once with the GitHub headers, or uses a given feed', async (t) => {
    const calls = []
    const fetch = async (url, options) => {
      calls.push({ url, options })
      return releaseResponse([release('0.1.7')])
    }
    const updates = watchReleases({ current: '0.1.7', arch: 'arm64', fetch, log: quietLog() })
    t.after(updates.stop)
    assert.equal(await updates.latest(), null)
    assert.deepEqual(calls[0], {
      url: RELEASES_URL,
      options: { headers: { accept: 'application/vnd.github+json', 'user-agent': 'DeepSeek-Bot/0.1.7' } },
    })

    const feed = 'http://127.0.0.1:8080/'
    const custom = watchReleases({ current: '0.1.7', arch: 'arm64', fetch, feed, log: quietLog() })
    t.after(custom.stop)
    await custom.latest()
    assert.equal(calls[1].url, feed)
  })

  test('reports a newer release and opens its page only when accepted', async (t) => {
    const page = 'https://github.com/Fei2411/DeepSeek-Bot/releases/tag/v0.1.9'
    for (const accepted of [true, false]) {
      const asked = []
      const opened = []
      const updates = watchReleases({
        current: '0.1.7', arch: 'arm64', fetch: async () => releaseResponse([release('0.1.9', { page })]), log: quietLog(),
        ask: async version => { asked.push(version); return accepted },
        open: url => { opened.push(url) },
      })
      t.after(updates.stop)
      assert.deepEqual(await updates.latest(), { version: '0.1.9', page })
      await sleep(0)
      assert.deepEqual(asked, ['0.1.9'])
      assert.deepEqual(opened, accepted ? [page] : [])
    }
  })

  test('ignores the same or an older release', async (t) => {
    for (const version of ['0.1.7', '0.1.6']) {
      const asked = []
      const updates = watchReleases({
        current: '0.1.7', arch: 'arm64', fetch: async () => releaseResponse([release(version)]), log: quietLog(),
        ask: async value => { asked.push(value); return true }, open: () => {},
      })
      t.after(updates.stop)
      assert.equal(await updates.latest(), null)
      assert.deepEqual(asked, [])
    }
  })

  test('asks once per version and asks again for a later version', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    let version = '0.1.9'
    let checks = 0
    const asked = []
    const updates = watchReleases({
      current: '0.1.7',
      arch: 'arm64',
      fetch: async () => { checks += 1; return releaseResponse([release(version)]) },
      ask: async value => { asked.push(value); return false },
      open: () => {},
      log: quietLog(),
    })
    t.after(updates.stop)

    await updates.latest()
    await sleep(0)
    t.mock.timers.tick(4 * 60 * 60_000)
    await updates.latest()
    await sleep(0)
    version = '0.1.10'
    t.mock.timers.tick(4 * 60 * 60_000)
    await updates.latest()
    await sleep(0)

    assert.equal(checks, 3)
    assert.deepEqual(asked, ['0.1.9', '0.1.10'])
  })

  test('reports releases without asking in throwaway runs', async (t) => {
    let opens = 0
    const updates = watchReleases({
      current: '0.1.7', arch: 'arm64', fetch: async () => releaseResponse([release('0.1.9')]),
      ask: undefined, open: () => { opens += 1 }, log: quietLog(),
    })
    t.after(updates.stop)
    assert.equal((await updates.latest()).version, '0.1.9')
    assert.equal(opens, 0)
  })

  test('logs failed requests, invalid JSON, and non-HTTPS release pages without throwing', async (t) => {
    const cases = [
      [async () => releaseResponse({}, 403), 'DeepSeek Bot: update check failed: HTTP 403'],
      [async () => { throw new Error('offline') }, 'DeepSeek Bot: update check failed: offline'],
      [async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad JSON') } }), 'DeepSeek Bot: update check failed: bad JSON'],
      [async () => releaseResponse([release('0.1.9', { page: 'http://github.com/Fei2411/DeepSeek-Bot' })]), 'DeepSeek Bot: update check failed: release page URL is not HTTPS'],
    ]
    for (const [fetch, message] of cases) {
      const log = quietLog()
      const updates = watchReleases({ current: '0.1.7', arch: 'arm64', fetch, log })
      t.after(updates.stop)
      assert.equal(await updates.latest(), null)
      assert.deepEqual(log.lines, [message])
    }
  })

  test('logs a non-array release response once', async (t) => {
    const log = quietLog()
    const updates = watchReleases({
      current: '0.1.7', arch: 'arm64', fetch: async () => releaseResponse({ releases: [] }), log,
    })
    t.after(updates.stop)
    assert.equal(await updates.latest(), null)
    assert.deepEqual(log.lines, ['DeepSeek Bot: update check failed: releases response is not an array'])
  })

  test('waits for the matching-architecture zip before asking', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    let attached = false
    const asked = []
    const updates = watchReleases({
      current: '0.1.7',
      arch: 'arm64',
      fetch: async () => releaseResponse([release('0.1.9', { arch: attached ? 'arm64' : 'x64' })]),
      ask: async version => { asked.push(version); return false },
      open: () => {},
      log: quietLog(),
    })
    t.after(updates.stop)

    assert.equal(await updates.latest(), null)
    await sleep(0)
    assert.deepEqual(asked, [])
    attached = true
    t.mock.timers.tick(4 * 60 * 60_000)
    assert.deepEqual(await updates.latest(), {
      version: '0.1.9', page: 'https://github.com/Fei2411/DeepSeek-Bot/releases/tag/v0.1.9',
    })
    await sleep(0)
    assert.deepEqual(asked, ['0.1.9'])
  })

  test('a given asset replaces the mac zip: the deb of a Linux install', async (t) => {
    const page = 'https://github.com/Fei2411/DeepSeek-Bot/releases/tag/v0.1.9'
    // The deb's file name uses the Debian architecture (x64 → amd64).
    const deb = version => `DeepSeek-Bot-${version}-linux-amd64.deb`
    // A release with only the mac zip does not count for a deb install.
    const misses = watchReleases({
      current: '0.1.7', arch: 'x64', asset: deb,
      fetch: async () => releaseResponse([release('0.1.9', { page })]), log: quietLog(),
    })
    t.after(misses.stop)
    assert.equal(await misses.latest(), null)

    const hits = watchReleases({
      current: '0.1.7', arch: 'x64', asset: deb,
      fetch: async () => releaseResponse([release('0.1.9', { page, assets: [{ name: 'DeepSeek-Bot-0.1.9-linux-amd64.deb' }] })]),
      log: quietLog(),
    })
    t.after(hits.stop)
    assert.deepEqual(await hits.latest(), { version: '0.1.9', page })
  })

  test('ignores prereleases for a stable installation', async (t) => {
    const updates = watchReleases({
      current: '0.1.7', arch: 'arm64',
      fetch: async () => releaseResponse([release('0.2.0-rc.2', { prerelease: true })]),
      log: quietLog(),
    })
    t.after(updates.stop)
    assert.equal(await updates.latest(), null)
  })

  test('includes prereleases when the installed version is a prerelease', async (t) => {
    const updates = watchReleases({
      current: '0.2.0-rc.1', arch: 'arm64',
      fetch: async () => releaseResponse([release('0.2.0-rc.2', { prerelease: true })]),
      log: quietLog(),
    })
    t.after(updates.stop)
    assert.deepEqual(await updates.latest(), {
      version: '0.2.0-rc.2', page: 'https://github.com/Fei2411/DeepSeek-Bot/releases/tag/v0.2.0-rc.2',
    })
  })

  test('ignores draft releases', async (t) => {
    const updates = watchReleases({
      current: '0.1.7', arch: 'arm64',
      fetch: async () => releaseResponse([release('0.1.9', { draft: true })]),
      log: quietLog(),
    })
    t.after(updates.stop)
    assert.equal(await updates.latest(), null)
  })

  test('chooses the highest newer release with a matching zip', async (t) => {
    const updates = watchReleases({
      current: '0.1.7', arch: 'arm64',
      fetch: async () => releaseResponse([release('0.1.9'), release('0.1.10'), release('0.1.8')]),
      log: quietLog(),
    })
    t.after(updates.stop)
    assert.deepEqual(await updates.latest(), {
      version: '0.1.10', page: 'https://github.com/Fei2411/DeepSeek-Bot/releases/tag/v0.1.10',
    })
  })

  test('logs a rejected prompt without an unhandled rejection', async (t) => {
    const unhandled = []
    const note = error => { unhandled.push(error) }
    process.on('unhandledRejection', note)
    t.after(() => { process.off('unhandledRejection', note) })
    const log = quietLog()
    const updates = watchReleases({
      current: '0.1.7', arch: 'arm64', fetch: async () => releaseResponse([release('0.1.9')]),
      ask: async () => { throw new Error('dialog failed') }, open: () => {}, log,
    })
    t.after(updates.stop)
    await updates.latest()
    await sleep(20)
    assert.deepEqual(log.lines, ['DeepSeek Bot: update 0.1.9 available', 'DeepSeek Bot: update 0.1.9 not opened: dialog failed'])
    assert.deepEqual(unhandled, [])
  })

  test('stop clears the interval', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    let checks = 0
    const updates = watchReleases({
      current: '0.1.7', arch: 'arm64',
      fetch: async () => { checks += 1; return releaseResponse([release('0.1.7')]) }, log: quietLog(),
    })
    await updates.latest()
    updates.stop()
    t.mock.timers.tick(4 * 60 * 60_000)
    assert.equal(checks, 1)
  })

  test('reports checking, then current when nothing is newer or available when one is', async (t) => {
    const none = watchReleases({
      current: '0.1.7', arch: 'arm64', fetch: async () => releaseResponse([release('0.1.7')]), log: quietLog(),
    })
    t.after(none.stop)
    assert.deepEqual(none.state(), { phase: 'checking' })
    assert.equal(await none.latest(), null)
    assert.deepEqual(none.state(), { phase: 'current' })

    const page = 'https://github.com/Fei2411/DeepSeek-Bot/releases/tag/v0.1.9'
    const found = watchReleases({
      current: '0.1.7', arch: 'arm64', fetch: async () => releaseResponse([release('0.1.9', { page })]), log: quietLog(),
    })
    t.after(found.stop)
    assert.deepEqual(await found.latest(), { version: '0.1.9', page })
    assert.deepEqual(found.state(), { phase: 'available', version: '0.1.9', page })
  })

  test('a failed check reports failed: HTTP error, bad JSON, non-array, thrown', async (t) => {
    const cases = [
      async () => releaseResponse({}, 503),
      async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad JSON') } }),
      async () => releaseResponse({ releases: [] }),
      async () => { throw new Error('offline') },
    ]
    for (const fetch of cases) {
      const updates = watchReleases({ current: '0.1.7', arch: 'arm64', fetch, log: quietLog() })
      t.after(updates.stop)
      assert.equal(await updates.latest(), null)
      assert.deepEqual(updates.state(), { phase: 'failed' })
    }
  })

  test('check() runs the same check as the timer, but not while one is on', async (t) => {
    let calls = 0
    let gate
    const updates = watchReleases({
      current: '0.1.7', arch: 'arm64',
      fetch: () => { calls += 1; return new Promise((resolve) => { gate = resolve }) },
      log: quietLog(),
    })
    t.after(updates.stop)
    assert.deepEqual(updates.state(), { phase: 'checking' })
    updates.check()
    assert.equal(calls, 1)
    gate(releaseResponse([release('0.1.7')]))
    await updates.latest()
    assert.deepEqual(updates.state(), { phase: 'current' })
    updates.check()
    assert.equal(calls, 2)
    assert.deepEqual(updates.state(), { phase: 'checking' })
    gate(releaseResponse([release('0.1.7')]))
    await updates.latest()
    assert.deepEqual(updates.state(), { phase: 'current' })
  })

  test('listeners hear every state change until they unsubscribe', async (t) => {
    const updates = watchReleases({
      current: '0.1.7', arch: 'arm64', fetch: async () => releaseResponse([release('0.1.7')]), log: quietLog(),
    })
    t.after(updates.stop)
    const seen = []
    const off = updates.subscribe(state => seen.push(state.phase))
    await updates.latest()
    assert.deepEqual(seen, ['current'])
    updates.check()
    await updates.latest()
    await sleep(0)
    assert.deepEqual(seen, ['current', 'checking', 'current'])
    off()
    updates.check()
    await updates.latest()
    await sleep(0)
    assert.deepEqual(seen, ['current', 'checking', 'current'])
  })
})

describe('watchUpdates', () => {
  test('downloads in the background, installs at the quit, and checks at once', (t) => {
    const updater = new FakeUpdater()
    t.after(watchUpdates({ updater, beforeInstall: async () => {}, log: quietLog() }).stop)
    assert.equal(updater.autoDownload, true)
    assert.equal(updater.autoInstallOnAppQuit, true)
    assert.equal(updater.checks, 1)
    assert.deepEqual(updater.feeds, [])
  })

  test('reads a given feed in place of the GitHub releases', (t) => {
    const updater = new FakeUpdater()
    t.after(watchUpdates({ updater, beforeInstall: async () => {}, feed: 'http://127.0.0.1:8080/', log: quietLog() }).stop)
    assert.deepEqual(updater.feeds, [{ provider: 'generic', url: 'http://127.0.0.1:8080/' }])
  })

  test('asks once per downloaded version, and on restart stops the Host before the installer runs', async (t) => {
    const updater = new FakeUpdater()
    const steps = []
    const asked = []
    t.after(watchUpdates({
      updater, log: quietLog(),
      ask: async (version) => { asked.push(version); return true },
      beforeInstall: async () => { await sleep(10); steps.push('host stopped') },
    }).stop)
    updater.quitAndInstall = (...args) => { steps.push(['install', ...args]) }
    updater.emit('update-downloaded', { version: '0.1.9' })
    updater.emit('update-downloaded', { version: '0.1.9' })
    await sleep(50)
    assert.deepEqual(asked, ['0.1.9'])
    assert.deepEqual(steps, ['host stopped', ['install', true, true]])
  })

  test('leaves the update for the next quit when the user says later, or when it may not ask', async (t) => {
    for (const ask of [async () => false, undefined]) {
      const updater = new FakeUpdater()
      const log = quietLog()
      let stopped = false
      t.after(watchUpdates({ updater, ask, log, beforeInstall: async () => { stopped = true } }).stop)
      updater.emit('update-downloaded', { version: '0.1.9' })
      await sleep(20)
      assert.deepEqual(updater.installs, [])
      assert.equal(stopped, false)
      assert.deepEqual(log.lines, ['DeepSeek Bot: update 0.1.9 downloaded'])
    }
  })

  test('logs a failed check and does not throw', async (t) => {
    const updater = new FakeUpdater()
    updater.failCheck = true
    const log = quietLog()
    const updates = watchUpdates({ updater, beforeInstall: async () => {}, log })
    t.after(updates.stop)
    assert.equal(await updates.latest(), null)
    assert.deepEqual(log.lines, ['DeepSeek Bot: update failed: offline'])
  })

  test('tells what the newest check found and whether its download finished', async (t) => {
    const cases = [
      [null, null],
      [finds('0.1.9', () => Promise.resolve(['installer.exe'])), true],
      [finds('0.1.9', () => Promise.reject(new Error('sha512 checksum mismatch'))), false],
    ]
    for (const [found, downloaded] of cases) {
      const updater = new FakeUpdater()
      updater.found = found
      const updates = watchUpdates({ updater, beforeInstall: async () => {}, log: quietLog() })
      t.after(updates.stop)
      const latest = await updates.latest()
      if (downloaded === null) assert.equal(latest, null)
      else {
        assert.equal(latest.version, '0.1.9')
        assert.equal(await latest.downloaded, downloaded)
      }
    }
  })

  test('a failed download, which electron-updater also reports as an error, is not left unhandled', async (t) => {
    const unhandled = []
    const note = (error) => { unhandled.push(error) }
    process.on('unhandledRejection', note)
    t.after(() => { process.off('unhandledRejection', note) })
    const updater = new FakeUpdater()
    updater.found = finds('0.1.9', () => Promise.reject(new Error('sha512 checksum mismatch')))
    t.after(watchUpdates({ updater, beforeInstall: async () => {}, log: quietLog() }).stop)
    await sleep(20)
    assert.deepEqual(unhandled, [])
  })

  test('installs on request: the Host stops first, then the installer runs and opens the app again', async (t) => {
    const updater = new FakeUpdater()
    const steps = []
    const updates = watchUpdates({ updater, beforeInstall: async () => { steps.push('host stopped') }, log: quietLog() })
    t.after(updates.stop)
    updater.quitAndInstall = (...args) => { steps.push(['install', ...args]) }
    await updates.install()
    assert.deepEqual(steps, ['host stopped', ['install', true, true]])
  })

  test('checks again every few hours until stopped', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const updater = new FakeUpdater()
    const { stop } = watchUpdates({ updater, beforeInstall: async () => {}, log: quietLog() })
    t.mock.timers.tick(4 * 60 * 60_000)
    assert.equal(updater.checks, 2)
    stop()
    t.mock.timers.tick(8 * 60 * 60_000)
    assert.equal(updater.checks, 2)
  })

  test('follows the updater events: checking, current, downloading, downloaded', (t) => {
    const updater = new FakeUpdater()
    const updates = watchUpdates({ updater, beforeInstall: async () => {}, log: quietLog() })
    t.after(updates.stop)
    // The first check already answered: nothing newer.
    assert.deepEqual(updates.state(), { phase: 'current' })
    updater.emit('checking-for-update')
    assert.deepEqual(updates.state(), { phase: 'checking' })
    updater.emit('update-available', { version: '0.1.9' })
    assert.deepEqual(updates.state(), { phase: 'downloading', version: '0.1.9' })
    updater.emit('update-downloaded', { version: '0.1.9' })
    assert.deepEqual(updates.state(), { phase: 'downloaded', version: '0.1.9' })
  })

  test('a failed check or download reports failed, unless an update is already downloaded', (t) => {
    const updater = new FakeUpdater()
    const updates = watchUpdates({ updater, beforeInstall: async () => {}, log: quietLog() })
    t.after(updates.stop)
    updater.emit('error', new Error('offline'))
    assert.deepEqual(updates.state(), { phase: 'failed' })
    updater.emit('update-available', { version: '0.1.9' })
    updater.emit('error', new Error('sha512 checksum mismatch'))
    assert.deepEqual(updates.state(), { phase: 'failed' })
    updater.emit('update-downloaded', { version: '0.1.9' })
    updater.emit('error', new Error('offline'))
    assert.deepEqual(updates.state(), { phase: 'downloaded', version: '0.1.9' })
  })

  test('check() runs the timer\'s check, but not while checking, downloading or downloaded', (t) => {
    const updater = new FakeUpdater()
    updater.wait = true
    const updates = watchUpdates({ updater, beforeInstall: async () => {}, log: quietLog() })
    t.after(updates.stop)
    // The first check is still on: the updater has not answered it yet.
    assert.deepEqual(updates.state(), { phase: 'checking' })
    updates.check()
    assert.equal(updater.checks, 1)
    updater.wait = false
    updater.emit('update-not-available')
    updates.check()
    assert.equal(updater.checks, 2)
    updater.emit('update-available', { version: '0.1.9' })
    updates.check()
    assert.equal(updater.checks, 2)
    updater.emit('update-downloaded', { version: '0.1.9' })
    updates.check()
    assert.equal(updater.checks, 2)
  })

  test('listeners hear every state change until they unsubscribe', (t) => {
    const updater = new FakeUpdater()
    const updates = watchUpdates({ updater, beforeInstall: async () => {}, log: quietLog() })
    t.after(updates.stop)
    const seen = []
    const off = updates.subscribe(state => seen.push(state.phase))
    updater.emit('checking-for-update')
    updater.emit('update-available', { version: '0.1.9' })
    assert.deepEqual(seen, ['checking', 'downloading'])
    off()
    updater.emit('update-downloaded', { version: '0.1.9' })
    assert.deepEqual(seen, ['checking', 'downloading'])
  })
})
