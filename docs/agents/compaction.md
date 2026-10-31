---
title: Compaction
summary: When omp compacts a conversation by itself (a share of the context window or a token count, globally or per conversation), and where a compact queued while the agent works runs (end of the turn or between two steps).
settings: compact-at, compact-where
---

# Compaction

## What it does

Compaction is omp's own: it summarizes the older part of a conversation so that it fits the model's context window again. omp-webui shows and changes two things about it.

**When omp compacts by itself ("Compact at").** omp compacts on its own once the context passes a point, which is one of omp's settings:

- `compaction.thresholdPercent`: a share of the model's window.
- `compaction.thresholdTokens`: a count of tokens; when positive it overrides the share.
- `-1` in both is omp's default: omp keeps a reserve free, `max(15% of the window, compaction.reserveTokens or 16384)`, and compacts once the context passes what is left (with a 200k window: about 170k, 85%).

The app writes one of the two and resets the other to `-1` (a leftover token count would otherwise override a share). The page offers a share of 50–95%, or a token count (a whole number above zero, optionally with `k`, `M` or `B`, e.g. `120k`), or **Default** (omp's reserve). omp reads the point at each check, so a change applies from the conversation's next turn without a restart.

- The **global** point is omp's own setting, as `omp config set` changes it in the terminal: it applies to every conversation that has not chosen its own, and to omp run in a terminal.
- A **conversation's own** point (session panel › **Compact at (context used)**) is kept in that conversation's own configuration overlay (`--config`), not in omp's global configuration; a running omp reloads it about 200 ms after it changes.
- omp's per-model points (`compaction.modelThresholds`, used only while `compaction.modelThresholdsEnabled` is not `false`) apply over both: when one matches the conversation's model the panel says so ("omp's configuration sets a compaction point for this model itself (…)") and the row has no effect on that conversation until that entry is removed. The app reads these, it does not write them.

Whether omp compacts by itself at all is the session control **Auto-compaction** (`session:autoCompaction`, omp's `compaction.enabled`; see `session-controls`).

**Where a compact you queue runs.** Asking for a compact while the agent is working does not interrupt it: the server holds the request ("Compact queued") and sends omp's compact when that loses no work.

- **When the turn ends** (`turn`, the default): before the next queued message is sent. Always possible.
- **Between two steps** (`step`): at the next point between two steps of the turn, once the tools that are running have returned and before the next model request; the turn then goes on after the compact. A turn that ends before such a point is compacted at its end. It needs the app's compact-between-steps extension running in the conversation and omp's `compaction.autoContinue` not `false`; otherwise it waits for the end of the turn and says why (the conversation was started with the person's own `--trusted-extension`; the extension did not load; "omp is set not to continue a turn after compacting (compaction.autoContinue)").

Messages sent while a compact is queued are held by the server and go to omp after it, in order (for a compact between steps: after the rest of that turn). A queued compact survives a page reload, every page sees it, and it can be cancelled until it starts (*Cancel*); once omp is compacting it is not cancelled from the app. The optional note for the summary (*Optional: what to keep*) is up to 4,000 characters. A compact asked of a conversation whose omp is not running resumes the conversation first ("Resumed the conversation to compact it.").

The Settings choice is where each conversation's own choice starts from; the session panel's **Where the compact runs** changes it for one compact.

## Where it is

- **Settings › Conversations & files › When omp compacts by itself** (`#/settings/chats`; index name *Automatic compaction*): the global point (Default / Percent of window / Tokens, *Apply*).
- **Settings › Conversations & files › Where a compact you queue runs** (index name *Queued compaction*): *When the turn ends* / *Between two steps*.
- **A conversation › session settings (This session panel)**: **Compact at (context used)** (this conversation's own point; *Default* makes it follow omp's configuration again), **Auto-compaction**, and **Compact context** (*Optional: what to keep*, *Compact now*; while the agent works *Compact after this turn* / *Compact between steps* with **Where the compact runs**, then *Compact queued* with *Cancel*). See `session-controls`.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `omp:compaction.thresholdPercent` | `-1` (omp's default), or a share; the app writes 50–95 | `-1` | omp compacts once the context passes this share of the model's window. Written globally with `omp config set` (Settings), or per conversation in its overlay (session panel). Writing it resets `thresholdTokens` to `-1`. |
| `omp:compaction.thresholdTokens` | `-1` (omp's default), or a positive whole number of tokens | `-1` | omp compacts once the context passes this many tokens; when positive it overrides `thresholdPercent`. Writing it resets `thresholdPercent` to `-1`. |
| `omp:compaction.reserveTokens` | a token count, or unset | unset (omp keeps `max(15% of the window, 16384)` free) | Read only: what omp's Default keeps free, so the page can say where Default compacts ("about N% · tokens of window"). |
| `omp:compaction.modelThresholds` | omp's record of `provider/id` (or `provider/…*`) → compaction point | unset | Read only: a matching entry applies over the two settings above for that model; the panel warns that its own row then has no effect. |
| `omp:compaction.modelThresholdsEnabled` | `true`, `false` | omp's default | Read only: `false` turns `modelThresholds` off entirely. |
| `omp:compaction.autoContinue` | `true`, `false` | `true` (omp's default; an omp that cannot be asked is taken to go on) | Read only: whether omp continues a turn after compacting. `false` makes a compact *between two steps* wait for the end of the turn. |
| `ompw.compactWhere` | `turn`, `step` | unset: `turn` | Synced preference. Where a compact queued while the agent works runs; each conversation's own choice in its session panel starts from it. |

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/compact-at` | GET, POST | token | GET returns `{ omp, session }`: omp's configured point (`percent`, `tokens`, `reserve`; `-1` is omp's default; null when omp could not be asked) and, with `?file=<session file>`, the point that conversation chose for itself (or null). POST `{ at }` sets omp's global point: `{ percent: 50–95 }`, `{ tokens: n }`, or `null` for omp's default again; anything else is 400. |
| `/api/compact-at/session` | POST | token | Body `{ file, at }`: one conversation's own point (`at` null: follow omp's configuration again). The session file need not be written yet. 404 for an unknown file, 409 when it cannot be applied. Answers `{ omp, session }`. |

Queuing, cancelling and running a compact go over the conversation's WebSocket (omp's own `compact` RPC), not over these routes.

## Limits and caveats

- Compaction is omp's: it costs a model request, and the summary replaces the older messages in the model's context (the transcript still shows them).
- The page cannot set a share below 50% or above 95% (omp itself takes 1–100); a token count above the model's window is refused by the panel ("More than the …-token window this model has").
- With **Auto-compaction** off, a request that no longer fits fails until the person compacts by hand.
- A per-model entry of `compaction.modelThresholds` wins over everything the page writes for that model.
- A conversation on a local model server (Light mode with a local server) runs on settings of its own; omp's defaults are not changed from it.

## Security notes

- The global point is omp's own configuration, shared with omp in the terminal; changing it affects every conversation that has not chosen its own.
- The routes need the access token and are open to a remote page that holds it (they change no file outside omp's configuration and the conversation's own overlay).
- Agents should not change the person's compaction settings unasked.
