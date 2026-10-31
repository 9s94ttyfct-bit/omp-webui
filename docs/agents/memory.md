---
title: Memory page
summary: A page on this computer that lists, searches and edits what omp remembers across conversations (omp's Mnemopi long-term memory), with automatic backups before changes.
settings:
---

# Memory page

## What it does

Shows omp's long-term memory (the Mnemopi backend: what omp's `retain`, `recall` and `memory_edit` tools work on) and lets the user change it. omp keeps it in SQLite databases ("banks"): one shared bank that every project recalls ("Global") and one per project ("Project"). Each bank has working memories and episodic (consolidated) memories.

- **Kinds**: **Notes** (saved on purpose: the agent's learn/retain, `/memory`, or this page), **Conversations** (excerpts omp kept by itself), **Consolidated** (what omp's sleep consolidation made of working memories).
- **List and search**: newest first, 50 per page (**Show more**); search text, folder, reason or id; filter by scope (All / Global / Project), project, kinds, and **Include retired**.
- **Detail**: text, whose (global or project), kind, who saved it, why, conversation (with **Open the conversation**), folder, created, importance (0 to 1), how often recalled, retired state, what it was made from / consolidated as, id, bank.
- **Add memory**: global (only when the shared bank exists, is writable, and omp's `mnemopi.scoping` is not `per-project`) or to a project's bank; default importance 0.75.
- **Edit** text and importance (working memories only). If the memory changed meanwhile (omp consolidated it, or another page changed it), the edit is kept and the user chooses **Keep mine** or **Use the current text**.
- **Retire** / **Restore**: omp stops recalling a retired memory; it stays in the store. Any memory, consolidated ones included, can be retired.
- **Delete**: working memories only (consolidated ones cannot be rewritten or deleted, as in omp's own `memory_edit`); removes what omp made from it. Cannot be undone from the page.
- **Secret check**: text that looks like a key or token is refused unless the user ticks "I mean to save this", because a memory goes into the prompt of every later conversation and so to the model provider.
- **Backups**: before a change, SQLite makes a consistent copy of the bank (`VACUUM INTO`) into `~/.omp-webui/memory-backups/<bank>/`, at most once every 10 minutes per bank (deletes: once a minute), keeping the newest 10 copies per bank. If a copy cannot be made, the change is not made.

Changes are made directly in omp's database as single SQLite transactions (omp has no command that edits one memory). Only an existing database in the layout omp 18.12 makes is written; another layout is read where possible and refused for writing ("Change it in omp, with its memory_edit tool"). Scratch banks of this app's helper conversations (`ompw-*`) and empty project banks are hidden. If omp's `memory.backend` is not `mnemopi`, the page says the store is not in use but still shows and edits it. If omp's settings cannot be read, nothing can be changed (503).

Where the store is: `mnemopi.dbPath` if set (must be absolute; a relative path is not supported here), else `<omp agent dir>/memories/mnemopi/mnemopi.db`; project banks are in `banks/` beside it. The shared bank's name comes from `mnemopi.bank` (default `default`).

## Where it is

- Sidebar/rail item **Memory** (`#/memory`), also in the command palette's Go to. Buttons **Refresh** and **Add memory**.
- On a page that is not on this computer the page shows "Memory is only shown on this computer".

## Settings

None. (omp's own settings `memory.backend`, `mnemopi.scoping`, `mnemopi.dbPath` and `mnemopi.bank` decide where and whether the store is used; change them with `omp config`.)

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/memory` | GET | local-only | Overview: omp's backend and scoping, whether settings were readable, the shared database path, the banks with counts, how many are hidden, and whether a global memory can be added. |
| `/api/memory/items` | GET | local-only | A page of memories, newest first. Query: `q` (first 200 chars), `scope` (`all`, `global`, `project`), `bank`, `kinds` (comma list of `note`, `conversation`, `consolidated`), `retired` (`active` default, `retired`, `all`), `limit` (default 50, max 200), `offset`. |
| `/api/memory/item` | GET | local-only | Query `bank`, `id`: one memory in full (with its `etag`). |
| `/api/memory/add` | POST | local-only | `{ scope: "global"\|"project", bank?, content, importance?, context?, acknowledgeSecret? }`. Returns the memory and whether a backup was made. |
| `/api/memory/update` | POST | local-only | `{ bank, id, etag, content?, importance?, acknowledgeSecret? }`. 409 `stale` if the etag no longer matches. |
| `/api/memory/retire` | POST | local-only | `{ bank, id, etag? }`: omp stops recalling it. |
| `/api/memory/restore` | POST | local-only | `{ bank, id, etag? }`: recall it again. |
| `/api/memory/delete` | POST | local-only | `{ bank, id, etag, retireConsolidated? }`: delete a working memory. |

Errors answer `{ error, code }` (e.g. `notFound` 404, `stale` 409, `secret` 409, `noGlobal` 409, `layout` 409, `tooLong` 413, `settings` 503).

## Limits and caveats

- A memory holds at most 64,000 characters; `context` (reason) at most 400.
- Rewriting a memory's text drops its embedding; omp recomputes it at its next start.
- Only Mnemopi's store is shown; other omp memory backends keep their data elsewhere.
- If no store exists yet, omp creates it when it first saves something with Mnemopi on (`memory.backend: mnemopi`).

## Security notes

- All `/api/memory*` routes are local-only: refused (403) to any page not on this computer whatever token it holds, because memories contain project paths and conversation excerpts, and anything written there goes into the prompt of every later conversation.
- Backups in `~/.omp-webui/memory-backups` keep the text of deleted or changed memories (and anything secret in them).
- Agents must not add, edit, retire or delete memories through this page's API on the user's behalf unless the user asks; agents have omp's own memory tools for their own notes.
