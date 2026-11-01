---
title: Restarting a wedged conversation (restart_session)
summary: The main agent's tool to end its own omp process and continue in a fresh one, and the person's Force restart.
settings:
---

# Restarting a wedged conversation (restart_session)

## What it does

`restart_session` lets a conversation's **main agent** recover by itself, without the person, from an omp process that is wedged in a way it cannot undo from inside: `bash` calls that hang while other tools still answer, background jobs that became runaway threads of omp's own process. The agent's omp is ended together with everything it started, and the same conversation goes on in a fresh process, which is sent what the agent asked to do next.

Arguments (JSON):

| Argument | Required | Meaning |
|---|---|---|
| `reason` | yes | Why, in one short line (at most 200 characters). The person sees it in the conversation. |
| `continue_with` | yes | What to do in the new process; it arrives there as a message (at most 4,000 characters). Write it so that doing it twice is harmless ("check whether X finished, then continue with Y"): it can arrive again after a crash of the server. |
| `force` | no | `true`: running subagents end with the process. Without it the restart is refused while subagents run. |

What happens:

1. The call returns at once and tells the agent to end its turn (one short line, no more tool calls). The server writes a request record and every page shows *Restart asked for by the agent (reason): the process is restarted when this turn ends* above the message box.
2. When the main agent's turn ends — not when the conversation is idle: a background job keeps it busy forever, and that is what the restart ends — or two minutes after the call (the turn is then aborted), the server checks that nothing the person would miss is cut off.
3. The process is ended: omp's stdin is closed, then SIGTERM after a short grace, then SIGKILL; the server confirms omp has exited (there is never a second omp on one session file), then kills what omp started that is still running (background `bash` and `eval` jobs, dev servers, MCP servers), each matched by its identity, not its bare pid.
4. The same session file is resumed in a new process (same mode, same per-conversation settings, guard, guidance, unattended mode, parallel subagents), and the server sends `continue_with` as a user message whose first line names the request: `[omp-webui restart r-…] Restarted by the agent: <reason>`. The message says it was written by omp-webui from the agent's own request, not by the person. The conversation shows it as a divider, *Restarted by the agent: reason*, with what the agent asked to do next behind it.

Everything the old process started ends: background `bash`/`eval` jobs, dev servers, MCP servers, `eval` state. The history, the todos and the goal are kept.

### Refusals

The restart is refused, and the agent is told why as a message in the conversation (`[omp-webui restart-refused r-… <why>] Restart refused: …`, shown as a divider):

| Why | When |
|---|---|
| `asking` | A question or approval waits for the person. |
| `paused` | The person paused the conversation. The page says so at once; the agent is told when the conversation is resumed. |
| `subagents` | Subagents run, and the call did not say `force`. |
| `subagentsUnknown` | omp did not say whether subagents run, and the call did not say `force`. |
| `rateLimit` | Three restarts the agent asked for in the last hour already (per conversation; kept across a restart of the server). The tool itself returns this as an error once the limit is known. |

## Where it is

- The tool is the agent's; a person sees its call in the conversation like any other.
- **This session › Restart the process › Force restart** (the session controls panel): the person's own restart. It asks once, aborts the turn that runs and restarts the process on the same path, with no message unless the agent had asked for a restart that still waits (then its message is sent). A paused conversation is refused: resume it first. The conversation shows *Force-restarted: the conversation goes on in a new omp process* until the new process's first turn.

## Settings

None. The tool is offered to every conversation the server started, main agent only; a subagent never has it.

## API routes

None of its own. The page's Force restart is the WebSocket message `force_restart` (`{ liveId }`, answered with the new process's `{ liveId }`), allowed from a remote page like Stop.

## Limits and caveats

- Delivery of `continue_with` is at least once. Before sending, the server looks for the request's id in the session file and skips the message when omp has it already; a server that stops between handing the message to omp and omp writing it to the session file can send it again. That window is small, and is why `continue_with` must be safe to do twice.
- A server that crashes in the middle of a restart finishes it when it starts again (the request records are in `<data dir>/restart/requests/`). A request that still waited for its turn when the person quit the app is not made.
- A conversation started with the person's own `--trusted-extension` flag has no `restart_session` (omp refuses `--extension` with it), and neither has a Light conversation (it offers the model exactly the tools Settings › Full / Light allows). Force restart still works in both.
- If omp does not end even after SIGKILL, the restart fails and the conversation says so; the old process goes on.

## Security notes

- The tool sends nothing to the server and holds no credential: the server acts on the call it sees in the conversation's event stream. The only file the extension reads is the limit the server writes for its process (`OMPW_RESTART_FILE`).
- The continuation message is role user but is the agent's own words relayed by the app, and it says so; it is not the person's approval of anything.
