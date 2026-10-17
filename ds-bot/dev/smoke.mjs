// API-level smoke test of the Bot team on a mock bench (dev/bench.sh). It drives the main
// flows through POST /api/bot, waits for the team to go quiet after each step, and checks
// the saved state and the mock model's log. Run it on a freshly reset bench whose check
// line is low enough for a few long replies to cross it, yet well above the ~16k tokens
// of system prompt and tools, so a condensed part can fall back below it:
//
//   CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 dev/bench.sh smoke 3096 8796 reset && node dev/smoke.mjs smoke 3096
//
// `--out <file>` writes a normalized transcript (names instead of ids, sorted where the
// order depends on timing), so two runs, before and after a refactor, can be diffed.
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [name, port, ...rest] = process.argv.slice(2)
if (!name || !port) {
  console.error('usage: node dev/smoke.mjs <bench-name> <web-port> [--out <file>]')
  process.exit(2)
}
const outFile = rest[0] === '--out' ? rest[1] : undefined
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const HOME = join(ROOT, `.dsh-test-${name}`)
const BASE = `http://127.0.0.1:${port}`
const QUIET_MS = 2500
const STEP_TIMEOUT_MS = 120_000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const mockLog = () => {
  try {
    return readFileSync(join(HOME, 'mock.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function login() {
  const log = readFileSync(join(HOME, 'web.log'), 'utf8')
  const url = log.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))?.[0]
  if (!url) throw new Error('no login URL in web.log')
  const response = await fetch(url, { redirect: 'manual' })
  const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';')[0])
  if (cookies.length === 0) throw new Error(`login returned no cookie (${response.status})`)
  return cookies.join('; ')
}

