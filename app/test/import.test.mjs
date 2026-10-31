import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { parse } from 'yaml'
import { copySessions, findTeam, importTeam, newerSessions, sessionIdsOf, teamInUse, userDshHome } from '../src/import.mjs'

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
// The import's stage folders in a data location.
const staged = to => readdirSync(to).filter(name => /^\.import-\d+$/u.test(name))

function treeHash(dir) {
  const hash = createHash('sha256')
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) walk(path)
      else hash.update(relative(dir, path)).update(readFileSync(path))
    }
  }
  walk(dir)
  return hash.digest('hex')
}

// A user's DSH home: Chief in two parts, Writer, a group where Chief is in two parts and
// which has its own Session, the team's own files, two profiles and one that DSH cannot read.
const TEAM = {
  version: 1,
  workspaceId: 'w-old',
  mainBotIds: ['session-a'],
  bots: {
    'session-a': { id: 'session-a', name: 'Chief', sessionId: 'session-a2', segments: [{ sessionId: 'session-a' }] },
    'session-b': { id: 'session-b', name: 'Writer', workDir: '/projects/site' },
  },
  rooms: {
    'session-r1': {
      id: 'session-r1', name: 'Ops', members: ['session-a', 'session-b'],
      sessions: { 'session-a': 'session-g', 'session-b': 'session-gone' },
      segments: { 'session-a': [{ sessionId: 'session-g0', endedAt: 1 }] },
    },
  },
  agents: { x: { id: 'x' } },
}
const TEAM_SESSIONS = [['--team--', 'session-a'], ['--team--', 'session-a2'], ['--team--', 'session-g'], ['--team--', 'session-g0'], ['--team--', 'session-r1'], ['--site--', 'session-b']]

function oldHome(root) {
  const from = join(root, 'dsh')
  write(join(from, 'bot', 'state.json'), JSON.stringify(TEAM))
  write(join(from, 'bot', 'state.lock'), '{}')
  write(join(from, 'bot', 'inflight.json'), '{}')
  write(join(from, 'bot', 'memory', 'session-a.md'), 'remember')
  write(join(from, 'bot', 'workspace', 'notes.txt'), 'old notes')
  write(join(from, 'bot', 'workspace', 'kept.txt'), 'old kept')
  for (const [group, id] of TEAM_SESSIONS) write(join(from, 'sessions', group, id, 'session.v4.jsonl.zstd'), id)
  write(join(from, 'sessions', '--team--', 'session-other', 'session.v4.jsonl.zstd'), 'not the team')
  write(join(from, 'attachments', 'ab', 'cdef'), 'file')
  write(join(from, '.credentials.yaml'), 'DEEPSEEK_API_KEY: fake\n')
  write(join(from, '.env'), 'X=1\n')
  write(join(from, 'profiles', 'desktop', 'cordis.patch.yml'), [
    '- id: llm-pi-ai', '  config:', '    providers:', '      moonshotai:', '        apiKeyEnv: MOONSHOTAI_API_KEY',
    '- id: agent-default-model', '  config:', '    model: deepseek-official/deepseek-flash',
    '- id: some-plugin', '  name: some-plugin', '',
  ].join('\n'))
  write(join(from, 'profiles', 'web', 'cordis.patch.yml'), '- id: some-plugin\n  name: some-plugin\n')
  write(join(from, 'profiles', 'broken', 'cordis.patch.yml'), '- id: llm-deepseek\n  config: [unclosed\n')
  return from
}

// What the Host's first start writes to the data location's .credentials.yaml: the connection
// plugin's browser session grant, and nothing else.
const HOST_CREDENTIALS = [
  'version: 1', 'records:', '  client-connection/browser-session:', '    kind: grant', '    payload:',
  '      version: 1', `      secret: ${'A'.repeat(43)}`, '',
].join('\n')

