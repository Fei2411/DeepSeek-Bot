// Browser profile enumeration (Chromium user-data roots, Firefox profiles.ini), the clone
// layout a harvest needs, and the process match for closing a running source on Windows.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { appBoundRows, chromiumProfiles, cloneCookieStore, cloneWorkDir, firefoxProfiles, harvestCookies, locksProfile } from '../src/browser-sources.mjs'

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'dsb-sources-test-'))
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) }
}

test('chromiumProfiles reads info_cache names and skips profiles without cookies', async () => {
  const root = await tempRoot()
  try {
    await mkdir(join(root.dir, 'Default', 'Network'), { recursive: true })
    await writeFile(join(root.dir, 'Default', 'Network', 'Cookies'), 'x')
    await mkdir(join(root.dir, 'Profile 1', 'Network'), { recursive: true })
    await writeFile(join(root.dir, 'Profile 1', 'Network', 'Cookies'), 'x')
    await mkdir(join(root.dir, 'Profile 2'), { recursive: true }) // no cookie db: not listed
    await mkdir(join(root.dir, 'System Profile', 'Network'), { recursive: true })
    await writeFile(join(root.dir, 'System Profile', 'Network', 'Cookies'), 'x')
    await writeFile(join(root.dir, 'Local State'), JSON.stringify({
      profile: { info_cache: { Default: { name: 'Person 1' }, 'Profile 1': { name: 'Work' } } },
    }))
    const profiles = await chromiumProfiles(root.dir)
    assert.deepEqual(profiles.map((p) => p.dir), ['Default', 'Profile 1'])
    assert.deepEqual(profiles.map((p) => p.name), ['Person 1', 'Work'])
    assert.equal(profiles[0].cookieDb, join(root.dir, 'Default', 'Network', 'Cookies'))
    assert.equal(profiles[0].hasCookies, true)
  } finally { await root.remove() }
})

test('firefoxProfiles reads profiles.ini', async () => {
  const root = await tempRoot()
  try {
    await mkdir(join(root.dir, 'Profiles', 'abc.default-release'), { recursive: true })
    await writeFile(join(root.dir, 'Profiles', 'abc.default-release', 'cookies.sqlite'), 'x')
    await writeFile(join(root.dir, 'profiles.ini'), [
      '[Profile0]', 'Name=default-release', 'IsRelative=1', 'Path=Profiles/abc.default-release', 'Default=1',
      '[Profile1]', 'Name=other', 'IsRelative=0', `Path=${join(root.dir, 'elsewhere')}`,
    ].join('\n'))
    const profiles = await firefoxProfiles(root.dir)
    assert.equal(profiles.length, 2)
    assert.equal(profiles[0].name, 'default-release')
    assert.equal(profiles[0].path, join(root.dir, 'Profiles', 'abc.default-release'))
    assert.equal(profiles[0].hasCookies, true)
    assert.equal(profiles[1].path, join(root.dir, 'elsewhere'))
    assert.equal(profiles[1].hasCookies, false)
  } finally { await root.remove() }
})

test('cloneCookieStore lays out Local State plus the profile cookie db', async () => {
  const root = await tempRoot()
  const work = await cloneWorkDir()
  try {
    await mkdir(join(root.dir, 'Default', 'Network'), { recursive: true })
    await writeFile(join(root.dir, 'Default', 'Network', 'Cookies'), 'db')
    await writeFile(join(root.dir, 'Default', 'Network', 'Cookies-wal'), 'wal')
    await writeFile(join(root.dir, 'Local State'), '{}')
    const source = { engine: 'chromium', profilePath: join(root.dir, 'Default'), cookieDb: join(root.dir, 'Default', 'Network', 'Cookies') }
    const copied = await cloneCookieStore(source, work.dir)
    assert.equal(copied.length, 3)
    assert.ok(existsSync(join(work.dir, 'Local State')))
    assert.ok(existsSync(join(work.dir, 'Default', 'Network', 'Cookies')))
    assert.ok(existsSync(join(work.dir, 'Default', 'Network', 'Cookies-wal')))
  } finally { await work.remove(); await root.remove() }
})

