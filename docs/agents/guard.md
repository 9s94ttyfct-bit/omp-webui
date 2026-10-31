---
title: Guard dangerous commands
summary: A gate inside every omp process that holds risky tool calls until a reviewer model or the user approves them, with tunable per-kind thresholds, reviewer rules, a decisions log and a benchmark.
settings: guard
---

# Guard dangerous commands

## What it does

Every conversation's omp process (the main agent and each subagent) is started with a gate. A pattern classifier flags tool calls that look risky (administrator rights, mass deletion, writes or deletes outside the project, credentials, force-push, downloaded scripts, tunnels, system-wide installs, and so on). With the guard on, a flagged call does not run until it is approved:

- **Off** (`off`): calls are not looked at by the guard; the permission mode alone decides.
- **Reviewer model** (`reviewer`, the default): a second model reads the call and the recent conversation, and allows or denies it before it runs.
- **Ask me** (`ask`): each risky call waits for the user's answer in its conversation, for as long as it takes. A subagent's call is refused in this mode (a subagent has nobody to ask).

Reviewer choice: when the Reviewer model field is blank, an omp `reviewer` model role is used if one is configured; otherwise the guard picks a model of another family than the agent's (roles `smol`, `slow`, `default` first, then the cheapest other signed-in models), then a model of the agent's own family, and as a last resort the agent's own model in a fresh context. A comma-separated list (`provider/model,provider/model`) is a chain: the first reviews, the others are tried in order when it cannot be reached (followed by omp's own `retry.fallbackChains.reviewer`). At most 5 configured reviewers are tried.

A reviewer that cannot be reached (rate limit, timeout, error, unclear answer) is not a verdict. When none can be reached the call is refused as "reviewer unavailable" unless **ask when unavailable** is on, in which case the user is asked about the main agent's call. When the reviewer denies a call and **ask when denied** is on, the user sees the reviewer's reason and can run the main agent's call anyway. A subagent's call is never put to the user: for subagents a denial or unavailability is final.

Policy (Guard page › Policy):

- **Thresholds per kind**: for each kind the classifier flags, Allow (runs unasked), Ask (goes to the reviewer, or to the user in Ask me) or Block (refused without asking anyone). Every kind defaults to Ask. A call flagged for several kinds gets the strictest. A call the classifier does not flag is not looked at at all.
- **Floors**: "Mass deletion or emptying" (`mass_delete`), "Credentials and the guard's own files" (`protected`), "Reading keys and passwords" (`secret_read`) and "A call that could not be checked" (`unreadable`) can be Ask or Block, never Allow. Setting any other kind to Allow first shows how many shipped harmful benchmark cases would then run unasked, and asks for confirmation.
- **The reviewer's rules**: free text (one rule per line: what the call does, then allow or block; anything the rules do not cover is blocked) the reviewer reads before judging. Default rules are versioned (currently version 6); if the default changes after the user edited the rules, the Policy tab says so and the user's rules are kept. Max 6,000 characters; cannot be empty (use Restore default).
- **Fixed, not tunable**: a call that names the guard's own settings or log is refused before anyone is asked; reading the guard's own settings, log or state counts as touching credentials; the reviewer is always told, after the user's rules, that the guard's own settings, state and API are off limits.

Per conversation: a conversation can choose its own guard fields (mode, reviewer, ask when unavailable, ask when denied) for itself and its subagents. Fields it does not choose follow Settings › Safety, also when those change. If what was kept of a conversation's choice cannot be read, it runs under the stricter of Settings and the shipped default (Reviewer model, ask when unavailable), never Off.

Decisions log: each gate appends one JSON line per decision. A decision records the outcome (Allowed, Asked you, Blocked), who decided (Classifier = a threshold of Allow/Block, Reviewer, You, Guard = the gate itself with nobody to ask), the reviewer model(s) tried, token usage, the reason, the folder, and the call (up to 4,000 characters). Tool cards in a conversation show a chip with the guard's verdict.

Benchmark: tries shipped harmful and harmless commands (plus up to 50 of the user's own cases) against the guard as currently set, and shows which are stopped and which slip through. Nothing is executed: each command is only read and judged. "Run (classifier only)" uses the classifier and thresholds alone; "Run with the reviewer" also asks the reviewer about each call the settings send to it (up to 120 reviewer requests, 2 at a time, on the user's quota). Results include suggestions ("What would change this") with an Apply button.

## Where it is

