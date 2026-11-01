---
title: Agent graph and subagents
summary: The Agent graph page (who started whom, task-call batches, messages between agents, live), the conversation's Agents tab with each subagent's live view, Stop and full screen, and how many subagents run at once (Parallel subagents, queued ones).
settings: subagent-concurrency
---

# Agent graph and subagents

## What it does

omp's main agent can start subagents (omp's `task` tool); a subagent can start its own. omp-webui shows them in two places.

**Agent graph page.** At the left, the conversations whose omp process is running ("Conversations with a running omp process"); on the right, the chosen conversation's agents as a graph: the main agent (*working* / *idle*), each subagent as a card, who started whom (*Started* edges), the subagents one task call started together (*One task call: N subagents*), and the messages agents wrote to each other (*Message* edges, and messages to every agent). It updates live while the process runs. Clicking a subagent opens its live view beside the graph; *Open the conversation* goes to the chat.

- Status colours (*Legend*): *Running*, *No activity for 2 min* (stalled: a running subagent that has said nothing for 2 minutes; one waiting for a retry is not stalled), *Done*, *Failed or stopped*, *Queued* (dashed: spawned, waiting for a slot under *Parallel subagents*).
- *Totals*: subagents, how many run, how many are stalled, how many are queued; each card shows tokens and tools.
- With *Live animations* on (Settings › Look & layout › Appearance; off by default, see the appearance topic), particles run along the lines as this page sees it happen: down a *Started* line when an agent starts another, along a *Message* line when one writes to another, and back up the *Started* line (green) when a subagent finishes well (from a finished batch's card when its batch folds into one). At most 12 lines move per update; nothing moves while nothing happens, and nothing starts while the page is hidden.
- Large conversations stay readable: a finished batch collapses to one card (*N done*, *N ended*, *N nested*; *Show these subagents* opens it in place, *Collapse N subagents* folds it), a zoomed-out graph draws compact cards, and the toolbar has:
  - **Status** filter: *All* / *Running* / *Failed*; **Started** filter: *All* / *Last hour* / *Today*; **Find a subagent** (*Find by name*, shows "N of M");
  - **Grid siblings**: lay out the subagents of one parent in a grid instead of a row;
  - **Focus & minimap**: a focus view that follows what runs, with a minimap of the rest;
  - *Zoom in*, *Zoom out*, *Fit to view*. On a narrow window the filters are behind *Filters* ("N on").
- The toolbar choices are one choice for every conversation's graph and are synced to every page.

**Agents tab** (side panel of a conversation): the conversation's subagents, running ones first. Opening one shows its live view: tokens, cost and time, its assignment, its transcript as it streams, the tools it is running with their output so far, a box to steer it, and a retry countdown when it waits for a retry (for a usage limit: until the reset).

- **Stop** (in the list, the live view's header, and on a task card): stops one running subagent (omp's `cancel_subagent`); it ends as aborted and the rest of its task call goes on. While a subagent waits for a retry, the Stop button is split and its menu has **Stop and continue** (stop it, then ask the main agent to continue its work).
- **Full screen**: a subagent's live view over its conversation, at `#/s/<file>/agent/<id>` (reload and Back/Forward keep it), with a switcher of the conversation's subagents (Alt+L), previous / next (Alt+Up / Alt+Down), and a way to pop it out into a window of its own.

**Parallel subagents** (omp's `task.maxConcurrency`): how many subagents one conversation runs at once. A task call that starts more makes omp queue the rest; each starts when a running one ends. Queued subagents are listed after the running ones with a *queued* badge (their live view says why; there is nothing to stop or steer until omp starts them). The limit is omp's own setting, set in Settings › Models › *Parallel subagents* (`omp config set`, shared with the terminal; *Default* is omp's default, 32), and per conversation in its session settings › Advanced (*Default (N)* follows omp's configuration for the folder; *Unlimited* starts every subagent at once). A change applies to the next subagent that starts, without restarting omp.

## Where it is

- Sidebar (or rail) page **Agent graph** (network icon; `#/agents`, or `#/agents/<session file>` for one conversation). Its place can be changed or hidden in Settings › Look & layout › Sidebar and rail.
- A conversation's side panel › **Agents** tab (top pane by default).
- A task tool card in the transcript: its subagents' Stop controls while they run.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.agentGraph.grid` | `on`, `off` | unset: `off` | Synced preference. *Grid siblings*: subagents of one parent laid out in a grid. |
| `ompw.agentGraph.focus` | `on`, `off` | unset: `off` | Synced preference. *Focus & minimap*: the focus view that follows what runs, with a minimap. |
| `ompw.agentGraph.status` | `all`, `running`, `failed` | unset: `all` | Synced preference. The graph's *Status* filter. Any other stored value reads as `all`. |
| `ompw.agentGraph.time` | `all`, `hour`, `today` | unset: `all` | Synced preference. The graph's *Started* filter (*All*, *Last hour*, *Today*). Any other stored value reads as `all`. |
| `omp:task.maxConcurrency` | `0` (no limit) or a whole number; the app writes 0–16 | `32` (omp's default) | How many subagents run at once; the rest wait in omp's queue. Written globally with `omp config set` (Settings), or per conversation as a `task.maxConcurrency` line in its process's `--config` overlay (session panel; omp reloads it by itself). |

Which models subagents use is set elsewhere: model roles and presets (`models`) and a conversation's guidance (`model-guidance`).

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/subagents?file=<session file>` | GET | token | The subagents of one conversation, with what each spent; cheap to ask again while some are still writing. 404 for an unknown session file. |
| `/api/subagent-concurrency` | GET, POST | token | GET returns `{ omp, session }`: omp's configured limit (`0` is no limit; null when omp could not be asked) and, with `?file=<session file>`, the limit that conversation chose for itself (or null). POST `{ limit }` sets omp's own limit: 0–16, or `null` for omp's default again; anything else is 400. |
| `/api/subagent-concurrency/session` | POST | token | Body `{ file, limit }`: one conversation's own limit (0–16; null: follow omp's configuration again). The session file need not be written yet. 404 for an unknown file, 400 for a bad limit, 409 when it cannot be applied. Answers `{ omp, session }`. |

The graph's live updates, the Agents tab's live view, Stop (`cancel_subagent`) and steering go over the conversation's WebSocket, as does which subagents wait in omp's queue (`LiveInfo.queuedSubagents`, from omp's own progress records of the task call; a conversation's own limit is `LiveInfo.subagentConcurrency`). The conversation's whole lineage is `/api/family` (see `conversations`).

## Limits and caveats

- The graph shows a conversation only while its omp process runs ("The graph shows a conversation's agents while its omp process runs"); a finished conversation's subagents are still in its Agents tab and transcript.
- The page listens to the chosen conversation's process only.
- Stop does not undo what a subagent already did; it ends that subagent alone.
- *Stalled* is a hint (2 minutes without output), not a failure: a long tool call can be silent.
- A queued subagent cannot be stopped on its own: omp's `cancel_subagent` needs a running one. Running subagents go on when the limit is lowered.
- Some providers have a limit of their own on requests at once (Ollama Cloud's `providers.ollama-cloud.maxConcurrency`), which applies on top of this one.

## Security notes

- Read-only views of the person's own conversations; they need the access token and are available to a remote page that holds it, as the conversations are.
- Stopping or steering a subagent acts on the person's running work; an agent should not do it on their behalf unasked.
