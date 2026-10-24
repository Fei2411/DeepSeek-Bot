// Scripted Anthropic-Messages-compatible mock that drives the Bot team flows
// (Main Bot setup, create_bot, message_bot round trips, group chat relay, questions)
// without a real model. Usage: node dev/mock-llm.mjs, then point DEEPSEEK_BASE_URL at it.
//
// Group turns read only the "This round so far" section of the prompt, so counting goes
// wrong if the round and older messages are not kept apart. Usage is estimated from the
// request size (about 3 characters per token, 90% cached), so context tables and the
// switch lines see real growth. The log records hashes of the system prompt and tools, to
// confirm that group Sessions share the private chat's prefix, and the Session each
// request names (`session`, from the adapter's session header), since some routes
// require one.
//
// Environment: MOCK_PORT, MOCK_LOG, MOCK_DELAY_MS, MOCK_JITTER_MS (random extra latency),
// MOCK_LOG_CHARS (prompt length kept per log entry), MOCK_SUMMARY_DELAY_MS (handoff notes
// and backend compaction only), MOCK_NATIVE_SEARCH=off (ignore web_search_* tools and
// answer like an endpoint without search), MOCK_REJECT_IMAGES=1 (reject requests with images).
//
// Commands to a Bot:
//   建群 名: A, B · 群发[回报] 名: 消息 · 改群 名 公告|管理员|模式|加|踢: 值 · 删群 名
//   看群 名 (read_group_chat) · 转告 名: 消息, also over several lines (message_bot) · 搜索：查询1 | 查询2 (web_search)
//   进目录 路径 (working_directory with cd)
//   插话 名: 消息 (message_bot when "now") · 排队 名: 消息 (message_bot when "queue") · 叫停 名: 原因 (stop_bot)
//   In a message from a Bot: 转告 名: 消息 (hands it on with message_bot) · 慢慢做 N (answers after N seconds)
//   长文 N / long N (N×1000 characters) · 长任务 N [K] (N steps of K×1000, default 4)
//   查记录 词 [词…] · 查锚点 part N #序号 · 查第 N 段 (read_own_chat)
//   上下文里有 词 (searches the context except the last message) · 撑爆 (fake overflow, 400)
//   报错 (fake rejected key, 401; also as the text of 转告, so the receiving Bot fails)
//   卡片 K (K×1000 characters, then a question card) · 笔记模式 截断一次|缺节一次|总截断|总缺节|失败|正常
//   记住[@话题] 事实 · 团队记住 事实 (remember) · 忘掉 事实 (forget) · 回忆 [词] (recall)
//   视图选项 (options card, waits) · 视图表单 (form card, waits) · 视图展示 (display-only
//   stack) · 大视图 (display-only, just under the byte limit)
//   查能力 [词] (names the mcp__ tools and catalog skills that contain 词; also in a group)
//   A message with a file (a long Bot message as a file, a file the user sent): the Bot
//   reads the saved path, then says how many lines it read and how the file ends.
// Memory panel: a summary restating the entries; asks 记住|remember X, 团队记住 X,
//   删掉|remove N, 改|edit N: X change entries, anything else gets the entry count.
// Commands in a group:
//   把X拉进群 · 把X踢出群 · 群名改成X · 讨论 (admin @all) · 私聊聊了啥 (repeats the briefing)
//   记住[@话题] 事实 (the admin saves to the group memory) · 自己记住 / 团队记住 事实 (own / team)
//   忘掉 事实 (the admin) · 回忆 [词] (every member)
//   查私聊 关键词 (read_own_chat) · 长文 N · 上下文里有 词 · 撑爆 · 报错 [名] (that member's call, or every member's, fails with 401)
//   提权 (members other than the admin run a shell command that asks for full access)
//   写成文字 (members write their tool call as text instead of making it; also in a Bot's own chat)
//   派活 N (the admin hands the first other member N seconds of work; the admin answers its result)
//   分步 N (like 派活, but the member says a line at each of its three steps, N seconds apart)
// A handoff turn answers "第 N 段接着做完了". Handoff notes and backend compaction each
// return a full eight-section note marked "handoff 提示词" or "backend 提示词" (a Bot's
// Session should only see the former; retries add "重试", merges add "合并了上一份笔记").
// A Bot's checkpoint is a short summary marked "checkpoint 提示词". The context steward
// answers "compact" while the latest user message contains 阶段未完, else "switch".
// Secret cards: 要密钥 [NAME] calls request_secret (default DEMO_TOKEN); once a key is
// saved or allowed the Bot echoes it in its shell and quotes what the output showed it.
// MOCK_WATCH=<value> adds "watchHit" to each log entry: whether that value is anywhere
// in the model input. MOCK_LOG_TOOLS=1 records each request's tool names as toolNames.
// Non-streaming requests with web_search_* tools are treated as native search, and
// POST /api/web_search is an Ollama-shaped search API for the searchApis config.
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.MOCK_PORT ?? 8765)
const LOG = process.env.MOCK_LOG ?? fileURLToPath(new URL('../../.dsh-test/mock.jsonl', import.meta.url))
mkdirSync(dirname(LOG), { recursive: true })
const DELAY = Number(process.env.MOCK_DELAY_MS ?? 600)
// Random extra latency per call, to shake out ordering assumptions.
const JITTER = Number(process.env.MOCK_JITTER_MS ?? 0)
// Latency of summary (handoff or compaction) calls, to leave time to send input meanwhile.
const SUMMARY_DELAY = Number(process.env.MOCK_SUMMARY_DELAY_MS ?? DELAY)
// How much of each call's last message the log keeps; raise it to read whole prompts.
const LOG_CHARS = Number(process.env.MOCK_LOG_CHARS ?? 160)
const WATCH = process.env.MOCK_WATCH ?? ''
const REJECT_IMAGES = process.env.MOCK_REJECT_IMAGES === '1'
// MOCK_LOG_TOOLS=1 records the request's tool names, to compare two Sessions' tool views.
const LOG_TOOLS = process.env.MOCK_LOG_TOOLS === '1'
let seq = 0

const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(block => (block.type === 'text' ? block.text : '')).join('\n') : ''
const systemText = system => typeof system === 'string' ? system
  : Array.isArray(system) ? system.map(block => block.text ?? '').join('\n') : ''

const text = value => ({ type: 'text', text: value })
// ask_user takes options as { label } objects; the scenarios below list plain labels.
const tool = (name, input) => ({
  type: 'tool_use',
  name,
  input: name === 'ask_user' && Array.isArray(input.options)
    ? { ...input, options: input.options.map(option => (typeof option === 'string' ? { label: option } : option)) }
    : input,
})
const think = value => ({ type: 'thinking', thinking: value })
const ESCALATION = '提权测试：用户在群里要求'
const HANDED_WORK = '群里派的活'
const STEPPED_WORK = '群里分步的活'
const STEP_LINES = ['目录看完了，一共 12 个文件，开始整理。', '整理好一半了，剩下的是索引。']
const WRITTEN_CALL = '我先看一下目录。\n<tool_call>\n<function=pwsh>\n<parameter=command>\nGet-ChildItem\n</parameter>\n</function>\n</tool_call>'
// Deterministic filler that grows a conversation by about `chars` characters.
const filler = (chars, tag) => Array.from({ length: Math.ceil(chars / 20) }, (_, index) => `${tag}第${index + 1}段：这是一段用来撑长上下文的测试文字。`).join('').slice(0, chars)
const isResults = message => Array.isArray(message?.content) && message.content.some(block => block.type === 'tool_result')
// 'handoff' or 'backend' for a summary request, by its final prompt. The adapter merges
// that prompt into the user message before it, so it is the last text block, not the
// whole message.
const SUMMARY_PROMPTS = [['handoff', 'You are now writing a handoff note'], ['checkpoint', 'You are now writing a checkpoint'], ['backend', 'You are now acting as a compaction engine']]
const summaryKind = value => SUMMARY_PROMPTS.find(([, prompt]) => value.trimStart().startsWith(prompt))?.[0]
const textBlocks = content => (typeof content === 'string' ? [content]
  : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text) : [])