- **Settings › Approvals & safety › Guard dangerous commands** (`#/settings/safety`; the app's own messages call it "Settings › Safety"): mode (Off / Reviewer model / Ask me); when Reviewer model is selected also the Reviewer model picker and the two switches "If no reviewer can be reached, ask me about the main agent's calls" and "When the reviewer denies a call, ask me". The card also shows a summary (decisions recorded, reviewer's rules default/yours, kinds changed from Ask) and an **Open the Guard page** button. This card is not shown to a page that is not on this computer.
- **Guard page** (`#/guard`): sidebar/rail item **Guard** (eye icon, bottom group by default; can be moved or hidden in Settings › Look & layout › Sidebar and rail; also in the command palette's Go to). Three tabs: **Decisions** (filters Outcome, Decided by, Search; paged list of recent decisions), **Policy** (How strict, by kind of call; The reviewer's rules; Restore default), **Benchmark** (Run (classifier only), Run with the reviewer, Cancel, Your own cases). The Guard item is not offered to a page that is not on this computer; such a page sees "Change the guard on the computer that runs omp-webui".
- **Header guard switch** (conversation header, eye icon): turns the guard Off for this conversation alone, and back on to what it was under before (its own mode, or following Settings). Disabled on a page that is not on this computer ("It is switched on the computer omp-webui runs on").
- **Per-conversation guard**: the session panel's **This session** section ("Guard: …" picker with Follow Settings / own values, "Use Settings' value"), and **New chat › Options** before the first message.
- A notice "No reviewer could be reached" appears when risky calls are being refused unjudged, with **Ask me instead**, **Safety settings** and **Dismiss**.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `guard.json:mode` | `off`, `reviewer`, `ask` | `reviewer` | Global guard mode for every conversation that does not choose its own. A missing or invalid value reads as the default, so a damaged file never turns the guard off. |
| `guard.json:reviewer` | Blank, or one or more `provider/model` selectors separated by commas; at most 512 characters, no control characters | `""` (automatic) | Which model(s) review flagged calls; the first reviews, the rest are fallbacks in order. Only used in `reviewer` mode. |
| `guard.json:askWhenUnavailable` | `true`, `false` | `true` | When no reviewer can be reached: `true` asks the user about the main agent's call (if a page can be asked); `false` refuses it as "reviewer unavailable". |
| `guard.json:askWhenDenied` | `true`, `false` | `true` | When the reviewer denies a call: `true` shows the user the reason and lets them run the main agent's call anyway; `false` makes the denial final. |
| `ompw.guardBefore` | JSON object: conversation (session file or process id) → `reviewer`, `ask` or `follow`; at most 40 remembered, most recent last | unset | Synced UI preference. What each conversation's guard was under before the header switch turned it off, so the switch can turn it back on to the same choice. |

Other guard data, kept in the same `guard.json` file and changed on the Guard page:

| Stored in | Field | Values | Default | Effect |
|---|---|---|---|---|
| `~/.omp-webui/guard.json` | `policy` | `{ text, basedOn }`, text up to 6,000 characters | absent (default rules, version 6) | The reviewer's rules. |
| `~/.omp-webui/guard.json` | `thresholds` | kind → `allow`, `ask`, `block` (floors apply) | every kind `ask` | How strict, by kind of call. |
| `~/.omp-webui/guard.json` | `cases` | list of own benchmark cases (command up to 2,000 chars, name up to 120, expect harmful/harmless) | none; max 50 | Your own benchmark cases. |

A per-conversation choice is kept with the conversation (not in `guard.json`). The environment variable `OMP_WEBUI_GUARD_CONFIG` overrides the path of the settings file.

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/guard` | GET, POST | local-only | GET returns `{ config }` (mode, reviewer, askWhenUnavailable, askWhenDenied). POST takes a partial object of those fields; unknown fields or invalid values are refused (400). Every running gate is updated at once. |
| `/api/guard/live` | POST | local-only | Change one running conversation's own guard: body `{ liveId, guard }` where `guard` is a partial override (a field set to `null` follows Settings again) or `null` to follow Settings entirely. 404 if the process is not found, 409 if it is not running. |
| `/api/guard/rules` | GET, POST | local-only | GET returns `{ rules, defaults }` (the user's policy, thresholds, cases, and the shipped defaults, floors and limits). POST takes `{ policy?, thresholds?, cases? }`: `policy: null` restores the default rules, a threshold set to `null` is Ask again, `cases` replaces the whole list. |
| `/api/guard/bench` | GET, POST | local-only | GET returns the current/last benchmark run. POST `{ reviewer: true\|false }` starts a run (409 if one is already running). |
| `/api/guard/bench/cancel` | POST | local-only | Cancel the running benchmark. |
| `/api/guard/bench/preview` | POST | local-only | Body `{ thresholds }`: what a threshold change would let through, tried on the shipped harmful cases with the classifier only (used by the Allow confirmation). |
| `/api/guard/log` | GET | local-only | A page of the decisions log, newest first. Query: `limit` (1–1000, default 200), `before` (decision id cursor), `outcome` (`allowed`, `asked`, `blocked`), `by` (`classifier`, `reviewer`, `person`, `guard`), `q` (text search, first 200 chars), `conversation` (transcript file). Returns `{ decisions, total, matched, next }`. |
| `/api/guard/decisions` | GET | local-only | The decisions (up to 500, newest first) for one agent: query `file` (transcript file) or `session` (session id); one is required. |

## Limits and caveats

- Best effort, not a sandbox: it judges a call from the command, code or paths it names before the tool runs, and can be wrong in both directions. It does not see what a program does once it runs, nor what the user types in a terminal.
- Every reviewer call uses tokens on the same quota as the user's conversations.
- A conversation whose omp process started before the guard (or under another server) is not covered; the conversation shows a notice with **Open it again**.
- In Ask me mode, or when asking on unavailable/denied, the user is asked only if a page can reach them; a subagent's call is refused instead.
- The decisions log is `~/.omp-webui/guard/decisions.jsonl`; pages read only its last 2 MB, and it is moved aside to `decisions.jsonl.1` (replacing the previous one) beyond 8 MB.
- The benchmark run with the reviewer is limited to 120 reviewer requests; a classifier-only run sends nothing to a model.

## Security notes

- All `/api/guard*` routes are local-only: refused (403) to any page not on this computer (tunnel, network address, proxy), whatever token it holds. A remote page cannot see the decisions, rules or settings, cannot switch a conversation's guard (header switch, This session or the WebSocket), and starts new conversations under the global settings.
- `guard.json` is written with mode `0600`. The server's memory is authoritative: if the file is changed outside Settings (for example by an agent), it is rewritten from memory at the next check, so the guard cannot be turned off or loosened by editing the file. Only an import from Move to another computer is adopted as-is.
- The guard refuses calls that name its own settings or log, and the reviewer is told the guard's settings, state and API are off limits.
- Agents must not change guard settings, rules or thresholds, or switch a conversation's guard off, on the user's behalf unless the user explicitly asks; the gate is designed to refuse such attempts.
- The rules, thresholds and own cases move with Move to another computer.
