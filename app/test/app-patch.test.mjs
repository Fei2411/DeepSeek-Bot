import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { parse } from 'yaml'
import { APP_PATCH_NAME, APP_PATCH_ROWS, writeAppPatch } from '../src/app-patch.mjs'
import { loadAppProfile } from '../src/profile.mjs'

// Every row of an entry list, with the rows inside groups.
function rows(entries) {
  return entries.flatMap((entry) => [
    entry,
    ...rows(Array.isArray(entry.config) ? entry.config : []),
    ...rows(Array.isArray(entry.config?.plugins) ? entry.config.plugins : []),
  ])
}

describe('writeAppPatch', () => {
  let home
  before(() => { home = mkdtempSync(join(tmpdir(), 'ds-bot-app-patch-')) })
  after(() => { rmSync(home, { recursive: true, force: true }) })

  test('writes one row that turns off the automatic credential step, next to the profiles', () => {
    const dir = join(home, 'profiles', 'ds-bot')
    mkdirSync(dir, { recursive: true })
    const [file, ...more] = writeAppPatch({ dir, patchPath: join(dir, 'cordis.patch.yml') })
    assert.deepEqual(more, [])
    // Outside the profile directory itself, so DSH only reads it through patchFiles.
    assert.equal(file, join(home, 'profiles', APP_PATCH_NAME))
    assert.deepEqual(parse(readFileSync(file, 'utf8')), [
      { id: 'ui-settings-models', name: '@deepseek-ai/dsh-client-ui-settings-models', config: { credentialOnboarding: false } },
    ])
  })

  test('writes the file again on every launch and never carries a Settings page row', () => {
    const dir = join(home, 'profiles', 'ds-bot')
    const file = join(home, 'profiles', APP_PATCH_NAME)
    writeFileSync(file, '- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: x\n')
    writeAppPatch({ dir })
    const written = parse(readFileSync(file, 'utf8'))
    assert.deepEqual(written, APP_PATCH_ROWS)
    assert.equal(written.some(row => row.id === 'ui-settings-general'), false)
  })
})

describe('the overlay on the pinned DSH', () => {
  let home
  let profile
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'ds-bot-app-patch-profile-'))
    process.env.DSH_HOME = home
    profile = loadAppProfile()
  })
  after(() => { rmSync(home, { recursive: true, force: true }) })

  // A row DSH renamed would only log a warning, and a config key DSH added would be wiped.
  test('targets a row the app profile mounts, whose whole config it restates', () => {
    const entries = rows(composeEntries([...profile.layers.map(layer => layer.patches), profile.patches]))
    const [patched] = APP_PATCH_ROWS
    const row = entries.find(entry => entry.id === patched.id)
    assert.ok(row, `${patched.id} is in the app profile`)
    assert.equal(row.name, patched.name)
    assert.notEqual(row.disabled, true)
    assert.deepEqual(Object.keys(row.config ?? {}).filter(key => !(key in patched.config)), [])
  })

  test('sets credentialOnboarding to false once laid over the profile', () => {
    const [file] = writeAppPatch(profile)
    assert.equal(dirname(file), dirname(profile.dir))
    const layers = [...profile.layers.map(layer => layer.patches), profile.patches, parse(readFileSync(file, 'utf8'))]
    const row = rows(composeEntries(layers)).find(entry => entry.id === 'ui-settings-models')
    assert.deepEqual(row.config, { credentialOnboarding: false })
  })
})
