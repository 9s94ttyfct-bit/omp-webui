---
title: Ask agent for help
summary: A dedicated conversation whose agent explains the settings and changes them with webui_settings, for 30 minutes, with the person's Allow for security-sensitive ones and Undo in Settings.
settings: settings-help
---

# Ask agent for help

## What it does

**Ask agent for help** (Settings) starts a conversation of its own whose agent explains omp-webui's settings (from these docs, with `webui_docs`) and changes them for the person with a second tool, `webui_settings`, that only that conversation has.

- The conversation runs in its own folder, `<data dir>/settings-help` (`~/.omp-webui/settings-help`, or the app's data folder), so that no project's `AGENTS.md`, files or memories are in its context. It is named *Settings help* and its first message says which Settings page it was opened from.
- `webui_settings` has two actions:
  - `get`: every setting it can change (or the `keys` given), each with its class (`normal` or `sensitive`), its current value, and how many minutes of access are left.
  - `set`: `changes`, a list of `{ key, value }` (at most 20, each key once). Every value is checked by the parser of the setting's own Settings card first; one unknown key or refused value refuses the whole call and nothing changes.
- A **normal** setting is changed at once. A **sensitive** one shows the person a card in the conversation (and in Settings) with the setting's current and new value and **Allow** / **Deny**; the tool waits for the answer. Deny, no answer within 5 minutes, the turn being stopped or the access ending all leave the value as it was.
- **Access** lasts 30 minutes from the start. It ends earlier when the person presses **Revoke now**, or when the conversation's process ends (closed, stopped, the server restarting). After that the tool answers with an error that says why. A conversation reopened later has no `webui_settings`; a new one is started from Settings.
- Every change is **logged**: when, which key, the value before and after, and who let it through (the agent alone for a normal setting, the person's Allow for a sensitive one). Settings lists them under *Changes made by the agent*, by conversation, with **Undo** per change and **Undo all** per conversation. Undo puts the old value back through the same setter; it is refused when the setting was changed again since (undo the later change first). The log keeps the last 200 changes.

### Keys `webui_settings` accepts

The keys are those of the other topics' `Key` tables:

- `ompw.*` synced preferences (see `appearance`, `notifications`, `composer`, `conversations`, …).
- `guard.json:<field>` (see `guard`), `remote.json:<field>` (see `remote-access`).
- `mode.json:mode`, `mode.json:lightModels`, `mode.json:offline.<field>` (see `light-mode`).
- `approval.json:default`: the permission mode new conversations start in (`always-ask`, `always-ask-cached`, `write`, `yolo`, or `null` for omp's own setting; see `session-controls`).
- `unattended.json:instruction`: what an unattended conversation is told (text up to 4,000 characters, or `null` for the shipped text; see `unattended`).

**Sensitive** (each needs the person's Allow): every field of `guard.json`, `remote.json` (remote access, its allow-list, shells and file transfer for remote pages, autostart, confirm risky), `approval.json:default` and `unattended.json:instruction`; `ompw.unattended`, `ompw.keepAwake`, `ompw.appUpdateCheck`, `ompw.notify` (whether the guard has somebody to ask); `mode.json:offline.baseUrls`, `offline.tools`, `offline.mcp` and `offline.skills` (where a Light conversation is sent, and what it may run).

**Not changeable here**: what the app remembers for itself rather than a choice (`ompw.cwd`, `ompw.usageDays`, `ompw.star`, `ompw.omp.dismissed`, `ompw.dropChoices.app`, `ompw.dropChoices.page`, `ompw.quickPromptsSeen`, `ompw.guardBefore`), and omp's own configuration (`omp:*`, `session:*`, model roles and presets, the guard's rules), which is changed in Settings or with `omp config` and is shared with omp in a terminal. Every other synced preference and Light setting is **normal**.

## Where it is

Settings, at the top of every page, under the search: the **Ask agent for help** card, with the conversations that can change settings now (time left, Open, Revoke now), the cards waiting for an Allow, and *Changes made by the agent*. In the dedicated conversation, a strip under the header shows the *Settings help* badge, the time left (`Can change settings · 29:41 left`) with **Revoke now**, and its Allow / Deny cards; after the access ended it says why.

Only on this computer: a page that came through the tunnel or over the network has no card and no strip (the macOS app is on this computer).

## Settings

None of its own. What it changes is listed above; the change log is kept in `~/.omp-webui/settings-help.json`.

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/settings-help` | GET | local-only | The state: the folder, the conversations that can change settings (`liveId`, `startedAt`, `expiresAt`), the ones whose access ended and why, the changes waiting for an answer, and the change log (newest first). |
| `/api/settings-help/start` | POST | local-only | Start a dedicated conversation with 30 minutes of access; answers the conversation (`liveId` …). |
| `/api/settings-help/revoke` | POST | local-only | `{ liveId }`: end that conversation's access now (404 when it has none). |
| `/api/settings-help/answer` | POST | local-only | `{ id, allow }`: Allow (`true`) or Deny (`false`) a waiting change (404 when it no longer waits). |
| `/api/settings-help/undo` | POST | local-only | `{ id }`: put back what one logged change replaced; 409 when the setting was changed again since. |
| `/api/settings-help/undo-all` | POST | local-only | `{ liveId }`: undo every standing change of one conversation, newest first; says how many were undone and which could not be. |

The pages on this computer are told every change of the state by the `settings_help` socket message.

## Limits and caveats

- The tool changes the settings listed above only. It cannot install updates, start or stop the tunnel, sign in to Cloudflare, edit the guard's rules, change omp's configuration, or touch conversations, memories or files.
- A setting changed while a sensitive change waits for an answer: what is written is the value the person allowed, and the log records the value it replaced at that moment.
- Changes take effect as from their card in Settings: open pages follow at once (preferences, the guard, Full / Light), a new permission mode applies to conversations started from then on.
- MCP tools of the person's own configuration follow the conversation's permission mode as in any conversation.

## Security notes

- `webui_settings` is served by the server over the dedicated conversation's own omp pipe (the mechanism Settings › Remote access › *Set up with AI* uses): no other conversation is told of it, and no token is handed to omp, so nothing can reach the agent's commands, the tool's arguments or results, or the exported session file. The access is a grant the server holds for that conversation's process, checked on every call; a restarted server holds none.
- A conversation a page that is not on this computer has been on is refused, since that page could answer omp's prompts; sending a message from this computer lifts it.
- The person's Allow for a sensitive change is given on a page of this computer only (`/api/settings-help/answer` is local-only); the agent cannot answer its own card.
- So that the agent cannot go around the tool by editing the settings files (`guard.json`, `remote.json`, `mode.json`, `ui-prefs.json`, `unattended.json`, …) or running a command that does, the dedicated conversation asks the person before every call of omp's `bash`, `edit`, `write`, `eval`, `python`, `notebook`, `ast_edit`, `lsp`, `debug`, `browser`, `computer` and `task` tools, in every permission mode, Auto-approve included (`tools.approval.<tool>: prompt` in its overlay). The agent has no need of them there; an attempt is in front of the person before it runs.
- Every value goes through the validated setter of its own card (the same parsers, the same side effects); unknown keys are refused.
