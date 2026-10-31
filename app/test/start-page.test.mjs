import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { START_ACTS } from '../src/start-window.mjs'
import { langOf, TEXT, t } from '../src/start/text.mjs'

const dir = new URL('../src/start/', import.meta.url)
const read = name => readFileSync(new URL(name, dir), 'utf8')
const SCRIPTS = ['start.js', 'whale.js', 'text.mjs']
const html = read('start.html')
const code = Object.fromEntries(SCRIPTS.map(name => [name, read(name)]))
const uncommented = text => text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, '')

test('the start page runs under its CSP: no inline style or script, no data: or network URLs', () => {
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'self'; base-uri 'none'; object-src 'none'">`), 'the CSP meta is missing or changed')
  const rules = [
    [/<style[\s>]/iu, '<style> element'],
    [/\sstyle\s*=/iu, 'style= attribute'],
    [/\son[a-z]+\s*=/iu, 'on* handler attribute'],
    [/<script(?![^>]*\ssrc=)[^>]*>/iu, 'inline <script>'],
    [/data:/iu, 'data: URL'],
    [/https?:/iu, 'http(s): URL'],
  ]
  for (const [pattern, what] of rules) assert.doesNotMatch(html, pattern, `start.html: ${what}`)
  for (const name of ['start.css', ...SCRIPTS]) {
    const body = uncommented(read(name))
    assert.doesNotMatch(body, /url\(\s*['"]?(?:data:|https?:)|@import/iu, `${name}: external or data: resource`)
    assert.doesNotMatch(body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/u, `${name}: markup or code from strings`)
  }
})

test('every file the page loads is relative and inside src/start', () => {
  const inside = (from, url) => {
    assert.doesNotMatch(url, /^(?:[a-z][\w+.-]*:|\/|\\)|\.\./iu, `${from} loads ${url}`)
    assert.ok(existsSync(new URL(url, dir)), `${from} loads ${url}, which is missing`)
  }
  const loads = [...html.matchAll(/\s(?:src|href)="([^"#][^"]*)"/gu)].map(match => match[1])
  assert.deepEqual(loads, ['start.css', 'start.js'])
  assert.match(html, /<script type="module" src="start.js"><\/script>/u)
  for (const url of loads) inside('start.html', url)
  for (const [name, text] of Object.entries(code)) {
    const body = uncommented(text)
    assert.doesNotMatch(body, /\bimport\s*\(/u, `${name}: a dynamic import`)
    for (const match of body.matchAll(/^\s*(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gmu)) inside(name, match[1] ?? match[2])
  }
  for (const [, url] of uncommented(read('start.css')).matchAll(/url\(\s*['"]?([^'")#][^'")]*)/gu)) inside('start.css', url)
})

test('the page binds window.dsBotStart through onState and act only', () => {
  const used = new Set([...code['start.js'].matchAll(/\bbridge\??\.(\w+)/gu)].map(match => match[1]))
  assert.deepEqual([...used].sort(), ['act', 'onState'])
  assert.match(code['start.js'], /const bridge = window\.dsBotStart\b/u)
})

// The acts the main process must accept from the start window (its allowlist).
test('the page sends only the acts of the start window', () => {
  const local = new Set(['toggleDetails', 'toggleMore', 'toggleModels'])
  const sent = new Set([
    ...[...html.matchAll(/data-act="(\w+)"/gu)].map(match => match[1]),
    ...[...code['start.js'].matchAll(/\bact: '(\w+)'|\bact\('(\w+)'/gu)].map(match => match[1] ?? match[2]),
    ...[...code['whale.js'].matchAll(/\bact\('(\w+)'\)/gu)].map(match => match[1]),
  ].filter(name => !local.has(name)))
  assert.deepEqual([...sent].sort(), ['answer', 'copyDetails', 'freshStart', 'handoffDone', 'handoffShow', 'importModel', 'importOption', 'installUpdate', 'keepCopying', 'manualDownload', 'openLogs', 'pick', 'reloadView', 'retry', 'stopCopy', 'wait'])
  // Every act the main process takes is one that the page sends, under the same name.
  for (const name of START_ACTS) assert.ok(sent.has(name), `the main process takes ${name}, which the page never sends`)
})

// docs/plans/2026-10-29-start-copy.md §2: the first part of a key says where the line is.
const LAYERS = ['voice', 'say', 'hint', 'card', 'reason', 'btn', 'note', 'foot', 'status', 'dialog']
const layerOf = key => key.split('.')[0]
// {name} and {name|one|many} (an English count) both name one placeholder.
const PLACEHOLDER = /\{(\w+)(?:\|[^}]*)?\}/gu

test('zh and en carry the same keys and the same placeholders', () => {
  const placeholders = text => [...text.matchAll(PLACEHOLDER)].map(match => match[1]).sort().join()
  assert.deepEqual(Object.keys(TEXT.en).sort(), Object.keys(TEXT.zh).sort())
  for (const [key, zh] of Object.entries(TEXT.zh)) assert.equal(placeholders(TEXT.en[key]), placeholders(zh), `${key}: placeholders differ`)
})

test('every text key starts with one of the ten layers', () => {
  for (const key of Object.keys(TEXT.zh)) assert.ok(LAYERS.includes(layerOf(key)), `${key}: unknown layer`)
})

// §2 and §4: a line that stands alone takes no full stop; card, reason, note and dialog text is
// whole sentences.
test('each layer ends its lines as its rule says', () => {
  const BARE = new Set(['voice', 'say', 'hint', 'btn', 'foot', 'status'])
  // Not sentences: picker titles, progress lines and labels.
  const NOT_SENTENCES = new Set([
    'card.update.slow', 'card.update.downloading', 'dialog.pickRoot', 'dialog.pickMove',
    'card.copying.step1', 'card.copying.step2', 'card.copying.step3', 'card.copying.eta', 'card.copying.etaSoon',
    'card.import.model', 'card.import.optRegen', 'card.import.optSkipWork',
  ])
  for (const key of Object.keys(TEXT.zh)) {
    const zh = TEXT.zh[key]
    const en = TEXT.en[key]
    if (BARE.has(layerOf(key))) {
      assert.doesNotMatch(zh, /。$/u, `${key}: zh ends with a full stop`)
      assert.doesNotMatch(en, /\.$/u, `${key}: en ends with a full stop`)
    } else if (key.startsWith('reason.copy.')) {
      // A fragment set into a sentence.
      assert.doesNotMatch(zh, /[。？！，]$/u, `${key}: a fragment ends with punctuation`)
      assert.doesNotMatch(en, /[.?!,]$/u, `${key}: a fragment ends with punctuation`)
    } else if (!NOT_SENTENCES.has(key)) {
      // A reason or a footnote states; only a card or a dialog may ask.
      const ends = layerOf(key) === 'reason' || layerOf(key) === 'note' ? [/。$/u, /\.$/u] : [/[。？]$/u, /[.?]$/u]
      assert.match(zh, ends[0], `${key}: zh is not a whole sentence`)
      assert.match(en, ends[1], `${key}: en is not a whole sentence`)
    }
    if (key === 'dialog.pickRoot' || key === 'dialog.pickMove') {
      assert.doesNotMatch(zh, /。$/u, `${key}: a picker title ends with a full stop`)
      assert.doesNotMatch(en, /\.$/u, `${key}: a picker title ends with a full stop`)
    }
  }
})

// Counted after the placeholders are removed, a run of Latin letters or digits (a name such as
// DeepSeek, a unit) as one character.
test('the zh lines stay within their layer’s length', () => {
  const LIMITS = { voice: 16, say: 12, hint: 22, btn: 10 }
  const length = text => [...text.replace(PLACEHOLDER, '').replace(/\s+/gu, '').replace(/[A-Za-z0-9]+/gu, 'A')].length
  for (const [key, zh] of Object.entries(TEXT.zh)) {
    const limit = LIMITS[layerOf(key)]
    if (limit !== undefined) assert.ok(length(zh) <= limit, `${key}: ${String(length(zh))} characters, over ${String(limit)}`)
  }
})

test('a button that opens the system picker ends with …', () => {
  const picks = [...html.matchAll(/<button\b[^>]*>/gu)].map(match => match[0]).filter(tag => tag.includes('data-act="pick"'))
  assert.ok(picks.length > 0)
  for (const tag of picks) {
    const key = tag.match(/data-t="([^"]+)"/u)?.[1]
    assert.ok(key !== undefined, `a pick button without text: ${tag}`)
    assert.match(TEXT.zh[key], /…$/u, `${key}: a pick button`)
    assert.match(TEXT.en[key], /…$/u, `${key}: a pick button`)
  }
})

// docs/plans/2026-10-26-windows-onboarding.md, 用词: proper names and units only.
test('the zh copy shows no English but the allowed names and units', () => {
  const NAMES = ['DS Bot', 'DSH Desktop', 'DSH Web']
  const WORDS = new Set(['DeepSeek', 'Bot', 'API', 'Key', 'Harness', 'DSH', 'Agent', 'MCP', 'Windows', 'PowerShell', 'GitHub', 'SmartScreen', 'OneDrive', 'HTTP', 'SOCKS', 'KB', 'MB', 'GB'])
  const english = []
  for (const [key, value] of Object.entries(TEXT.zh)) {
    let rest = value.replace(PLACEHOLDER, ' ')
    for (const name of NAMES) rest = rest.replaceAll(name, ' ')
    for (const word of rest.match(/[A-Za-z][A-Za-z0-9.-]*/gu) ?? []) if (!WORDS.has(word)) english.push(`${key}: ${word}`)
    // A promise the engine cannot keep.
    assert.doesNotMatch(value, /马上|稍后|下个版本/u, key)
  }
  assert.deepEqual(english, [])
})

test('every text key that the page uses exists', () => {
  const keys = Object.keys(TEXT.zh)
  const matching = pattern => keys.filter(key => new RegExp(`^${pattern.replaceAll('.', '\\.').replace(/\{\w+\}/gu, '\\w+')}$`, 'u').test(key))
  for (const [, key] of html.matchAll(/data-t(?:-label)?="([^"]+)"/gu)) assert.ok(matching(key).length > 0, `start.html: unknown text key ${key}`)
  const literal = new RegExp(`^(?:${LAYERS.join('|')})\\.[\\w.]+$`, 'u')
  for (const name of ['start.js', 'whale.js']) {
    const text = uncommented(code[name])
    const used = [
      ...[...text.matchAll(/'([\w.]+)'/gu)].map(match => match[1]).filter(key => literal.test(key)),
      ...[...text.matchAll(/\b(?:say|label)\('([\w.]+)'/gu)].map(match => match[1]),
    ]
    for (const key of used) assert.ok(key in TEXT.zh, `${name}: unknown text key ${key}`)
    for (const [, prefix] of text.matchAll(/`([\w.]+\.)\$\{/gu)) assert.ok(keys.some(key => key.startsWith(prefix)), `${name}: no text key starts with ${prefix}`)
  }
  // Keys the page builds from the snapshot's views, the stages and the failure reasons.
  for (const key of ['voice.failed', 'voice.viewFailed', 'voice.opening', 'voice.moving', 'status.phase.data', 'status.phase.engine', 'status.phase.team', 'status.state.pending', 'status.state.active', 'status.state.done', 'status.state.failed']) assert.ok(key in TEXT.zh, key)
  assert.deepEqual(matching('reason.start.{reason}').sort(), ['reason.start.engine', 'reason.start.files', 'reason.start.other', 'reason.start.permission', 'reason.start.space'])
  assert.deepEqual(matching('reason.place.{reason}').sort(), ['reason.place.dsh', 'reason.place.foreign', 'reason.place.nested', 'reason.place.onedrive', 'reason.place.permission', 'reason.place.program', 'reason.place.space'])
  assert.deepEqual(matching('reason.copy.{reason}').sort(), ['reason.copy.full', 'reason.copy.inUse', 'reason.copy.permission'])
})

// §1: the main process takes its dialog copy from the same table.
test('the main process uses only keys of the table and keeps no table of its own', () => {
  const src = new URL('../src/', import.meta.url)
  const files = Object.fromEntries(['main.mjs', 'first-run.mjs', 'updates.mjs'].map(name => [name, uncommented(readFileSync(new URL(name, src), 'utf8'))]))
  for (const [name, text] of Object.entries(files)) {
    const used = [
      ...[...text.matchAll(/\btx\(\s*'([^']+)'/gu)].map(match => match[1]),
      ...[...text.matchAll(/'((?:dialog|btn)\.[\w.]+)'/gu)].map(match => match[1]),
    ]
    for (const key of used) assert.ok(key in TEXT.zh, `${name}: unknown text key ${key}`)
  }
  assert.match(files['main.mjs'], /\btx\('dialog\./u)
  assert.match(files['first-run.mjs'], /\btx\('dialog\./u)
  for (const name of ['first-run.mjs', 'updates.mjs']) {
    assert.doesNotMatch(files[name], /\b(?:en|zh)\s*:\s*\{/u, `${name}: a string table`)
    assert.doesNotMatch(files[name], /[㐀-鿿]/u, `${name}: Chinese copy outside text.mjs`)
  }
})

test('t fills placeholders and falls back to zh, then to the key', () => {
  assert.equal(t('zh', 'status.elapsed', { n: 12 }), '已用 12 秒')
  assert.equal(t('en', 'status.elapsed', { n: 12 }), '12 s so far')
  assert.equal(t('en', 'voice.helloName', { name: 'Ada' }), 'Hi, I’m Ada')
  assert.equal(t('fr', 'btn.retry'), '重试')
  assert.equal(t('en', 'hint.space', { drive: 'C' }), 'Only {free} left on drive C')
  assert.equal(t('zh', 'no.such.key'), 'no.such.key')
})

test('t picks the English singular or plural by the value', () => {
  assert.equal(t('en', 'hint.reinstall', { bots: 1, groups: 6 }), 'Your 1 Bot and 6 group chats are still here')
  assert.equal(t('en', 'hint.reinstall', { bots: 6, groups: 1 }), 'Your 6 Bots and 1 group chat are still here')
  assert.equal(t('zh', 'hint.reinstall', { bots: 6, groups: 1 }), '上次的 6 个 Bot 和 1 个群聊都在')
  assert.equal(t('en', 'hint.reinstall', { bots: 1 }), 'Your 1 Bot and {groups|group chat|group chats} are still here')
})

test('langOf gives zh for every Chinese locale and en otherwise', () => {
  assert.equal(langOf('zh-CN'), 'zh')
  assert.equal(langOf('ZH-tw'), 'zh')
  assert.equal(langOf('en-US'), 'en')
  assert.equal(langOf('fr'), 'en')
  assert.equal(langOf(''), 'en')
})

test('the generated blocks of the start page are current', () => {
  const script = fileURLToPath(new URL('../scripts/start-assets.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