const cookie = await login()
async function api(endpoint, payload = {}) {
  const response = await fetch(`${BASE}/api/bot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ endpoint, payload }),
  })
  const result = await response.json()
  if (!result.ok) throw new Error(`${endpoint}: ${result.error?.message ?? JSON.stringify(result)}`)
  return result.value
}

const state = () => readJson(join(HOME, 'bot', 'state.json'))
const botNamed = wanted => Object.values(state().bots).find(bot => bot.name === wanted)
const roomNamed = wanted => Object.values(state().rooms).find(room => room.name === wanted)

// Quiet: no Bot shows an activity and the mock has taken no call for QUIET_MS. Deliveries
// start a moment after a turn ends, so activity alone is not enough.
async function settle() {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  let calls = mockLog().length
  let since = Date.now()
  while (Date.now() < deadline) {
    await sleep(400)
    const { activity = {} } = await api('state')
    const now = mockLog().length
    if (now !== calls || Object.keys(activity).length > 0) {
      calls = now
      since = Date.now()
    } else if (Date.now() - since >= QUIET_MS) {
      return
    }
  }
  throw new Error('the team did not go quiet')
}

// Ids differ between runs, so the transcript names Bots, groups and Sessions by owner.
function normalized() {
  const current = state()
  const nameOf = id => current.bots[id]?.name ?? current.rooms[id]?.name ?? (id ? 'unknown' : null)
  const sessionOwner = (sessionId) => {
    for (const bot of Object.values(current.bots)) {
      if (bot.id === sessionId || bot.sessionId === sessionId || (bot.segments ?? []).some(part => part.sessionId === sessionId)) return bot.name
    }
    for (const room of Object.values(current.rooms)) {
      if (room.id === sessionId) return `group ${room.name}`
      for (const [botId, groupSession] of Object.entries(room.sessions ?? {})) {
        if (groupSession === sessionId) return `${nameOf(botId)} in ${room.name}`
      }
    }
    return 'unknown'
  }
  const sorted = list => [...list].sort()
  return {
    bots: Object.values(current.bots).map(bot => ({
      name: bot.name,
      role: bot.role,
      model: bot.model ?? null,
      main: current.mainBotIds.includes(bot.id),
      pinned: bot.pinned === true,
      hidden: bot.hidden === true,
      parts: 1 + (bot.segments ?? []).length,
      createdBy: nameOf(bot.createdBy),
    })).sort((a, b) => a.name.localeCompare(b.name)),
    rooms: Object.values(current.rooms).map(room => ({
      name: room.name,
      members: sorted(room.members.map(nameOf)),
      admin: nameOf(room.admin),
      mode: room.mode,
      notice: room.notice,
      log: sorted((room.log ?? []).map(line => `${line.kind ?? 'say'} ${line.who}: ${String(line.text).slice(0, 48)}`)),
      groupSessions: sorted(Object.keys(room.sessions ?? {}).map(nameOf)),
    })),
    exchanges: sorted(current.exchanges.map(entry => `${entry.role} ${nameOf(entry.from) ?? 'You'} -> ${nameOf(entry.to)}: ${entry.text.slice(0, 40)}`)),
    questions: sorted(Object.keys(current.questions ?? {}).map(sessionOwner)),
  }
}

// What the mock said during a step, without timing-dependent order, clock times or filler
// length.
const said = calls => calls.flatMap(call => (call.out ?? []).map(block => (block.type === 'tool_use'
  ? `tool ${block.name} ${JSON.stringify(block.input).slice(0, 60)}`
  : block.type === 'text' ? `text ${block.text.replace(/…\(\d+\)$/, '…').replace(/\d\d-\d\d \d\d:\d\d/g, 'MM-DD hh:mm').slice(0, 60)}` : block.type))).sort()

const transcript = []
const failures = []
async function step(title, run, check) {
  const before = mockLog().length
  const started = Date.now()
  let value
  try {
    value = await run()
    await settle()
  } catch (error) {
    failures.push(`${title}: ${error.message}`)
    console.log(`FAIL ${title}: ${error.message}`)
    return undefined
  }
  const calls = mockLog().slice(before)
  const problem = (() => {
    try { return check?.(value, calls) } catch (error) { return error.message }
  })()
  transcript.push({ step: title, said: said(calls), state: normalized() })
  if (problem) {
    failures.push(`${title}: ${problem}`)
    console.log(`FAIL ${title}: ${problem}`)
  } else {
    console.log(`ok   ${title} (${((Date.now() - started) / 1000).toFixed(1)} s, ${calls.length} model calls)`)
  }
  return value
}
const expect = (condition, message) => (condition ? undefined : message)
const saidText = (calls, pattern) => calls.some(call => (call.out ?? []).some(block => block.type === 'text' && pattern.test(block.text)))

const send = (sessionId, text) => api('send', { sessionId, text })
const chief = () => botNamed('Chief')

let models = []
await step('bootstrap: Chief waits for a model', () => api('state'), (value, calls) => {
  const current = state()
  const bots = Object.values(current.bots)
  models = value.models ?? []
  return expect(bots.length === 1 && bots[0].name === 'Chief' && current.mainBotIds[0] === bots[0].id, 'expected one Main Bot named Chief')
    ?? expect(bots[0].model === undefined && bots[0].kickoff !== undefined, 'Chief should hold its greeting until a model is picked')
    ?? expect(value.bots[0].waiting === true, 'the view should show Chief as waiting')
    ?? expect(calls.length === 0, `Chief called the model ${calls.length} times before it had one`)
    ?? expect(models.length > 0, 'no models listed for the model card')
})

await step('user picks a model; Chief greets and asks in its reply', () => api('update-bot', { id: chief().id, model: models.at(-1).ref }), (_value, calls) => {
  const current = state()
  return expect(chief().model === models.at(-1).ref, `Chief runs on ${chief().model}`)
    ?? expect(chief().kickoff === undefined, 'the greeting is still held')
    ?? expect(!current.questions?.[chief().sessionId ?? chief().id], 'the greeting should not leave a question card')
    ?? expect(saidText(calls, /先让团队帮你做哪块/), 'expected Chief to ask in its reply')
})

await step('Chief creates Writer, who replies', () => send(chief().id, '创建一个叫Writer的bot'), () => {
  const writer = botNamed('Writer')
  if (!writer) return 'no Writer'
  const kinds = state().exchanges.filter(entry => [entry.from, entry.to].includes(writer.id)).map(entry => entry.role)
  return expect(writer.createdBy === chief().id, 'Writer should be created by Chief')
    ?? expect(kinds.includes('request') && kinds.includes('reply'), `expected a request and a reply, got ${kinds}`)
})

// The mock calls dsh's ask_user_question for 阻塞提问 whenever the request offers it.
await step('a Bot is not offered dsh\'s blocking question tool', () => send(botNamed('Writer').id, '阻塞提问'), (_value, calls) => {
  const asked = calls.some(call => (call.out ?? []).some(block => block.type === 'tool_use' && block.name === 'ask_user_question'))
  return expect(!asked, 'Writer called ask_user_question')
    ?? expect(saidText(calls, /^收到：阻塞提问/), 'expected Writer to answer in its reply')
})

await step('user creates Coder, who keeps the default model', () => api('create-bot', { name: 'Coder', role: 'Engineer', instructions: 'Write code.' }), (bot) => {
  const coder = botNamed('Coder')
  return expect(coder && coder.id === bot.id && coder.role === 'Engineer', 'Coder not saved as asked')
    ?? expect(typeof coder.model === 'string' && coder.model.includes('/'), `Coder has no model of its own: ${coder.model}`)
    ?? expect(!Object.values(state().bots).some(entry => 'lab' in entry), 'a Bot still has a lab')
})

await step('Chief creates a group', () => send(chief().id, '建群 研发群: Writer, Coder'), () => {
  const room = roomNamed('研发群')
  if (!room) return 'no group 研发群'
  const names = room.members.map(id => state().bots[id]?.name).sort()
  return expect(names.includes('Writer') && names.includes('Coder'), `members ${names}`)
})

await step('user talks in the group', () => send(roomNamed('研发群').id, '大家好'), () => {
  const log = roomNamed('研发群').log ?? []
  return expect(log.some(line => line.who === 'User' && line.text === '大家好'), 'no user line')
    ?? expect(log.some(line => line.who !== 'User' && line.kind === undefined), 'no Bot answered')
})

await step('admin calls everyone', () => send(roomNamed('研发群').id, '讨论'), () => {
  const log = roomNamed('研发群').log ?? []
  const at = log.findLastIndex(line => line.who === 'User' && line.text === '讨论')
  const answers = log.slice(at + 1).filter(line => line.who !== 'User' && line.kind === undefined)
  return expect(answers.length >= 2, `expected at least two answers, got ${answers.length}`)
})

await step('Chief posts to the group', () => send(chief().id, '群发 研发群: 今天下午开会'), () => {
  const log = roomNamed('研发群').log ?? []
  return expect(log.some(line => line.who === 'Chief' && line.text.includes('今天下午开会')), 'post missing from the group log')
})

await step('Chief sets the group notice', () => send(chief().id, '改群 研发群 公告: 周五交付'), () => expect(roomNamed('研发群').notice === '周五交付', 'notice not set'))

await step('Chief reads the group', () => send(chief().id, '看群 研发群'), (_value, calls) => expect(saidText(calls, /^群里最近/), 'no read_group_chat answer'))

// Group memory: what the group keeps stays in the group.
const groupFact = '研发群的产物放在 out 目录'
const memoryFile = (...path) => {
  try { return readFileSync(join(HOME, 'bot', 'memory', ...path, 'MEMORY.md'), 'utf8') } catch { return '' }
}
await step('the group keeps what the user asks it to remember, in the group memory only', () => send(roomNamed('研发群').id, `记住 ${groupFact}`), () => {
  const room = roomNamed('研发群')
  const elsewhere = [['team'], ...room.members.map(id => ['bots', id])].filter(path => memoryFile(...path).includes(groupFact))
  return expect(memoryFile('groups', room.id).includes(groupFact), 'not in the group memory')
    ?? expect(elsewhere.length === 0, `also in ${elsewhere.map(path => path.join('/')).join(', ')}`)
})
await step('the group memory panel shows it', () => api('memory-view', { roomId: roomNamed('研发群').id }), view => expect(view.entries.some(entry => entry.scope === 'group' && entry.text === groupFact), 'not in the panel'))
await step('members recall it in the group', () => send(roomNamed('研发群').id, '回忆 out'), (_value, calls) => expect(saidText(calls, new RegExp(`记忆里有：[\\s\\S]*\\[group · MEMORY\\.md\\] ${groupFact}`)), 'no member found it'))
await step('a member\'s own chat does not read it', () => send(botNamed('Writer').id, '回忆 out'), (_value, calls) => expect(saidText(calls, /记忆里有：\nNothing in your memory and the team memory mentions "out"/), 'Writer\'s own chat found it'))
await step('a Bot outside the group does not read it', async () => {
  const outsider = await api('create-bot', { name: 'Outsider', role: 'Tester', instructions: 'Test.' })
  await settle()
  return send(outsider.id, '回忆 out')
}, (_value, calls) => expect(saidText(calls, /记忆里有：\nNothing in your memory and the team memory mentions "out"/), 'Outsider found it'))
await step('delete Outsider', () => api('delete-bot', { id: botNamed('Outsider').id }), () => expect(botNamed('Outsider') === undefined, 'Outsider still there'))

for (const round of [1, 2, 3]) {
  await step(`Writer writes long reply ${round}`, () => send(botNamed('Writer').id, `长文 30 第${round}篇`), round < 3 ? undefined : () => {
    const writer = botNamed('Writer')
    return expect((writer.segments ?? []).length >= 1 && writer.sessionId !== writer.id, 'Writer did not switch to a new part')
  })
}

await step('Writer searches its own chat across parts', () => send(botNamed('Writer').id, '查记录 长文'), (_value, calls) => expect(saidText(calls, /共 \d+ 段/), 'read_own_chat did not span parts'))

// `earlier` pages backwards from the part the chat shows now.
await step('earlier part pages load', () => api('earlier', { sessionId: botNamed('Writer').sessionId }), page => expect(Array.isArray(page?.items) && page.items.some(item => item.kind === 'user'), `no user lines in the part before (${JSON.stringify(page).slice(0, 80)})`))

// Work still under way (the mock steward reads 阶段未完 in the latest user message): the
// part is condensed in place with DS Bot's checkpoint, not switched, and the condensed
// messages stay searchable. Then work that reaches a stopping point switches again.
const writerParts = () => (botNamed('Writer').segments ?? []).length
const partsBeforeWork = writerParts()
const workMark = mockLog().length
for (const round of [1, 2, 3]) {
  await step(`Writer keeps working ${round}`, () => send(botNamed('Writer').id, `长文 30 阶段未完 第${round}节`))
}
await step('Writer condensed in place, not switched', () => api('state'), () => {
  const calls = mockLog().slice(workMark)
  return expect(saidText(calls, /"action":"compact"/), 'the steward did not say compact')
    ?? expect(saidText(calls, /checkpoint 提示词/), 'no checkpoint was written')
    ?? expect(!saidText(calls, /backend 提示词/), 'the backend\'s own summary ran for a Bot')
    ?? expect(writerParts() === partsBeforeWork, `Writer switched (${partsBeforeWork} -> ${writerParts()} earlier parts)`)
})
await step('Writer finds a condensed message', () => send(botNamed('Writer').id, '查记录 阶段未完 第1节'), (_value, calls) => expect(saidText(calls, /聊过 [1-9]\d* 条.*第1节/), 'read_own_chat lost the condensed message'))
const wrapMark = mockLog().length
for (const round of [1, 2, 3, 4]) {
  await step(`Writer wraps up ${round}`, () => send(botNamed('Writer').id, `长文 30 收尾 第${round}节`), round < 4 ? undefined : () => {
    const calls = mockLog().slice(wrapMark)
    return expect(saidText(calls, /"action":"switch"/), 'the steward did not say switch')
      ?? expect(writerParts() > partsBeforeWork, 'Writer did not move on after the work was done')
  })
}

await step('exchange log between Chief and Writer', () => api('exchange', { a: chief().id, b: botNamed('Writer').id }), entries => expect(entries.length >= 2, `got ${entries.length}`))

// Writer hands Chief's work on to Coder and waits, and the team view shows it; Coder's
// result goes up to Chief with Writer's answer.
await step('Writer waits for the work it handed on, then answers with it', async () => {
  await send(chief().id, '转告 Writer: 转告 Coder: 慢慢做 3')
  const writer = botNamed('Writer').id
  for (const deadline = Date.now() + STEP_TIMEOUT_MS; Date.now() < deadline; await sleep(200)) {
    const { activity = {}, work = {} } = await api('state')
    if (activity[writer] === 'waiting') return work.waiting?.[writer]
  }
  return undefined
}, (waiting, calls) => expect(waiting?.bots?.includes(botNamed('Coder').id) && waiting.for.includes(chief().id), `Writer did not show that it waits for Coder (${JSON.stringify(waiting)})`)
  ?? expect(saidText(calls, /^Coder 交回了，我把结果交给 Chief/), 'Writer did not go on when Coder answered')
  ?? expect(state().exchanges.some(entry => entry.role === 'reply' && entry.from === botNamed('Writer').id && entry.text.includes('[Handed back to Writer for this work]')), 'Chief did not get Coder\'s result with Writer\'s answer'))

await step('update Writer', () => api('update-bot', { id: botNamed('Writer').id, role: 'Copywriter', instructions: 'Write the copy.' }), () => {
  const writer = botNamed('Writer')
  return expect(writer.role === 'Copywriter' && writer.instructions === 'Write the copy.', 'update not saved')
})

// dsh keeps each Session under a folder named after its cwd. A change of working folder
// moves the Bot's own chat on to a fresh part made there; the fresh part then stays put.
// The native realpath is the one DS Bot saves; on Windows the JS one keeps 8.3 short names.
const project = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-smoke-folder-')))
const folderOf = sessionId => readdirSync(join(HOME, 'sessions')).find(dir => existsSync(join(HOME, 'sessions', dir, sessionId)))
const coderParts = () => (botNamed('Coder').segments ?? []).length
const partsBeforeFolder = coderParts()
await step('Coder works in a folder of its own', () => api('update-bot', { id: botNamed('Coder').id, workDir: project }), () => {
  const coder = botNamed('Coder')
  return expect(coder.workDir === project, `folder not saved (${coder.workDir})`)
    ?? expect(coderParts() === partsBeforeFolder + 1, `Coder has ${coderParts()} earlier parts, not ${partsBeforeFolder + 1}`)
    ?? expect(folderOf(coder.sessionId)?.includes(basename(project)), `Coder's chat is under ${folderOf(coder.sessionId)}`)
})
await step('Coder answers from its folder', () => send(botNamed('Coder').id, '你好'), () => expect(coderParts() === partsBeforeFolder + 1, 'Coder moved on again'))
await step('Coder goes back to the team workspace', () => api('update-bot', { id: botNamed('Coder').id, workDir: '' }), () => {
  const coder = botNamed('Coder')
  return expect(coder.workDir === undefined, 'folder not cleared')
    ?? expect(folderOf(coder.sessionId)?.endsWith('-bot-workspace--'), `Coder's chat is under ${folderOf(coder.sessionId)}`)
})
rmSync(project, { recursive: true, force: true })

