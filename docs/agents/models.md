---
title: Models, accounts and presets
summary: Provider logins, omp's model roles and default thinking level, named model presets, and how a conversation picks its model, favourite and recent models included.
settings: accounts, model-roles, model-presets
---

# Models, accounts and presets

## What it does

All of this is omp's own configuration, read and written through omp (`omp config get|set`, omp's RPC login), so the terminal UI sees the same values.

### Accounts

Logs in to model providers through omp; omp stores the credentials exactly as `omp login` would. The list is loaded only on **Show accounts**: it starts a small session-less omp process (shown under Running processes as the accounts helper), which stops when the list is hidden or Settings is left. Per provider: **Log in** (opens the provider's sign-in page; **Cancel sign-in**), **Manage**, **Add account**, **Log out** (asks for confirmation). If credentials also come from the environment or config, logging out says "still authenticated via …".

### Model roles

Which model each role uses (`modelRoles` in omp's global config) and the **Default thinking level** (`defaultThinkingLevel`). Roles shown with names: Default, Fast (`smol`), Thinking (`slow`), Architect (`plan`), Subtask (`task`), Commit, Vision, Advisor, Tiny tasks, Memory, Web search, Image generation, Speech, Dictation, Judge; **Add role** adds any other name (a letter, then letters, digits, `-` or `_`, at most 32 characters). A role's value is an omp model selector: `provider/id`, optionally `:<level>` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`), and also fallback lists, aliases and globs (max 512 characters, no control characters). The default thinking level is one of `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`, or Model default. Changes go to omp's global config and apply to new conversations. When a conversation's folder has a project `.omp/config.yml` that overrides roles, Settings shows a **Project overrides** section (read-only). If omp could not read `config.yml` and moved it aside, Settings says where it was moved.

### Model presets

A preset is a named set of models for every role plus an optional thinking level and optional subagent models (`agentModelOverrides`), stored in omp's `modelPresets` (shared with the terminal UI's `/modelpreset`). Names: a letter, then letters, digits, `-` or `_`, at most 64 characters. In Settings each preset has **Apply** (writes its roles, thinking level and subagent models to the global config; open conversations keep their model until switched from their composer), **Edit**, **Rename**, **Duplicate**, **Delete**. Presets defined by a project's config are read-only.

### In a conversation

- The composer's **Presets** menu switches this conversation (and the subagents it starts) to a preset without changing the global config; "Custom" when its models match none. **Save current as…**, **Set as default** (makes the current models the default for new conversations: writes the global roles), **Manage presets…**. The shortcut **Mod+Shift+M** (⌘⇧M / Ctrl+Shift+M, rebindable in Settings › Look & layout › Keyboard shortcuts) cycles presets while the composer is shown. A preset chosen for a conversation is remembered for its file, so a saved conversation comes back on it.
- The composer's model picker sets the conversation's model; its search lists **recently picked models** first (the last 6, kept per browser) and lets you star **favourite models**, which are kept on the server and shared by every page.
- The thinking level picker offers `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto` (as the model supports).

## Where it is

- **Settings › Models & accounts** (`#/settings/models`): cards **Accounts**, **Model roles**, **Model presets** (also Full / Light, Model guidance and the quota floor, documented elsewhere).
- Conversation composer: model picker, thinking level, **Presets** menu.
- **Settings › App & system › omp configuration**: the buttons `omp models` and `omp login` open omp's own commands on the Commands & terminal page.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.recentModels` | JSON list of up to 6 `provider/id` keys, newest first | unset (empty) | Per-device localStorage key, not synced: the models picked recently in the model picker, listed first. |

Other stored values:

| Stored in | Field | Values | Default | Effect |
|---|---|---|---|---|
| omp global config | `modelRoles` | role name → model selector | omp's | Model of each role (Settings › Model roles, Apply, Set as default). |
| omp global config | `defaultThinkingLevel` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto` | omp's | Default thinking level. |
| omp global config | `modelPresets` | preset name → `{ modelRoles, defaultThinkingLevel?, agentModelOverrides? }` | none | Named presets. |
| omp global config | `task.agentModelOverrides` | agent name → model selector | none | Subagent models, written when a preset that carries them is applied. |
| `~/.omp-webui/favorite-models.json` | list | `provider/id` strings | `[]` | Starred models in the picker. |
| `~/.omp-webui/approval.json` | per-conversation models | — | — | The preset/roles a conversation was switched to, restored when it is reopened. |
| omp's agent directory | credentials | — | — | Provider logins, stored by omp. |

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/models` | GET | token | The models omp can use (`omp`'s list); `force=1` re-reads it (after a sign-in); `scope=local` lists the models of the Light mode's local server instead. |
| `/api/favorite-models` | GET, POST | token | GET: the starred models. POST `{ model: "provider/id", on: true\|false }` stars or unstars one (max 200 chars). |
| `/api/model-preset/session` | GET | token | Query `file`: the models remembered for a saved conversation (`{ models }`, null = the global roles). 404 for an unknown file. |
| `/api/model-config` | GET | token | Roles, default thinking level, subagent models, presets (global and, with `cwd=<folder>`, the project's layer), and `movedAside` if omp moved an unreadable config aside. |
| `/api/model-config/roles` | POST | token | `{ roles, defaultThinkingLevel?, agentModelOverrides? }`: write the global roles (Settings and Set as default). |
| `/api/model-config/preset/save` | POST | token | `{ name, roles?, defaultThinkingLevel?, agentModelOverrides?, overwrite? }`: save a preset (current roles if `roles` omitted); 409 if it exists without `overwrite`. |
| `/api/model-config/preset/edit` | POST | token | `{ name, roles, defaultThinkingLevel (null = none), agentModelOverrides }`: replace those keys of a preset, keeping the rest. |
| `/api/model-config/preset/agents` | POST | token | `{ name, agentModelOverrides }`: set a preset's subagent models. |
| `/api/model-config/preset/rename` | POST | token | `{ from, to }`. 409 if `to` exists. |
| `/api/model-config/preset/duplicate` | POST | token | `{ from, to }`. 409 if `to` exists. |
| `/api/model-config/preset/delete` | POST | token | `{ name }`. Current roles stay as they are. |
| `/api/model-config/preset/apply` | POST | token | `{ name }`: write the preset's roles, thinking level and subagent models to the global config (409 if omp cannot use it). |

Logins go over the WebSocket to the accounts helper process (omp RPC), not over HTTP.

## Limits and caveats

- Writes go through the `omp` CLI (30 s limit per command); a change to one preset reads and rewrites the whole `modelPresets` record, leaving untouched entries exactly as they were.
- Global values are read without project config so project values are never copied into the global config; a project whose role storage is "project" saves role changes from omp's terminal UI to `.omp/config.yml`, not where this page writes.
- Presets and roles apply to conversations on your own models; a conversation running on a local server (Light) uses the model chosen under Full / Light.
- Applying a preset or saving roles does not change already-open conversations.

## Security notes

- None of these routes is local-only: any page holding the access token (including through the tunnel) can change roles and presets and log in or out of providers. Credentials are stored by omp, never by omp-webui, and are not sent to pages.
- Agents should not change the user's global model roles, presets or provider logins unless the user asks.