function isSummary(body) {
  const last = textBlocks(body.messages?.at(-1)?.content).at(-1)
  return last === undefined ? undefined : summaryKind(last)
}

function decide(body) {
  const system = systemText(body.system) + '\n' + (body.messages ?? []).filter(m => m.role === 'system').map(m => textOf(m.content)).join('\n')
  const tools = new Set((body.tools ?? []).map(entry => entry.name))
  // Clock snapshots are context, not a new scripted user command.
  const messages = (body.messages ?? []).filter(m => m.role !== 'system').map(message => {
    if (message.role !== 'user') return message
    const isClock = value => value.startsWith('Current time: ') || value.startsWith('Time sampled while preparing turn ')
    const content = typeof message.content === 'string' ? (isClock(message.content) ? '' : message.content)
      : message.content.filter(block => block.type !== 'text' || !isClock(block.text))
    return { ...message, content }
  }).filter(message => message.role !== 'user' || message.content.length > 0)
  const last = messages.at(-1)
  const blocks = Array.isArray(last?.content) ? last.content : []
  // A side-chat question (side.js). The first line is the marker; the reply is
  // fixed and calls nothing. Its count of earlier answers proves follow-ups
  // carry the chat's finished pairs.
  if (last?.role === 'user' && textBlocks(last.content).some(value => value.startsWith('ds-bot/side\n') || value === 'ds-bot/side')) {
    const pairs = messages.filter(message => message.role === 'assistant'
      && textBlocks(message.content).some(value => value.startsWith('Side note:'))).length
    return [text(`Side note: ${pairs} earlier pair(s) seen.`)]
  }
  const me = /You are (.+?), a Bot on the user's team/.exec(system)?.[1] ?? 'Bot'
  const isMain = system.includes('You are the Main Bot')
  const isRelay = system.includes('# Group chat relay')

  // Summary requests: the Bot's handoff prompt, or the backend's own one when the
  // plugin did not rewrite it. The note names which, and quotes the latest user lines.
  // "笔记模式 <mode>" in the conversation makes later handoff notes misbehave:
  // 截断一次 / 缺节一次 fail the first attempt only, 总截断 / 总缺节 every attempt,
  // 失败 makes the call an error, 正常 goes back to good notes.
  // The context steward: "compact" while the latest user message says 阶段未完,
  // otherwise "switch".
  if (system.includes('You are the context steward')) {
    const latestUser = textOf(last?.content).split('\n').filter(line => line.startsWith('User: ')).at(-1) ?? ''
    const action = latestUser.includes('阶段未完') ? 'compact' : 'switch'
    return [text(JSON.stringify({ action, reason: `mock: ${action}` }))]
  }

  // The memory panel: a prose summary of the entries it lists, and "ask or update".
  if (system.includes('You write the memory summary')) return [text(memorySummary(textOf(last?.content)))]
  if (/You keep the memory of one (Bot|group chat)/.test(system)) return [text(JSON.stringify(memoryAsk(textOf(last?.content))))]
  if (/You keep the long-term memory of one (Bot|group chat)/.test(system)) return [text(JSON.stringify(memoryReview(textOf(last?.content))))]

  const kind = isSummary(body)
  if (kind === 'checkpoint') {
    const said = messages.filter(m => m.role === 'user').flatMap(m => textBlocks(m.content))
      .filter(value => !summaryKind(value)).map(value => value.split('\n')[0].slice(0, 60))
      .filter(line => line && !line.startsWith('<') && !/^(This is an automatically generated checkpoint|Current runtime context|Time sampled)/.test(line))
    const merged = messages.some(m => m.role === 'user' && textBlocks(m.content).some(value => value.includes('[Checkpoint '))) ? '（合并了上一个检查点）' : ''
    return [text([`- ${me}（checkpoint 提示词）${merged}`, ...said.slice(-3).map(line => `- User: ${line}`)].join('\n'))]
  }
  if (kind) {
    const userTexts = messages.filter(m => m.role === 'user').flatMap(m => textBlocks(m.content))
    const said = userTexts
      .filter(value => !summaryKind(value)).map(value => value.split('\n')[0].slice(0, 60))
      .filter(line => line && !line.startsWith('<') && !/^(This is an automatically generated checkpoint|Current runtime context|Time sampled)/.test(line))
    const prompt = textBlocks(last?.content).at(-1) ?? ''
    const mode = kind === 'handoff' ? userTexts.map(value => /^笔记模式\s*(\S+)/.exec(value)?.[1]).filter(Boolean).at(-1) : undefined
    const retried = /was cut off at the output limit|lacked these headings/.test(prompt)
    const carried = userTexts.some(value => value.startsWith('[Handoff · part')) ? '（合并了上一份笔记）' : ''
    const sections = [
      ['Goals', `- ${me}（${kind} 提示词${retried ? '，重试' : ''}）${carried}`],
      ['Constraints and preferences', '- (none)'],
      ['Progress', '- Done: (none)\n- In progress: (none)\n- Blocked: (none)'],
      ['Decisions', '- (none)'],
      ['Facts to keep', said.slice(-3).map(line => `- User: ${line}`).join('\n') || '- (none)'],
      ['Open threads', '- (none)'],
      ['Next step', '- (none)'],
      ['Where to look', '- (none)'],
    ]
    const note = list => list.map(([name, body]) => `## ${name}\n${body}`).join('\n\n')
    if (mode === '失败') return 'fail'
    if (mode === '总截断' || (mode === '截断一次' && !retried)) return Object.assign([text(note(sections.slice(0, 3)))], { stop: 'max_tokens' })
    if (mode === '总缺节' || (mode === '缺节一次' && !retried)) return [text(note(sections.filter(([name]) => name !== 'Next step' && name !== 'Decisions')))]
    return [text(note(sections))]
  }

  // A stopped call's result can share a message with the next group turn, which wins.
  const fresh = textBlocks(last?.content).some(value => value.trimStart().startsWith('[Group chat'))
  const result = fresh ? undefined : blocks.find(block => block.type === 'tool_result')
  if (result) {
    const resultText = typeof result.content === 'string' ? result.content : textOf(result.content)
    const call = [...messages].reverse().find(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use'))
    const used = call?.content.find(b => b.type === 'tool_use' && b.id === result.tool_use_id) ?? call?.content.find(b => b.type === 'tool_use')
    // "长任务 N [K]": N steps in one turn, each adding about K thousand characters (default 4).
    const openerAt = messages.findLastIndex(m => m.role === 'user' && !isResults(m) && /^长任务\s*\d+/.test(textOf(m.content).trimStart()))
    if (openerAt !== -1 && used?.name === 'list_bots') {
      const task = /^长任务\s*(\d+)(?:\s+(\d+))?/.exec(textOf(messages[openerAt].content).trimStart())
      const steps = Number(task[1])
      const size = Number(task[2] ?? 4)
      const done = messages.slice(openerAt + 1).filter(isResults).length
      if (done < steps) return [text(filler(size * 1000, `步骤${done + 1}`)), tool('list_bots', {})]
      return [text(`长任务做完了，一共 ${done} 步。`)]
    }
    // "看网页结构 [N]": answer with the first N lines (default 40) of what read_browser
    // returned, fenced so the chat shows the Markdown as text.
    const asked = messages.map(m => (m.role === 'user' ? textOf(m.content).trim() : '')).filter(Boolean).at(-1) ?? ''
    const structure = /^看网页结构(?:\s+(\d+))?/.exec(asked)
    if (structure && used?.name === 'read_browser') {
      return [text(`读到的结果（前 ${Number(structure[1] ?? 40)} 行）：\n\n~~~~text\n${resultText.split('\n').slice(0, Number(structure[1] ?? 40)).join('\n')}\n~~~~`)]
    }
    // Secret cards: a key already there is echoed at once; a card ends the turn.
    // The note after the card can ride in the same message as the card's tool result.
    if (used?.name === 'request_secret') {
      if (/already saved/.test(resultText)) return [echoSecret(used.input.name, tools)]
      const note = textBlocks(last.content).find(value => value.trim().startsWith('[Secret card]'))
      return note ? secretNote(note.trim(), tools) : [text('')]
    }
    if ((used?.name === 'bash' || used?.name === 'pwsh') && /DSH_SECRET_/.test(used.input?.command ?? '')) {
      return [text(`终端输出里我看到的是：${resultText.replace(/\s+/g, ' ').trim().slice(0, 200)}`)]
    }
    if (used?.input?.justification === ESCALATION) return [text(result.is_error ? `没跑成：${resultText.slice(0, 80)}` : '命令跑完了，文件已经写好。')]
    const job = new RegExp(`^${HANDED_WORK}-(\\d+)-`).exec(used?.input?.pattern ?? '')
    if (job) return Object.assign([text(`干完了，用了 ${job[1]} 秒。`)], { delay: Number(job[1]) * 1000 })
    const stepped = new RegExp(`^${STEPPED_WORK}-(\\d+)-(\\d+)-`).exec(used?.input?.pattern ?? '')
    if (stepped) {
      const [at, wait] = [Number(stepped[1]), Number(stepped[2]) * 1000]
      if (at > STEP_LINES.length) return Object.assign([text('分步干完了：目录、正文、索引都整理好了。')], { delay: wait })
      return Object.assign([text(STEP_LINES[at - 1]), tool(used.name, { pattern: `${STEPPED_WORK}-${at + 1}-${stepped[2]}-*` })], { delay: wait })
    }
    switch (used?.name) {
      case 'group_relay': return [text('')]
      case 'create_bot': {
        const name = used.input.name
        return [text(`${name} 已就位。`), tool('message_bot', { to: name, message: `用户刚让我建了你。请用三条要点回我：你打算先做什么、需要用户提供什么、第一周节奏。没有的写“尚未聊过”。` })]
      }
      case 'message_bot': return [text(used.input.reply_to === 'user' ? `去 ${used.input.to} 的对话框看它说吧。` : '我已经把需求转过去了，有结果我马上告诉你。')]
      // The user's answer can ride in the same message as the card's tool result.
      case 'ask_user': if (textOf(last.content).trim() === '') return [text('')]
        break
      case 'show_view': return [text(resultText.startsWith('The view is on screen') ? '这些都是示例数据，换成你的数据我再画一次。' : `没画成：${resultText}`)]
      case 'ask_user_question': {
        let picked = ''
        try { picked = JSON.parse(resultText).answers?.[0]?.selected?.[0] ?? '' } catch {}
        return [text(picked ? `好，就从「${picked}」开始。` : '好的。'), text('我先把要点理一下，稍后给你一个方案。')]
      }
      case 'list_bots': return [text(`现在的班底：\n${resultText}`)]
      case 'create_group':
      case 'update_group':
      case 'delete_group':
      case 'post_to_group':
        return [text(/^(Created|Updated|Deleted|Posted|Nothing changed)/.test(resultText) ? `办好了：${resultText}` : `没办成：${resultText}`)]
      case 'read_own_chat': {
        const parts = /has (\d+) parts/.exec(resultText)?.[1]
        const across = parts ? `（共 ${parts} 段）` : ''
        if (used.input.part !== undefined) return [text(`第 ${used.input.part} 段：${resultText.split('\n').slice(0, 3).join(' / ').slice(0, 160)}${across}`)]
        if (!resultText.includes('(oldest first)')) return [text(`私聊里没有：${resultText.split('\n')[0]}${across}`)]
        const hits = resultText.split('\n').filter(line => line.startsWith('['))
        if (used.input.around !== undefined) return [text(`${resultText.split('\n')[0]} 前后 ${hits.length} 条：${hits.map(line => line.slice(0, 40)).join(' | ')}`)]
        const loose = resultText.includes('no message has all of') ? '（没有全部词都命中的，按命中词数排）' : ''
        return [text(`我私聊里聊过 ${hits.length} 条${loose}：${hits.at(-1)?.slice(0, 120) ?? ''}${across}`)]
      }
      case 'read_group_chat': return [text(`群里最近：\n${resultText}`)]
      case 'read': {
        const content = resultText.replace(/<[^>]+>/g, '').replace(/^\s*\d+[\t→|:]/gm, '').trim()
        return [text(result.is_error ? `附件没读成：${resultText.slice(0, 200)}` : `读了附件（${content.length} 字），结尾是「${content.slice(-24)}」。`)]
      }
      case 'remember':
      case 'forget':
        return [text(/^(Saved to|Updated in|Removed from) /.test(resultText) ? (used.name === 'remember' ? '记下了。' : '已经忘掉了。') : `没记成：${resultText}`)]
      case 'recall': return [text(`记忆里有：\n${resultText}`)]
      case 'web_search': return [text(result.is_error ? `搜索失败：${resultText}` : `搜到了：\n${resultText}`)]
      case 'working_directory': return [text(result.is_error ? `没进去：${resultText}` : `现在在 ${resultText}`)]
      case 'read_browser': {
        const title = /^Title: (.+)$/m.exec(resultText)?.[1]
        const body = (resultText.split(/^Text[^\n]*:\n/m)[1] ?? '').split('\n\nLinks and controls')[0].replace(/\s+/g, ' ').trim()
        return [text(title ? `我看了你开的页面「${title}」。开头写的是：${body.slice(0, 120)}` : `没读到页面：${resultText.slice(0, 160)}`)]
      }
      default: return [text('好了。')]
    }
  }

  const userText = textOf(last?.content).trim()
  // "撑爆": the provider rejects the request as past its window.
  if (userText.startsWith('撑爆')) return 'overflow'
  // A file in the message (a long Bot message, a file the user sent): DSH gives its saved
  // path, and the Bot reads it first.
  const saved = /verbatim read-only copy saved at ("(?:[^"\\]|\\.)*")/.exec(userText)
  if (saved) return [tool('read', { file_path: JSON.parse(saved[1]) })]
  // "长任务" keeps stepping when a Bot message splices into its turn (a relayed
  // note); only a fresh opener or "[Stopped by" ends it. A spliced "[Message
  // from X]" is taken into account there; it is answered in a turn of its own.
  const longOpener = messages.findLastIndex(m => m.role === 'user' && !isResults(m) && /^长任务\s*\d+/.test(textOf(m.content).trimStart()))
  if (longOpener !== -1 && /^\[(?:Message|Reply) from /.test(userText)) {
    const task = /^长任务\s*(\d+)(?:\s+(\d+))?/.exec(textOf(messages[longOpener].content).trimStart())
    const steps = Number(task[1])
    const size = Number(task[2] ?? 4)
    const done = messages.slice(longOpener + 1).filter(isResults).length
    if (done < steps) {
      const joined = /^\[Message from ([^\]·]+?)(?: · [^\]]*)?\]/.exec(userText)?.[1]
      return [text(`${joined ? `（已按 ${joined} 的话调整）\n` : ''}${filler(size * 1000, `步骤${done}`)}`), tool('list_bots', {})]
    }
  }
  // "报错": the provider rejects the key, in the user's chat or in a message from a Bot.
  if (/^报错$/.test(userText) || /^(?:\[Message from [^\]]*\]\n报错\n?)+$/.test(userText)) return 'auth'
  const lastCall = [...messages].reverse().find(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use'))
  const lastAsk = lastCall?.content.find(b => b.type === 'tool_use' && b.name === 'ask_user')
  const answeredAsk = lastAsk && (lastAsk.input?.options ?? []).map(option => option?.label ?? option).find(label => userText.includes(label))
  if (isRelay && tools.has('group_relay')) return [tool('group_relay', {})]
  if (answeredAsk && !userText.trim().startsWith('[')) {
    return [text(`好，就从「${answeredAsk}」开始。`), text('我先把要点理一下，稍后给你一个方案。')]
  }
  // A turn the plugin stopped at a context line goes on in the next part. The package
  // is merged with the workspace instructions, so match it before any free-text rule.
  if (userText.startsWith('[Handoff · part')) {
    const number = /^\[Handoff · part (\d+)\]/.exec(userText)[1]
    return [text(/in the group chat "/.test(userText) ? `${me}：第 ${number} 段接着群里的话说完。` : `第 ${number} 段接着做完了。`)]
  }
  if (userText.startsWith('[Bot team setup]')) {
    if (isMain) {
      return [
        text(`嘿，我是 ${me}。从今天起我来管你的 Bot 团队，需要拍板的事找我就行。`),
        text('现在还只有我一个。我先摸清你每天用的工具，再决定先上谁。先让团队帮你做哪块？'),
      ]
    }
    return [text(`Hi, I'm ${me}. Where should I start?`)]
  }
  if (/^\[Group chat "[^"]*" · replies to your post\]/.test(userText)) {
    const replies = userText.split('\n').filter(line => /^[^:\n]{1,40}: /.test(line)).length
    return [text(`群里回完了，一共 ${replies} 条回复。`)]
  }
  if (userText.startsWith('[Group chat') && userText.includes('The user just created this group')) return [text('群建好了，这个群要一起做点什么？')]
  if (/^\[Group chat "[^"]*" · your tool call did not run\]/.test(userText) || userText.startsWith('[Your last reply wrote a tool call as text')) {
    return [text('这次真的调用了，目录看完了。')]
  }
  if (userText.startsWith('[Group chat')) {
    // Reads only this round's transcript block. The opener is the user's last line, or
    // a Bot's post that started the round. Count-off says the next number after the
    // highest one said so far.
    const block = /(?:^|\n)This round so far[^\n]*:\n([\s\S]*?)(?:\n\n|$)/.exec(userText)?.[1] ?? ''
    const lines = block.split('\n').filter(Boolean)
    const userAt = lines.map(line => line.startsWith('User:')).lastIndexOf(true)
    const openAt = userAt === -1 && /starting with the new message/.test(userText) ? 0 : userAt
    const userLine = openAt === -1 ? '' : lines[openAt]
    const said = lines.slice(openAt + 1)
      .map(line => /^[^:\n]{1,40}: \D*?(\d+)/.exec(line)?.[1])
      .filter(Boolean).map(Number)
    const mentioner = /^\[Group chat [^\]]*· (\S+) mentioned you\]/.exec(userText)?.[1]
    const peer = /^Members: the user, ([^,\n]+?)(?:,| and you)/m.exec(userText)?.[1]?.replace(/ \(admin\)$/, '')
    const room = /^\[Group chat "([^"]+)"/.exec(userText)?.[1] ?? ''
    const leads = /^Members: .* and you \(admin\)\./m.test(userText)
    let ask
    if ((ask = /把\s*(\S+?)\s*拉进群/.exec(userLine))) return [tool('update_group', { group: room, add_members: [ask[1]] })]
    if ((ask = /把\s*(\S+?)\s*踢出群/.exec(userLine))) return [tool('update_group', { group: room, remove_members: [ask[1]] })]
    if ((ask = /群名改成\s*(\S+)/.exec(userLine))) return [tool('update_group', { group: room, name: ask[1] })]
    if (/报.{0,3}数|count off/i.test(userLine)) return [text(String((said.length ? Math.max(...said) : 0) + 1))]
    if (/^User: 撑爆/.test(userLine)) return 'overflow'
    if ((ask = /^User: 报错(?:\s+(\S+))?/.exec(userLine)) && (!ask[1] || ask[1] === me)) return 'auth'
    // Context-line tests in a group Session: grow it, or check what is still in it.
    if ((ask = /长文\s*(\d+)/.exec(userLine))) return [text(filler(Number(ask[1]) * 1000, `${me}群长文`))]
    if ((ask = /上下文里有\s*(\S+)/.exec(userLine))) {
      const earlier = messages.slice(0, -1).map(m => textOf(m.content)).join('\n')
      return [text(earlier.includes(ask[1]) ? `上下文里有「${ask[1]}」。` : `上下文里没有「${ask[1]}」。`)]
    }
    // Group memory: the admin saves, so a round of members does not save it twice.
    if ((ask = /^User: (团队|自己)?记住(?:@(\S+))?\s*[:：]?\s*(.+)$/.exec(userLine)) && tools.has('remember')) {
      if (!leads) return [text('[PASS]')]
      return [tool('remember', { text: ask[3].trim(), ...(ask[2] ? { topic: ask[2] } : {}), ...(ask[1] ? { scope: ask[1] === '团队' ? 'team' : 'own' } : {}) })]
    }
    if ((ask = /^User: 忘掉\s*[:：]?\s*(.+)$/.exec(userLine)) && tools.has('forget')) return leads ? [tool('forget', { entry: ask[1].trim() })] : [text('[PASS]')]
    if ((ask = /^User: 回忆(?:\s+(.+))?$/.exec(userLine)) && tools.has('recall')) return [tool('recall', ask[1] ? { query: ask[1].trim() } : {})]
    // Group Sessions: the frozen brief is in the Session's first message, the lookup a tool.
    if ((ask = /查能力\s*(\S*)/.exec(userLine))) return [text(capabilityReport(me, tools, messages, ask[1]))]
    if ((ask = /查私聊\s*(\S*)/.exec(userLine))) return [tool('read_own_chat', ask[1] ? { query: ask[1] } : {})]
    if (/私聊聊了啥/.test(userLine)) {
      const all = messages.map(m => textOf(m.content)).join('\n')
      const brief = /Your own chat with the user so far[^\n]*\n([\s\S]*?)\nThis brief does not change/.exec(all)?.[1] ?? ''
      return [text(brief ? `简报最后一句：${brief.split('\n').at(-1)}` : '没有简报。')]
    }
    if (/写成文字/.test(userLine) && !leads) return [text(WRITTEN_CALL)]
    const shell = ['pwsh', 'bash'].find(name => tools.has(name))
    if (/提权/.test(userLine) && !leads && shell) {
      return [text('这一步要写工作区外的文件，我申请一次提权。'), tool(shell, { command: 'echo ok', description: '在工作区外写一个测试文件', justification: ESCALATION, sandbox_permissions: 'danger-full-access' })]
    }
    // "派活 N": the admin hands a member N seconds of work: a file lookup, then a model
    // step that takes N seconds. The member posts the result when done, and the admin
    // answers the result.
    const handed = /^\S+: @(\S+) 干活 (\d+)/m.exec(block)
    const lookup = ['glob', 'grep', 'read'].find(name => tools.has(name))
    if ((ask = /派活\s*(\d+)/.exec(userLine)) && leads && peer) return [text(`@${peer} 干活 ${ask[1]}`)]
    if (handed?.[1] === me && mentioner && lookup) return [tool(lookup, { pattern: `${HANDED_WORK}-${handed[2]}-*` })]
    const steps = /^\S+: @(\S+) 分步干活 (\d+)/m.exec(block)
    if ((ask = /分步\s*(\d+)/.exec(userLine)) && leads && peer) return [text(`@${peer} 分步干活 ${ask[1]}`)]
    if (steps?.[1] === me && mentioner && lookup) return [text('收到，我先看看目录。'), tool(lookup, { pattern: `${STEPPED_WORK}-1-${steps[2]}-*` })]
    if (/分步干完了/.test(block) && leads) return [text('收到，辛苦了。')]
    if (/^\S+: 干完了/.test(userLine) && leads) return [text('收到，辛苦了。')]
    // Ping-pong: whoever is mentioned mentions back, to exercise the per-member cap.
    if (/来回/.test(userLine)) return [text(mentioner ? `@${mentioner} 回你` : leads && peer ? `@${peer} 来回` : '[PASS]')]
    if (mentioner) return [text('进度正常，今天能交。')]
    if (/安排/.test(userLine)) return [text(leads && peer ? `@${peer} 你先说说进度。` : '[PASS]')]
    if (/讨论/.test(userLine)) return [text(leads ? '@all 大家各说一句。' : '我觉得可以。')]
    return [text(`${me}：${leads ? '我是群管理员，需要拍板时找我。' : '我负责自己那一摊，有需要直接点我。'}`)]
  }
  // Secret cards: ask for a key, and use it once the card says it is saved or allowed.
  if (userText.startsWith('[Secret card]')) return secretNote(userText, tools)
  // Multiline: a runtime-context or policy notice can share the user's message.
  const secretAsk = /^要密钥(?:[ \t]+([A-Za-z][\w]*))?/m.exec(userText)
  if (secretAsk && tools.has('request_secret')) {
    return [text('这件事要用一个密钥，我先看看有没有。'), tool('request_secret', { name: secretAsk[1] ?? 'DEMO_TOKEN', purpose: '测试' })]
  }
  // Group management in a Bot's own chat, in a fixed command form the tests use.
  let order
  if ((order = /^建群\s*(\S+?)\s*[:：]\s*(.+)$/.exec(userText))) {
    return [text('我来建这个群。'), tool('create_group', { name: order[1], members: order[2].split(/[,，、\s]+/).filter(Boolean) })]
  }
  if ((order = /^群发(回报)?\s*(\S+?)\s*[:：]\s*([\s\S]+)$/.exec(userText))) {
    return [tool('post_to_group', { group: order[2], message: order[3], ...(order[1] ? { report_back: true } : {}) })]
  }
  if ((order = /^改群\s*(\S+?)\s*(公告|管理员|模式|加|踢)\s*[:：]\s*(.+)$/.exec(userText))) {
    const field = { 公告: { notice: order[3] }, 管理员: { admin: order[3] }, 模式: { mode: order[3] }, 加: { add_members: [order[3]] }, 踢: { remove_members: [order[3]] } }[order[2]]
    return [tool('update_group', { group: order[1], ...field })]
  }
  if ((order = /^删群\s*(\S+)$/.exec(userText))) return [tool('delete_group', { group: order[1] })]
  if ((order = /^转告\s*(\S+?)\s*[:：]\s*([\s\S]+)$/.exec(userText))) return [tool('message_bot', { to: order[1], message: order[2] })]
  if ((order = /^插话\s*(\S+?)\s*[:：]\s*(.+)$/.exec(userText))) return [tool('message_bot', { to: order[1], message: order[2], when: 'now' })]
  if ((order = /^排队\s*(\S+?)\s*[:：]\s*(.+)$/.exec(userText))) return [tool('message_bot', { to: order[1], message: order[2], when: 'queue' })]
  if ((order = /^叫停\s*(\S+?)\s*[:：]\s*(.+)$/.exec(userText))) return [tool('stop_bot', { bot: order[1], reason: order[2] })]
  if ((order = /^看群\s*(.+)$/.exec(userText))) return [tool('read_group_chat', { group: order[1].trim() })]
  // Memory: 记住[@话题] 事实 · 团队记住 事实 · 忘掉 事实 · 回忆 [词]
  if ((order = /^(团队)?记住(?:@(\S+))?\s*[:：]?\s*(.+)$/.exec(userText)) && tools.has('remember')) {
    return [tool('remember', { text: order[3].trim(), ...(order[2] ? { topic: order[2] } : {}), ...(order[1] ? { scope: 'team' } : {}) })]
  }
  if ((order = /^忘掉\s*[:：]?\s*(.+)$/.exec(userText)) && tools.has('forget')) return [tool('forget', { entry: order[1].trim() })]
  if ((order = /^回忆(?:\s+(.+))?$/.exec(userText)) && tools.has('recall')) return [tool('recall', order[1] ? { query: order[1].trim() } : {})]
  if ((order = /^搜索\s*[:：]\s*([^\n]+)/.exec(userText)) && tools.has('web_search')) return [tool('web_search', { queries: order[1].trim().split(/\s*[|｜]\s*/) })]
  if ((order = /^进目录\s+(.+)$/.exec(userText)) && tools.has('working_directory')) return [tool('working_directory', { cd: order[1].trim() })]
  if (/^看(?:网页|页面)/.test(userText) && tools.has('read_browser')) return [tool('read_browser', {})]
  if (userText.startsWith('写成文字')) return [text(WRITTEN_CALL)]
  // Context-line tests: grow the context, run a long multi-step turn, search history.
  if ((order = /^(?:长文|long)\s*(\d+)/.exec(userText))) return [text(filler(Number(order[1]) * 1000, '长文'))]
  if ((order = /^长任务\s*(\d+)(?:\s+(\d+))?/.exec(userText))) return [text(filler(Number(order[2] ?? 4) * 1000, '步骤0')), tool('list_bots', {})]
  if ((order = /^查记录\s*([^\n]+)/.exec(userText))) return [tool('read_own_chat', { query: order[1].trim() })]
  if ((order = /^查锚点\s*([^\n]+)/.exec(userText))) return [tool('read_own_chat', { around: order[1].trim() })]
  if ((order = /^查第\s*(\d+)\s*段/.exec(userText))) return [tool('read_own_chat', { part: Number(order[1]) })]
  if ((order = /^查能力\s*(\S*)/.exec(userText))) return [text(capabilityReport(me, tools, messages, order[1]))]
  if ((order = /^上下文里有\s*(\S+)/.exec(userText))) {
    const all = messages.slice(0, -1).map(m => textOf(m.content)).join('\n')
    return [text(all.includes(order[1]) ? `上下文里有「${order[1]}」。` : `上下文里没有「${order[1]}」。`)]
  }
  let match
  if ((match = /^\[Message from ([^\]·]+?) · the user sees your reply here\]/.exec(userText))) {
    const asked = userText.split('\n').slice(1).join(' ').trim().replace(/[。.!！?？]+$/u, '')
    return [text(`${match[1]} 转来一句话：「${asked}」。我先说打算：把手头已有的材料理一遍，列出还缺什么，再和你确认先后顺序；你确认之前我不会动手。`)]
  }
  if ((match = /^\[Message from ([^\]·]+?)(?: · [^\]]*)?\]\n(?:转告\s*(\S+?)\s*[:：]\s*([\s\S]+)|慢慢做\s*(\d+))/.exec(userText))) {
    if (match[2] && tools.has('message_bot')) return [tool('message_bot', { to: match[2], message: match[3].trim() })]
    if (match[4]) return Object.assign([text(`给 ${match[1]} 的回复：做完了，用了 ${match[4]} 秒。`)], { delay: Number(match[4]) * 1000 })
  }
  if ((match = /^\[Message from ([^\]·]+?)(?: · [^\]]*)?\]/.exec(userText))) {
    return [text(`给 ${match[1]} 的回复：\n- 先做：把现有材料理一遍\n- 需要用户提供：目标和截止时间（尚未聊过）\n- 节奏：确认后每天同步一次`)]
  }
  if ((match = /^\[Reply from ([^\]]+)\]\n.* could not answer your message: its model call failed \(([^)]+)\)/.exec(userText))) {
    return [text(`${match[1]} 这次没能回答：它的模型调用出错了（${match[2]}）。可能是 API 密钥失效，请检查它用的模型设置。`)]
  }
  if ((match = /^\[Reply from ([^\]·]+?) · for the work ([^\]]+?) asked you for/.exec(userText))) {
    return [text(`${match[1]} 交回了，我把结果交给 ${match[2]}。`)]
  }
  if ((match = /^\[Reply from ([^\]]+)\]/.exec(userText))) {
    return [text(`${match[1]} 回话了：目标和截止时间都还没和你聊过，它没法凭空开工。`), tool('ask_user', { question: '下一步怎么走？', detail: '没有目标之前它只能空转。', options: ['现在告诉我目标', '先去跟它聊', '先搁着'] })]
  }
  if ((match = /(?:创建|创|建|新建|create)\s*(?:一个|个)?\s*(?:叫|名为)?\s*[「“"]?([^」”"\s，,。]+?)[」”"]?\s*(?:的)?\s*bot/i.exec(userText)) && isMain && tools.has('create_bot')) {
    const name = match[1].replace(/^(一个|个)/, '')
    return [text(`先建 ${name}，建好再让它报一下打算。`), tool('create_bot', { name, role: name.slice(-2), instructions: `负责${name}相关的一切工作：规划、执行、复盘。`, brief: userText })]
  }
  if ((match = /让\s*([^\s，,。]+?)\s*在(?:它|他|她)?自己的(?:对话框|窗口)/.exec(userText)) && tools.has('message_bot')) {
    return [text(`好，我让 ${match[1]} 在它自己的对话框里跟你说。`), tool('message_bot', { to: match[1], message: '用户想直接听你说说打算。', reply_to: 'user' })]
  }
  if (/^\s*多选/.test(userText)) {
    return [tool('ask_user', {
      question: '这周先盯哪些？', detail: '可以选几项。', multiSelect: true,
      options: [{ label: '收集资料', description: '先列出已有的' }, { label: '写初稿' }, { label: '每周复盘', description: '每周五出一页' }],
    })]
  }
  if (/^\s*阻塞提问/.test(userText) && tools.has('ask_user_question')) {
    return [tool('ask_user_question', { questions: [{ id: 'start', header: 'Choose', question: '先从哪块开始？', options: [{ label: '先定目标 (Recommended)', description: '先把要做成什么说清楚' }, { label: '整理日常事务' }] }] })]
  }
  // View cards: 视图选项 and 视图表单 wait for an answer; 视图展示 and 大视图 are
  // display-only — the latter sits just under the view byte limit.
  if (/^\s*视图选项/.test(userText) && tools.has('show_view')) {
    return [tool('show_view', { title: 'Pick a lane', view: { type: 'options', id: 'lane', options: [{ label: 'Ship now' }, { label: 'One more pass' }] } })]
  }
  if (/^\s*视图表单/.test(userText) && tools.has('show_view')) {
    return [tool('show_view', { title: 'A few details', view: { type: 'form', id: 'ask', submitLabel: 'Send', fields: [{ id: 'name', label: 'Name', placeholder: 'Ada' }, { id: 'note', label: 'Note' }] } })]
  }
  if (/^\s*视图展示/.test(userText) && tools.has('show_view')) {
    return [tool('show_view', {
      title: 'Status board', await_reply: false,
      view: {
        type: 'stack',
        children: [
          { type: 'text', text: '**Release readiness** — all checks are in.' },
          { type: 'metric', label: 'Open issues', value: 3, tone: 'warn' },
          { type: 'table', columns: [{ key: 'item', label: 'Item' }, { key: 'state', label: 'State' }], rows: [['Tests', 'green'], ['Docs', 'draft'], ['Changelog', 'done']] },
          { type: 'progress', label: 'Reviewed', percent: 72 },
        ],
      },
    })]
  }
  if (/^\s*大视图/.test(userText) && tools.has('show_view')) {
    // Big but valid: every text node stays under the component limit, the whole
    // blueprint just under the byte limit.
    return [tool('show_view', { title: 'A long note', view: { type: 'stack', children: [0, 1, 2, 3].map(() => ({ type: 'text', text: 'x'.repeat(1900) })) }, await_reply: false })]
  }
  // 视图图表, 视图计算器 and 视图网页 cover the chart kinds, inputs with formulas
  // and a submit, and the sandboxed html frame.
  if (/^\s*视图图表/.test(userText) && tools.has('show_view')) {
    return [text('B 最快，D 最慢。下面是四个模型的首字延迟（示例数据）：'), tool('show_view', {
      view: {
        type: 'stack',
        children: [
          { type: 'chart', kind: 'bar', categories: ['Model A', 'Model B', 'Model C', 'Model D'], series: [{ name: 'p50', values: [420, 310, 520, 680] }, { name: 'p95', values: [690, 540, 810, 1150] }], unit: 'ms', caption: 'Time to first token, sample data' },
          { type: 'row', children: [{ type: 'chart', kind: 'line', categories: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], series: [{ name: 'Requests', values: [120, 180, 160, 240, 210] }] }, { type: 'chart', kind: 'donut', categories: ['Cached', 'Fresh', 'Failed'], series: [{ values: [62, 33, 5] }], unit: '%' }] },
          { type: 'sources', items: [{ label: 'Bench notes', url: 'https://example.com/bench' }] },
        ],
      },
    })]
  }
  if (/^\s*视图计算器/.test(userText) && tools.has('show_view')) {
    return [text('拖一下滑块看看每月要花多少：'), tool('show_view', {
      title: 'Monthly cost',
      view: {
        type: 'stack',
        let: { tokens: 'req * 30 * 2000 / 1e6', cost: 'tokens * (1 - hit) * 2 + tokens * hit * 0.5' },
        children: [
          { type: 'slider', id: 'req', label: 'Requests a day', min: 100, max: 5000, step: 100, value: 1200 },
          { type: 'choice', id: 'hit', label: 'Cache hits', options: [{ label: 'Low', value: 0.2 }, { label: 'Mid', value: 0.5 }, { label: 'High', value: 0.8 }], value: 0.5 },
          { type: 'row', children: [
            { type: 'metric', label: 'Cost a month', value: { '=': "'¥' + format(cost, 0)" }, tone: { '=': "cost > 100 ? 'bad' : 'good'" } },
            { type: 'metric', label: 'Tokens a month', value: { '=': "format(tokens, 1) + ' M'" } },
          ] },
          { type: 'progress', label: 'Basic plan (¥100)', value: { '=': 'min(cost, 100)' }, max: 100, valueLabel: { '=': "cost > 100 ? '¥' + format(cost - 100, 0) + ' over' : '¥' + format(100 - cost, 0) + ' left'" }, tone: { '=': "cost > 100 ? 'bad' : cost > 80 ? 'warn' : 'good'" } },
          { type: 'callout', text: 'Assumes 2,000 tokens a request and list prices.', tone: 'info' },
          { type: 'submit', id: 'send', label: 'Send to Bot' },
        ],
      },
    })]
  }
  if (/^\s*视图网页/.test(userText) && tools.has('show_view')) {
    return [tool('show_view', {
      view: {
        type: 'html', summary: 'Six seats, two taken', height: 96,
        html: '<style>.g{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}.s{height:40px;border-radius:8px;background:var(--bt-hover);border:0;color:var(--bt-ink);font:inherit;cursor:pointer}.s[data-on]{background:var(--bt-accent);color:#fff}.s:disabled{opacity:.4}</style><div class="g"></div><p id="n" style="color:var(--bt-ink-2);margin:8px 0 0">Pick a seat</p><script>const g=document.querySelector(".g");for(let i=1;i<=6;i++){const b=document.createElement("button");b.className="s";b.textContent="A"+i;if(i===2||i===5)b.disabled=true;b.onclick=()=>{b.toggleAttribute("data-on");document.getElementById("n").textContent=[...g.querySelectorAll("[data-on]")].map(x=>x.textContent).join(", ")||"Pick a seat"};g.append(b)}</script>',
      },
    })]
  }
  // Streams slowly, then checks the team: exercises the activity row stepping aside
  // for a streaming reply and coming back for the tool.
  if (/^\s*慢慢说/.test(userText) && tools.has('list_bots')) {
    return [{ ...text('好，我一点一点说：先看目标，再看约束，然后定下一步，最后去问问团队现在各自在忙什么。'), slow: true }, tool('list_bots', {})]
  }
  // "卡片 K": a reply of about K thousand characters (default 4) that ends with a question card.
  const card = /^卡片(?:\s+(\d+))?/.exec(userText)
  if (card && tools.has('ask_user')) {
    return [text(filler(Number(card[1] ?? 4) * 1000, '卡片前')), tool('ask_user', { question: '接下来先做哪个？', options: ['写正文', '改标题', '先停'] })]
  }
  if (/团队|班底|team/i.test(userText) && tools.has('list_bots')) return [tool('list_bots', {})]
  if (/想想|思考|think/i.test(userText)) {
    return [think('用户想让我认真想一下。先拆成三件事：目标、约束、下一步。'), text('想了一下，建议分三步走：先定目标，再看约束，最后定下一步。')]
  }
  return [text(`收到：${userText.slice(0, 60)}`), text('还有别的要我盯的吗？')]
}