test('cloneCookieStore needs Local State: without it the clone cannot decrypt', async () => {
  const root = await tempRoot()
  const work = await cloneWorkDir()
  try {
    await mkdir(join(root.dir, 'Default', 'Network'), { recursive: true })
    await writeFile(join(root.dir, 'Default', 'Network', 'Cookies'), 'db')
    const source = { engine: 'chromium', profilePath: join(root.dir, 'Default'), cookieDb: join(root.dir, 'Default', 'Network', 'Cookies') }
    await assert.rejects(() => cloneCookieStore(source, work.dir))
  } finally { await work.remove(); await root.remove() }
})

test('cloneCookieStore for Firefox copies the sqlite family', async () => {
  const root = await tempRoot()
  const work = await cloneWorkDir()
  try {
    const profile = join(root.dir, 'Profiles', 'abc.default')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'cookies.sqlite'), 'db')
    const source = { engine: 'firefox', profilePath: profile }
    const copied = await cloneCookieStore(source, work.dir)
    assert.deepEqual(copied, [join(profile, 'cookies.sqlite')])
    assert.ok(existsSync(join(work.dir, 'cookies.sqlite')))
  } finally { await work.remove(); await root.remove() }
})

async function cookieDb(dir, rows) {
  const db = new DatabaseSync(join(dir, 'Cookies'))
  db.exec('CREATE TABLE cookies (name TEXT, host_key TEXT, path TEXT, encrypted_value BLOB)')
  const insert = db.prepare('INSERT INTO cookies (name, host_key, path, encrypted_value) VALUES (?, ?, ?, ?)')
  for (const [name, host, blob] of rows) insert.run(name, host, '/', blob)
  db.close()
}

test('appBoundRows lists v20 rows by name and domain, and counts the rest readable', async () => {
  const root = await tempRoot()
  try {
    const net = join(root.dir, 'Default', 'Network')
    await mkdir(net, { recursive: true })
    await cookieDb(net, [
      ['sid', '.example.com', Buffer.concat([Buffer.from('v20'), Buffer.alloc(29)])],
      ['old', '.example.org', Buffer.concat([Buffer.from('v10'), Buffer.alloc(20)])],
    ])
    const census = appBoundRows(join(net, 'Cookies'))
    assert.equal(census.readable, 1)
    assert.equal(census.locked.length, 1)
    assert.equal(census.locked[0].name, 'sid')
    assert.equal(census.locked[0].domain, '.example.com')
    assert.equal(census.locked[0].code, 'app-bound')
    assert.equal(appBoundRows(join(root.dir, 'nowhere')), null)
  } finally { await root.remove() }
})

test('harvestCookies refuses an all-v20 clone: launching the browser would read nothing', async () => {
  const root = await tempRoot()
  const work = await cloneWorkDir()
  try {
    const net = join(root.dir, 'Default', 'Network')
    await mkdir(net, { recursive: true })
    await writeFile(join(root.dir, 'Local State'), '{}')
    await cookieDb(net, [['sid', '.example.com', Buffer.concat([Buffer.from('v20'), Buffer.alloc(29)])]])
    const source = { engine: 'chromium', profilePath: join(root.dir, 'Default'), cookieDb: join(net, 'Cookies') }
    await assert.rejects(() => harvestCookies(source, work.dir), (error) => error.code === 'app-bound')
  } finally { await work.remove(); await root.remove() }
})

test('locksProfile matches a browser process to the user-data root it locks', () => {
  const source = { profilePath: 'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data\\Default' }
  assert.equal(locksProfile({ commandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"' }, source), true)
  assert.equal(locksProfile({ commandLine: 'chrome.exe --user-data-dir="C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data" --restore' }, source), true)
  assert.equal(locksProfile({ commandLine: 'chrome.exe --user-data-dir=D:\\other\\dir' }, source), false)
})
