import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import {
  MEMORY_LIMITS, addLink, cleanEntry, cleanTopic, formatEntry, insertEntry, looksLikeKey,
  looksSecret, matchEntries, parseAsk, parseMemory, parseReview, reviewEntries, removeLink, splitMeta, writtenIn,
} from '../src/host/memory.js'
import { latestMemoryChange, summaryBlocks } from '../src/client/text.js'
import { fakeContext } from './fake-ctx.js'

test('entries carry their metadata at the end of the line, as Agent Memory Repo writes it', () => {
  assert.deepEqual(splitMeta('Prefers tea [source: part 2 #14; by: Chief; added: 2026-10-09]'), {
    text: 'Prefers tea', meta: { source: 'part 2 #14', by: 'Chief', added: '2026-10-09' },
  })
  // Brackets that are not metadata stay in the text.
  assert.deepEqual(splitMeta('Uses [[travel]] notes [draft]'), { text: 'Uses [[travel]] notes [draft]', meta: {} })
  assert.equal(formatEntry('Prefers tea', { source: 'part 1 #3', by: '', added: '2026-10-09' }), '- Prefers tea [source: part 1 #3; added: 2026-10-09]')
  assert.equal(formatEntry('x', { source: 'a; b [c]' }), '- x [source: a b c]')
  assert.equal(cleanEntry('  - * Likes  short\nreplies [source: forged] '), 'Likes short replies')
  assert.equal(cleanTopic(' [[Project X.md]] '), 'project-x')
  assert.equal(cleanTopic('旅行'), '旅行')
  for (const bad of ['', '../etc', 'a/b', 'memory', '-x', 'x'.repeat(49)]) assert.equal(cleanTopic(bad), undefined, bad)
})

test('the Index holds topic links; entries above it, and hand-written lines, stay put', () => {
  const text = '# Memory\n\nA note by hand.\n\n- One [added: 2026-10-01]\n\n## Index\n- [[travel]]\n'
  const parsed = parseMemory(text)
  assert.deepEqual(parsed.entries.map(entry => [entry.line, entry.text]), [[4, 'One']])
  assert.deepEqual(parsed.links, ['travel'])
  const added = insertEntry(parsed.lines, '- Two')
  assert.deepEqual(added, ['# Memory', '', 'A note by hand.', '', '- One [added: 2026-10-01]', '- Two', '', '## Index', '- [[travel]]'])
  assert.deepEqual(insertEntry(['# Memory', '', '## Index'], '- First'), ['# Memory', '', '- First', '', '## Index'])
  assert.deepEqual(insertEntry(['# travel'], '- Fly'), ['# travel', '', '- Fly'])
  assert.deepEqual(addLink(added, 'work'), [...added, '- [[work]]'])
  assert.deepEqual(addLink(['# Memory', '', '- One'], 'work'), ['# Memory', '', '- One', '', '## Index', '- [[work]]'])
  assert.deepEqual(removeLink(addLink(added, 'work'), 'travel'), [...added.slice(0, -1), '- [[work]]'])
})

test('a request names one entry by its text, or by a part only it has', () => {
  const entries = parseMemory('- Likes tea\n- Likes green tea\n- Lives in Hangzhou\n').entries
  assert.deepEqual(matchEntries(entries, 'likes tea').map(entry => entry.text), ['Likes tea'])
  assert.deepEqual(matchEntries(entries, 'tea').map(entry => entry.text), ['Likes tea', 'Likes green tea'])
  assert.deepEqual(matchEntries(entries, 'hangzhou').map(entry => entry.text), ['Lives in Hangzhou'])
  assert.deepEqual(matchEntries(entries, '  '), [])
})

test('keys are refused, while paths, names, and links are kept', () => {
  for (const key of ['sk-' + 'abcdefghijklmnopqrstuv', 'ghp_abcdefghijklmnopqrstuvwxyz12', 'AKIA' + 'ABCDEFGHIJKLMNOP', 'token aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3f']) assert.equal(looksLikeKey(key), true, key)
  for (const fine of ['The repo is ~/repos/deepseek-bot/ds-bot/src/host', 'Doc: https://docs.example.com/d/aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3f/edit', 'Uses deepseek-v4-flash for drafts', '用户喜欢简短的回答']) assert.equal(looksLikeKey(fine), false, fine)
  // Passwords given as such, and ID or card numbers, are secrets too.
  for (const secret of ['测试服务器的 root 密码是 hunter2-prod', 'The root password is hunter2', 'pwd: x', '身份证号 330106199001011234', 'card 6222 0212 3456 7890', 'the password for root is hunter2', 'The user\'s ATM PIN is 1234', 'passcode is 654321', '验证码是 123456', 'the CVV is 123', 'staging password remains hunter2', 'root 的密码还是 hunter2', 'the db password was changed to s3cret', 'card 6222-0212-3456-7890', 'Amex 3714-496353-98431', '身份证 330106-19900101-1234', 'I use hunter2 as my password', 'Use 654321 for the PIN', 'The user uses s3cret as the staging root password', '我的密码用 hunter2', '我用 hunter2 当密码', '用 abc123 作为服务器密码', 'I use correct horse battery staple as my password', 'Use six five four three two one for the PIN', '我用 correct horse battery staple 当密码', 'The user\'s SSN is 123-45-6789', 'passport number is A12345678', '护照号E12345678', 'driver\'s license D1234567']) assert.equal(looksSecret(secret), true, secret)
  for (const fine of ['用户不想把密码存进记忆', 'Trip on 2026-11-15, back 2026-11-17', 'The user keeps passwords in a password manager, which is 1Password', '用户的密码管理器是 1Password', 'The user pins the sidebar', 'Pin the tab, it is handy', 'The user uses 1Password for passwords', 'Uses Bitwarden as the password manager', 'Use the PIN pad on the left', '密码用 1Password 管理', '密码不能告诉用户', '密码用于登录', '用 1Password 作为密码管理器', 'Uses Tab for the password field', 'The user uses Vim for editing and Rust for work', 'The user\'s passport expires 2027-05-01', 'Passport renewed 2026-11-15, flight 2026-11-17', 'ID card photo, call 138 0013 8000', '密码不能明文保存因为不安全', 'Off 2026-11-15 2026-11-17', '电话 138-0013-8000', '手机 138 0013 8000 是工作号', 'Issue https://x.test/a/1234567890123456789']) assert.equal(looksSecret(fine), false, fine)
})

test('the memory review writes entries in the language of the user\'s lines', () => {
  assert.equal(writtenIn(['帮我写个函数。我们项目用 TypeScript，包管理只用 pnpm，别给我 npm 命令。'], 'x'), 'Chinese (简体中文)')
  assert.equal(writtenIn(['Use pnpm, not npm'], 'x'), 'English')
  assert.equal(writtenIn(['Rename it to 订单 service please, the old one is wrong'], 'x'), 'x')
  assert.equal(writtenIn(['👍'], 'x'), 'x')
})

test('the memory panel reads JSON from the model, in a fence or not', () => {
  assert.deepEqual(parseAsk('```json\n{"reply": "Done.", "changes": [{"op": "add", "text": "x"}]}\n```'), { reply: 'Done.', changes: [{ op: 'add', text: 'x' }] })
  assert.deepEqual(parseAsk('I could not do that.'), { reply: 'I could not do that.', changes: [] })
  assert.deepEqual(parseAsk('{"reply": 3}'), { reply: '3', changes: [] })
  // The review takes only a list of changes; prose or a broken object is no answer.
  assert.deepEqual(parseReview('```json\n{"changes": [{"op": "add", "text": "x"}]}\n```'), [{ op: 'add', text: 'x' }])
  assert.deepEqual(parseReview('{"changes": []}'), [])
  for (const bad of ['Nothing to keep.', '{"changes": "none"}', '{"changes": [{"op": "add"', '{"changes": ["remember this"]}', '{"changes": [{"text": "x"}]}', '{"changes": [{"op": "add", "text": " "}]}', '{"changes": [{"op": "edit", "entry": "two", "text": "x"}]}', '{"changes": [{"op": "remove", "entry": 0}]}', '{"changes": [{"op": "add", "text": "x", "team": "true"}]}']) assert.equal(parseReview(bad), undefined, bad)
  assert.deepEqual(parseReview('{"changes": [{"op": "remove", "entry": "2"}]}'), [{ op: 'remove', entry: '2' }])
})

test('the panel shows a summary as headings over paragraphs', () => {
  assert.deepEqual(summaryBlocks('## Overview\nYou like **tea**.\nYou live in Hangzhou.\n\n## Team\n- Ship on Friday\n'), [
    { kind: 'h', text: 'Overview' },
    { kind: 'p', text: 'You like tea. You live in Hangzhou.' },
    { kind: 'h', text: 'Team' },
    { kind: 'p', text: 'Ship on Friday' },
  ])
  assert.deepEqual(summaryBlocks(''), [])
})