// The memory panel's summary: headed paragraphs that restate the listed entries.
function memorySummary(request) {
  const asked = /Here is everything (?:the group chat "(.+?)"|(.+?)) remembers/.exec(request)
  const name = asked?.[1] ?? asked?.[2] ?? 'Bot'
  const zh = /Write the summary in [^,]*Chinese/.test(request)
  const [own = [], team = []] = request.split(/^## .*$/m).slice(1, 3).map(part => part.split('\n')
    .filter(line => line.startsWith('- ')).map(line => line.slice(2).replace(/^\[\[[^\]]+\]\]\s*/, '').replace(/[。.]$/u, '')))
  const prose = list => list.map(entry => `${entry}${zh ? '。' : '.'}`).join(zh ? '' : ' ')
  const sections = zh
    ? [['概览', `${name} 记着 ${own.length + team.length} 件关于你和你工作的事。`], own.length > 0 && [`${name} 知道的`, prose(own)], team.length > 0 && ['整个团队共享', `下面这些每个 Bot 都知道：${prose(team)}`]]
    : [['Overview', `${name} keeps ${own.length + team.length} things about you and your work.`], own.length > 0 && [`What ${name} knows`, prose(own)], team.length > 0 && ['Shared with the whole team', `Every Bot knows these: ${prose(team)}`]]
  return sections.filter(Boolean).map(([head, body]) => `## ${head}\n${body}`).join('\n\n')
}

