import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { cleanVersion, install, newer, sourceOf } from '../src/host/update.js'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() }
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

// The update module alone, on a stub plugin manager and a scripted fetch.
function start({ source, registries, answers = {}, result = { application: 'restart-required' }, remove = { application: 'applied' }, config = {}, profileDir, home }) {
  const fetched = []
  const installs = []
  const removes = []
  const warnings = []
  globalThis.fetch = async (url) => {
    fetched.push(url)
    const answer = answers[url]
    if (answer === undefined) return { ok: false, status: 404, json: async () => ({}) }
    if (answer instanceof Error) throw answer
    return { ok: true, status: 200, json: async () => answer }
  }
  const pluginManager = {
    listBundles: async () => [{ name: 'other', source: 'other@^1.0.0' }, ...(source === undefined ? [] : [{ name: PKG.name, source }])],
    registries: async () => registries ?? { registry: null, fallbackRegistries: ['https://registry.npmmirror.com/'], resolved: 'https://registry.npmjs.org/' },
    installBundle: async (spec, options) => { installs.push([spec, options]); return typeof result === 'function' ? result(installs.length) : result },
    removeBundle: async (name) => { removes.push(name); return typeof remove === 'function' ? remove() : remove },
  }
  const rt = {
    ctx: { get: name => (name === 'pluginManager' ? pluginManager : name === 'profileContext' && profileDir ? { dir: profileDir } : undefined), effect() {} },
    config,
    home,
    warn: (...args) => warnings.push(args),
  }
  install(rt)
  return { rt, fetched, installs, removes, warnings }
}

test('versions compare in semver order and lose their v and build metadata', () => {
  assert.equal(cleanVersion('v1.2.3+build.5'), '1.2.3')
  assert.equal(cleanVersion('latest'), null)
  assert.equal(newer('0.2.0', '0.1.9'), true)
  assert.equal(newer('0.10.0', '0.9.0'), true)
  assert.equal(newer('1.0.0', '1.0.0'), false)
  assert.equal(newer('1.0.0', '1.0.0-beta.2'), true)
  assert.equal(newer('1.0.0-beta.10', '1.0.0-beta.2'), true)
  assert.equal(newer('0.1.0', '0.2.0'), false)
})

test('the install source decides where a newer version is looked for', () => {
  assert.deepEqual(sourceOf('ds-bot@^0.1.0'), { kind: 'registry' })
  assert.deepEqual(sourceOf('@scope/ds-bot@latest'), { kind: 'registry' })
  // A profile's own dependency entry says the same without the package name.
  assert.deepEqual(sourceOf('^0.1.0'), { kind: 'registry' })
  assert.deepEqual(sourceOf('npm:ds-bot@^0.1.0'), { kind: 'registry' })
  assert.deepEqual(sourceOf('link:E:/项目库/My Bots/ds-bot'), { kind: 'path' })
  assert.deepEqual(sourceOf('/home/user/ds-bot'), { kind: 'path' })
  assert.deepEqual(sourceOf('github:Fei2411/DeepSeek-Bot#v0.1.0&path:/ds-bot'),
    { kind: 'git', owner: 'Fei2411', repo: 'DeepSeek-Bot', ref: 'v0.1.0', rest: ['path:/ds-bot'] })
  assert.deepEqual(sourceOf('git+https://github.com/Fei2411/DeepSeek-Bot.git#main'),
    { kind: 'git', owner: 'Fei2411', repo: 'DeepSeek-Bot', rest: [] })
  assert.deepEqual(sourceOf('https://example.com/ds-bot-0.1.0.tgz'), { kind: 'tarball' })
  assert.deepEqual(sourceOf(undefined), { kind: 'unknown' })
})

test('a registry install finds the newest version on the next registry and installs it from there', async () => {
  const { rt, fetched, installs } = start({
    source: `${PKG.name}@^${PKG.version}`,
    answers: {
      [`https://registry.npmjs.org/${PKG.name}/latest`]: new Error('offline'),
      [`https://registry.npmmirror.com/${PKG.name}/latest`]: { version: '9.0.0' },
    },
    result: { application: 'restart-required', version: '9.0.0' },
  })
  const view = await rt.updateCheck()
  assert.deepEqual(fetched, [`https://registry.npmjs.org/${PKG.name}/latest`, `https://registry.npmmirror.com/${PKG.name}/latest`])
  assert.equal(view.available, true)
  assert.equal(view.latest, '9.0.0')
  assert.equal(view.current, PKG.version)
  assert.equal(view.source, 'registry')
  assert.equal(view.notesUrl, 'https://github.com/Fei2411/DeepSeek-Bot/releases')
  assert.equal(rt.updateStart().phase, 'installing')
  await flush()
  assert.deepEqual(installs, [[`${PKG.name}@9.0.0`, { registry: 'https://registry.npmmirror.com/' }]])
  const done = await rt.updateCheck()
  assert.equal(done.phase, 'installed')
  assert.equal(done.installed, '9.0.0')
  assert.equal(done.available, false)
})

