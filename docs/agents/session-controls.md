---
title: Session controls, permission mode and the Loaded dialog
summary: The per-conversation "This session" panel (runtime settings, Set as default, Advanced), the permission mode and its default, the Loaded dialog's tool/MCP/skill/plugin switches, restarting omp, editing todos, and Pause/Resume.
settings: approval
---

# Session controls, permission mode and the Loaded dialog

## What it does

### This session panel

Runtime settings of the conversation's own omp process. Rows:

- **Auto-compaction** (On/Off): omp summarizes older context by itself when it passes the threshold. Off: a request that no longer fits fails until you compact by hand.
- **Compact at (context used)**: where omp compacts (Default / Percent of window / Tokens). See the compaction topic.
- **Fast mode** (On/Off): the provider's priority tier (omp's `/fast`) for the model's family (Anthropic, OpenAI or Google); billed at a premium. Models whose family is unknown (OpenRouter, a local server) have no default star.
- **Slow mode** (shown when the model supports it): either Claude's low-priority lane at the usage limit (omp's global setting `providers.anthropic.slowMode`, written to omp's `config.yml`, affects every conversation) or the provider's flex tier (this conversation only). A *Claude slow mode* row appears when the model is not Claude but the setting exists. No default star.
- The conversation's **guard** and **Full / Light** mode rows (see their own topics). Switching mode restarts omp in the other mode and resumes the conversation; while a turn runs the switch waits for it to end. A paused conversation cannot switch mode.
- **Compact context**: optional instructions (*Optional: what to keep*) and *Compact now*; while omp works it becomes *Compact after this turn* / *Compact between steps* with a *Where the compact runs* choice, and a queued compact can be cancelled.
- **Advanced** (folded; remembers whether it is open; a dot means one of these is not omp's default): **Auto-retry** (On/Off), **Steering delivery** (One at a time / All), **Follow-up delivery** (One at a time / All), **Interrupt tools on steer** (Immediately / Wait), **Prompt-cache warming** (Off / Streaming / Idle).

Every row and Compact context has an ⓘ *About* explanation (what it does, each choice, cost and risk, recommendation).

**Set as default (the star)**: makes the row's current value omp's global default for new conversations by running `omp config set` on omp's own setting (shared with the terminal). The star is filled (and saves nothing) when the row already is the default. Other running conversations are first held at what they have, so only new conversations change; this conversation keeps its value. Not available in a Light conversation on a local server (its settings are its own).

A paused conversation's panel shows the settings omp had when paused; changing one runs omp briefly to apply it and the conversation stays paused.

### Permission mode

What omp asks about before running a tool (omp's `tools.approvalMode`), switched per conversation from the picker below the message box (or ⌘⇧A / Ctrl+Shift+A); it applies from the next tool call and is kept when the conversation is resumed:

- **Ask every time** (`always-ask`): reads run freely; every edit and command waits for approval.
- **Ask and remember** (`always-ask-cached`): like Ask every time, and file reads wait too; an approved file or folder can be remembered for this conversation or for good.
- **Ask for commands** (`write`): reads and edits run freely; commands, the browser and subagents wait for approval.
- **Auto-approve** (`yolo`): everything runs without asking (shown in the warning colour).

The default for new conversations is set in Settings; unset, it follows omp's own setting. omp's per-tool policies (`tools.approval`) apply in every mode. A mode a newer omp added is shown as omp names it until one of these is picked.

### Loaded in this chat

A dialog (header button *Loaded in this chat*, the ⋯ menu, or typing `/status`, `/extensions` or `/skills`) listing what the conversation's omp process has: tools (offered, mounted at `xd://`, not enabled), MCP servers and their tools, slash commands by source, skills, plugins and stream rules. Switches:

- **Skill**: writes `skill:<name>` into omp's global `disabledExtensions` (`omp config set`); a running omp picks it up without restart. Global; a folder's own `.omp/config.yml` may override it (the dialog says so).
- **Plugin**: runs `omp plugin enable|disable` in the conversation's folder, then `/reload-plugins` on its omp. Not in Light mode.
- **MCP server**: runs the conversation's `/mcp enable|disable <name>`, writing `enabled` in the folder's `.omp/mcp.json` or the user's `mcp.json`. omp connects MCP servers only at start, so the dialog offers **Restart omp to apply** once the conversation is idle. Not for names with a space, servers defined in both files, or Light conversations.

**Restart omp** ends the conversation's omp only when it is idle (not working, waiting for an answer, or paused) and the page resumes the same session file in a new process.

### Todos

The Todos tab and the todo strip let the user finish/reopen a task, change its state (with a reason for *blocked*), edit text, move, remove, rename a phase, add tasks and phases, or edit the whole list as Markdown (omp's `/todo edit` format). Every change replaces the whole list through omp's `/todo import`, so omp enforces exactly one task in progress and records the edit. Works mid-turn and while paused (it stays paused).

### Pause and Resume

*Pause conversation* (beside the message box) freezes omp, its agents and their tools (SIGSTOP); *Resume*, or Enter with a message (*Resume & send*), continues. A paused conversation survives quitting the app or restarting the server and is still paused afterwards. Settings › Running sessions and the macOS quit dialog offer to end paused (and quota-waiting) conversations.

## Where it is

- Conversation header: *Session settings* (sliders icon) opens **This session**; on narrow layouts it is in the header's ⋯ menu.
- Below the message box: the permission-mode picker.
- Settings › Approvals & safety › Permissions: *Default permission mode for new conversations* (*Same as omp's setting (…)* or one of the four modes).
- Header: *Loaded in this chat*. Side panel: Todos tab.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.controlsAdvanced` | `on`, `off` | unset (= `off`) | Synced preference. Whether the panel's Advanced rows are unfolded. |
| `session:autoCompaction` | `on`, `off` | omp's own default | Star writes omp config `compaction.enabled` (`true`/`false`). |
| `session:autoRetry` | `on`, `off` | omp's own default | Star writes omp config `retry.enabled`. |
| `session:steeringMode` | `one-at-a-time`, `all` | omp's own default | Star writes omp config `steeringMode`. |
| `session:followUpMode` | `one-at-a-time`, `all` | omp's own default | Star writes omp config `followUpMode`. |
| `session:interruptMode` | `immediate`, `wait` | omp's own default (`immediate`) | Star writes omp config `interruptMode`. |
| `session:fastMode` | `on`, `off` | omp's own default | Star writes omp config `tier.<family>` (`anthropic`, `openai` or `google`, the model's family): `priority` for on; for off `none`, only over `priority` or `ultrafast`. |
| `session:cacheWarming` | `off`, `streaming`, `idle` | omp's own default (`idle`) | Star writes omp config `providers.cacheWarming`. |

| Stored in | Field | Values | Default | Effect |
|---|---|---|---|---|
| `approval.json` (omp-webui data folder) | `default` | `always-ask`, `always-ask-cached`, `write`, `yolo`, or null | null (follow omp's `tools.approvalMode`) | Permission mode of new conversations. |
| `approval.json` | `sessions` | session file → mode | none | The mode the user picked per conversation, used when it is reopened. |

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/approval` | GET, POST | token | GET `{ mode, omp }`: the default for new conversations (null: follow omp) and omp's own setting. POST `{ mode }` (a mode or null). |
| `/api/approval/session` | GET | token | `?file=`: the mode a conversation without a running omp starts in (its last pick, else the default, else omp's setting for its folder). |
| `/api/controls` | POST | token | Prefix of the actions below (`/api/controls/<action>`); each takes a JSON body, POST only. |
| `/api/controls/todos` | POST | token | `{ live, markdown }`: replace the todo list via omp's `/todo import`. |
| `/api/controls/skill` | POST | token | `{ live, name, enabled }`: skill on/off in omp's global `disabledExtensions`; answers `overridden` when another config layer decides. |
| `/api/controls/plugin` | POST | token | `{ live?, file?, name, enabled, scope? }` (`user`/`project`): plugin on/off, then reload. Refused in Light mode. |
| `/api/controls/mcp` | POST | token | `{ live, name, enabled }`: MCP server on/off via `/mcp enable\|disable`. Running Full conversations only. |
| `/api/controls/restart` | POST | token | `{ live }`: end the conversation's omp if idle (409 while working, waiting or paused) so the page can resume it anew. |
| `/api/controls/default` | POST | token | `{ live, setting, value }`: make a session control omp's global default (`SESSION_DEFAULTS`). Refused in Light. |
| `/api/controls/settings` | POST | token | `{ live }`: what omp's configuration says for auto-retry and cache warming for this process. |
| `/api/controls/panel-config` | POST | token | `{ live }`: Claude slow mode in omp's config and the folder's defaults (which rows are already the default). |
| `/api/controls/claude-slow` | POST | token | `{ live, enabled }`: Claude slow mode in omp's global config (every conversation). Refused in Light. |
| `/api/loaded` | GET | token | `?live=&file=`: the Loaded dialog's contents (tools, MCP servers, commands, skills, plugins, rules) and `restartOwed`. |
| `/api/lives` | GET | token | The omp processes this server runs (live id, session file, folder, mode, paused/working state), as Settings › Running sessions lists them. |
| `/api/lives/end-kept` | POST | token | End every kept conversation (paused, or waiting out a usage limit), as the macOS app's *Quit and end* does; answers `{ ended }`. |

## Limits and caveats

- Changes in This session apply to this omp process only, except the star (global omp config), slow mode for Claude (global) and skill switches (global).
- MCP changes need an omp restart; restart is refused while the conversation works, waits for input, or is paused.
- Auto-retry and cache warming are not reported by omp; the server shows what it told the process, else what omp's config says.
- Auto-approve runs every tool without asking.

## Security notes

- These routes are open to any page with the access token, including a remote (tunnel) page: such a page can change the permission mode (including Auto-approve), toggle skills, plugins and MCP servers, and write omp's global defaults.
- Defaults and switches are written with omp's own CLI and commands, never by editing omp's files directly; `approval.json` is written with mode 0600.
- An agent must not switch to Auto-approve, change the default permission mode, or set global defaults on the user's behalf unless the user explicitly asks.