// "Ask or update": 记住|remember X, 团队记住|team remember X, 删掉|remove N, 改|edit N: X;
// anything else is a question, answered with the entry count.
function memoryAsk(request) {
  const entries = request.split('\n').map(line => /^\[(\d+)\] \([^)]*\) (.+)$/.exec(line)).filter(Boolean)
  const said = request.split(/The user says:\n/).at(-1).trim()
  const zh = /in [^.]*Chinese/.test(request) || /[\u4e00-\u9fff]/.test(said)
  let ask
  if ((ask = /^(团队|team\s+)?(?:记住|remember)\s*[:：]?\s*(.+)$/i.exec(said))) {
    return { reply: zh ? `记下了：${ask[2]}` : `Saved: ${ask[2]}`, changes: [{ op: 'add', text: ask[2], team: Boolean(ask[1]) }] }
  }
  if ((ask = /^(?:删掉|删除|remove|forget)\s*(\d+)$/i.exec(said))) {
    return { reply: zh ? `删掉了第 ${ask[1]} 条。` : `Removed entry ${ask[1]}.`, changes: [{ op: 'remove', entry: Number(ask[1]) }] }
  }
  if ((ask = /^(?:改|edit)\s*(\d+)\s*[:：]\s*(.+)$/i.exec(said))) {
    return { reply: zh ? `第 ${ask[1]} 条改好了。` : `Entry ${ask[1]} is updated.`, changes: [{ op: 'edit', entry: Number(ask[1]), text: ask[2] }] }
  }
  const first = entries[0]?.[2]
  return { reply: zh ? `我记着 ${entries.length} 条${first ? `，第一条是：${first}` : ''}。` : `I keep ${entries.length} entries${first ? `; the first is: ${first}` : ''}.`, changes: [] }
}

