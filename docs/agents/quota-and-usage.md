---
title: Quota and usage
summary: Provider quota in the conversation header, waiting out a usage limit and retrying, the quota floor that holds a working conversation before it spends the last of a usage window, and the Usage & cost page.
settings: usage-wait, quota-floor
---

# Quota and usage

## What it does

**Quota ring.** A conversation's header shows a ring with how much of its provider's usage window is left (*N% left*); hovering or opening it lists the provider's windows (*label: N% left · resets in …*), per account where omp has several. The figures are omp's own (`omp usage`), read per provider.

**Waiting for the reset.** *When the usage limit is reached, wait for the reset and retry*: instead of failing the turn, omp sleeps until the provider's reset time and retries by itself. This is omp's own setting `retry.waitForUsageReset`, shared with omp in the terminal. It needs the provider to say when the limit resets. The conversation shows the countdown with **Cancel** and **Retry now**; the Agents tab shows a subagent's wait. Each conversation can override the setting from its quota pill. Switching it off fails only waits longer than omp's `retry.maxDelayMs` (5 minutes by default); neither way changes a wait already running. omp's automatic compaction retries on its own and does not report its wait.

**Quota floor.** Hold a working conversation before it spends the last of a provider's usage window. For each provider the person sets a floor (*Hold when this much or less is left*, 1–99 % left); with none set (the default) nothing is held.

- When a working conversation's provider is at or below its floor, the request in flight finishes and the conversation then waits before its next step ("Quota floor reached: the next step will wait", then "Waiting for the quota to reset").
- It is held, not frozen: it resumes by itself after the window resets (with a minute of grace), or when the person chooses **Continue anyway** on the conversation's own line, which ignores the floor until the provider is above it again (**Hold again** undoes that).
- Subagents already running finish their assignment. The first request of a new prompt sent to a held conversation still goes out.
- While held, the prompt cache is kept warm only while refreshing it until the reset costs less than rebuilding it once (rebuild cost minus refresh cost at least $0.05); omp refreshes at 90% of the cache's lifetime and stops an hour after the request that made the entry while a turn works (half an hour while idle). The line says which applies and what refreshing has spent.
- It works through an extension of the server's that omp is started with: a conversation started with the person's own `--trusted-extension`, or whose extension did not start, cannot be held and says so ("It keeps working past the floor"). A change reaches working conversations at their next look at the quota.

**Usage & cost page.** Total cost, requests (with error share), tokens (output, cache hit), speed (tokens/s, time to first token), daily cost by model (UTC days), and tables *By model*, *By project*, *By agent type* (the guard's reviewer is its own agent type), *Most expensive conversations* (with subagent and advisor shares). **Range**: *24 hours*, *7 days*, *30 days* (default), *All time*. **Refresh** asks omp again. The figures come from `omp stats` and omp's statistics database; a plain load answers at once from the figures kept from the last run while omp brings them up to date ("Figures from …; omp is bringing them up to date…"). When the database cannot be read the page shows omp's own last 24 hours and says so.

## Where it is

- Conversation header: the quota ring (with the per-conversation *wait for reset* choice in its pill).
- **Settings › Conversations & files › Conversations** card › *When the usage limit is reached, wait for the reset and retry* (`#/settings/chats`, with *How it works*).
- **Settings › Models & accounts › Quota floor** (`#/settings/models`): one row per provider omp reports usage for (*N% left · window*), a floor field, *Save*, *Off*, and *How it works*. "No provider has reported its usage yet" until omp can read a quota.
- Sidebar (or rail) page **Usage & cost** (`#/usage`).

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.usageRange` | `24h`, `7d`, `30d`, `all` | unset: `30d` | Synced preference. How far back Usage & cost looks. |

Stored elsewhere:

| Stored in | Setting | Values | Default | Effect |
|---|---|---|---|---|
| omp's `config.yml` | `retry.waitForUsageReset` | `true`, `false` | omp's default | Wait for the usage-limit reset and retry instead of failing the turn (Settings writes it with `omp config set`). |
| kept with the conversation | its *wait for reset* choice | `true`, `false`, or follow omp | follow omp | One conversation's override, from its quota pill. |
| `~/.omp-webui/quota-floor.json` | floor per provider | provider id → whole number 1–99 (% left) | none (nothing held) | The quota floor. At most 64 providers. A file that cannot be read is kept aside as `quota-floor.json.damaged` and no floor applies. Moves with Move to another computer. |
| `~/.omp-webui/omp-stats.json` | last statistics | omp's figures | — | What Usage & cost shows at once while omp refreshes. |

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/usage?provider=<id>` | GET | token | omp's usage report for one provider (the quota ring). `force=1` asks omp afresh. 400 for an invalid provider id. |
| `/api/usage-reset-wait` | GET, POST | token | GET `{ omp, session }`: omp's `retry.waitForUsageReset` and, with `?file=`, that conversation's own choice (null: follows omp). POST `{ enabled: true\|false }` sets omp's setting. |
| `/api/usage-reset-wait/session` | POST | token | `{ file, enabled }` (`enabled` null: follow omp again): one conversation's own choice. |
| `/api/quota-floor` | GET, POST | token | GET the floors. POST `{ provider, floor }` (`floor` 1–99, or `null` to remove); 422 for an unknown provider, a bad value, or more than 64 floors. Reaches working conversations at their next look at the quota. |
| `/api/stats?range=<24h\|7d\|30d\|all>` | GET | token | Usage & cost figures. Headers: `x-stats-range`, `x-stats-at` (when the figures were taken), `x-stats-refreshing: 1` (ask again with `wait=1` for omp's run), `x-stats-fallback: 24h` (the database could not be read). `force=1` makes omp recount. |

Holding, *Continue anyway* and *Hold again* for one conversation go over its WebSocket.

## Limits and caveats

- Quota figures are only as good as what the provider reports to omp; a provider that reports none cannot have a floor applied, and a wait for reset needs the provider to say when the limit resets.
- The floor is checked between steps: a long single request can still go below it.
- Cache warming while held costs money (shown on the conversation's line); it stops when it no longer saves anything.
- Usage & cost counts what omp recorded; the guard's reviewer requests are counted only where omp's database holds them.

## Security notes

- All these routes need the access token and are open to a remote page that holds it; the floor and wait settings only affect how the person's own quota is spent.
- `retry.waitForUsageReset` is omp's global setting, shared with the terminal.
- Agents should not lift a hold (*Continue anyway*) or change floors on the person's behalf unasked: the floor protects the person's quota.
