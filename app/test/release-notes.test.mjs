import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { checksums, copyName, downloadBlock, formatSize, missingPackages, PACKAGES, packageName, withDownloads } from '../scripts/release-notes.mjs'

const script = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url))
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8')
const names = version => PACKAGES.map(entry => packageName(version, entry))
const MB = 1024 ** 2

test('the packages carry the names electron-builder gives them, and copies drop the version', () => {
  assert.match(read('../electron-builder.yml'), /^artifactName: DeepSeek-Bot-\$\{version\}-\$\{os\}-\$\{arch\}\.\$\{ext\}$/mu)
  assert.deepEqual(names('0.2.3'), [
    'DeepSeek-Bot-0.2.3-win-x64.exe',
    'DeepSeek-Bot-0.2.3-mac-arm64.zip',
    'DeepSeek-Bot-0.2.3-mac-x64.zip',
    'DeepSeek-Bot-0.2.3-linux-x86_64.AppImage',
    'DeepSeek-Bot-0.2.3-linux-amd64.deb',
  ])
  assert.deepEqual(PACKAGES.map(copyName), [
    'DeepSeek-Bot-win-x64.exe',
    'DeepSeek-Bot-mac-arm64.zip',
    'DeepSeek-Bot-mac-x64.zip',
    'DeepSeek-Bot-linux-x86_64.AppImage',
    'DeepSeek-Bot-linux-amd64.deb',
  ])
})

test('sizes are whole megabytes, as GitHub shows them', () => {
  assert.equal(formatSize(222_174_558), '212 MB')
  assert.equal(formatSize(10), '1 MB')
})