// The memory review keeps what a new user line asks for "以后" or "from now on",
// unless an entry already says it.
function memoryReview(request) {
  const entries = request.split('\n').map(line => /^\[\d+\] \([^)]*\) (.+)$/.exec(line)?.[1]).filter(Boolean)
  const fresh = request.split(/^New in .*$/m).at(-1)
  const changes = []
  for (const line of fresh.split('\n')) {
    const asked = /^User: (以后|from now on,?\s*)(.+?)[。.]?$/i.exec(line.trim())
    if (!asked || entries.some(entry => entry.includes(asked[2]))) continue
    changes.push({ op: 'add', text: asked[1] === '以后' ? `用户希望以后${asked[2]}` : `From now on, the user wants: ${asked[2]}` })
  }
  return { changes }
}

// The MCP tools in this request and the entries of the latest skill catalog, both limited
// to names that contain `filter`.
function capabilityReport(me, tools, messages, filter) {
  const catalogs = messages.flatMap(m => textBlocks(m.content)).flatMap(value => [...value.matchAll(/<available_skills>([\s\S]*?)<\/available_skills>/g)])
  const skills = (catalogs.at(-1)?.[1] ?? '').split('\n').map(line => /^- `([^`]+)`: (.*)$/.exec(line))
    .filter(entry => entry && entry[1].includes(filter)).map(entry => `${entry[1]}（${entry[2]}）`)
  const mcp = [...tools].filter(name => name.startsWith('mcp__') && name.includes(filter)).sort()
  return `${me} 能力：工具 ${mcp.join(', ') || '无'}；技能 ${skills.join(', ') || '无'}`
}

function secretNote(note, tools) {
  const ready = /The user (?:saved|let you use) ([A-Z][A-Z0-9_]*)/.exec(note)
  return ready ? [text(`收到 ${ready[1]}，我来试一下。`), echoSecret(ready[1], tools)] : [text('好，不用这个密钥了。')]
}
// Prints a secret's variable in whichever shell the profile offers.
function echoSecret(name, tools) {
  const key = `DSH_SECRET_${String(name).toUpperCase()}`
  return tools.has('pwsh') && !tools.has('bash')
    ? tool('pwsh', { description: 'Print the secret variable', command: `Write-Output "value=$env:${key}"` })
    : tool('bash', { description: 'Print the secret variable', command: `echo "value=$${key}"` })
}

// Anthropic's server-side `web_search` tool, which a search provider sends without streaming.
// MOCK_NATIVE_SEARCH=off answers like an endpoint that ignores the tool.
const NATIVE_SEARCH = process.env.MOCK_NATIVE_SEARCH !== 'off'
const asksNativeSearch = body => body.stream !== true && (body.tools ?? []).some(entry => /^web_search_\d+$/.test(entry.type ?? ''))
function nativeSearch(body) {
  const query = /query: (.+)$/s.exec(textOf(body.messages?.at(-1)?.content))?.[1]?.trim() ?? ''
  if (!NATIVE_SEARCH) return [text(`凭记忆回答：${query}`)]
  const url = n => `https://example.com/mock-search/${encodeURIComponent(query)}/${n}`
  return [
    { type: 'server_tool_use', id: 'srvtoolu_mock', name: 'web_search', input: { query } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_mock', content: [1, 2].map(n => ({ type: 'web_search_result', url: url(n), title: `Mock result ${n}: ${query}`, page_age: `${n} days ago` })) },
    { type: 'text', text: 'Found it.', citations: [{ type: 'web_search_result_location', url: url(1), title: `Mock result 1: ${query}`, cited_text: `Mock excerpt about ${query}.` }] },
  ]
}

