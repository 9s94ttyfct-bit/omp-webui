---
title: The webui_docs tool
summary: A read-only tool every conversation's main agent has, to list, search and read this documentation.
settings:
---

# The webui_docs tool

## What it does

`webui_docs` lets an agent running in omp-webui answer questions about omp-webui itself from this documentation (`docs/agents/`) instead of guessing. It has three actions, given as the tool's JSON arguments:

| Action | Arguments | Answer |
|---|---|---|
| `list` | none | Every topic: its name, title and one-line summary. |
| `search` | `query` (keywords), optional `limit` (1–30, default 10) | The sections that contain **every** keyword (case-insensitive), best first, each with the line that shows the match. |
| `read` | `topic` (a name from `list`, `.md` optional), optional `section` (a heading, its anchor, or a unique part of it) | The topic without its front matter, or that section with its subsections. At most 60,000 characters. |

Examples: `{"action":"list"}`, `{"action":"search","query":"remote shell"}`, `{"action":"read","topic":"guard","section":"Settings"}`.

A question it cannot answer is the tool's error, with what to do instead: an unknown topic lists the topics, an unknown section lists the sections, an empty query or an unknown action says what is required.

### How it reaches the agent

omp-webui starts every conversation's omp with a small extension of its own (`--extension <data dir>/webui-docs/server/omp/docs-tool/extension.ts`), beside its other extensions (the guard's gate, model guidance, unattended mode, the quota floor, compact between steps). The extension registers the tool with omp's extension API (`pi.registerTool`) as **discoverable**: omp mounts it at `xd://webui_docs` and lists it with a one-line summary among the devices of the system prompt; the agent reads `xd://webui_docs` for its schema and calls it by writing its JSON arguments to `xd://webui_docs`. When omp's `tools.xdev` setting is off, omp offers it as an ordinary top-level tool named `webui_docs` instead.

The documentation is compiled into the server (a Bun macro reads `docs/agents/*.md` when the server is built), so the packaged macOS app carries it with no `docs/` folder. When a conversation starts, the server writes the extension, its lookup and the docs (as a module, `docs-data.ts`) under `<data dir>/webui-docs/`, rewriting a file only when it changed; an update of the app brings its docs along.

## Where it is

Nowhere in the UI: it is a tool of the agent. A person sees its calls in the conversation like any other tool call. The *Loaded in this chat* dialog (`/status`) lists it among the tools mounted at `xd://`.

## Settings

None. The tool is always there for a conversation the server started, and changes no setting.

## API routes

None. The tool does not talk to the server.

## Limits and caveats

- It answers from the docs of the omp-webui version the conversation's omp was started by: after an update, a conversation started before keeps the docs it loaded until its omp is restarted.
- A conversation started with the person's own `--trusted-extension` flag has no `webui_docs` (omp refuses `--extension` together with `--trusted-extension`), and neither has the gate nor the other extensions.
- A process this server did not start (one taken over from an earlier server that started it without the extension) has it only from its next start.
- The main agent has it. Whether a subagent has it is omp's choice of which extension tools a subagent is offered.
- The docs are English only, by choice: one language keeps them exact and searchable, and agents answer the person in their language anyway.
- The docs describe the app; they are not a substitute for reading the person's actual settings. To know what *this* installation has set, look at the UI or ask the person; the server's settings routes are listed per topic, and many of them are local-only.

## Security notes

- Read-only by construction: the extension imports nothing but its lookup and its docs module. It opens no file, starts no process, makes no network request, writes nothing and holds no credential. A topic is looked up by name in that module; a name that is not a topic's (a path, `..`, `/etc/passwd`) is refused before any lookup.
- Its approval tier is `read`, so no permission mode stops the agent to ask about it, and the guard has nothing to review.
- Documentation tells an agent where a setting is and what it does; it does not entitle the agent to change it. An agent must not change guard, remote-access, memory or update settings for the person unless the person asks, and the local-only routes refuse any page that is not on the computer omp-webui runs on whatever token it holds.