test('the table lists Windows first, then macOS and Linux, and says which files are not for download', () => {
  const sizes = Object.fromEntries(names('0.2.3').map((name, index) => [name, (index + 1) * 100 * MB]))
  const block = downloadBlock({ version: '0.2.3', sizes })
  const rows = block.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| System'))
  assert.equal(rows.length, 5)
  assert.match(rows[0], /^\| \*\*Windows 10\/11 \(64-bit \/ 64 位\)\*\*<br>Double-click to install \/ 双击安装 \| \[DeepSeek-Bot-0\.2\.3-win-x64\.exe\]\(https:\/\/github\.com\/Fei2411\/DS-Bot\/releases\/download\/v0\.2\.3\/DeepSeek-Bot-0\.2\.3-win-x64\.exe\) \| 100 MB \|$/u)
  assert.match(rows[1], /^\| macOS, Apple chip .*mac-arm64\.zip.*\| 200 MB \|$/u)
  assert.match(rows[2], /^\| macOS, Intel .*mac-x64\.zip.*\| 300 MB \|$/u)
  assert.match(rows[3], /^\| Linux, AppImage .*linux-x86_64\.AppImage.*\| 400 MB \|$/u)
  assert.match(rows[4], /^\| Linux, deb .*linux-amd64\.deb.*\| 500 MB \|$/u)
  assert.match(block, /^## Download \/ 下载$/mu)
  assert.match(block, /The `\.blockmap`, `latest\*\.yml` and `ds-bot-\*\.tgz` files and the source code archives are for updates and the plugin/u)
  assert.match(block, /\[SHA256SUMS\.txt\]\(https:\/\/github\.com\/Fei2411\/DS-Bot\/releases\/download\/v0\.2\.3\/SHA256SUMS\.txt\)/u)
  assert.doesNotMatch(block, /Mirror/u)
})

test('a mirror comes before GitHub, and a fork links to its own releases', () => {
  const sizes = Object.fromEntries(names('0.2.3').map(name => [name, MB]))
  const block = downloadBlock({ version: '0.2.3', sizes, repo: 'someone/DS-Bot', mirror: 'https://mirror.example/ds-bot/v0.2.3/' })
  assert.match(block, /\| DeepSeek-Bot-0\.2\.3-win-x64\.exe: \[Mirror \/ 国内镜像\]\(https:\/\/mirror\.example\/ds-bot\/v0\.2\.3\/DeepSeek-Bot-0\.2\.3-win-x64\.exe\) · \[GitHub\]\(https:\/\/github\.com\/someone\/DS-Bot\/releases\/download\/v0\.2\.3\/DeepSeek-Bot-0\.2\.3-win-x64\.exe\) \|/u)
  assert.doesNotMatch(block, /Fei2411/u)
})

test('SHA256SUMS.txt lists each package under both of its names, in the format sha256sum checks', () => {
  const hashes = Object.fromEntries(names('0.2.3').map((name, index) => [name, String(index).repeat(64)]))
  const lines = checksums('0.2.3', hashes).split('\n')
  assert.equal(lines.pop(), '')
  assert.equal(lines.length, 10)
  assert.equal(lines[0], `${'0'.repeat(64)}  DeepSeek-Bot-0.2.3-win-x64.exe`)
  assert.equal(lines[1], `${'0'.repeat(64)}  DeepSeek-Bot-win-x64.exe`)
  assert.equal(lines[9], `${'4'.repeat(64)}  DeepSeek-Bot-linux-amd64.deb`)
})

test('a missing package is named; other files in the folder do not count', () => {
  const present = ['DeepSeek-Bot-0.2.3-win-x64.exe', 'DeepSeek-Bot-0.2.3-win-x64.exe.blockmap', 'DeepSeek-Bot-mac-arm64.zip', 'DeepSeek-Bot-0.2.2-mac-x64.zip',
    'DeepSeek-Bot-0.2.3-linux-x86_64.AppImage', 'DeepSeek-Bot-0.2.3-linux-amd64.deb', 'latest.yml']
  assert.deepEqual(missingPackages('0.2.3', present), ['DeepSeek-Bot-0.2.3-mac-arm64.zip', 'DeepSeek-Bot-0.2.3-mac-x64.zip'])
  assert.deepEqual(missingPackages('0.2.3', names('0.2.3')), [])
})

test('the table goes on top of the notes, and a second run replaces it', () => {
  const sizes = Object.fromEntries(names('0.2.3').map(name => [name, MB]))
  const block = downloadBlock({ version: '0.2.3', sizes })
  const once = withDownloads('## What changed\r\n\r\n- Fixed it\r\n', block)
  assert.ok(once.startsWith(`${block}\n\n## What changed`))
  assert.equal(withDownloads(once, block), once)
  const bigger = downloadBlock({ version: '0.2.3', sizes: Object.fromEntries(names('0.2.3').map(name => [name, 2 * MB])) })
  const again = withDownloads(once, bigger)
  assert.ok(again.startsWith(`${bigger}\n\n## What changed`))
  assert.equal(again.split('## Download / 下载').length, 2)
  assert.equal(withDownloads('', block), `${block}\n`)
})

test('the script hashes and copies the packages and prints the notes', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'ds-bot-release-notes-'))
  t.after(() => { rmSync(work, { recursive: true, force: true }) })
  const from = join(work, 'packages')
  const to = join(work, 'attach')
  mkdirSync(from)
  for (const name of names('0.2.3')) writeFileSync(join(from, name), `package ${name}`)
  writeFileSync(join(from, 'DeepSeek-Bot-0.2.3-win-x64.exe.blockmap'), 'map')
  writeFileSync(join(work, 'notes.md'), '- Fixed it\n')
  const env = { ...process.env, GITHUB_REPOSITORY: '', MIRROR_BASE: '' }
  const run = spawnSync(process.execPath, [script, '0.2.3', from, to, join(work, 'notes.md')], { encoding: 'utf8', env })
  assert.equal(run.status, 0, run.stderr)
  assert.ok(run.stdout.startsWith('<!-- downloads -->\n## Download / 下载\n'))
  assert.ok(run.stdout.endsWith('<!-- /downloads -->\n\n- Fixed it\n'))
  assert.match(run.stdout, /\/Fei2411\/DS-Bot\/releases\/download\/v0\.2\.3\/DeepSeek-Bot-0\.2\.3-win-x64\.exe/u)
  assert.deepEqual(readdirSync(to).sort(), [...PACKAGES.map(copyName), 'SHA256SUMS.txt'].sort())
  const sums = readFileSync(join(to, 'SHA256SUMS.txt'), 'utf8')
  for (const entry of PACKAGES) {
    const name = packageName('0.2.3', entry)
    const hash = createHash('sha256').update(`package ${name}`).digest('hex')
    assert.ok(sums.includes(`${hash}  ${name}\n`) && sums.includes(`${hash}  ${copyName(entry)}\n`), name)
    assert.equal(readFileSync(join(to, copyName(entry)), 'utf8'), `package ${name}`)
  }
})