await step('pin Coder', () => api('set-flags', { id: botNamed('Coder').id, pinned: true }), () => expect(botNamed('Coder').pinned === true, 'not pinned'))

await step('make Coder a Main Bot and back', async () => {
  await api('set-main', { id: botNamed('Coder').id, main: true })
  const both = state().mainBotIds.length
  await api('set-main', { id: botNamed('Coder').id, main: false })
  return both
}, both => expect(both === 2 && state().mainBotIds.length === 1, `main counts ${both}, ${state().mainBotIds.length}`))

await step('duplicate Coder', () => api('duplicate-bot', { id: botNamed('Coder').id }), copy => expect(copy && state().bots[copy.id] && copy.id !== botNamed('Coder').id, 'no copy'))

await step('set prefs', () => api('set-prefs', { theme: 'dark', accent: '#336699' }), () => expect(state().prefs.theme === 'dark' && state().prefs.accent === '#336699', 'prefs not saved'))

const devRoomId = roomNamed('研发群')?.id
await step('delete the group', () => api('delete-room', { id: devRoomId }), () => expect(Object.keys(state().rooms).length === 0, 'group still there')
  ?? expect(memoryFile('groups', devRoomId) === '', 'the group memory is still in place')
  ?? expect(readdirSync(join(HOME, 'bot', 'memory', 'archive')).some(entry => entry.startsWith(`group-${devRoomId}`)), 'the group memory is not in the archive'))