test('a private registry of pnpm\'s own is asked alone, and an answer stands for a while', async () => {
  const { rt, fetched } = start({
    source: `${PKG.name}@^${PKG.version}`,
    registries: { registry: null, fallbackRegistries: ['https://registry.npmmirror.com/'], resolved: 'https://npm.corp.example/' },
    answers: { [`https://npm.corp.example/${PKG.name}/latest`]: { version: PKG.version } },
  })
  const view = await rt.updateCheck()
  assert.equal(view.available, false)
  assert.deepEqual(fetched, [`https://npm.corp.example/${PKG.name}/latest`])
  await rt.updateCheck()
  assert.equal(fetched.length, 1)
  await rt.updateCheck({ fresh: true })
  assert.equal(fetched.length, 2)
})

test('a versioned GitHub install follows the latest release tag and keeps its path', async () => {
  const { rt, installs } = start({
    source: 'github:Fei2411/DeepSeek-Bot#v0.1.0&path:/ds-bot',
    answers: { 'https://api.github.com/repos/Fei2411/DeepSeek-Bot/releases/latest': { tag_name: 'v9.1.0' } },
  })
  const view = await rt.updateCheck()
  assert.equal(view.available, true)
  assert.equal(view.latest, '9.1.0')
  rt.updateStart()
  await flush()
  assert.deepEqual(installs, [['github:Fei2411/DeepSeek-Bot#v9.1.0&path:/ds-bot', {}]])
})

test('a versioned GitHub install follows the release to the repository\'s current address', async () => {
  const { rt, installs } = start({
    source: 'github:old-owner/DeepSeek-Bot#v0.1.0&path:/ds-bot',
    answers: {
      'https://api.github.com/repos/old-owner/DeepSeek-Bot/releases/latest': {
        tag_name: 'v9.1.0',
        html_url: 'https://github.com/Fei2411/DeepSeek-Bot/releases/tag/v9.1.0',
      },
    },
  })
  const view = await rt.updateCheck()
  assert.equal(view.available, true)
  assert.equal(view.latest, '9.1.0')
  rt.updateStart()
  await flush()
  assert.deepEqual(installs, [['github:Fei2411/DeepSeek-Bot#v9.1.0&path:/ds-bot', {}]])
})

test('a linked checkout, an unversioned git install, or a disabled check never asks the network', async () => {
  for (const source of [`link:/work/${PKG.name}`, 'github:Fei2411/DeepSeek-Bot#main', undefined]) {
    const { rt, fetched } = start({ source })
    const view = await rt.updateCheck()
    assert.equal(view.available, false)
    assert.deepEqual(fetched, [])
    assert.throws(() => rt.updateStart(), /No DS Bot update/)
  }
  const { rt, fetched } = start({ source: `${PKG.name}@^${PKG.version}`, config: { updateCheck: false } })
  assert.equal((await rt.updateCheck({ fresh: true })).available, false)
  assert.deepEqual(fetched, [])
})

test('in the desktop app, which updates as a whole, it never asks the network and offers nothing', async (t) => {
  process.env.DS_BOT_APP = '1'
  t.after(() => { delete process.env.DS_BOT_APP })
  const { rt, fetched } = start({ source: `${PKG.name}@^${PKG.version}`, answers: { [`https://registry.npmjs.org/${PKG.name}/latest`]: { version: '9.0.0' } } })
  const view = await rt.updateCheck({ fresh: true })
  assert.equal(view.source, 'app')
  assert.equal(view.available, false)
  assert.deepEqual(fetched, [])
  assert.throws(() => rt.updateStart(), /No DS Bot update/)
})

test('the star count comes from the repository, is kept for an hour, and survives a failed answer', async () => {
  const repo = 'https://api.github.com/repos/Fei2411/DeepSeek-Bot'
  const answers = { [repo]: new Error('offline') }
  const { rt, fetched } = start({ source: `${PKG.name}@^${PKG.version}`, answers })
  assert.equal(rt.updateView().repoUrl, 'https://github.com/Fei2411/DeepSeek-Bot')
  assert.equal(await rt.repoStars(), null)
  answers[repo] = { stargazers_count: 42 }
  assert.equal(await rt.repoStars(), 42)
  answers[repo] = new Error('offline')
  assert.equal(await rt.repoStars(), 42)
  assert.deepEqual(fetched, [repo, repo])
})

