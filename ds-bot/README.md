# ds-bot

The DS Bot plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). It turns dsh into a team of long-lived Bots that talk to you, to each other and in group chats. See the [project page](../README.md) for an overview, install steps and screenshots.

> Early release (v0.1). Features, tools and the saved data format can still change.

Tested with dsh `0.2.1-rc.2` (Web) and `0.2.0-rc.2` (Web and Desktop).

## Features

- **Long-lived Bots**: each Bot is a dsh Session in the "DS Bot" workspace, with its own name, role, instructions and model.
- **Working folders**: a Bot can work in a folder you choose instead of the team workspace, and a group chat can set one folder for all its members there. Pick it in the Bot's settings or details panel or in the group's settings, or ask a Bot (`update_bot`, `update_group`). After a change, the chat goes on in a fresh part that starts in the new folder. When a Bot sets a folder outside the team workspace, or adds a Bot to a group that works in one, it asks for your approval if those Bots can only write in their folder. Folders that hold dsh data (`$DSH_HOME`, the team's data) are refused. The team workspace itself moves in Settings > General > Locations; Bots and groups that work there go on in a fresh part in the new folder, and the old folder keeps its files.
- **Permission presets**: each Bot runs with its own dsh permission preset (Read only, Workspace or Full access), set in its details panel. A group chat can run all its members with one preset there, in place of their own: turn on **Same for every member** under Permissions in the group's settings. Only you set permissions; Bots cannot change them.
- **Bots work together**: `message_bot` sends a message to another Bot, `create_bot` and `update_bot` add and set up Bots (including a profile photo from a local image file or a data URL), and `ask_user` asks you a question without blocking the other Bots. `show_view` draws a card in a Bot's own chat — text, metrics, tables, progress, choices, confirmations and short forms; an interactive card waits for your answer.
- **Group chats**: members speak one at a time, and each one reads the latest messages first. A message can `@Name` a member to pass the turn on; type `@` to pick one from a list. **+ → Reference a chat** adds another Bot's chat to a message as context, and in a group the members who answer get it. A member with nothing new to add stays quiet (`[PASS]`). Each member has its own hidden Session per group, so a group never reads a Bot's private chat.
- **Roles and permissions**:

  | Who | Can do |
  |---|---|
  | You | Everything |
  | Main Bot (there can be more than one) | Manage every group; change and delete Bots |
  | Group admin | Manage its own group only (name, notice, members, reply mode) |
  | Member | Speak in the group, `@` another member, and post into its groups from outside them |

- **Long chats stay inside the model's window**: dsh's own compaction never runs on a Bot's Session. When a turn ends past the check line (a share of the model's context window), a small separate model call, the context steward, reads the latest messages of the chat and decides once. If the work is still under way, the chat is condensed in place into a checkpoint: a handoff summary plus your recent messages word for word. If the work has reached a stopping point, the Bot writes a handoff note and continues in a new part. Either way you still see one chat, with no marker. Earlier parts and condensed messages stay searchable in a full-text index (`node:sqlite` FTS5) through `read_own_chat`.
- **Memory**: each Bot keeps notes across all its conversations, each group chat keeps its own for its members, and the team shares one more. See [Memory](#memory).
- **Web search**: see [Web search](#web-search).
- **Bot browser (dsh Desktop and the desktop app)**: see [Bot browser](#bot-browser).
- **Images**: for a model that cannot read images, a vision model first turns the image into text.
- **Secrets**: a Bot asks for an API key or token with a card in its own chat and never sees the value. See [Secrets](#secrets).
- **Usage**: Settings → Usage shows token usage by time (24 hours to 12 months, or days picked on a calendar), by Bot and by model, with a page for each Bot and each model. Calls that a Session logs are read from the logs, so older chats count too. Calls that leave no log (checkpoints, handoff notes, the steward, image readings, dsh titles and compaction) are counted while they stream, from the time the plugin runs. Tokens only, no cost.
- **Make it yours**: name, role, instructions, model and look (20 characters and 12 colors, or your own photo) for each Bot; a theme, an accent color and an avatar animation level (quiet, normal or lively) for the team. A pinned Bot or group chat shows a small pushpin in the sidebar. Settings has these pages: General (look), Bots (Main Bots and each Bot's settings), Group chats (each group's settings), Connectors, Capabilities, Scheduled tasks, Usage, Secrets, Feedback and About DS Bot (versions, updates and links).

## Install

The [project page](../README.md#install) has the full steps for dsh Desktop and dsh Web. In short:

- dsh Desktop: Settings → Plugins → add `ds-bot` (npm), a `.tgz` file, or `github:Fei2411/DeepSeek-Bot#v0.1.7&path:/ds-bot`.
- Command line: `dsh plugin --profile desktop add ds-bot` (or `--profile web`).

To work on the plugin from a checkout, add it to a dsh profile as a linked dependency and a bundle:

```json
{
  "dependencies": { "ds-bot": "link:/path/to/ds-bot" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "ds-bot"] } }
}
```

Run `pnpm install` in the profile folder, then start dsh from the deepseek-harness repository:

```sh
pnpm -s dsh --profile web --no-open
```

The first time the team opens, the plugin creates a Main Bot called Chief.

**Upgrading from the legacy `dsh-bot` package**: earlier builds used the package name `dsh-bot`. Remove `dsh-bot` from the profile before you add `ds-bot`, because both use the plugin id `bot`. Your team, chats and secrets stay where they are (see [Data and backups](#data-and-backups)); saved browser settings, the theme and Bot colors move over the first time DS Bot opens.

## Configuration

Options go in the profile's `cordis.patch.yml`, under the `bot` entry. All of them are optional.

```yaml
- id: bot
  name: ds-bot
  config:
    workspace: /path/to/workspace   # where the Bots work; default <home>/workspace
    home: /path/to/bot-data         # where the team is saved; default $DSH_HOME/bot
    checkRatio: 0.8                 # share of the model's usable window where the steward decides
    browser: true                   # force the Bot browser on or off; default on in Desktop and the desktop app only
    memory: true                    # false turns memory off: no memory tools, section or panel
    memoryReview: true              # false leaves memory to the Bots' own remember calls
    diagnosticsFile: false          # keep the error log in memory only; default <home>/logs/diagnostics.jsonl
    updateCheck: true               # look for a newer DS Bot when a window opens; default true
    updateRegistry: https://registry.example/   # ask only this npm registry for updates
    github: false                   # hide the GitHub connector; default shown in Connectors
```

**Updates**: when a window opens, DS Bot asks where it was installed from for a newer release: the npm registry (the one the DSH plugin manager installs from, then its fallbacks), or the latest GitHub release for a `github:…#vX.Y.Z` install. A newer version shows a cloud button at the top right of the sidebar; **Update** reinstalls DS Bot through the DSH plugin manager, and the new version runs from the next DSH start. A linked or local checkout is never offered an update. Settings → About DS Bot shows the same state, with **Check for updates** to ask again at once.

The same card can carry DSH itself: a DS Bot release may name the DSH release it was verified against (`dsBot.verifiedDsh` in its `package.json`), and only that version is offered — running something newer is a downgrade offer too. A release that names no version offers no DSH update. A DSH installed from npm is swapped by `npm install -g @deepseek-ai/dsh@<version>`. DSH Desktop installs the newest release its own updater finds, so the card shows DSH there only when that release is the verified one, and **Open updates** opens the app's update panel. A release may raise the floor with `dsBot.minBot`: until the bot itself is that new, the DSH row waits.

## Models

Model providers are set up with dsh's `llm-pi-ai` plugin in `cordis.patch.yml`. Every Bot runs on one model of its own, from the models DSH serves. A new team's first Main Bot has none: its chat opens on a model card and it greets the user only after a pick. The Create Bot form starts on the DSH default model. The Bot's details panel and settings (or a Main Bot's `update_bot`) change it; a Bot whose model is no longer served shows the card again. A team saved by an older version keeps the model each Bot last ran on.

- Give every model a `contextWindow`. DS Bot takes its lines from it: the usable window is the window minus the reply reserve (`maxTokens`), the hard line is 95% of that, and the check line is `checkRatio` of it. A model without `contextWindow` gets the adapter's default (262,144 tokens for `llm-pi-ai`), which may be wrong for that model; a model that reports no window at all counts as 500,000.
- To send images, the provider needs `defaultInput: [ text, image ]`.
- Keep API keys out of the repository. Use dsh's own key storage or environment variables.

## Memory

A Bot remembers what should last beyond one conversation: your preferences, decisions, corrections and facts it should not ask again. Memory is plain Markdown in the [Agent Memory Repo](https://github.com/AgentMemoryRepo/agentmemoryrepo) format: one entry per line, ending in `[source: …; added: …]`.

After each turn, a memory review reads what is new in the conversation and keeps, updates or removes entries itself, so memory does not depend on the Bot deciding to call `remember`. A Bot's own chat is reviewed by its model into its own memory; a group chat is reviewed once for the whole group, by the admin's model (or the first member's), into the group memory only. It keeps only what you say, writes entries in your language, and refuses keys, passwords and ID numbers.

- **Three scopes**: each Bot has its own memory; each group chat has a group memory, which its members read in that group only (not in their own chats, and not in other groups); and the team memory is read by every Bot. A Bot writes its own, and any member writes its group's memory from the group. Main Bots and group admins (of any group) also write the team memory; a Main Bot can read and change another Bot's memory when you ask.
- **Tools**: `remember` saves an entry or replaces one (`replace`), `forget` removes one, and `recall` searches every entry, reads a topic whole, or lists what is saved. In a Bot's own chat they use its own memory by default; in a group chat, the group memory (`scope: "own"` for the Bot's own). The Bot adds the source (a part anchor such as `part 2 #1234`, which `read_own_chat` opens, or the group and the time) and the date; a Bot that writes for others is named with `by:`.
- **Files**: `MEMORY.md` holds what every conversation needs, and details go in topic files linked from its `## Index` as `[[topic]]`.
- **In the prompt**: the Bot's own and the team's `MEMORY.md` go into the Bot's system prompt, and in a group Session the group's after them. The section is frozen when a Session starts, so the provider's prompt cache holds; a change shows from the next part or checkpoint, and `recall` finds it at once.
- **Fixed sizes**: an entry has at most 300 characters, a `MEMORY.md` 4,000, a topic 16,000, and a scope 40 topics. A save past a limit fails and says how to make room.
- **Safety**: memory is data, not instructions. An entry that looks like a key or token is refused, and a Bot is told not to save what a web page, file or tool result asks it to remember.
- **History**: files change in place, and `journal.jsonl` keeps every change with the line before and after. When a Bot or a group chat is deleted, its memory moves to `archive/`.

**The memory panel**: the details panel of a Bot, and of a group chat, has a Memory row with the entry count; Manage opens the memory panel. A Bot's panel shows its own memory and the team memory; a group's shows the group memory.

- **Memory summary**: a model writes a short summary in prose from every entry, in the interface language: the Bot's, or for a group its admin's. It is written again when the entries change, and the ⋯ menu can regenerate it.
- **All entries**: the ⋯ menu lists every entry by scope and topic, with its date and author, and the size of each `MEMORY.md`. Remove takes two clicks.
- **Ask or update**: ask what the Bot remembers, or tell it what to add, correct or remove. One model call answers from the entries only, and its changes go through the same checks as the tools.
- A line in the chat ("Memory updated") shows when a Bot changes memory and opens the panel. When memory changes in the background, the capsule at the top of the chat (the Bot's, or the group's) stretches to say "Memory updated" for a moment; clicking it opens the memory panel.

A read-only dsh (see [Data and backups](#data-and-backups)) shows memory but cannot change it.

## Web search

The package includes a second plugin, `ds-bot/web-search`. It registers the search provider `auto`, and `cordis.patch.yml` makes it the default. Each search goes in this order:

1. If the profile names another `searchProvider`, that one is used.
2. The current model route's own search, with that route's key and host. The plugin knows the Anthropic Messages, OpenAI Responses and Gemini protocols, and a few search APIs (Ollama, Kimi, Zhipu, MiMo). Add more with `searchApis`.
3. A fallback without a key: the public result pages of Bing and DuckDuckGo.
4. If nothing works, the search fails and tells the model not to guess addresses.

Each result starts with a `Search backend: …` line that names the path it took.

**Turning `auto` off**: the `web` row still names `auto` when you turn off only the `web-search-auto` row (in the sidebar's Plugins page or with `disabled: true` in a profile patch). Then `web_search` fails in every session, Bot or not, with `WEB_PROVIDER_CONFIGURED_MISSING` (`configured web provider "auto" is not registered`). When you turn that row off, also name another `searchProvider` for the `web` row in the profile's `cordis.patch.yml`. The override replaces the row's whole config, so restate `fetchProvider`:

```yaml
- id: web-search-auto
  name: ds-bot/web-search
  disabled: true
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

Another plugin can also set the search provider while dsh runs, after the profile patch. When you turn such a plugin off, check this setting again.

## Bot browser

In dsh Desktop and the desktop app, a Bot's chat header has a globe button. It opens that Bot's own browser panel.

- **One partition per Bot** (`bot:<id>`): logins and cookies belong to that Bot only. The desktop app keeps them on disk, so a Bot stays signed in after a restart; dsh Desktop keeps them in memory only.
- **The Bot can read the page**: the `read_browser` tool reads the page's DOM, not a screenshot. The text becomes Markdown with headings, nested lists, tables, code blocks and quotes. Links and form controls are marked `[#n]` in place and listed below with their targets and values. The tool also reads the text you selected. Long pages are read in parts (`from`). Page content is treated as data, never as instructions.
  - It reads open Shadow DOM (with `<slot>`) and same-origin iframes up to 3 levels deep.
  - It reads only what is visible: `display:none`, `visibility:hidden`, zero-height and closed `<details>` content is skipped.
  - It never reads the values of password, credit card (`autocomplete="cc-*"`) or one-time code fields.
  - Limits: 400,000 characters, 150,000 nodes, 5,000 rows per table, 3,000 links and controls, 1.5 seconds. A cut result says so.
  - It cannot read cross-origin iframes (one line with the address), closed shadow roots, canvas content (online editors, maps), or text in CSS `::before` / `::after`. On pages that render on demand, only the rendered part is read.
  - Read only: the Bot cannot click, type, scroll or open addresses yet.
- **Addresses**: http and https only. localhost and LAN addresses are allowed; cloud metadata addresses (such as `169.254.x.x`) and dsh's own ports are not.
- The browser panel and the details drawer share the right column; opening one closes the other. Switching chats switches the panel to that Bot. Deleting a Bot clears its browser and saved address.
- **Cookie import (desktop app only)**: the import button in the browser bar previews the cookies of a file (Cookie-Editor JSON, Netscape `cookies.txt`, Playwright `storageState`) or of an installed Chromium/Firefox profile, then writes them into the Bot's partition. A source browser closes for a moment so its cookie store can be copied, and it reopens with its tabs. Sign-in that lives outside cookies (localStorage, passkeys) does not come along.

dsh Web has no browser panel and no `read_browser` tool.

## Secrets

When a Bot needs an API key, token or password, it calls `request_secret`, and a secret card shows in its own chat. The Bot never sees the value.

- **Fill in**: the field hides what you type, is not part of a form and is not autofilled. Choose "All Bots" or "Only this Bot" and select Save. A value must have at least 4 characters (a 4-digit PIN works). A value of 8 characters or more is hidden wherever it appears; a shorter one only where no letter or digit touches it, so ordinary words stay intact.
- **Allow**: if the secret is already saved but this Bot is not allowed to use it, the card only asks whether to allow it. You can also replace the value there.
- **Use**: the value goes into the Bot's shell environment as `DSH_SECRET_<NAME>` (`$DSH_SECRET_NAME` in bash, `$env:DSH_SECRET_NAME` in PowerShell). `list_secrets` lists the names a Bot can use. An MCP capability can also take `$DSH_SECRET_<NAME>` in its env, its headers and its URL (path or query); in the URL the value is URL-encoded. Use headers when the server accepts them.
- **Masking**: before a tool result is saved and before each request goes to the model, every copy of a secret value is replaced with `[secret:<NAME>]`.
- **Manage**: Settings → Secrets lists every secret by name, purpose, the Bot that asked and the last use. You can change who may use it, replace the value, delete it or add one. Deleting a Bot removes it from every secret.
- **Storage**: `<DSH_HOME>/bot/secrets.json`, file mode 600, written atomically. Values are never in `state.json` or logs.

Limits:

- On Windows, the file mode has no effect; the file is protected by your user folder only.
- Only exact copies of a value are masked. A Bot that encodes, splits or reverses a value can still print it. Do not give important secrets to a Bot you do not trust.
- On a page that is not HTTPS (for example dsh Web opened over http on a LAN), the value crosses the network in clear text. The card warns you.
- Group chats show no cards; a Bot asks in its own chat.

## Data and backups

The plugin saves its data in `config.home`. Without it, the folder is `$DSH_HOME/bot`, or `~/.dsh/bot` when `DSH_HOME` is not set.

| System | Default folder |
|---|---|
| Linux, macOS | `~/.dsh/bot/` |
| Windows | `C:\Users\<user>\.dsh\bot\` |

- To move all dsh data (Sessions, profiles and plugin data), set `DSH_HOME`.
- To move only the plugin data, set `home` in the configuration (see [Configuration](#configuration)).

Files in `bot/`:

| File | Content |
|---|---|
| `state.json` | The team: Bots, groups, Bot-to-Bot messages, preferences and open questions. A long message keeps only its first 2,000 characters here; all of it is in the Session it went to. |
| `group-lines/` | Long group lines, up to the 20,000 characters a member reads, one file per line; each is removed when its line leaves the group's latest 60 lines or the group is deleted |
| `state.lock` | The dsh that is using this data (pid and host), its mtime bumped as a heartbeat. It is removed when that dsh exits; a leftover whose heartbeat has stopped is taken over by the next dsh to load. |
| `chat-index.sqlite` | Full-text index of older chat parts (`read_own_chat`); rebuilt if deleted |
| `usage.sqlite` | Token counts for the Usage page; rebuilt from the Session logs if deleted, losing only the calls outside the logs and the names of deleted Bots |
| `memory/` | Memory (see [Memory](#memory)): `bots/<id>/`, `groups/<id>/` and `team/` (`MEMORY.md` and topics), `journal.jsonl` (every change), `snapshots/` (the section each Session froze), `summaries/` (the panel's summary; safe to delete), `reviewed.json` (how far the memory review has read) and `archive/` (deleted Bots and group chats) |
| `ocr.json` | Cache of image text; safe to delete |
| `avatars/` | The avatar library: the profile photos you imported once, so several Bots can use the same picture. `index.json` lists them, `files/` holds the images, each named by the hash of its bytes, so the same photo is stored once. The Bots that use a photo keep their own copy. Safe to delete. |
| `workspace` | The team workspace: the working folder of every Bot without one of its own (`config.workspace` changes it) |
| `secrets.json` | Saved secrets. Treat backups of it like passwords. |
| `logs/diagnostics.jsonl` | Recent errors and warnings, with keys, tokens, saved secrets and the home folder removed. It moves to `diagnostics.jsonl.1` past 1 MB. Safe to delete. |

The chats themselves are dsh Sessions and are not in `bot/`: they are in `~/.dsh/sessions/`. dsh keeps its workspace list in `~/.dsh/storages/workspace.json` and profiles (with model settings) in `~/.dsh/profiles/`. dsh Desktop keeps each Bot's browser partition in memory only, so its logins are not saved. The desktop app saves them with its own window data, not in the data location, and clears a Bot's when the Bot is deleted.

**Back up and restore**

1. Quit dsh completely (both the Web server and Desktop), so `state.json` is current.
2. Copy all of `~/.dsh/` (at least `bot/`, `sessions/` and `storages/`). A copy of `bot/` alone loses the chats.
3. To restore, quit dsh, put the folder back in the same place, then start dsh.

**Move to another computer**: `state.json` has no absolute paths except the working folders you set for Bots and groups, but dsh's `storages/workspace.json` and the Session folder names contain the workspace's absolute path. If the path is the same on the new computer, copy the folder. If it is different (another user name or system), it is not yet tested whether dsh finds the old Sessions.

**dsh Web and Desktop at the same time**: by default both use the same `~/.dsh`. The dsh that loads the team first takes `bot/state.lock` and can change the team. The other one is read-only: it shows the team and follows changes to the file, but refuses changes (`bot/read-only`, "open in another dsh"), and its Bots cannot start new Sessions. When the first one exits, the other one takes over on its next request. To change the team from both at once, give one of them a different `DSH_HOME` (two separate teams).

## Development

You need Node 24, pnpm and a deepseek-harness checkout with its dependencies installed, next to this repository (`../deepseek-harness`, or set `DSH_HARNESS`). The Desktop test bench also needs `xvfb-run` and `ffmpeg`. Web screenshots need Chrome or Chromium (`CHROME_BIN`; by default `google-chrome` or `chromium`).

```sh
npm ci                                   # esbuild, for the client build
npm run build                            # src/client → client.js
npm test                                 # unit tests
npm run lint                             # oxlint from the dsh repository (.oxlintrc.json)
dev/bench.sh dev 3100 8800 start         # Web test bench: mock model + dsh Web, data in ../.dsh-test-dev
dev/desktop-linux/desktop.sh dev start   # Desktop test bench: mock model + dsh Desktop in Xvfb
CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 dev/bench.sh smoke 3101 8801 reset && node dev/smoke.mjs smoke 3101
dev/check.sh                             # all checks (see below)
```

- `client.js` is built from `src/client/` and committed, so `link:` and Git installs need no build. Do not edit `client.js` by hand; `npm test` checks that it matches the source. After a change in `src/client/`, run `npm run build` and reload the page. After a change in `index.js` or `src/host/`, restart dsh.
- **Web test bench** `dev/bench.sh <name> <web port> <mock port> [start|stop|reset|status]`: a scripted mock model (`dev/mock-llm.mjs`, no real tokens; its commands are listed at the top of the file) and a dsh Web server. Data goes in `../.dsh-test-<name>/`; `reset` clears the team and Sessions first. The login address with its token is in `../.dsh-test-<name>/web.log`.
- **Desktop test bench** `dev/desktop-linux/desktop.sh <name> [start|stop|reset|status]`: dsh does not run Desktop on Linux; `launch.mts` runs the unpackaged Desktop in Xvfb. The first start downloads Electron and a Linux runtime (a few minutes). `start` returns when the team shows in a 1400×860 window.
- **All checks** `dev/check.sh [--skip steps] [--only steps] [--out dir]`: `unit`, `build`, `lint`, `smoke`, `web` (screenshots of the sidebar, a chat, a group, Bot settings, the Bots page and group settings) and `desktop` (the same screenshots, then the Bot browser checks). It stops everything it started. On failure it names the step and its log and exits non-zero. A full run takes about 3 minutes after the first download.
- **Ports**: every script takes `SLOT=n` (0-9, default 0) so that several people or sessions on one machine do not collide: Web bench `31n0` and mock `88n0`, smoke `31n1` and `88n1`, Desktop mock `88n2`, and so on. A Desktop uses about 1 GB of memory; stop it when you are done.
- **Real models** (these cost tokens): `dev/steward-eval.mjs` sends hand-written conversation endings through the context steward's own prompt to an OpenAI-compatible route (or, with `--api messages`, an Anthropic Messages route such as DeepSeek's official one) and checks each decision. `dev/llm-tap.mjs <port> <upstream base URL> <log.jsonl> [body dir]` is a logging pass-through for either format: point a provider's `baseURL` at it, and it writes one JSON line per call (steward, checkpoint, handoff note or main turn, the Bot's name, token usage, the answer, and where the request first differs from the same Bot's previous one, which is what a provider's cache can reuse; never headers). With a body dir it also saves every request body. Each file explains its use at the top.
- **Screenshots**: `dev/ui-shots.mjs` works for both apps (`desktop <dsh repo> <dir> <renderer port>` or `web <dsh repo> <dir> <bench name> <web port>`).
- `npm test` loads the `@deepseek-ai/*` packages from the deepseek-harness checkout.

## Layout

| Path | Purpose |
|---|---|
| `index.js` | Host entry: installs the `src/host/` modules in order |
| `src/host/` | Host: team and storage (`roster`, `store`), tools (`tools`), turns and delivery (`turns`, `delivery`), group chats (`groups`), chat parts, the context steward and the index (`parts`, `steward`, `chat-index`), image text (`images`), secrets (`secrets`), Bot browser (`browser`), the `POST api/bot` route (`channel`) |
| `src/client/` | Browser source: sidebar, chat header, transcript cells, panels and dialogs, themes, Bot browser panel |
| `client.js` | Built from `src/client/` by `scripts/build-client.mjs` (esbuild); committed |
| `web-search.js` | The `auto` search provider; independent of the team code |
| `test/` | Unit tests and fixtures |
| `dev/characters.mjs` | Builds the characters (small 3D models traced to outlines) into the `CHARACTERS` table in `src/client/characters.js` |
| `dev/` | Mock model, test benches, smoke test, Desktop scripts, real-model tools (steward evaluation, logging pass-through) |

## License

[Apache-2.0](LICENSE)