await step('delete the copy', async () => {
  const copy = Object.values(state().bots).find(bot => bot.name !== 'Coder' && bot.name.startsWith('Coder'))
  if (!copy) throw new Error('no copy to delete')
  await api('delete-bot', { id: copy.id })
  return copy.id
}, id => expect(state().bots[id] === undefined, 'copy still there'))

// The mock answers 查能力 with the mcp__ tools and catalog skills it sees in the request.
const echoName = 'smoke-echo'
const skillName = 'smoke-guide'
const skillDescription = 'Smoke test skill'
const echoServer = join(ROOT, 'ds-bot', 'dev', 'mcp-echo-server.mjs')
const sees = `工具 mcp__${echoName}__echo；技能 ${skillName}（${skillDescription}）`
const seesNothing = '工具 无；技能 无'
const reportOf = (calls, bot) => calls.flatMap(call => call.out ?? []).find(block => block.type === 'text' && block.text.startsWith(`${bot} 能力：`))?.text
const attach = (bot, name, attached) => api('bot-capability', { botId: bot.id, name, attached })
await api('capability-save', { name: echoName, kind: 'mcp', description: 'Smoke test echo server', transport: 'stdio', command: process.execPath, args: [echoServer], env: {} })
await api('capability-save', { name: skillName, kind: 'skill', description: skillDescription, content: 'Use this skill when asked about capability smoke checks.' })
await attach(chief(), echoName, true)
await attach(chief(), skillName, true)

