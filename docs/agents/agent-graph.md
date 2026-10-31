---
title: Agent graph and subagents
summary: The Agent graph page (who started whom, task-call batches, messages between agents, live) and the conversation's Agents tab with each subagent's live view, Stop and full screen.
settings:
---

# Agent graph and subagents

## What it does

omp's main agent can start subagents (omp's `task` tool); a subagent can start its own. omp-webui shows them in two places.

**Agent graph page.** At the left, the conversations whose omp process is running ("Conversations with a running omp process"); on the right, the chosen conversation's agents as a graph: the main agent (*working* / *idle*), each subagent as a card, who started whom (*Started* edges), the subagents one task call started together (*One task call: N subagents*), and the messages agents wrote to each other (*Message* edges, and messages to every agent). It updates live while the process runs. Clicking a subagent opens its live view beside the graph; *Open the conversation* goes to the chat.

- Status colours (*Legend*): *Running*, *No activity for 2 min* (stalled: a running subagent that has said nothing for 2 minutes; one waiting for a retry is not stalled), *Done*, *Failed or stopped*.
- *Totals*: subagents, how many run, how many are stalled; each card shows tokens and tools.
- Large conversations stay readable: a finished batch collapses to one card (*N done*, *N ended*, *N nested*; *Show these subagents* opens it in place, *Collapse N subagents* folds it), a zoomed-out graph draws compact cards, and the toolbar has:
  - **Status** filter: *All* / *Running* / *Failed*; **Started** filter: *All* / *Last hour* / *Today*; **Find a subagent** (*Find by name*, shows "N of M");
  - **Grid siblings**: lay out the subagents of one parent in a grid instead of a row;
  - **Focus & minimap**: a focus view that follows what runs, with a minimap of the rest;
  - *Zoom in*, *Zoom out*, *Fit to view*. On a narrow window the filters are behind *Filters* ("N on").
- The toolbar choices are one choice for every conversation's graph and are synced to every page.

**Agents tab** (side panel of a conversation): the conversation's subagents, running ones first. Opening one shows its live view: tokens, cost and time, its assignment, its transcript as it streams, the tools it is running with their output so far, a box to steer it, and a retry countdown when it waits for a retry (for a usage limit: until the reset).

- **Stop** (in the list, the live view's header, and on a task card): stops one running subagent (omp's `cancel_subagent`); it ends as aborted and the rest of its task call goes on. While a subagent waits for a retry, the Stop button is split and its menu has **Stop and continue** (stop it, then ask the main agent to continue its work).
- **Full screen**: a subagent's live view over its conversation, at `#/s/<file>/agent/<id>` (reload and Back/Forward keep it), with a switcher of the conversation's subagents (Alt+L), previous / next (Alt+Up / Alt+Down), and a way to pop it out into a window of its own.

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

Which models subagents use is set elsewhere: model roles and presets (`models`) and model guidance (`model-guidance`).

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/subagents?file=<session file>` | GET | token | The subagents of one conversation, with what each spent; cheap to ask again while some are still writing. 404 for an unknown session file. |

The graph's live updates, the Agents tab's live view, Stop (`cancel_subagent`) and steering go over the conversation's WebSocket. The conversation's whole lineage is `/api/family` (see `conversations`).

## Limits and caveats

- The graph shows a conversation only while its omp process runs ("The graph shows a conversation's agents while its omp process runs"); a finished conversation's subagents are still in its Agents tab and transcript.
- The page listens to the chosen conversation's process only.
- Stop does not undo what a subagent already did; it ends that subagent alone.
- *Stalled* is a hint (2 minutes without output), not a failure: a long tool call can be silent.

## Security notes

- Read-only views of the person's own conversations; they need the access token and are available to a remote page that holds it, as the conversations are.
- Stopping or steering a subagent acts on the person's running work; an agent should not do it on their behalf unasked.
