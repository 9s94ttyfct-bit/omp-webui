---
title: Conversations, sidebar and history
summary: The sidebar list of conversations (grouping, filter, message search, sort, pins, archive), ⌘K search, rename, delete, branches, export, automatic titles and how a transcript is shown.
settings: auto-title, keep-thinking, tool-timer
---

# Conversations, sidebar and history

## What it does

### The list

- Every omp session is listed, grouped by date (Today, Yesterday, Previous 7 days, Previous 30 days, …) and filterable by project. Conversations started with `--profile` or `--session-dir` are listed too; subagent and advisor transcripts are counted in their conversation, not listed on their own.
- **Sort** (button at the right of the list's first line): *Last activity* (default; date groups), *Created* (date groups by start time) or *Name A–Z* (one list under *By name*). In every order pinned conversations come first (in pin order), then conversations working now (running, waiting for the user's answer, or held by the quota floor).
- **Pinned** group: its heading folds/unfolds the pinned rows (the fold is remembered). Pins are omp's own (`session-pins.json` in omp's folder): `/pin` typed in a conversation or a terminal shows here, and a sidebar pin is what `omp --resume` lists first. A sidebar pin is made by a short-lived omp on a new session (`/pin <id>`), never by resuming the conversation, so it never forks it.
- **Row marks**: Pinned, Branch, and the live state: *Running*, *Open*, *Needs your input*, *Waiting for the quota to reset*, *Paused*, Light mode's feather.
- **Row menu** (⋯ on a row): Pin / Unpin, Export HTML, Open in terminal, Archive / Unarchive, Delete….
- **Archive**: hides conversations from the main list without deleting them. *Archived · N* at the right of the list's first line opens the archived list (*All conversations* goes back); command palette *Go to › Archived conversations* opens it too. The archive is kept by omp-webui (`archived.json` in its data folder), not by omp.
- **Select**: pick several rows (*Select all*) to Archive / Unarchive or Delete at once, after a dialog listing them.
- **Filter**: the field at the top is a fuzzy match on conversation names (and project names), with a time range (Today, 7 days, 30 days, All time). From two characters on, an **In messages** group also lists conversations whose messages contain every word typed (any order, in one message), each with the matching line; a click opens the conversation at that message. 30 conversations at a time (*More results* adds 30, up to 199). The search waits for a 250 ms pause in typing. Tool calls, tool output, thinking and subagent transcripts are not searched.
- **⌘K search** (Ctrl+K elsewhere; command palette): full-text search across every message of every conversation, plus *Go to* entries (pages, Questions, Archived conversations). While the server is still indexing (first start, after an update) it says so and results may be partial.
- **Rename**: the pencil in a conversation's header (*Rename conversation*). Done through omp (`set_session_name`).
- **Delete**: row menu *Delete…* or Select › Delete. omp deletes the transcript and its subagent transcripts (omp's `/session delete`); it cannot be undone.
- **Automatic titles**: after the first reply omp names a new conversation with its title models (one small model call). The server does it, so it happens even with no page open.

### Branches

Edit a prompt or regenerate a reply to create a branch and flip between versions with ‹ 1/2 ›; *Branch from here (new conversation)* under a reply forks a new conversation. Branches are omp session files linked by `parentSession`, shown as one tree; the side panel's Branches tab lists every file of the family with its last prompt and size.

### The transcript

- A conversation opens on its latest part (the last 200 entries or 1 MiB, cut at a prompt); *Show earlier messages* and *Go to the first message* load more.
- **Thinking** is shown while the model thinks and folds away once it answers, unless *Keep thinking expanded* is on.
- **Tool-call timers**: a running call shows a ticking clock on its card and a finished one how long it took (also when reopened later): for all tool calls, shell commands only (`bash` and the user's own `!commands`), or off.
- **Start times**: each reply and tool call shows the clock time it started (`14:32:07`; with the date when not today), 24-hour, in the page's language and time zone; the full date is the tooltip.
- **Paused conversations** (frozen with Pause in the composer) stay paused across quitting the app or restarting the server; their tool cards say *Paused*. See session-controls.
- **Folder**: a conversation runs in its folder and follows omp's `/move` and `/wt`. In the home folder the server starts omp with `--allow-home` so omp works in `~` (not a temp dir). If the recorded folder no longer exists (or none is recorded), the server refuses to open it, names the folder, and the page asks the user to choose a folder to start omp in.

## Where it is

- Sidebar (left): New chat, the filter row (with the project funnel button), then *Select*, the sort button and *Archived* on the list's first line, then the list.
- ⌘K / Ctrl+K anywhere: search palette.
- Conversation header: rename pencil, download button (export).
- Settings › Conversations & files › Conversations: *Name new conversations automatically*, *Keep thinking expanded*, *Show how long tool calls run* (All tool calls / Shell commands only / Off).

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.autoTitle` | `on`, `off` | unset (= on) | Synced preference. Whether the server names new conversations after the first reply. |
| `ompw.keepThinking` | `on`, `off` | unset (= off) | Synced preference. Keep thinking blocks expanded after the answer arrives. |
| `ompw.toolTimer` | `all`, `shell`, `off` | unset (= `all`) | Synced preference. Which tool cards show how long they ran. |
| `ompw.sessionSort` | `activity`, `created`, `title` | unset (= `activity`) | Synced preference. Order of the sidebar list (Last activity / Created / Name A–Z). |
| `ompw.pinnedFolded` | `on`, `off` | unset (= `off`) | Synced preference. Whether the sidebar's Pinned group is folded. |
| `ompw.cwd` | a folder path (free text) | unset | Synced preference. The folder of the last new conversation; New chat's folder picker starts there. Also set when an issue is sent to New chat. |

| Variable | Values | Effect |
|---|---|---|
| `OMP_WEBUI_AUTO_TITLE` | `off` | Environment variable read by the server: turns automatic titles off whatever `ompw.autoTitle` says. |

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/sessions` | GET | token | The conversation list. With request header `x-sessions-since: <cursor>` only what changed (`{ changed, removed }`); otherwise the whole list. Answer header `x-sessions-cursor`. |
| `/api/session` | GET | token | One transcript, by `?file=<session file>`. |
| `/api/family` | GET | token | A window of a conversation's history: `?file=` and `view=tail\|before\|after\|around\|stats`, with `at` (entry id; required except for `tail`/`stats`), `leaf`, `limit` (max 200 entries). Without `view`: the whole lineage (all branch files). |
| `/api/search` | GET | token | Full-text search: `q`, `limit` (default 50), `file` (one conversation, uncapped), `conversations=N` (best hit per conversation, up to N), `all=1` (every word in one message). Header `x-search-index: indexed/total` while indexing. |
| `/api/session/rename` | POST | token | `{ file, title }`. Refused (409) while another omp process (e.g. a terminal) holds the conversation for writing. |
| `/api/session/delete` | POST | token | `{ file }`. Deletes through omp's `/session delete` and unarchives it. Refused (409) while it is working, waiting for an answer or paused, or open for writing in another omp. |
| `/api/sessions/delete` | POST | token | `{ files: [...] }`: bulk delete, one at a time; answers `{ deleted, failed: [{ file, error }] }`. |
| `/api/pins` | GET, POST | token | GET: the pinned session files (omp's pins). POST `{ file, pinned }`. |
| `/api/archive` | GET, POST | token | GET: archived session files. POST `{ files: [...], archived }`. |
| `/api/export` | POST | token | `?file=`: the conversation as a self-contained HTML download (`omp --export`, hardened by the server so opening it runs no unexpected script and loads nothing but omp's pinned viewer scripts). |
| `/api/blob/<sha256>` | GET | token | An image or file omp stored in its blob store (`~/.omp/agent/blobs`), by its 64-hex SHA-256; cached as immutable. |

## Limits and caveats

- Message search needs at least two characters; it skips tool calls, tool output, thinking and subagent transcripts. Results may be partial while the index is built.
- Delete is permanent and removes subagent transcripts; it is refused while the conversation works, waits for input or is paused (stop it first) and while a terminal's omp holds it.
- Archive and pins are different stores: archive is omp-webui's; pins are omp's and shared with the terminal.
- `/api/family` without `view` returns the whole lineage and can be large.

## Security notes

- All these routes are open to any page holding the access token, including a remote (tunnel) page: such a page can read, search, rename, archive, export and delete conversations.
- Exported HTML is made inert (content policy, raw HTML shown as text, unsafe links refused).
- An agent must not delete or rename conversations unless the user asks; deletion cannot be undone.