// The app's data location after the Host's first start, and the folder chosen for the Bots' files.
function newHome(root) {
  const to = join(root, 'ds-bot')
  write(join(to, 'bot', 'state.json'), JSON.stringify({ version: 1, mainBotIds: [], bots: {}, rooms: {} }))
  write(join(to, '.credentials.yaml'), HOST_CREDENTIALS)
  write(join(to, 'profiles', 'ds-bot', 'cordis.patch.yml'), '- id: llm-pi-ai\n  config:\n    providers: {}\n- id: webserver\n  config:\n    port: 0\n- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: seen\n')
  const workspace = join(root, 'DeepSeek Bot')
  write(join(workspace, 'kept.txt'), 'new kept')
  return { to, workspace }
}

describe('importTeam', () => {
  let root, from, to, workspace, oldTree, summary
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-app-import-'))
    from = oldHome(root);
    ({ to, workspace } = newHome(root))
    oldTree = treeHash(from)
    summary = await importTeam({ from, to, workspace, profile: 'desktop', dsh: '0.2.0-rc.2' })
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('copies the team without its lock, its turns in flight, its workspace, its old workspace id or Agents', () => {
    const team = readJson(join(to, 'bot', 'state.json'))
    assert.deepEqual(Object.keys(team.bots), ['session-a', 'session-b'])
    assert.equal(team.workspaceId, undefined)
    assert.deepEqual(team.agents, {})
    assert.equal(readFileSync(join(to, 'bot', 'memory', 'session-a.md'), 'utf8'), 'remember')
    for (const name of ['state.lock', 'inflight.json', 'workspace']) assert.equal(existsSync(join(to, 'bot', name)), false, name)
  })

  test('copies every Session the team names into the same folder group, and only those', () => {
    for (const [group, id] of TEAM_SESSIONS) assert.equal(readFileSync(join(to, 'sessions', group, id, 'session.v4.jsonl.zstd'), 'utf8'), id)
    assert.equal(existsSync(join(to, 'sessions', '--team--', 'session-other')), false)
    assert.deepEqual(summary.missingSessions, ['session-gone'])
    assert.equal(summary.sessions, 6)
  })

  test('copies the own Session of every group, so an imported group can be opened', () => {
    assert.equal(readFileSync(join(to, 'sessions', '--team--', 'session-r1', 'session.v4.jsonl.zstd'), 'utf8'), 'session-r1')
  })

  test('copies the attachments, the keys, and the model rows of the chosen profile', () => {
    assert.equal(readFileSync(join(to, 'attachments', 'ab', 'cdef'), 'utf8'), 'file')
    assert.equal(readFileSync(join(to, '.credentials.yaml'), 'utf8'), 'DEEPSEEK_API_KEY: fake\n')
    assert.equal(readFileSync(join(to, '.env'), 'utf8'), 'X=1\n')
    const patch = parse(readFileSync(join(to, 'profiles', 'ds-bot', 'cordis.patch.yml'), 'utf8'))
    // The data location's other rows stay, such as the Settings page's own.
    assert.deepEqual(patch.map(row => row.id), ['webserver', 'ui-settings-general', 'llm-pi-ai', 'agent-default-model'])
    assert.deepEqual(patch[1].config, { welcomeNoticeVersion: 'seen' })
    assert.deepEqual(patch[2].config.providers, { moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' } })
  })

  test('puts the old workspace files in the chosen folder without replacing one that is there', () => {
    assert.equal(readFileSync(join(workspace, 'notes.txt'), 'utf8'), 'old notes')
    assert.equal(readFileSync(join(workspace, 'kept.txt'), 'utf8'), 'new kept')
  })

  test('records the import, leaves nothing staged and changes nothing in the old home', () => {
    const record = readJson(join(to, 'bot', 'imported.json'))
    assert.deepEqual({ ...record, at: undefined }, {
      from, at: undefined, dsh: '0.2.0-rc.2', bots: 2, rooms: 1, sessions: 6, missingSessions: ['session-gone'],
      keys: ['.credentials.yaml', '.env'], keptKeys: [], modelSettings: 'desktop',
    })
    assert.deepEqual(readdirSync(to).filter(name => name.startsWith('.import-')), [])
    assert.equal(treeHash(from), oldTree)
  })

  test('does not replace a team that is there', async () => {
    await assert.rejects(importTeam({ from, to, workspace }), /already has a Bot team/u)
  })
})

describe('a copy that stopped', () => {
  let root, from
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-app-stopped-'))
    from = oldHome(root)
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('a copy that stopped part way runs again', async () => {
    const { to, workspace } = newHome(root)
    write(join(to, '.import-1', 'junk.txt'), 'left over')
    write(join(to, 'sessions', '--site--', 'session-b', 'session.v4.jsonl.zstd'), 'junk')
    const summary = await importTeam({ from, to, workspace })
    assert.equal(summary.sessions, 6)
    assert.deepEqual(Object.keys(readJson(join(to, 'bot', 'state.json')).bots), ['session-a', 'session-b'])
    assert.equal(readFileSync(join(to, 'sessions', '--site--', 'session-b', 'session.v4.jsonl.zstd'), 'utf8'), 'session-b')
    assert.deepEqual(staged(to), [])
  })

  test('a stopped copy leaves no Bot team', async () => {
    const to = join(root, 'stopped')
    mkdirSync(to, { recursive: true })
    await assert.rejects(importTeam({ from, to, workspace: join(root, 'stopped-files'), signal: AbortSignal.abort() }), { name: 'AbortError' })
    assert.equal(existsSync(join(to, 'bot')), false)
    assert.deepEqual(staged(to), [])
  })

  test('a quit during the move-in leaves no Bot team, and the next copy finishes', async () => {
    const { to, workspace } = newHome(join(root, 'mid'))
    const movedIn = join(to, 'sessions', '--team--', 'session-a')
    let stopped = false
    const signal = {
      get aborted() { return stopped },
      throwIfAborted() {
        if (existsSync(movedIn)) stopped = true
        if (stopped) throw Object.assign(new Error('stopped'), { name: 'AbortError' })
      },
    }
    await assert.rejects(importTeam({ from, to, workspace, signal }), { name: 'AbortError' })
    assert.equal(Object.keys(readJson(join(to, 'bot', 'state.json')).bots).length, 0)
    assert.equal(existsSync(movedIn), true)
    assert.deepEqual(staged(to), [])
    const summary = await importTeam({ from, to, workspace })
    assert.equal(summary.sessions, 6)
    assert.deepEqual(Object.keys(readJson(join(to, 'bot', 'state.json')).bots), ['session-a', 'session-b'])
    assert.equal(readFileSync(join(movedIn, 'session.v4.jsonl.zstd'), 'utf8'), 'session-a')
    assert.deepEqual(staged(to), [])
  })

  test('a copy that failed part way removes what it staged and leaves no Bot team', async () => {
    const { to } = newHome(join(root, 'failed'))
    // The folder for the Bots' files is a file: the copy fails once the team is staged.
    const workspace = join(root, 'failed', 'a-file')
    write(workspace, 'not a folder')
    await assert.rejects(importTeam({ from, to, workspace }))
    assert.deepEqual(staged(to), [])
    assert.equal(Object.keys(readJson(join(to, 'bot', 'state.json')).bots).length, 0)
  })
})

describe('keys the data location has already', () => {
  let root
  before(() => { root = mkdtempSync(join(tmpdir(), 'ds-bot-app-keys-')) })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  const importOver = async (name, credentials) => {
    const from = oldHome(join(root, name))
    const { to, workspace } = newHome(join(root, name))
    write(join(to, '.credentials.yaml'), credentials)
    return { to, summary: await importTeam({ from, to, workspace }) }
  }

  test('copies the old keys over the .credentials.yaml that only the Host\'s first start wrote', async () => {
    const { to, summary } = await importOver('host', HOST_CREDENTIALS)
    assert.equal(readFileSync(join(to, '.credentials.yaml'), 'utf8'), 'DEEPSEEK_API_KEY: fake\n')
    assert.deepEqual(summary.keys, ['.credentials.yaml', '.env'])
    assert.deepEqual(summary.keptKeys, [])
  })

  test('keeps a .credentials.yaml with a key saved since, copies the rest and reports which it kept', async () => {
    const saved = `${HOST_CREDENTIALS}refs:\n  DEEPSEEK_API_KEY: saved-since\n`
    const { to, summary } = await importOver('saved', saved)
    assert.equal(readFileSync(join(to, '.credentials.yaml'), 'utf8'), saved)
    assert.equal(readFileSync(join(to, '.env'), 'utf8'), 'X=1\n')
    assert.deepEqual(summary.keys, ['.env'])
    assert.deepEqual(summary.keptKeys, ['.credentials.yaml'])
    assert.deepEqual(readJson(join(to, 'bot', 'imported.json')).keptKeys, ['.credentials.yaml'])
  })

  test('keeps one with an account sign-in, in the old flat layout or that does not read as YAML', async () => {
    for (const [name, text] of [
      ['account', `${HOST_CREDENTIALS}  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      token: saved-since\n`],
      ['flat', 'DEEPSEEK_API_KEY: saved-since\n'],
      ['broken', 'refs: [unclosed\n'],
    ]) {
      const { to, summary } = await importOver(name, text)
      assert.equal(readFileSync(join(to, '.credentials.yaml'), 'utf8'), text, name)
      assert.deepEqual(summary.keptKeys, ['.credentials.yaml'], name)
    }
  })
})

describe('links in the old team workspace', () => {
  let root
  before(() => { root = mkdtempSync(join(tmpdir(), 'ds-bot-app-links-')) })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('makes a package link again inside the chosen folder and gets past a link to nothing', async () => {
    const from = oldHome(root)
    const old = join(from, 'bot', 'workspace')
    write(join(old, '.pnpm', 'pkg', 'index.js'), 'package')
    mkdirSync(join(old, 'node_modules'), { recursive: true })
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(join(old, '.pnpm', 'pkg'), join(old, 'node_modules', 'pkg'), type)
    mkdirSync(join(old, '.pnpm-store'), { recursive: true })
    symlinkSync(join(root, 'gone'), join(old, '.pnpm-store', '.ignored_pkg'), type)
    const { to, workspace } = newHome(root)
    const summary = await importTeam({ from, to, workspace })
    assert.equal(summary.sessions, 6)
    assert.equal(readFileSync(join(workspace, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'package')
    assert.equal(realpathSync.native(join(workspace, 'node_modules', 'pkg')), realpathSync.native(join(workspace, '.pnpm', 'pkg')))
    assert.equal(readFileSync(join(workspace, 'notes.txt'), 'utf8'), 'old notes')
  })
})

describe('finding the team', () => {
  let root, from
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ds-bot-app-find-'))
    from = oldHome(root)
  })
  after(() => { rmSync(root, { recursive: true, force: true }) })

  test('counts the Bots and groups and lists only the readable profiles with model settings', () => {
    const found = findTeam(from)
    assert.equal(found.bots, 2)
    assert.equal(found.rooms, 1)
    assert.deepEqual(found.profiles.map(entry => [entry.name, entry.rows.map(row => row.id)]), [['desktop', ['llm-pi-ai', 'agent-default-model']]])
    assert.equal(findTeam(join(root, 'none')), undefined)
  })

  test('names each Session of the team once', () => {
    assert.deepEqual(sessionIdsOf(TEAM), ['session-a', 'session-a2', 'session-b', 'session-r1', 'session-g', 'session-gone', 'session-g0'])
  })

  test('names the own Session of every group, so an imported group can be opened', () => {
    assert.ok(sessionIdsOf(TEAM).includes('session-r1'))
    assert.deepEqual(sessionIdsOf({ bots: {}, rooms: { 'session-r2': { id: 'session-r2' } } }), ['session-r2'])
  })

  test('copies only the Sessions of the team for the check, and changes nothing in the old home', async () => {
    const oldTree = treeHash(from)
    const home = join(root, 'check')
    const ids = await copySessions(from, TEAM, home)
    assert.deepEqual(ids.toSorted(), TEAM_SESSIONS.map(([, id]) => id).toSorted())
    for (const [group, id] of TEAM_SESSIONS) assert.equal(readFileSync(join(home, 'sessions', group, id, 'session.v4.jsonl.zstd'), 'utf8'), id)
    assert.equal(existsSync(join(home, 'sessions', '--team--', 'session-other')), false)
    assert.equal(treeHash(from), oldTree)
  })

  test('stops copying for the check once the app quits', async () => {
    const home = join(root, 'check-stopped')
    await assert.rejects(copySessions(from, TEAM, home, AbortSignal.abort()), { name: 'AbortError' })
    assert.equal(existsSync(join(home, 'sessions')), false)
  })

  test('finds Sessions written in a newer format than the pinned DSH reads', () => {
    assert.deepEqual(newerSessions(from, TEAM), [])
    write(join(from, 'sessions', '--site--', 'session-b', 'session.v99.jsonl.zstd'), 'newer')
    write(join(from, 'sessions', '--team--', 'session-g0', 'session.v99.jsonl.zstd'), 'newer')
    assert.deepEqual(newerSessions(from, TEAM), ['session-b', 'session-g0'])
  })

  test('takes the team for in use while a live process on this machine or a fresh lock elsewhere holds it', () => {
    const lock = join(from, 'bot', 'state.lock')
    write(lock, JSON.stringify({ pid: process.pid, host: 'here' }))
    assert.equal(teamInUse(from, { host: 'here' }), true)
    const ended = spawnSync(process.execPath, ['-e', '']).pid
    write(lock, JSON.stringify({ pid: ended, host: 'here' }))
    assert.equal(teamInUse(from, { host: 'here' }), false)
    write(lock, JSON.stringify({ pid: 1, host: 'elsewhere' }))
    assert.equal(teamInUse(from, { host: 'here' }), true)
    const old = new Date(Date.now() - 120_000)
    utimesSync(lock, old, old)
    assert.equal(teamInUse(from, { host: 'here' }), false)
    write(lock, '{"pid": ')
    assert.equal(teamInUse(from, { host: 'here' }), true, 'a lock being written')
    rmSync(lock)
    assert.equal(teamInUse(from, { host: 'here' }), false)
  })

  // #428: the pid of a holder that crashed long ago now belongs to another process.
  test('does not take a stale lock on this machine for in use, even when its pid is alive', () => {
    const lock = join(from, 'bot', 'state.lock')
    write(lock, JSON.stringify({ pid: process.pid, host: 'here' }))
    const at = statSync(lock).mtimeMs
    assert.equal(teamInUse(from, { host: 'here', now: at + 59_000 }), true)
    assert.equal(teamInUse(from, { host: 'here', now: at + 60_000 }), false)
    assert.equal(teamInUse(from, { host: 'here', now: at + 59_000, isAlive: () => false }), false)
    const asked = []
    assert.equal(teamInUse(from, { host: 'here', now: at + 120_000, isAlive: (pid) => { asked.push(pid); return true } }), false)
    assert.deepEqual(asked, [])
  })

  test('reads DSH_HOME as DSH does', () => {
    assert.equal(userDshHome({}), join(homedir(), '.dsh'))
    assert.equal(userDshHome({ DSH_HOME: ' ' }), join(homedir(), '.dsh'))
    assert.equal(userDshHome({ DSH_HOME: '~/dsh-x' }), join(homedir(), 'dsh-x'))
  })
})