test('the script stops when a package is missing, so the release is not marked Latest', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'ds-bot-release-notes-'))
  t.after(() => { rmSync(work, { recursive: true, force: true }) })
  for (const name of names('0.2.3').slice(1)) writeFileSync(join(work, name), name)
  const run = spawnSync(process.execPath, [script, '0.2.3', work, join(work, 'attach')], { encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /has no DeepSeek-Bot-0\.2\.3-win-x64\.exe$/mu)
})

// A releases/latest link must never reach a release whose files are still being attached.
test('the release becomes Latest last, after every job that attaches files', () => {
  const workflow = YAML.parse(read('../../.github/workflows/release.yml'))
  const runs = job => (job.steps ?? []).map(step => step.run ?? '').join('\n')
  const latest = Object.entries(workflow.jobs).filter(([, job]) => /gh release edit "\$TAG" --latest/u.test(runs(job)))
  assert.equal(latest.length, 1)
  const [name, job] = latest[0]
  const before = (jobName, seen = new Set()) => {
    for (const need of [workflow.jobs[jobName].needs ?? []].flat()) if (!seen.has(need)) before(need, seen.add(need))
    return seen
  }
  const uploaders = Object.keys(workflow.jobs).filter(other => other !== name && /gh release upload/u.test(runs(workflow.jobs[other])))
  assert.ok(uploaders.length >= 4)
  for (const uploader of uploaders) assert.ok(before(name).has(uploader), `${name} must come after ${uploader}`)
  assert.match(job.steps.at(-1).run, /^gh release edit "\$TAG" --latest$/u)
  assert.match(runs(job), /node scripts\/release-notes\.mjs /u)
})

test('both READMEs open with the same download block, a Windows link and the not-official line', () => {
  for (const file of ['../../README.md', '../../README.zh.md']) {
    const top = read(file).split(/\r?\n/u).slice(0, 10).join('\n')
    assert.match(top, /\(https:\/\/github\.com\/Fei2411\/DS-Bot\/releases\/latest\)/u, file)
    assert.match(top, /Windows 10\/11/u, file)
    assert.match(top, /not an official DeepSeek product/u, file)
    assert.match(top, /不是 DeepSeek 官方产品/u, file)
  }
  const block = (file) => {
    const lines = read(file).split(/\r?\n/u)
    return lines.slice(lines.findIndex(line => line.startsWith('**[Download DeepSeek Bot')), lines.findIndex(line => line.startsWith('**DeepSeek Bot**:')) + 1)
  }
  assert.ok(block('../../README.md').length > 10)
  assert.deepEqual(block('../../README.zh.md'), block('../../README.md'))
  // Edge shows Keep anyway only under Show more.
  assert.match(block('../../README.md').join('\n'), /\*\*Keep\*\* → \*\*Show more\*\* → \*\*Keep anyway\*\*/u)
  assert.match(block('../../README.md').join('\n'), /「保留」→「显示更多」→「仍然保留」/u)
  for (const file of ['../../README.md', '../../README.zh.md'])
    assert.doesNotMatch(read(file), /ds-bot-\d+\.\d+\.\d+\.tgz|DS-Bot#v\d/u, file)
})