// ---------------------------------------------------------------------------

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', model: 'deepseek/v4', instructions: '', createdAt: 2 },
    b3: { id: 'b3', sessionId: 'b3', name: 'Coder', role: '代码', instructions: '', createdAt: 3 },
    b4: { id: 'b4', sessionId: 'b4', name: 'Temp', role: '临时', instructions: '', createdAt: 4 },
  },
  rooms: {
    r1: {
      id: 'r1', name: 'Launch', named: true, members: ['b2', 'b3'], admin: 'b3', mode: 'everyone', notice: '', sessions: { b3: 'g3' },
      seq: 3,
      log: [
        { who: 'User', text: 'Keep everything you send me under one page', seq: 1 },
        { who: 'Coder', botId: 'b3', kind: 'lookup', text: 'page', seq: 2 },
        { who: 'Coder', botId: 'b3', text: 'Will do.', seq: 3 },
      ],
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const ownChat = [
  { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please remember this' }] } } },
  { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Saved.' }] } } } },
]

// The model answers each call with the next of `replies`. `history` holds the events
// of a Session, oldest first; each own chat has one user message, at seq 10, unless
// it says otherwise. `requireSession` turns down a request without a Session, as
// some routes do.
function start({ home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-')), replies = [], config = {}, history = {}, reasoning = { efforts: [{ id: 'off' }, { id: 'high' }] }, models = ['v4'], defaultModel, requireSession = false } = {}) {
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const services = defaultModel === undefined ? {} : { agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: defaultModel }) } }
  const ctx = fakeContext({ services })
  const requests = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => models.map(id => ({ id })),
      resolveModelInfo: async () => ({ reasoning }),
      async* stream(request) {
        requests.push(request)
        if (requireSession && request.sessionId === undefined) throw new Error('400: {"type":"MissingSessionID","message":"Request is missing x-opencode-session"}')
        const reply = await replies.shift()
        if (reply instanceof Error) throw reply
        const out = typeof reply === 'object' && reply !== null ? reply : { text: reply ?? '' }
        yield { type: 'text-delta', index: 0, text: out.text ?? '' }
        yield { type: 'finish', reason: { kind: out.finish ?? 'stop', ...(out.failure ? { failure: { message: out.failure } } : {}) } }
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: (history[sessionId] ?? ownChat).at(-1).event.seq + 1 } } }),
      selectModel: async () => {},
      page: async ({ address, beforeSeq, maxMessages }) => {
        const all = (history[address.sessionId] ?? ownChat).filter(record => beforeSeq === undefined || record.event.seq < beforeSeq)
        const records = maxMessages === undefined ? all : all.slice(-maxMessages)
        return { records, hasMore: records.length < all.length }
      },
    },
    sessions: { messageProjections: [] },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home, ...config })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const section = sessionId => ctx.sections.get('bot-memory').text({ agent: { id: sessionId } })
  const read = (...path) => readFileSync(join(home, 'memory', ...path), 'utf8')
  const journal = () => read('journal.jsonl').trim().split('\n').map(line => JSON.parse(line))
  const stop = async ({ keep = false } = {}) => {
    await ctx.dispose()
    if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, home, call, tool, section, read, journal, requests, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

// The summary is written to disk after the model answers; a fixed wait is too short on
// a slow disk and leaves the write running into the next step or the cleanup.
async function summarized(call, botId = 'b2') {
  for (let tries = 0; tries < 200; tries += 1) {
    if ((await call('memory-view', { botId })).value.summarizing === false) return
    await settle()
  }
  throw new Error('the memory summary did not finish')
}

async function until(check) {
  for (let tries = 0; tries < 200 && !check(); tries += 1) await settle()
  assert.ok(check(), 'the condition did not hold within 4 s')
}

test('remember saves one entry with its source, and forget removes it, both in the journal', async (t) => {
  const { tool, read, journal, stop } = start()
  t.after(() => stop())
  assert.match(await tool('remember', { text: '- User prefers short replies' }, 'b2'), /^Saved to your memory, in MEMORY\.md \(MEMORY\.md: \d+ of 4000 characters\)\. It shows in your memory from your next conversation; recall finds it now\.$/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /^# Memory\n\n- User prefers short replies \[source: part 1 #10; added: \d{4}-\d{2}-\d{2}\]\n\n## Index\n$/)
  assert.match(await tool('remember', { text: 'user prefers  SHORT replies' }, 'b2'), /^Already in your memory \(MEMORY\.md\): "User prefers short replies"\. Nothing changed\.$/)

  assert.match(await tool('remember', { text: 'User prefers detailed replies', replace: 'short replies' }, 'b2'), /"User prefers short replies" is now "User prefers detailed replies"/)
  assert.match(await tool('forget', { entry: 'detailed' }, 'b2'), /^Removed from your memory \(MEMORY\.md\): "User prefers detailed replies", all of it, so save again with remember any part that is still true\. The change log keeps a copy\.$/)
  assert.equal(parseMemory(read('bots', 'b2', 'MEMORY.md')).entries.length, 0)
  assert.deepEqual(journal().map(record => [record.op, record.scope, record.file, record.actorName]), [
    ['add', 'bot:b2', 'MEMORY.md', 'Writer'],
    ['replace', 'bot:b2', 'MEMORY.md', 'Writer'],
    ['remove', 'bot:b2', 'MEMORY.md', 'Writer'],
  ])
  const [, replaced, removed] = journal()
  assert.match(replaced.before, /^- User prefers short replies \[/)
  assert.match(replaced.after, /^- User prefers detailed replies \[/)
  assert.match(removed.before, /^- User prefers detailed replies \[/)
  await assert.rejects(tool('forget', { entry: 'nothing like it' }, 'b2'), /No entry in your memory matches "nothing like it"\. recall shows what is saved\.$/)
})

test('topics hold details, linked from MEMORY.md, and go when their last entry does', async (t) => {
  const { tool, read, stop, home } = start()
  t.after(() => stop())
  assert.match(await tool('remember', { text: 'Flies from Hangzhou', topic: 'Travel' }, 'b2'), /in the new topic \[\[travel\]\], linked from MEMORY\.md/)
  assert.match(await tool('remember', { text: 'Prefers window seats', topic: 'travel' }, 'b2'), /in topic \[\[travel\]\] \(travel\.md: \d+ of 16000 characters\)/)
  assert.match(read('bots', 'b2', 'travel.md'), /^# travel\n\n- Flies from Hangzhou \[.*\]\n- Prefers window seats \[.*\]\n$/)
  assert.equal(read('bots', 'b2', 'MEMORY.md'), '# Memory\n\n## Index\n- [[travel]]\n')
  await assert.rejects(tool('remember', { text: 'x', topic: '../up' }, 'b2'), /cannot be a topic name/)

  assert.match(await tool('recall', { topic: 'travel' }, 'b2'), /^Topic \[\[travel\]\] in your memory \(travel\.md: \d+ of 16000 characters\):\n# travel\n\n- Flies from Hangzhou/)
  assert.match(await tool('recall', { query: 'window' }, 'b2'), /^Entries with "window" in your memory and the team memory:\n\[yours · \[\[travel\]\]\] Prefers window seats \[source: part 1 #10; added: /)
  assert.match(await tool('recall', {}, 'b2'), /^Your memory: MEMORY\.md has 0 entries \(MEMORY\.md: \d+ of 4000 characters\); topics \[\[travel\]\] \(2\)\.\n\nThe team memory: MEMORY\.md has 0 entries/)

  await tool('forget', { entry: 'Flies' }, 'b2')
  assert.match(await tool('forget', { entry: 'window', topic: 'travel' }, 'b2'), /The topic \[\[travel\]\] was empty, so it is gone too\./)
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b2', 'travel.md')), false)
  assert.equal(read('bots', 'b2', 'MEMORY.md'), '# Memory\n\n## Index\n')
})

test('Main Bots and group admins write the team memory; only Main Bots touch another Bot\'s', async (t) => {
  const { tool, read, stop } = start()
  t.after(() => stop())
  await assert.rejects(tool('remember', { text: 'Ship on Friday', scope: 'team' }, 'b2'), /Only Main Bots and group admins write the team memory/)
  // Coder is the admin of Launch, and speaks there from its group Session.
  assert.match(await tool('remember', { text: 'Ship on Friday', scope: 'team' }, 'g3'), /^Saved to the team memory/)
  assert.match(read('team', 'MEMORY.md'), /- Ship on Friday \[source: group "Launch" \d{2}-\d{2} \d{2}:\d{2}; by: Coder; added: /)
  assert.match(await tool('remember', { text: 'Writes in Chinese', scope: 'Writer' }, 'm1'), /^Saved to Writer's memory/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Writes in Chinese \[source: part 1 #10; by: Chief; added: /)
  await assert.rejects(tool('remember', { text: 'Bossy', scope: 'Chief' }, 'b2'), /Only a Main Bot can change another Bot's memory/)
  assert.match(await tool('recall', { scope: 'Writer' }, 'b3'), /^Only a Main Bot can read another Bot's memory/)
  assert.match(await tool('recall', { scope: 'Nobody' }, 'b3'), /^No Bot named Nobody/)
  assert.match(await tool('recall', { query: 'friday' }, 'b2'), /\[team · MEMORY\.md\] Ship on Friday/)
  await assert.rejects(tool('forget', { entry: 'Friday', scope: 'team' }, 'b2'), /Only Main Bots and group admins/)
  assert.match(await tool('forget', { entry: 'Friday', scope: 'team' }, 'm1'), /^Removed from the team memory/)
  await assert.rejects(tool('remember', { text: 'x' }, 'stranger'), /Only Bots on the team keep a memory\./)
})

test('keys, long entries, and full files are refused with what to do instead', async (t) => {
  const { tool, read, stop, home } = start()
  t.after(() => stop())
  await assert.rejects(tool('remember', { text: 'API key sk-' + 'abcdefghijklmnopqrstuvwx' }, 'b2'), /looks like a key.*request_secret/)
  await assert.rejects(tool('remember', { text: 'x'.repeat(MEMORY_LIMITS.entry + 1) }, 'b2'), /at most 300 characters; this one has 301/)
  await assert.rejects(tool('remember', { text: '  ' }, 'b2'), /Write the entry to save\.$/)

  // A MEMORY.md written past its size by hand still takes a shorter replacement.
  const big = Array.from({ length: 16 }, (_, index) => `- Fact ${index} ${'y'.repeat(250)}`)
  mkdirSync(join(home, 'memory', 'bots', 'b2'), { recursive: true })
  writeFileSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md'), `# Memory\n\n${big.join('\n')}\n`)
  await assert.rejects(tool('remember', { text: 'One more' }, 'b2'), /MEMORY\.md would have \d+ of its 4000 characters\. Make room first: move details into a topic/)
  assert.match(await tool('remember', { text: 'Fact 3 is short now', replace: 'Fact 3 ' }, 'b2'), /is now "Fact 3 is short now"/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Fact 3 is short now \[/)
  await assert.rejects(tool('forget', { entry: 'Fact 1' }, 'b2'), /matches \d+ entries in your memory; quote more of the one you mean:\n- Fact 1 y+ \(MEMORY\.md\)\n- Fact 10/)
})

test('a write that changed nothing fails the call with a code, and a saved one keeps its answer', async (t) => {
  const { tool, stop } = start()
  t.after(() => stop())
  // What a saved write answers is what the model reads, word for word.
  assert.match(await tool('remember', { text: 'Likes tea' }, 'b2'), /^Saved to your memory, in MEMORY\.md \(MEMORY\.md: \d+ of 4000 characters\)\. It shows in your memory from your next conversation; recall finds it now\.$/)
  // A refusal is a failure, with the kind of failure in its code.
  await assert.rejects(tool('remember', { text: 'Ship on Friday', scope: 'team' }, 'b2'), (error) => {
    assert.equal(error.code, 'memory/refused')
    assert.match(error.message, /Only Main Bots and group admins write the team memory/)
    return true
  })
  // A write with nothing in it says what is missing.
  await assert.rejects(tool('remember', { text: '  ' }, 'b2'), (error) => {
    assert.equal(error.code, 'memory/empty')
    assert.match(error.message, /Write the entry to save\./)
    return true
  })
  // A failure from the write keeps the kind it came with.
  await assert.rejects(tool('forget', { entry: 'nothing like it' }, 'b2'), (error) => {
    assert.equal(error.code, 'memory/no-match')
    assert.match(error.message, /No entry in your memory matches "nothing like it"/)
    return true
  })
})

test('a Session keeps the memory it began with, across restarts, until its snapshot goes', async (t) => {
  const first = start()
  t.after(() => first.stop())
  await first.tool('remember', { text: 'Likes tea' }, 'b2')
  const opened = first.section('b2')
  assert.match(opened, /^# Your memory\n/)
  assert.match(opened, /## Your memory \(MEMORY\.md\)\n- Likes tea \[source: part 1 #10; added: [\d-]+\]\n\n## Team memory, shared by every Bot \(team\/MEMORY\.md\)\n\(nothing saved yet\)$/)
  assert.match(opened, /when the whole team should know something, tell a Main Bot with message_bot/)
  assert.match(first.section('m1'), /As a Main Bot you write it with remember scope "team"/)
  assert.match(first.section('g3'), /As a group admin you write it/)
  assert.equal(first.section('nobody'), '')

  await first.tool('remember', { text: 'Lives in Hangzhou', topic: 'home' }, 'b2')
  assert.equal(first.section('b2'), opened)
  // Another dsh run finds the snapshot and keeps the same bytes.
  await first.stop({ keep: true })
  const second = start({ home: first.home })
  await second.tool('recall', {}, 'b2')
  assert.equal(second.section('b2'), opened)
  // Without its snapshot (renewMemory removes it), the Session freezes the memory anew.
  await second.ctx.dispose()
  const renewed = start({ home: first.home })
  t.after(() => renewed.stop())
  rmSync(join(first.home, 'memory', 'snapshots', 'b2.md'))
  await renewed.tool('recall', {}, 'b2')
  assert.match(renewed.section('b2'), /- Likes tea \[.*\]\nTopics: \[\[home\]\]\n/)
})

test('a memory file that cannot be read is left alone, and the section says so', async (t) => {
  const { home, tool, section, stop } = start()
  t.after(() => stop())
  // A directory reads as EISDIR on every platform; no chmod games needed.
  mkdirSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md'), { recursive: true })
  await assert.rejects(tool('remember', { text: 'Likes tea' }, 'b2'), /Memory file .*MEMORY\.md could not be read \(EISDIR\)\. DS Bot leaves it as it is/)
  assert.deepEqual(readdirSync(join(home, 'memory', 'bots', 'b2')), ['MEMORY.md'])
  // The prompt shows the failure instead of looking empty, and nothing is frozen.
  assert.match(section('b2'), /\(this memory could not be read: EISDIR\)/)
  assert.equal(existsSync(join(home, 'memory', 'snapshots', 'b2.md')), false)
  rmSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md'), { recursive: true })
  const after = section('b2')
  assert.doesNotMatch(after, /could not be read/)
  assert.match(after, /\(nothing saved yet\)/)
})

test('a change of role freezes the section again, so its team rule matches the tools', async (t) => {
  const { call, tool, section, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  const before = section('b2')
  assert.match(before, /tell a Main Bot with message_bot/)
  await tool('remember', { text: 'Lives in Hangzhou' }, 'b2')
  assert.equal(section('b2'), before)

  assert.equal((await call('set-main', { id: 'b2', main: true })).ok, true)
  const promoted = section('b2')
  assert.match(promoted, /As a Main Bot you write it with remember scope "team"/)
  assert.doesNotMatch(promoted, /tell a Main Bot with message_bot/)
  // Frozen anew, so entries saved since come along; then it holds still again.
  assert.match(promoted, /- Lives in Hangzhou \[/)
  assert.equal(section('b2'), promoted)

  assert.equal((await call('set-main', { id: 'b2', main: false })).ok, true)
  assert.match(section('b2'), /tell a Main Bot with message_bot/)
  // Coder loses the admin seat of Launch, and with it the team rule in its group Session.
  assert.match(section('g3'), /As a group admin you write it/)
  assert.equal((await call('update-room', { id: 'r1', admin: 'b2' })).ok, true)
  assert.match(section('g3'), /tell a Main Bot with message_bot/)
  assert.match(section('b2'), /As a group admin you write it/)
})

test('deleting a Bot moves its memory to the archive', async (t) => {
  const { tool, call, home, journal, section, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Temporary fact' }, 'b4')
  section('b4')
  assert.equal(existsSync(join(home, 'memory', 'snapshots', 'b4.md')), true)
  assert.equal((await call('delete-bot', { id: 'b4' })).ok, true)
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b4')), false)
  assert.equal(existsSync(join(home, 'memory', 'snapshots', 'b4.md')), false)
  const [archived] = readdirSync(join(home, 'memory', 'archive'))
  assert.match(archived, /^b4-\d{4}-/)
  assert.match(readFileSync(join(home, 'memory', 'archive', archived, 'MEMORY.md'), 'utf8'), /Temporary fact/)
  assert.deepEqual(journal().at(-1).op, 'archive')
})

test('the memory panel shows every entry and a summary the Bot\'s model writes once per change', async (t) => {
  const replies = ['## Overview\nYou like tea.']
  const { tool, call, requests, stop } = start({ replies })
  t.after(() => stop())
  assert.equal((await call('state', {})).value.memory, true)
  const empty = (await call('memory-view', { botId: 'b2', summarize: true })).value
  assert.deepEqual([empty.entries, empty.summary, empty.fresh, empty.summarizing], [[], null, true, false])
  assert.deepEqual(empty.limits, MEMORY_LIMITS)
  assert.equal(requests.length, 0)

  await tool('remember', { text: 'Likes tea' }, 'b2')
  const asked = (await call('memory-view', { botId: 'b2', summarize: true })).value
  assert.deepEqual(asked.entries.map(entry => [entry.scope, entry.topic, entry.text]), [['own', null, 'Likes tea']])
  assert.equal(asked.summarizing, true)
  await summarized(call)
  const done = (await call('memory-view', { botId: 'b2', summarize: true })).value
  assert.deepEqual([done.summary.text, done.fresh, done.summarizing, done.error], ['## Overview\nYou like tea.', true, false, null])
  assert.equal(requests.length, 1)
  assert.deepEqual([requests[0].provider, requests[0].model, requests[0].reasoningEffort], ['deepseek', 'v4', 'off'])
  assert.match(requests[0].messages[0].content[0].text, /## Writer's memory\n- Likes tea\n\n## Team memory\n\(nothing\)/)

  // A new entry leaves the old summary up, marked stale, until the next one is in.
  await tool('remember', { text: 'Lives in Hangzhou' }, 'b2')
  replies.push(new Error('provider down'))
  assert.equal((await call('memory-view', { botId: 'b2', summarize: true })).value.fresh, false)
  await summarized(call)
  const failed = (await call('memory-view', { botId: 'b2', summarize: true })).value
  assert.deepEqual([failed.summary.text, failed.fresh, failed.error], ['## Overview\nYou like tea.', false, 'provider down'])
  assert.equal(requests.length, 2)
  replies.push('## Overview\nYou like tea and live in Hangzhou.')
  await call('memory-view', { botId: 'b2', regenerate: true })
  await summarized(call)
  assert.equal((await call('memory-view', { botId: 'b2' })).value.summary.text, '## Overview\nYou like tea and live in Hangzhou.')
  assert.equal((await call('memory-view', { botId: 'nope' })).error.message, 'Unknown Bot')
})

test('a summary cut off at the output limit is written once more with a bigger budget, never kept half', async (t) => {
  const replies = [
    { text: '## Overview\nYou like', finish: 'max-tokens' },
    '## Overview\nYou like tea.',
  ]
  const { tool, call, requests, stop } = start({ replies })
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  await call('memory-view', { botId: 'b2', summarize: true })
  await summarized(call)
  const done = (await call('memory-view', { botId: 'b2' })).value
  assert.deepEqual([done.summary?.text, done.fresh, done.error], ['## Overview\nYou like tea.', true, null])
  assert.deepEqual(requests.map(request => request.maxTokens), [2048, 8192])
})

test('a summary cut off at both budgets keeps the old one and says the reasoning used the budget', async (t) => {
  const replies = [
    '## Overview\nYou like tea.',
    { text: '', finish: 'max-tokens' },
    { text: '## Overview\nhalf', finish: 'max-tokens' },
  ]
  const { tool, call, requests, stop } = start({ replies })
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  await call('memory-view', { botId: 'b2', summarize: true })
  await summarized(call)
  // A new entry asks for a fresh summary; both its tries are cut off.
  await tool('remember', { text: 'Lives in Hangzhou' }, 'b2')
  await call('memory-view', { botId: 'b2', summarize: true })
  await summarized(call)
  const failed = (await call('memory-view', { botId: 'b2' })).value
  assert.equal(failed.summary.text, '## Overview\nYou like tea.')
  assert.match(failed.error, /reasoning.*output budget|output budget.*reasoning/i)
  assert.deepEqual(requests.map(request => request.maxTokens), [2048, 2048, 8192])
})

test('the panel call asks for the model\'s lowest thinking level when it has no "off"', async (t) => {
  const first = start({ replies: ['## ok'], reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } })
  t.after(() => first.stop())
  await first.tool('remember', { text: 'Likes tea' }, 'b2')
  await first.call('memory-view', { botId: 'b2', summarize: true })
  await summarized(first.call)
  assert.equal(first.requests[0].reasoningEffort, 'low')

  const second = start({ replies: ['## ok'], reasoning: {} })
  t.after(() => second.stop())
  await second.tool('remember', { text: 'Likes tea' }, 'b2')
  await second.call('memory-view', { botId: 'b2', summarize: true })
  await summarized(second.call)
  assert.equal(second.requests[0].reasoningEffort, undefined)
})

const routes = requests => requests.map(request => `${request.provider}/${request.model}@${request.maxTokens}`)

test('a summary the Bot\'s model refuses is written by the profile default model', async (t) => {
  const replies = [{ text: '', finish: 'error', failure: '403 Forbidden' }, '## Overview\nYou like tea.']
  const { tool, call, requests, stop } = start({ replies, models: ['v4', 'flash'], defaultModel: 'flash' })
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  await call('memory-view', { botId: 'b2', summarize: true })
  await summarized(call)
  const done = (await call('memory-view', { botId: 'b2' })).value
  assert.deepEqual([done.summary?.text, done.fresh, done.error], ['## Overview\nYou like tea.', true, null])
  assert.deepEqual(routes(requests), ['deepseek/v4@2048', 'deepseek/flash@2048'])
  assert.ok(requests.every(request => request.messages[0].content[0].text.includes('Likes tea')))
})

test('a summary cut off at both budgets on the Bot\'s model is written by the default model', async (t) => {
  const replies = [{ text: '', finish: 'max-tokens' }, { text: '## half', finish: 'max-tokens' }, '## Overview\nYou like tea.']
  const { tool, call, requests, stop } = start({ replies, models: ['v4', 'flash'], defaultModel: 'flash' })
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  await call('memory-view', { botId: 'b2', summarize: true })
  await summarized(call)
  const done = (await call('memory-view', { botId: 'b2' })).value
  assert.deepEqual([done.summary?.text, done.error], ['## Overview\nYou like tea.', null])
  assert.deepEqual(routes(requests), ['deepseek/v4@2048', 'deepseek/v4@8192', 'deepseek/flash@2048'])
})

test('a summary that failed on both models is tried again once the Bot has another model', async (t) => {
  const replies = [new Error('401: Unauthorized'), { text: '', finish: 'error', failure: '503 Service Unavailable' }]
  const { tool, call, requests, stop } = start({ replies, models: ['v4', 'flash'], defaultModel: 'flash' })
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  await call('memory-view', { botId: 'b2', summarize: true })
  await summarized(call)
  const failed = (await call('memory-view', { botId: 'b2', summarize: true })).value
  assert.equal(failed.error, 'deepseek/v4: 401: Unauthorized; deepseek/flash: 503 Service Unavailable')
  assert.equal(failed.summarizing, false)
  assert.equal(requests.length, 2)

  assert.equal((await call('update-bot', { id: 'b2', model: 'deepseek/flash' })).ok, true)
  replies.push('## Overview\nYou like tea.')
  const retried = (await call('memory-view', { botId: 'b2', summarize: true })).value
  assert.deepEqual([retried.summarizing, retried.error], [true, null])
  await summarized(call)
  const done = (await call('memory-view', { botId: 'b2' })).value
  assert.deepEqual([done.summary?.text, done.error], ['## Overview\nYou like tea.', null])
  assert.deepEqual(routes(requests).slice(2), ['deepseek/flash@2048'])
})

test('"ask or update" falls back to the default model when the Bot\'s model fails', async (t) => {
  const replies = [new Error('403 Forbidden'), JSON.stringify({ reply: 'You like tea.', changes: [] })]
  const { tool, call, requests, stop } = start({ replies, models: ['v4', 'flash'], defaultModel: 'flash' })
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  const answer = (await call('memory-ask', { botId: 'b2', text: 'What do I like?' })).value
  assert.equal(answer.reply, 'You like tea.')
  assert.deepEqual(routes(requests), ['deepseek/v4@2048', 'deepseek/flash@2048'])
})

test('"ask or update" answers from the entries and changes them through the same rules', async (t) => {
  const replies = []
  const { tool, call, read, journal, requests, stop } = start({ replies })
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  await tool('remember', { text: 'Ship on Friday', scope: 'team' }, 'm1')
  replies.push(JSON.stringify({
    reply: 'Done.',
    changes: [
      { op: 'edit', entry: 1, text: 'Likes green tea' },
      { op: 'add', text: 'Lives in Hangzhou' },
      { op: 'add', text: 'Team meets on Monday', team: true },
      { op: 'remove', entry: 2 },
      { op: 'add', text: 'token aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3f' },
      { op: 'remove', entry: 9 },
    ],
  }))
  const answer = (await call('memory-ask', { botId: 'b2', text: 'I like green tea now; I live in Hangzhou; we meet Mondays; Friday is off' })).value
  assert.match(requests[0].messages[0].content[0].text, /^Entries of Writer \(yours: Writer's own; team: shared by every Bot\):\n\[1\] \(own\) Likes tea\n\[2\] \(team\) Ship on Friday\n/)
  assert.equal(answer.reply, 'Done.')
  assert.deepEqual(answer.changes.map(change => [change.op, change.scope, change.ok]), [
    ['edit', 'own', true], ['add', 'own', true], ['add', 'team', true], ['remove', 'team', true], ['add', 'own', false], ['remove', 'own', false],
  ])
  assert.match(answer.changes[4].error, /looks like a key/)
  assert.equal(answer.changes[5].error, 'There is no entry 9.')
  assert.deepEqual(answer.view.entries.map(entry => entry.text), ['Likes green tea', 'Lives in Hangzhou', 'Team meets on Monday'])
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- Likes green tea \[source: memory panel; by: user; added: /)
  assert.ok(journal().slice(-4).every(record => record.actor === 'user'))

  const forgot = (await call('memory-forget', { botId: 'b2', scope: 'team', topic: null, text: 'Team meets on Monday' })).value
  assert.deepEqual(forgot.entries.map(entry => entry.text), ['Likes green tea', 'Lives in Hangzhou'])
  assert.equal((await call('memory-ask', { botId: 'b2', text: ' ' })).error.message, 'Type a question or a change first')
})

test('a host that only reads the team shows memory but changes none of it', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const { tool, call, section, stop } = start({ home })
  t.after(() => stop())
  await call('state', {})
  await assert.rejects(tool('remember', { text: 'Likes tea' }, 'b2'), /Memory cannot change now: The Bot team in .* is open in another dsh/)
  assert.equal((await call('memory-view', { botId: 'b2' })).ok, true)
  assert.equal((await call('memory-ask', { botId: 'b2', text: 'hi' })).error.code, 'bot/read-only')
  assert.match(section('b2'), /^# Your memory/)
  assert.equal(existsSync(join(home, 'memory', 'snapshots')), false)
})

// Until no review waits or runs.
async function reviewed(call) {
  for (let tries = 0; tries < 200; tries += 1) {
    await settle()
    if ((await call('state', {})).value.memoryReviews === 0) return
  }
  throw new Error('the memory review did not finish')
}

test('when a turn ends, the memory review keeps what the user said, through the same rules', async (t) => {
  const history = {
    b2: [
      { event: { seq: 20, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Too busy. I like it plain, mostly black and white. I moved to Rust. The root password is hunter2' }] } } },
      { event: { seq: 21, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Here is a plainer one.' }] } } } },
    ],
  }
  const replies = []
  const { ctx, home, tool, call, read, journal, requests, section, stop } = start({ replies, history, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await tool('remember', { text: 'The user writes Go' }, 'b2')
  assert.equal((await call('state', {})).value.memoryNews.b2.text, 'The user writes Go')
  assert.match(section('b2'), /After each of your turns, a memory review reads the new messages/)

  replies.push(`\`\`\`json\n${JSON.stringify({
    changes: [
      { op: 'add', text: 'The user likes a plain style, mostly black and white' },
      { op: 'add', text: 'Everyone should keep it plain', team: true },
      { op: 'edit', entry: 1, text: 'The user writes Rust' },
      { op: 'add', text: 'The root password is hunter2' },
    ],
  })}\n\`\`\``)
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.match(requests[0].system, /^You keep the long-term memory of one Bot/)
  assert.doesNotMatch(requests[0].system, /"team": true/)
  assert.equal(requests[0].messages[0].content[0].text, [
    'The Bot: Writer, 写作.',
    '',
    'MEMORY.md has 81 of 4000 characters (own) and 0 of 4000 (team).',
    '',
    'Its memory now (own: this Bot\'s; team: shared by every Bot):',
    '[1] (own) The user writes Go',
    '',
    'New in its own chat with the user, oldest first:',
    'User: Too busy. I like it plain, mostly black and white. I moved to Rust. The root password is hunter2',
    'Writer: Here is a plainer one.',
    '',
    'Write every new or changed entry in English.',
  ].join('\n'))
  // Writer writes no team memory, so the team entry stays its own; no password is kept.
  const entries = parseMemory(read('bots', 'b2', 'MEMORY.md')).entries
  assert.deepEqual(entries.map(entry => entry.text), ['The user writes Rust', 'The user likes a plain style, mostly black and white', 'Everyone should keep it plain'])
  assert.equal(entries[1].meta.source, 'part 1 #20')
  assert.deepEqual(journal().slice(1).map(record => [record.op, record.actorName, record.auto]), [
    ['add', 'Writer', true], ['add', 'Writer', true], ['replace', 'Writer', true],
  ])
  // The review's tokens count as the Bot's memory use, not as "Other".
  const meter = ctx.listeners.get('llm/stream').find(listener => /tags\.get/.test(String(listener)))
  for await (const chunk of meter(requests[0], async function* () { yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 2 } } })) assert.equal(chunk.type, 'usage')
  const usage = (await call('usage', { timeZone: 'UTC' })).value
  assert.deepEqual(usage.rows.map(row => [usage.owners[row[1]].name, usage.kinds[row[3]], row[4] + row[7]]), [['Writer', 'memory', 42]])
  const state = (await call('state', {})).value
  assert.deepEqual([state.memoryNews.b2.op, state.memoryNews.b2.text], ['replace', 'The user writes Rust'])
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 21 })

  // Nothing new, or nothing from the user: no model call, and the place moves on.
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  history.b2.push({ event: { seq: 22, type: 'user/message', data: { source: { kind: 'bot' }, content: [{ type: 'text', text: '[Message from Chief] Status?' }] } } })
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 22 })

  // A turn that starts again before the review is due is reviewed when it ends; a
  // Session that is no Bot's is never reviewed.
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'running' })
  ctx.emit('agent/status', { agent: { id: 'stranger' }, status: 'idle' })
  assert.equal((await call('state', {})).value.memoryReviews, 0)
  assert.equal(existsSync(join(home, 'memory', 'team', 'MEMORY.md')), false)

  // Changes the user makes in the memory panel are no news.
  replies.push(JSON.stringify({ reply: 'Done.', changes: [{ op: 'add', text: 'Likes tea' }] }))
  await call('memory-ask', { botId: 'b2', text: 'I like tea' })
  assert.equal((await call('state', {})).value.memoryNews.b2.text, 'The user writes Rust')
})

test('a group\'s review keeps what is said there in the group memory, read once for all its members', async (t) => {
  const replies = [JSON.stringify({ changes: [{ op: 'add', text: 'The user wants everything under one page', team: true }] })]
  const { ctx, call, read, home, requests, stop } = start({ replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.match(requests[0].system, /^You keep the long-term memory of one group chat/)
  // The admin's model reads it, but no team entry comes of a group's review.
  assert.doesNotMatch(requests[0].system, /"team": true/)
  assert.equal(requests[0].sessionId, 'r1')
  const text = requests[0].messages[0].content[0].text
  assert.match(text, /^The group chat: "Launch", with the user and Writer, Coder \(admin\)\.\n\nMEMORY\.md has 0 of 4000 characters \(group\) and 0 of 4000 \(team\)\.\n\nIts memory now \(group: shared by the members of this group; team: shared by every Bot\):\n\(none yet\)\n/)
  assert.match(text, /New in the group chat "Launch", oldest first:\nUser: Keep everything you send me under one page\nCoder: Will do\.\n\nWrite every new or changed entry in English\.$/)
  assert.match(read('groups', 'r1', 'MEMORY.md'), /- The user wants everything under one page \[source: group "Launch" \d{2}-\d{2} \d{2}:\d{2}; added: /)
  for (const elsewhere of [['team'], ['bots', 'b2'], ['bots', 'b3']]) assert.equal(existsSync(join(home, 'memory', ...elsewhere, 'MEMORY.md')), false, elsewhere.join('/'))
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'group:r1': 3 })
  assert.equal((await call('state', {})).value.memoryNews.r1.op, 'add')
})

test('a first group review reads back to the user\'s line past a round of replies', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  const replies = Array.from({ length: 6 }, (_, at) => ({ who: at % 2 ? 'Coder' : 'Writer', botId: at % 2 ? 'b3' : 'b2', text: `Reply ${at + 1}`, seq: at + 2 }))
  const room = { ...TEAM.rooms.r1, seq: 7, log: [{ who: 'User', text: 'From now on, answer in Chinese', seq: 1 }, ...replies] }
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, rooms: { r1: room } }))
  const { ctx, call, read, requests, stop } = start({ home, replies: [JSON.stringify({ changes: [] })], config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.match(requests[0].messages[0].content[0].text, /oldest first:\nUser: From now on, answer in Chinese\nWriter: Reply 1\n/)
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'group:r1': 7 })
})

test('an answer that is no list of changes keeps the review\'s place, and the next one reads the turn again', async (t) => {
  const replies = ['Nothing worth keeping here.', JSON.stringify({ changes: [{ op: 'add', text: 'The user wants this remembered' }] })]
  const { ctx, call, read, requests, stop } = start({ replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  // The first review fixed where it starts, just before the user's line.
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 9 })
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].messages[0].content[0].text, requests[0].messages[0].content[0].text)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- The user wants this remembered \[source: part 1 #10;/)
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 11 })
})

test('an answer with a malformed change, an unlisted entry, an entry too long, or a bad topic changes nothing and keeps the review\'s place', async (t) => {
  const replies = [
    JSON.stringify({ changes: [{ op: 'add', text: 'The user likes tea' }, { op: 'add' }] }),
    JSON.stringify({ changes: [{ op: 'add', text: 'The user likes tea' }, { op: 'remove', entry: 7 }] }),
    JSON.stringify({ changes: [{ op: 'add', text: 'The user likes tea' }, { op: 'add', text: `The user tells ${'a long story '.repeat(30)}` }] }),
    JSON.stringify({ changes: [{ op: 'add', text: 'The user likes tea' }, { op: 'add', text: 'The user writes C++', topic: 'C++' }] }),
    JSON.stringify({ changes: [{ op: 'add', text: 'The user likes tea' }, { op: 'add', text: 'I use hunter2 as my password' }] }),
  ]
  const { ctx, call, read, requests, stop } = start({ replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  for (let tries = 0; tries < 4; tries += 1) {
    ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
    await reviewed(call)
    assert.throws(() => read('bots', 'b2', 'MEMORY.md'), { code: 'ENOENT' })
    assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 9 })
  }
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  // A password is only left out: the rest is written and the place moves on.
  assert.equal(requests.length, 5)
  assert.deepEqual(parseMemory(read('bots', 'b2', 'MEMORY.md')).entries.map(entry => entry.text), ['The user likes tea'])
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 11 })
})

test('a backlog past the text limit is reviewed in passes, oldest first', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  mkdirSync(join(home, 'memory'), { recursive: true })
  writeFileSync(join(home, 'memory', 'reviewed.json'), JSON.stringify({ 'chat:b2': 19 }))
  const notes = Array.from({ length: 8 }, (_, at) => ({ event: { seq: 20 + at, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `Note ${at + 1} ${'x'.repeat(2480)}` }] } } }))
  const replies = [JSON.stringify({ changes: [] }), JSON.stringify({ changes: [] })]
  const { ctx, call, read, requests, stop } = start({ home, replies, history: { b2: notes }, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 2)
  const [first, second] = requests.map(request => request.messages[0].content[0].text)
  assert.match(first, /oldest first \(newer messages come in the next review\):\nUser: Note 1 /)
  assert.deepEqual(first.match(/Note \d/g), ['Note 1', 'Note 2', 'Note 3', 'Note 4', 'Note 5', 'Note 6'])
  assert.deepEqual(second.match(/Note \d/g).slice(-2), ['Note 7', 'Note 8'])
  assert.match(second, /oldest first:\nUser: Note 7 /)
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 27 })
})

test('an answer past the change limit is applied in part, and the same lines are read once more', async (t) => {
  const many = Array.from({ length: 9 }, (_, at) => ({ op: 'add', text: `The user likes thing ${at + 1}` }))
  const replies = [JSON.stringify({ changes: many }), JSON.stringify({ changes: [many[8]] })]
  const { ctx, call, read, requests, stop } = start({ replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 2)
  assert.match(requests[0].system, /At most 8 changes in one answer/)
  assert.match(requests[1].messages[0].content[0].text, /\[8\] \(own\) The user likes thing 8\n/)
  assert.equal(parseMemory(read('bots', 'b2', 'MEMORY.md')).entries.length, 9)
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 11 })
})

test('an answer that reaches the change limit exactly is followed by another pass', async (t) => {
  const many = Array.from({ length: 9 }, (_, at) => ({ op: 'add', text: `The user likes item ${at + 1}` }))
  const replies = [JSON.stringify({ changes: many.slice(0, 8) }), JSON.stringify({ changes: [many[8]] })]
  const { ctx, call, read, requests, stop } = start({ replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 2)
  assert.equal(parseMemory(read('bots', 'b2', 'MEMORY.md')).entries.length, 9)
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 11 })
})

test('a full MEMORY.md keeps the review\'s place, and an add with a topic lands there', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  mkdirSync(join(home, 'memory', 'bots', 'b2'), { recursive: true })
  const filler = Array.from({ length: 13 }, (_, at) => `- Filler fact number ${at + 1} ${'y'.repeat(280)}`)
  writeFileSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md'), `# Memory\n\n${filler.join('\n')}\n\n## Index\n`)
  const replies = [JSON.stringify({ changes: [{ op: 'add', text: 'The user flies with Air China' }] }), JSON.stringify({ changes: [{ op: 'add', text: 'The user flies with Air China', topic: '出行' }] })]
  const { ctx, call, read, requests, stop } = start({ home, replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.match(requests[0].messages[0].content[0].text, /MEMORY\.md has 3\d{3} of 4000 characters \(own\)/)
  assert.match(requests[0].system, /"topic": "travel"/)
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 9 })
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.match(read('bots', 'b2', '出行.md'), /- The user flies with Air China \[/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /\[\[出行\]\]/)
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 11 })
})

test('topic entries that share words with the user\'s new lines come first', () => {
  const own = [{ entries: [] }, { topic: 'work', entries: [
    { text: 'Ships on Fridays', meta: { added: '2026-01-01' } },
    { text: 'Drinks green tea', meta: { added: '2026-10-01' } },
    { text: '用户住在杭州的西湖区附近哦', meta: { added: '2026-02-01' } },
  ] }]
  const shown = about => reviewEntries(own, [{ entries: [] }], 16, about).numbered.map(entry => entry.text)
  assert.deepEqual(shown(''), ['Drinks green tea'])
  assert.deepEqual(shown('We no longer ship on Fridays'), ['Ships on Fridays'])
  assert.deepEqual(shown('我搬离杭州了'), ['用户住在杭州的西湖区附近哦'])
})

test('the pill opens the memory that changed last on the host, when one poll brings two', () => {
  const news = { b2: { at: 2_000, seen: 5_000 }, b3: { at: 3_000, seen: 5_000 }, b4: { at: 9_000, seen: 0 } }
  assert.equal(latestMemoryChange(news, ['b2', 'b3']), 'b3')
  assert.equal(latestMemoryChange(news, ['b4', 'b2']), 'b2')
  assert.equal(latestMemoryChange({}, ['b2']), 'b2')
  assert.equal(latestMemoryChange({}, []), null)
})

const twoMembers = home => writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, rooms: { r1: { ...TEAM.rooms.r1, members: ['b2', 'b3', 'b4'], sessions: { b2: 'g2', b3: 'g3' } } } }))