function sse(res, payload) {
  res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`)
}

// An Ollama-shaped search API, for checking a `searchApis` entry declared in config.
function searchApi(req, res) {
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), id: ++seq, images: 0, searchApi: { path: req.url, body, auth: req.headers.authorization ? 'bearer' : '' } }) + '\n')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ results: [{ title: `Search API result: ${body.query}`, url: `https://example.com/search-api/${encodeURIComponent(body.query ?? '')}`, content: `Page text about ${body.query}.` }] }))
  })
}

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/web_search') return searchApi(req, res)
  // Anthropic's own client, which a provider set up by hand uses, adds a query string.
  const path = req.url.split('?')[0]
  if (req.method === 'GET' && path.endsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ type: 'model', id: 'mock-model', display_name: 'Mock Model' }, { type: 'model', id: 'mock-model-mini', display_name: 'Mock Model Mini' }], has_more: false }))
    return
  }
  if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `no route ${req.method} ${req.url}` } }))
    return
  }
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    const body = JSON.parse(raw)
    const images = (body.messages ?? []).reduce((count, message) => count
      + (Array.isArray(message.content) ? message.content.filter(block => block?.type === 'image').length : 0), 0)
    const id = ++seq
    if (REJECT_IMAGES && images > 0) {
      appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), id, images, rejectedImages: true, messages: body.messages?.length ?? 0, last: textOf(body.messages?.at(-1)?.content).slice(0, LOG_CHARS) }) + '\n')
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'mock: request with images rejected' } }))
      return
    }
    const search = asksNativeSearch(body)
    const out = search ? nativeSearch(body) : decide(body)
    if (out === 'overflow') {
      appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), id, images, overflow: true, messages: body.messages?.length ?? 0, last: textOf(body.messages?.at(-1)?.content).slice(0, LOG_CHARS) }) + '\n')
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: maximum context length exceeded' } }))
      return
    }
    if (out === 'auth') {
      appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), id, images, auth: true, messages: body.messages?.length ?? 0 }) + '\n')
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'mock: invalid x-api-key sk-mock1234567890' } }))
      return
    }
    if (out === 'fail') {
      appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), id, images, fail: true, messages: body.messages?.length ?? 0 }) + '\n')
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'mock: this note request fails on purpose' } }))
      return
    }
    // Usage follows the model input's size (about three characters per token, all but
    // the newest tenth cached), so context meters and lines see real growth. Sibling
    // fields such as dsh_session_log are not model input.
    const tokens = Math.ceil(JSON.stringify([body.system, body.tools, body.messages]).length / 3)
    const cached = Math.floor(tokens * 0.9)
    // Hashes of the system prompt and tools show whether two Sessions share a cacheable prefix.
    const digest = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 12)
    const watch = WATCH ? { watchHit: JSON.stringify([body.system, body.tools, body.messages]).includes(WATCH) } : {}
    appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), id, tokens, images, session: req.headers['x-deepseek-harness-session-id'] ?? null, ...watch, ...LOG_TOOLS ? { toolNames: (body.tools ?? []).map(entry => entry.name ?? entry.type) } : {}, ...search ? { nativeSearch: { model: body.model, tools: body.tools, auth: [req.headers['x-api-key'] ? 'x-api-key' : '', req.headers.authorization ? 'bearer' : ''].filter(Boolean) } } : {}, system: digest(body.system), tools: digest(body.tools), messages: body.messages?.length ?? 0, first: textOf(body.messages?.[0]?.content).slice(0, 60), last: textOf(body.messages?.at(-1)?.content).slice(0, LOG_CHARS), out: out.map(block => (block.type === 'text' && block.text.length > 200 ? { ...block, text: `${block.text.slice(0, 200)}…(${block.text.length})` } : block)) }) + '\n')
    if (search) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: `mock-${id}`, type: 'message', role: 'assistant', model: body.model ?? 'mock', content: out, stop_reason: 'end_turn', usage: { input_tokens: 300, output_tokens: 40 } }))
      }, DELAY)
      return
    }
    setTimeout(async () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      sse(res, { type: 'message_start', message: { id: `mock-${id}`, type: 'message', role: 'assistant', model: body.model ?? 'mock', content: [], usage: { input_tokens: tokens - cached, output_tokens: 0, cache_read_input_tokens: cached } } })
      let index = 0
      let usedTool = false
      for (const block of out) {
        if (block.type === 'text') {
          if (block.text === '') continue
          sse(res, { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
          if (block.slow) {
            for (const piece of block.text.match(/.{1,4}/gsu)) {
              sse(res, { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } })
              await new Promise(resolve => setTimeout(resolve, 120))
            }
          } else {
            sse(res, { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
          }
        } else if (block.type === 'thinking') {
          sse(res, { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } })
          sse(res, { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } })
          sse(res, { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'mock' } })
        } else {
          usedTool = true
          sse(res, { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call-${id}-${index}`, name: block.name, input: {} } })
          sse(res, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
        }
        sse(res, { type: 'content_block_stop', index })
        index += 1
      }
      if (index === 0) {
        sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        sse(res, { type: 'content_block_stop', index: 0 })
      }
      sse(res, { type: 'message_delta', delta: { stop_reason: out.stop ?? (usedTool ? 'tool_use' : 'end_turn'), stop_sequence: null }, usage: { output_tokens: Math.ceil(JSON.stringify(out).length / 3) } })
      sse(res, { type: 'message_stop' })
      res.end()
    }, (out.delay ?? (isSummary(body) ? SUMMARY_DELAY : DELAY)) + Math.random() * JITTER)
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`ds-bot mock on http://127.0.0.1:${server.address().port}/v1`))