test('without a source from the plugin manager, the profile\'s own dependency entry decides', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-update-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [PKG.name]: `^${PKG.version}` } }))
  const { rt } = start({
    profileDir: dir,
    answers: { [`https://registry.npmjs.org/${PKG.name}/latest`]: { version: '9.0.0' } },
  })
  const view = await rt.updateCheck()
  assert.equal(view.source, 'registry')
  assert.equal(view.available, true)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [PKG.name]: 'link:/work/ds-bot' } }))
  assert.equal((await rt.updateCheck({ fresh: true })).source, 'path')
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

test('a check that finds nothing clears the version a check before it found', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-update-'))
  const setSource = source => writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [PKG.name]: source } }))
  setSource(`^${PKG.version}`)
  const latest = `https://registry.npmjs.org/${PKG.name}/latest`
  const answers = { [latest]: { version: '9.0.0' } }
  const { rt } = start({ profileDir: dir, answers })
  const offered = await rt.updateCheck()
  assert.equal(offered.available, true)
  assert.equal(offered.latest, '9.0.0')
  // The profile now links a local checkout: the old registry offer must go.
  setSource('link:/work/ds-bot')
  const linked = await rt.updateCheck({ fresh: true })
  assert.equal(linked.available, false)
  assert.equal(linked.latest, null)
  assert.throws(() => rt.updateStart(), /No DS Bot update/)
  // Back on the registry with no copy answering: the offer stays cleared.
  delete answers[latest]
  setSource(`^${PKG.version}`)
  const gone = await rt.updateCheck({ fresh: true })
  assert.equal(gone.available, false)
  assert.equal(gone.latest, null)
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

test('a failed install reports why and can be tried again', async () => {
  let attempt = 0
  const { rt, installs } = start({
    source: `${PKG.name}@^${PKG.version}`,
    config: { updateRegistry: 'https://registry.example' },
    answers: { [`https://registry.example/${PKG.name}/latest`]: { version: '9.0.0' } },
    result: () => (++attempt === 1
      ? { application: 'failed', error: { code: 'incompatible-version', diagnostic: 'needs a newer DSH' } }
      : { application: 'restart-required', version: '9.0.0' }),
  })
  await rt.updateCheck()
  rt.updateStart()
  await flush()
  const failed = await rt.updateCheck()
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.error, 'needs a newer DSH')
  assert.equal(failed.available, true)
  rt.updateStart()
  await flush()
  assert.equal((await rt.updateCheck()).phase, 'installed')
  assert.equal(installs.length, 2)
  assert.deepEqual(installs[0][1], { registry: 'https://registry.example/' })
})

// Under HMR the manager refuses a spec the profile already depends on with
// 'already-installed'; the update then removes the bundle and installs it again,
// leaving a note at <home>/update.json for the start that reloads the new copy.
const NOTE = `${PKG.name}@9.0.0`
const newHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-update-home-'))
const noteIn = home => JSON.parse(readFileSync(join(home, 'update.json'), 'utf8'))

test('a plain refusal or success needs no removal and writes no note', async () => {
  const home = newHome()
  const { rt, installs, removes } = start({
    source: `${PKG.name}@^${PKG.version}`,
    config: { updateRegistry: 'https://registry.example' },
    answers: { [`https://registry.example/${PKG.name}/latest`]: { version: '9.0.0' } },
    result: { application: 'restart-required', version: '9.0.0' },
    home,
  })
  await rt.updateCheck()
  rt.updateStart()
  await flush()
  assert.equal((await rt.updateCheck()).phase, 'installed')
  assert.equal(installs.length, 1)
  assert.deepEqual(removes, [])
  assert.equal(existsSync(join(home, 'update.json')), false)
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
})