await step('Chief sees its attached MCP and skill', () => send(chief().id, '查能力 smoke'), (_value, calls) => {
  const report = reportOf(calls, 'Chief')
  return expect(report?.endsWith(sees), `Chief reported ${report}`)
})

const capabilityRoom = await api('create-room', { name: 'Capability smoke', members: [chief().id, botNamed('Coder').id], admin: chief().id })
await step('Chief first group turn sees its attached MCP and skill', () => send(capabilityRoom.id, '查能力 smoke'), (_value, calls) => {
  const report = reportOf(calls, 'Chief')
  return expect(report?.endsWith(sees), `Chief reported ${report} in the group`)
})

await step('Coder does not inherit Chief capabilities', () => send(botNamed('Coder').id, '查能力 smoke'), (_value, calls) => {
  const report = reportOf(calls, 'Coder')
  return expect(report?.endsWith(seesNothing), `Coder reported ${report}`)
})

await attach(chief(), echoName, false)
await attach(chief(), skillName, false)
await step('detached capabilities disappear from Chief', () => send(chief().id, '查能力 smoke'), (_value, calls) => {
  const report = reportOf(calls, 'Chief')
  return expect(report?.endsWith(seesNothing), `Chief reported ${report}`)
})

if (outFile) writeFileSync(outFile, `${JSON.stringify(transcript, null, 2)}\n`)
console.log(failures.length === 0 ? `\nsmoke: all ${transcript.length} steps passed` : `\nsmoke: ${failures.length} failed\n${failures.join('\n')}`)
process.exit(failures.length === 0 ? 0 : 1)
