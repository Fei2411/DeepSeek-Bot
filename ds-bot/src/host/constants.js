// Fixed values shared by the host modules: colors, OCR settings, the client route, and
// the limits on messages, group chats, and chat reads.

// Classic avatar inks, offered as Bot colors.
export const COLORS = ['deepseek', 'blue', 'violet', 'orange', 'green', 'magenta', 'cyan', 'red', 'yellow', 'brown', 'gray', 'black', 'aurora']
// Deeper inks, also offered as accent swatches; each is a valid Bot color too.
export const EXTRA_COLORS = ['charcoal', 'graphite', 'rose', 'sky', 'tangerine', 'cobalt']
// Renamed color ids, so a Bot saved with an old one keeps its color (LEGACY: old id → new id).
export const LEGACY_COLORS = { kimi: 'charcoal', zai: 'graphite', minimax: 'rose', stepfun: 'sky', mimo: 'tangerine', qwen: 'cobalt' }
// Renamed theme ids, so a saved choice keeps its look (LEGACY: old id → new id).
export const LEGACY_THEMES = { grok: 'mono' }

export const OCR_PROMPT = [
  'Transcribe all text in this image exactly, in its original language, keeping line breaks and reading order; use Markdown tables for tables.',
  'Then add a line starting with "Image:" that describes in one to three sentences what is not text (photo, chart, diagram, screen layout).',
  'Reply with only that. If there is no text, reply with only the "Image:" line.',
].join(' ')
export const OCR_TIMEOUT_MS = 120_000
export const OCR_RETRY_MS = 120_000
export const OCR_CACHE_MAX = 500
export const MAX_AVATAR_IMAGE = 160_000
export const ROUTE = '/api/bot'
export const MAX_EXCHANGES = 600
// state.json is written whole on every save, so a long message between Bots or a long
// group line keeps only its start there. The rest stays where it already is (a message
// in the Session it was delivered to) or in a file of its own (a group line).
export const TEXT_KEPT = 2000
// Of one group line, a member reads this much: in its prompt, and with read_group_chat.
export const GROUP_LINE_READ = 20_000
// The Bot exchange dialog shows at most this much of one message.
export const TEXT_SHOW_MAX = 200_000
// A message a Bot sends past this goes as a DSH file, which the recipient reads with its
// file tools; the message keeps its first LONG_HEAD characters.
export const MESSAGE_INLINE_MAX = GROUP_LINE_READ
export const LONG_HEAD = 1000
// DSH's read tool shows this much of one line (dsh-tool-fs `readMaxLineLength`, default).
export const READ_LINE_MAX = 2000
export const ROOM_REPLY_TIMEOUT_MS = 240_000
// Lines a member writes less than this apart while it works reach its group together.
export const ROOM_STEP_GAP_MS = 30_000
export const SOURCE_KIND = 'bot'
// The fixed reply that opens a fresh conversation part; it is never shown or sent on.
export const HANDOFF_ACK = 'Noted. I have my handoff note and carry on from here.'
// An answer from a question card, in the shape DSH's own late question replies use.
export const REPLY_KIND = 'user-question-reply'
// DSH's snapshot of a referenced conversation, logged right after the user's message
// that cites it.
export const REFERENCE_KIND = 'session-reference'
// `everyone`: every member answers a plain message in turn, admin first. `admin`: a
// plain message goes to the admin, who calls others with @mentions. New groups start
// in `admin` mode, because every extra speaker re-reads its whole context; a group
// without an admin still answers as `everyone`.
export const ROOM_MODES = ['everyone', 'admin']
export const ROOM_NAME_MAX = 60
export const ROOM_NOTICE_MAX = 2000
export const ROOM_MAX_MEMBERS = 12

// A team's one DSH Agent: a plain dsh entry in the sidebar, not a Bot. Its Sessions
// are ordinary root Sessions, so the team tools must not be offered to them.
export const AGENT_NAME = 'DSH Agent'
export const AGENT_SESSION_TITLE_MAX = 80
// Every tool this plugin registers for Bots. `read_browser` only exists in the
// Desktop profile, so a restriction filters this list down to registered names.
export const TEAM_TOOLS = [
  'list_bots', 'message_bot', 'stop_bot', 'create_bot', 'update_bot', 'list_models',
  'create_group', 'update_group', 'delete_group', 'post_to_group', 'ask_user', 'show_view',
  'request_secret', 'list_secrets', 'group_relay', 'read_own_chat',
  'read_group_chat', 'remember', 'forget', 'recall', 'read_browser',
  'list_capabilities', 'save_capability', 'delete_capability',
  'attach_capability', 'detach_capability',
]
// A member still at work this long after its first tool call lets the round go on; it
// posts its reply when the work is done.
export const ROOM_WORK_GRACE_MS = 15_000

export const OWN_CHAT_LINE_MAX = 400
// The message an anchor points at is shown whole (up to this), so a long draft takes
// one read instead of many searches for its pieces.
export const ANCHOR_LINE_MAX = 8000
export const OWN_CHAT_BRIEF = 10
export const OWN_CHAT_READ = 12
export const OWN_CHAT_SEARCH = 20
export const HISTORY_PAGE = 200
export const HISTORY_PAGES_MAX = 50
export const HISTORY_TIMEOUT_MS = 20_000
// Shown when an aside stops at the route's own output limit. The partial answer stays.
export const ASIDE_LIMIT = 'Answer cut off at the output limit.'