test('an already-installed refusal removes the bundle, reinstalls and leaves a note', async () => {
  const home = newHome()
  const calls = []
  const { rt, installs, removes } = start({
    source: `${PKG.name}@^${PKG.version}`,
    config: { updateRegistry: 'https://registry.example' },
    answers: { [`https://registry.example/${PKG.name}/latest`]: { version: '9.0.0' } },
    result: (count) => {
      calls.push(`install${count}`)
      return count === 1 ? { error: { code: 'already-installed' } } : { application: 'applied', version: '9.0.0' }
    },
    remove: { application: 'applied' },
    home,
  })
  await rt.updateCheck()
  rt.updateStart()
  await flush()
  assert.deepEqual(calls, ['install1', 'install2'])
  assert.deepEqual(installs, [[NOTE, { registry: 'https://registry.example/' }], [NOTE, { registry: 'https://registry.example/' }]])
  assert.deepEqual(removes, [PKG.name])
  // The note was written before the removal — and still carries no error on success.
  const note = noteIn(home)
  assert.equal(note.from, PKG.version)
  assert.equal(note.to, '9.0.0')
  assert.equal(note.spec, NOTE)
  assert.equal(typeof note.startedAt, 'string')
  assert.equal(note.error, undefined)
  assert.equal((await rt.updateCheck()).phase, 'installed')
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
})

test('a failed removal fails the update without a second install', async () => {
  const home = newHome()
  const { rt, installs, removes } = start({
    source: `${PKG.name}@^${PKG.version}`,
    config: { updateRegistry: 'https://registry.example' },
    answers: { [`https://registry.example/${PKG.name}/latest`]: { version: '9.0.0' } },
    result: count => (count === 1 ? { error: { code: 'already-installed' } } : { application: 'applied', version: '9.0.0' }),
    remove: { error: { code: 'bundle-in-use' } },
    home,
  })
  await rt.updateCheck()
  rt.updateStart()
  await flush()
  assert.equal(installs.length, 1)
  assert.deepEqual(removes, [PKG.name])
  const view = await rt.updateCheck()
  assert.equal(view.phase, 'failed')
  assert.equal(view.error, 'bundle-in-use')
  assert.equal(existsSync(join(home, 'update.json')), false)
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
})

test('a failed reinstall writes its reason into the note', async () => {
  const home = newHome()
  const { rt } = start({
    source: `${PKG.name}@^${PKG.version}`,
    config: { updateRegistry: 'https://registry.example' },
    answers: { [`https://registry.example/${PKG.name}/latest`]: { version: '9.0.0' } },
    result: count => (count === 1 ? { error: { code: 'already-installed' } } : { error: { code: 'operation-error', diagnostic: 'pnpm: tarball 500' } }),
    home,
  })
  await rt.updateCheck()
  rt.updateStart()
  await flush()
  assert.equal((await rt.updateCheck()).phase, 'failed')
  const note = noteIn(home)
  assert.equal(note.to, '9.0.0')
  assert.equal(note.error, 'pnpm: tarball 500')
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
})

test('the note for the version now running shows the update once and is consumed', async () => {
  const home = newHome()
  writeFileSync(join(home, 'update.json'), JSON.stringify({ from: '0.2.0', to: PKG.version, spec: `${PKG.name}@${PKG.version}`, startedAt: new Date().toISOString() }))
  const { rt, warnings } = start({ home })
  const view = rt.updateView()
  assert.equal(view.phase, 'updated')
  assert.equal(view.installed, PKG.version)
  assert.equal(view.available, false)
  assert.equal(existsSync(join(home, 'update.json')), false)
  assert.deepEqual(warnings, [])
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
})

test('a note for another version warns and is consumed', async () => {
  const home = newHome()
  writeFileSync(join(home, 'update.json'), JSON.stringify({ from: '0.2.0', to: '9.0.0', spec: NOTE, startedAt: new Date().toISOString(), error: 'pnpm: tarball 500' }))
  const { rt, warnings } = start({ home })
  assert.equal(rt.updateView().phase, 'idle')
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0][1] ?? warnings[0][0]), /9\.0\.0|pnpm/)
  assert.equal(existsSync(join(home, 'update.json')), false)
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
})

test('a clean note on the version that wrote it waits for a start that runs the target', async () => {
  const home = newHome()
  writeFileSync(join(home, 'update.json'), JSON.stringify({ from: PKG.version, to: '9.0.0', spec: NOTE, startedAt: new Date().toISOString() }))
  const { rt, warnings } = start({ home })
  assert.equal(rt.updateView().phase, 'idle')
  assert.deepEqual(warnings, [])
  assert.equal(existsSync(join(home, 'update.json')), true)
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
})

test('a note that cannot be read is warned about and deleted', async () => {
  const home = newHome()
  writeFileSync(join(home, 'update.json'), 'not json {')
  const { rt, warnings } = start({ home })
  assert.equal(rt.updateView().phase, 'idle')
  assert.equal(warnings.length, 1)
  assert.equal(existsSync(join(home, 'update.json')), false)
  rmSync(home, { recursive: true, force: true, maxRetries: 5 })
})