test('the members of a group read its memory in their Sessions there, and no Bot reads it anywhere else', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  twoMembers(home)
  const { ctx, call, tool, section, requests, stop } = start({ home, replies: [JSON.stringify({ changes: [{ op: 'add', text: 'The user wants everything under one page' }] })], config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  // Two members' turns end: the group is reviewed once, not once per member.
  ctx.emit('agent/status', { agent: { id: 'g2' }, status: 'idle' })
  ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  for (const member of ['g2', 'g3']) {
    assert.match(section(member), /\n\n## Group memory, shared by the members of this group chat\nOnly the members of this group read it[^\n]*\n\n- The user wants everything under one page \[source: group "Launch"[^\n]*\]$/)
    assert.match(await tool('recall', { query: 'page' }, member), /^Entries with "page" in your memory, the group memory, and the team memory:\n\[group · MEMORY\.md\] The user wants everything under one page/)
  }
  // Not in a member's own chat, nor for a Bot outside the group, a Main Bot included.
  for (const elsewhere of ['b2', 'b3', 'b4', 'm1']) {
    assert.doesNotMatch(section(elsewhere), /one page|Group memory/, elsewhere)
    assert.match(await tool('recall', { query: 'page' }, elsewhere), /^Nothing in your memory and the team memory mentions "page"/, elsewhere)
    assert.match(await tool('recall', { scope: 'group' }, elsewhere), /^There is no group memory here/, elsewhere)
  }
})

test('in a group, remember and forget write the group memory unless told otherwise, for any member', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  twoMembers(home)
  const { tool, call, read, journal, stop } = start({ home })
  t.after(() => stop())
  assert.match(await tool('remember', { text: 'Builds go in the out folder' }, 'g2'), /^Saved to the group memory, in MEMORY\.md \(MEMORY\.md: \d+ of 4000 characters\)\. Every member sees it in its next conversation in this group; recall finds it now\.$/)
  assert.match(read('groups', 'r1', 'MEMORY.md'), /- Builds go in the out folder \[source: group "Launch" \d{2}-\d{2} \d{2}:\d{2}; by: Writer; added: /)
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md')), false)
  // "own" keeps it for the Bot itself, in all its conversations.
  assert.match(await tool('remember', { text: 'I review drafts twice', scope: 'own' }, 'g2'), /^Saved to your memory/)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- I review drafts twice \[source: group "Launch"/)
  // Another member changes the same memory.
  assert.match(await tool('remember', { text: 'Builds go in the dist folder', replace: 'out folder' }, 'g3'), /"Builds go in the out folder" is now "Builds go in the dist folder"/)
  assert.match(await tool('forget', { entry: 'dist folder' }, 'g3'), /^Removed from the group memory/)
  assert.deepEqual(journal().map(record => [record.op, record.scope, record.actorName]), [
    ['add', 'group:r1', 'Writer'], ['add', 'bot:b2', 'Writer'], ['replace', 'group:r1', 'Coder'], ['remove', 'group:r1', 'Coder'],
  ])
  // A Bot's own chat has no group memory to write.
  await assert.rejects(tool('remember', { text: 'x', scope: 'group' }, 'b2'), /There is no group memory here/)
  // A member removed from the group writes no more of it.
  await tool('remember', { text: 'Ship on Friday' }, 'g2')
  assert.equal((await call('update-room', { id: 'r1', remove: ['b2'] })).ok, true)
  await assert.rejects(tool('remember', { text: 'Still here' }, 'g2'), /Only Bots on the team keep a memory\./)
  await assert.rejects(tool('forget', { entry: 'Friday' }, 'g2'), /Only Bots on the team keep a memory\./)
  assert.deepEqual(parseMemory(read('groups', 'r1', 'MEMORY.md')).entries.map(entry => entry.text), ['Ship on Friday'])
})

test('a group Session frozen before groups kept a memory is frozen again, with it', async (t) => {
  const { tool, section, home, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Ship on Friday' }, 'g3')
  writeFileSync(join(home, 'memory', 'snapshots', 'g3.md'), section('b3'))
  assert.match(section('g3'), /## Group memory, shared by the members of this group chat\n[^\n]*\n\n- Ship on Friday \[/)
})

test('deleting a group moves its memory to the archive, with its members\' snapshots gone', async (t) => {
  const { tool, call, home, journal, section, stop } = start()
  t.after(() => stop())
  await tool('remember', { text: 'Ship on Friday' }, 'g3')
  section('g3')
  assert.equal(existsSync(join(home, 'memory', 'snapshots', 'g3.md')), true)
  assert.equal((await call('delete-room', { id: 'r1' })).ok, true)
  assert.equal(existsSync(join(home, 'memory', 'groups', 'r1')), false)
  assert.equal(existsSync(join(home, 'memory', 'snapshots', 'g3.md')), false)
  const [archived] = readdirSync(join(home, 'memory', 'archive'))
  assert.match(archived, /^group-r1-\d{4}-/)
  assert.match(readFileSync(join(home, 'memory', 'archive', archived, 'MEMORY.md'), 'utf8'), /Ship on Friday/)
  assert.deepEqual([journal().at(-1).op, journal().at(-1).scope], ['archive', 'group:r1'])
})

test('a group\'s memory panel shows only the group memory, and what the user changes there stays there', async (t) => {
  const replies = ['## Overview\nThe group ships on Friday.', JSON.stringify({ reply: 'Done.', changes: [{ op: 'add', text: 'Demo on Monday', team: true }, { op: 'remove', entry: 1 }] })]
  const { tool, call, read, requests, stop } = start({ replies })
  t.after(() => stop())
  await tool('remember', { text: 'Ship on Friday' }, 'g3')
  await tool('remember', { text: 'Likes tea' }, 'b3')
  await tool('remember', { text: 'Keep it short', scope: 'team' }, 'm1')
  const view = (await call('memory-view', { roomId: 'r1', summarize: true })).value
  assert.equal(view.roomId, 'r1')
  assert.deepEqual(view.entries.map(entry => [entry.scope, entry.text, entry.by]), [['group', 'Ship on Friday', 'Coder']])
  assert.deepEqual(Object.keys(view.sizes), ['group'])
  for (let tries = 0; tries < 200 && (await call('memory-view', { roomId: 'r1' })).value.summarizing; tries += 1) await settle()
  assert.match(requests[0].messages[0].content[0].text, /^Here is everything the group chat "Launch" remembers[^\n]*\n\n## Group memory\n- Ship on Friday\n/)
  assert.doesNotMatch(requests[0].messages[0].content[0].text, /Likes tea|Keep it short/)
  assert.equal(requests[0].sessionId, 'r1')
  assert.equal((await call('memory-view', { roomId: 'r1' })).value.summary.text, '## Overview\nThe group ships on Friday.')

  const answer = (await call('memory-ask', { roomId: 'r1', text: 'The demo is on Monday; Friday is off' })).value
  assert.match(requests[1].system, /^You keep the memory of one group chat/)
  assert.doesNotMatch(requests[1].system, /"team"/)
  assert.match(requests[1].messages[0].content[0].text, /^Entries of the group chat "Launch" \(group: shared by its members\):\n\[1\] \(group\) Ship on Friday\n/)
  assert.deepEqual(answer.changes.map(change => [change.op, change.scope, change.ok]), [['add', 'group', true], ['remove', 'group', true]])
  assert.match(read('groups', 'r1', 'MEMORY.md'), /- Demo on Monday \[source: memory panel; by: user; added: /)
  assert.doesNotMatch(read('team', 'MEMORY.md'), /Demo/)
  const forgot = (await call('memory-forget', { roomId: 'r1', scope: 'group', topic: null, text: 'Demo on Monday' })).value
  assert.deepEqual(forgot.entries, [])
  assert.equal((await call('memory-view', { roomId: 'nope' })).error.message, 'Unknown group chat')
})

// Lines reach a group's log as posts, through the relay; the aborted round lets no
// member speak.
const postToGroup = async (ctx, texts) => {
  for (const text of texts) {
    const event = { type: 'user/message', data: { source: { kind: 'bot', role: 'post', senderSessionId: 'b3', senderName: 'Coder' }, content: [{ type: 'text', text }] } }
    for (const listener of ctx.listeners.get('session/event')) listener({ id: 'r1' }, event)
  }
  await ctx.registeredTools.get('group_relay').execute({}, { agent: { id: 'r1' }, callId: 'relay', signal: AbortSignal.abort() })
}

test('a queued review keeps the group lines that leave the log while it waits', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  mkdirSync(join(home, 'memory'), { recursive: true })
  writeFileSync(join(home, 'memory', 'reviewed.json'), JSON.stringify({ 'chat:b2': 9, 'group:r1': 5 }))
  const log = [{ who: 'User', text: 'Call me Lu from now on', seq: 6 }, ...Array.from({ length: 39 }, (_, at) => ({ who: 'Coder', botId: 'b3', text: `Step ${at + 1}`, seq: at + 7 }))]
  writeFileSync(join(home, 'state.json'), JSON.stringify({ ...TEAM, rooms: { r1: { ...TEAM.rooms.r1, sessions: { b2: 'g2', b3: 'g3' }, seq: 45, log } } }))
  let release
  const replies = [new Promise(resolve => { release = resolve }), ...Array.from({ length: 6 }, () => JSON.stringify({ changes: [] }))]
  const { ctx, call, requests, stop } = start({ home, replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  // A slow review of Writer's own chat holds the queue.
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await until(() => requests.length === 1)
  assert.equal(requests.length, 1)
  ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  await postToGroup(ctx, Array.from({ length: 50 }, (_, at) => `More ${at + 1}`))
  release(JSON.stringify({ changes: [] }))
  await reviewed(call)
  const group = requests.map(request => request.messages[0].content[0].text).filter(text => text.startsWith('The group chat: "Launch"'))
  assert.match(group[0], /\nUser: Call me Lu from now on\n/)
})

test('what is said after a member leaves is still reviewed, for the group', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  twoMembers(home)
  const { ctx, call, read, requests, stop } = start({ home, replies: [JSON.stringify({ changes: [{ op: 'add', text: 'The launch moved to Friday' }] })], config: { memoryReviewDelayMs: 200 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g2' }, status: 'idle' })
  assert.equal((await call('update-room', { id: 'r1', remove: ['b2'] })).ok, true)
  await postToGroup(ctx, ['The launch moved to Friday'])
  await reviewed(call)
  assert.equal(requests.length, 1)
  const text = requests[0].messages[0].content[0].text
  assert.match(text, /^The group chat: "Launch", with the user and Coder \(admin\), Temp\./)
  assert.match(text, /\nUser: Keep everything you send me under one page\nCoder: Will do\.\n[\s\S]*The launch moved to Friday/)
  assert.match(read('groups', 'r1', 'MEMORY.md'), /- The launch moved to Friday \[source: group "Launch"/)
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md')), false)
})

test('a group deleted while its review writes keeps no more of it, and its folder stays gone', async (t) => {
  const many = Array.from({ length: 8 }, (_, at) => ({ op: 'add', text: `The group likes thing ${at + 1}` }))
  const { ctx, home, call, stop } = start({ replies: [JSON.stringify({ changes: many })], config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  const folder = join(home, 'memory', 'groups', 'r1')
  while (!existsSync(join(folder, 'MEMORY.md'))) await new Promise(resolve => setImmediate(resolve))
  assert.equal((await call('delete-room', { id: 'r1' })).ok, true)
  await reviewed(call)
  assert.equal(existsSync(folder), false)
  const [archived] = readdirSync(join(home, 'memory', 'archive'))
  assert.ok(parseMemory(readFileSync(join(home, 'memory', 'archive', archived, 'MEMORY.md'), 'utf8')).entries.length < 8)
  assert.equal(existsSync(join(home, 'memory', 'team', 'MEMORY.md')), false)
})

test('a turn that ends after its member left the group is still reviewed, for the group', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  twoMembers(home)
  const { ctx, call, read, requests, stop } = start({ home, replies: [JSON.stringify({ changes: [{ op: 'add', text: 'The user wants one page' }] })], config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g2' }, status: 'running' })
  assert.equal((await call('update-room', { id: 'r1', remove: ['b2'] })).ok, true)
  ctx.emit('agent/status', { agent: { id: 'g2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.match(requests[0].messages[0].content[0].text, /^The group chat: "Launch"[\s\S]*\nUser: Keep everything you send me under one page\n/)
  assert.match(read('groups', 'r1', 'MEMORY.md'), /- The user wants one page \[source: group "Launch"/)
  assert.equal(existsSync(join(home, 'memory', 'bots', 'b2', 'MEMORY.md')), false)
})

test('a keeper out of the group during the review keeps the place, and the next keeper reads the lines again', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  twoMembers(home)
  let release
  const replies = [new Promise(resolve => { release = resolve }), JSON.stringify({ changes: [{ op: 'add', text: 'The user wants everything under one page' }] })]
  const { ctx, call, read, requests, stop } = start({ home, replies, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g3' }, status: 'idle' })
  await until(() => requests.length === 1)
  // The admin — the review's keeper — leaves the group before its model answers.
  assert.equal((await call('update-room', { id: 'r1', remove: ['b3'] })).ok, true)
  release(JSON.stringify({ changes: [{ op: 'add', text: 'The user wants everything under one page' }] }))
  await reviewed(call)
  // Nothing was written and the cursor stayed at the first pass's mark, so the same
  // lines are read again instead of being skipped for good.
  assert.throws(() => read('groups', 'r1', 'MEMORY.md'), { code: 'ENOENT' })
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'group:r1': 0 })
  ctx.emit('agent/status', { agent: { id: 'g2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 2)
  assert.match(requests[1].messages[0].content[0].text, /\nUser: Keep everything you send me under one page\n/)
  assert.match(read('groups', 'r1', 'MEMORY.md'), /- The user wants everything under one page \[source: group "Launch"/)
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'group:r1': 3 })
})

test('a Bot deleted while its review writes keeps no more of it, and its folder stays gone', async (t) => {
  const many = Array.from({ length: 8 }, (_, at) => ({ op: 'add', text: `The user likes thing ${at + 1}` }))
  const { ctx, home, call, stop } = start({ replies: [JSON.stringify({ changes: many })], config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  const folder = join(home, 'memory', 'bots', 'b2')
  while (!existsSync(join(folder, 'MEMORY.md'))) await new Promise(resolve => setImmediate(resolve))
  assert.equal((await call('delete-bot', { id: 'b2' })).ok, true)
  await reviewed(call)
  assert.equal(existsSync(folder), false)
})

test('a long user message keeps both ends for the review', async (t) => {
  const long = `Background ${'x'.repeat(5000)} From now on, always answer in English.`
  const history = { b2: [{ event: { seq: 20, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: long }] } } }] }
  const { ctx, call, requests, stop } = start({ replies: [JSON.stringify({ changes: [] })], history, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  const text = requests[0].messages[0].content[0].text
  assert.match(text, /\nUser: Background x+ …\(middle cut\)… x+ From now on, always answer in English\.\n/)
  assert.ok(text.length < 3_400)
})

test('a group deleted before its review keeps nothing more, in no memory', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  twoMembers(home)
  const { ctx, call, requests, stop } = start({ home, replies: [JSON.stringify({ changes: [{ op: 'add', text: 'The user wants one page' }] })], config: { memoryReviewDelayMs: 200 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g2' }, status: 'idle' })
  assert.equal((await call('delete-room', { id: 'r1' })).ok, true)
  await reviewed(call)
  assert.equal(requests.length, 0)
  for (const where of [['groups', 'r1'], ['bots', 'b2'], ['team']]) assert.equal(existsSync(join(home, 'memory', ...where)), false, where.join('/'))
})

test('a first chat review pages back to the user\'s latest line', async (t) => {
  const events = Array.from({ length: 900 }, (_, at) => (at + 1 === 50
    ? { event: { seq: 50, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'I work on Linux' }] } } }
    : { event: { seq: at + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `ok ${at + 1}` }] } } } }))
  const { ctx, call, requests, stop } = start({ replies: [JSON.stringify({ changes: [] })], history: { b2: events }, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.ok(requests[0].messages[0].content[0].text.includes('\nUser: I work on Linux\n'))
})

test('a chat review reads back to its cursor through every page', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  mkdirSync(join(home, 'memory'), { recursive: true })
  writeFileSync(join(home, 'memory', 'reviewed.json'), JSON.stringify({ 'chat:b2': 10 }))
  const events = Array.from({ length: 900 }, (_, at) => (at + 1 === 50
    ? { event: { seq: 50, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'I work on Linux' }] } } }
    : { event: { seq: at + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `ok ${at + 1}` }] } } } }))
  const { ctx, call, read, requests, stop } = start({ home, replies: [JSON.stringify({ changes: [] })], history: { b2: events }, config: { memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.ok(requests[0].messages[0].content[0].text.includes('\nUser: I work on Linux\n'))
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'chat:b2': 900 })
})

test('a review shows both MEMORY.md files whole, then the newest topic entries that fit', () => {
  const own = [{ entries: [{ text: 'A', meta: {} }] }, { topic: 't', entries: [{ text: 'old', meta: { added: '2026-01-01' } }, { text: 'new', meta: { added: '2026-10-01' } }] }]
  const team = [{ entries: [{ text: 'T', meta: {} }] }]
  const { numbered, left } = reviewEntries(own, team, 5)
  assert.deepEqual(numbered.map(entry => [entry.scope, entry.file.topic, entry.text]), [['own', undefined, 'A'], ['team', undefined, 'T'], ['own', 't', 'new']])
  assert.equal(left, 1)
  assert.equal(reviewEntries(own, team).left, 0)
  // One entry too long for what is left does not keep out a shorter one after it.
  const tight = [{ entries: [{ text: 'A', meta: {} }] }, { topic: 't', entries: [{ text: 'x'.repeat(5), meta: { added: '2026-10-01' } }, { text: 'yy', meta: { added: '2026-01-01' } }] }]
  const fit = reviewEntries(tight, [{ entries: [] }], 5)
  assert.deepEqual(fit.numbered.map(entry => entry.text), ['A', 'yy'])
  assert.equal(fit.left, 1)
})

test('a turn whose Session moves to a fresh part before its review is still reviewed', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other' }))
  const replies = [JSON.stringify({ changes: [{ op: 'add', text: 'The user wants short answers' }] })]
  const { ctx, call, read, requests, stop } = start({ home, replies, config: { memoryReviewDelayMs: 200 } })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  // Before the review is due, the chat moves on to part 2 and this host takes over.
  const moved = { ...TEAM, bots: { ...TEAM.bots, b2: { ...TEAM.bots.b2, sessionId: 'b2-next', segments: [{ sessionId: 'b2', endedAt: Date.now() }] } } }
  writeFileSync(join(home, 'state.json'), JSON.stringify(moved))
  rmSync(join(home, 'state.lock'))
  await call('state', {})
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.match(read('bots', 'b2', 'MEMORY.md'), /- The user wants short answers \[source: part 1 #/)
  assert.deepEqual(Object.keys(JSON.parse(read('reviewed.json'))), ['chat:b2'])
})

test('config.memoryReview false leaves memory to the Bots\' own remember calls', async (t) => {
  const { ctx, call, section, requests, stop } = start({ config: { memoryReview: false, memoryReviewDelayMs: 0 } })
  t.after(() => stop())
  assert.equal(ctx.calls.filter(entry => entry === 'on agent/status').length, 3)
  await call('state', {})
  assert.match(section('b2'), /Call it in that same turn, before you reply/)
  ctx.emit('agent/status', { agent: { id: 'b2' }, status: 'idle' })
  await settle()
  assert.equal((await call('state', {})).value.memoryReviews, 0)
  assert.equal(requests.length, 0)
})

test('config.memory false leaves the tools, the section, and the panel out', async (t) => {
  const { ctx, call, stop } = start({ config: { memory: false } })
  t.after(() => stop())
  assert.ok(!ctx.calls.some(entry => /tool (remember|forget|recall)|bot-memory/.test(entry)))
  assert.equal((await call('state', {})).value.memory, false)
  assert.equal((await call('memory-view', { botId: 'b2' })).error.message, 'Memory is turned off on this host')
  // The first state call applies the Bots' models and saves; let that finish first.
  await settle()
})

// Routes such as OpenCode Go turn down a request that names no Session. Each memory
// call names the Bot's own current chat.
const idleSession = { requestHeader: () => undefined }
test('a memory summary names the Bot chat on both of its tries', async (t) => {
  const { tool, call, requests, stop } = start({ requireSession: true, replies: [{ text: 'Half', finish: 'max-tokens' }, 'You like tea.'] })
  t.after(() => stop())
  await tool('remember', { text: 'Likes tea' }, 'b2')
  await call('memory-view', { botId: 'b2', summarize: true })
  await summarized(call)
  const view = (await call('memory-view', { botId: 'b2' })).value
  assert.equal(view.error, null)
  assert.equal(view.summary?.text, 'You like tea.')
  assert.deepEqual(requests.map(request => [request.sessionId, request.maxTokens, request.purpose]), [['b2', 2048, undefined], ['b2', 8192, undefined]])
})

test('a memory panel question names the Bot chat', async (t) => {
  const { call, requests, stop } = start({ requireSession: true, replies: [JSON.stringify({ reply: 'You have no entries yet.', changes: [] })] })
  t.after(() => stop())
  const answer = await call('memory-ask', { botId: 'b2', text: 'What do you remember?' })
  assert.equal(answer.ok, true)
  assert.equal(answer.value.reply, 'You have no entries yet.')
  assert.equal(requests[0].sessionId, 'b2')
})

test('a memory review of a Bot chat names that chat and saves its changes', async (t) => {
  const { ctx, call, read, requests, stop } = start({
    requireSession: true, config: { memoryReviewDelayMs: 0 },
    replies: [JSON.stringify({ changes: [{ op: 'add', text: 'The user wants this remembered' }] })],
  })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'b2', session: idleSession }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].sessionId, 'b2')
  assert.match(read('bots', 'b2', 'MEMORY.md'), /The user wants this remembered/)
})

test('a memory review of a group names the group chat', async (t) => {
  const { ctx, call, read, requests, stop } = start({
    requireSession: true, config: { memoryReviewDelayMs: 0 },
    replies: [JSON.stringify({ changes: [{ op: 'add', text: 'Keep replies under one page' }] })],
  })
  t.after(() => stop())
  await call('state', {})
  ctx.emit('agent/status', { agent: { id: 'g3', session: idleSession }, status: 'idle' })
  await reviewed(call)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].sessionId, 'r1')
  assert.match(read('groups', 'r1', 'MEMORY.md'), /Keep replies under one page/)
})

test('a memory call names the current part of the Bot chat', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-'))
  const team = structuredClone(TEAM)
  team.bots.b2.sessionId = 'b2-part2'
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const { call, requests, stop } = start({ home, requireSession: true, replies: [JSON.stringify({ reply: 'This part.', changes: [] })] })
  t.after(() => stop())
  const answer = await call('memory-ask', { botId: 'b2', text: 'Which part?' })
  assert.equal(answer.ok, true)
  assert.equal(requests[0].sessionId, 'b2-part2')
})
