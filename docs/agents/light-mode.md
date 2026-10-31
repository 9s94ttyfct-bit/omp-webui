---
title: Full / Light mode
summary: Full runs omp as configured; Light starts omp with only the chosen tools, MCP servers and skills to keep the context window small, on the user's own models or on a local model server (oMLX, Ollama, LM Studio).
settings: mode
---

# Full / Light mode

## What it does

The mode belongs to each omp process, not to the app: one conversation can run in Full while another runs in Light.

- **Full**: omp as the user has set it up (models, tools, MCP servers, skills, plugins, `AGENTS.md`).
- **Light**: omp is started with only what Settings › Full / Light ticks: built-in tools passed as `--tools` (default `read, bash, edit, write, grep, glob, todo`; also offered: `ask`, `eval`, `lsp`, `task`, `wait`, `debug`), only the ticked MCP servers of the user's `mcp.json` (default `rea`), only the listed skills (default `reverse-engineer-anything`; names or globs such as `git-*`; empty means none), no plugins, project `.mcp.json` files ignored, and the user's own `AGENTS.md` only when ticked (a project's `AGENTS.md` is always read). This leaves more of the context window for the work.

**Light's models**:

- **Your models** (`yours`, default): the user's `models.yml`, model roles, thinking level and logins, as Full uses them.
- **Local server** (`local`): every model role runs on one local server: **oMLX** (needs a provider named `omlx` in omp's `models.yml`, with its address and API key), **Ollama** (default `http://127.0.0.1:11434/v1`) or **LM Studio** (default `http://127.0.0.1:1234/v1`). Ollama and LM Studio need nothing in `models.yml`; if it has a provider of that name, its API key and model settings are used. The address can be changed in Settings (for Light only). The model is one the server serves, or Automatic (the first it serves), with its own thinking level. Such a conversation has no presets, refuses command-line flags that pick another provider's model, and its quota pill is the local backend's.

To list a backend's models the server asks `GET <address>/models` (OpenAI format); when Ollama does not answer that, it asks Ollama's own model list at `/api/tags` on the same host. That is Ollama's endpoint, not one of omp-webui's.

Light processes run with an agent directory of the web UI's own (`offline-agent/<revision>` in the data folder), built from the user's files for each configuration and never changed afterwards; sessions, history and images are links to the user's, so Light conversations show in the history and open in Full too.

**Choosing.** The mode of *new* conversations is one choice kept by the server (`mode.json`) and followed by every tab: the **Full / Light** chip in New chat's footer, or Settings. An open conversation keeps the mode its process started in; its *This session* settings can switch it, which restarts its omp on the same session file (it waits while a turn runs). A conversation started in Light shows a **Light** (or **Light · local**) badge.

**Context measurement.** Settings shows how many tokens a fresh conversation of each mode starts with (measured with omp's `/context` in a new process of each mode), broken down into system prompt, tool definitions, context files and MCP notes, and skills, with **Measure again**.

## Where it is

- **Settings › Models & accounts › Full / Light** (`#/settings/models`): **Mode of new conversations** (Full / Light), **Light's models** (Your models / Local server), **Local server** section (Local model server, address, model, Thinking level, "Check again"), **What Light loads** (MCP servers, Tools, Skills, **Also load my AGENTS.md**), and **Context at the start of a conversation**.
- New chat footer: the **Mode** chip (Full / Light).
- A conversation's *This session* settings: switch its mode.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `mode.json:mode` | `full`, `light` | `full` | Mode of new conversations. |
| `mode.json:lightModels` | `yours`, `local` | `yours` | What Light runs on: the user's own models, or a local server's. |
| `mode.json:offline.backend` | `omlx`, `ollama`, `lm-studio` | `omlx` | The local server Light uses when `lightModels` is `local`. |
| `mode.json:offline.baseUrls` | object `{ omlx, ollama, "lm-studio" }`, each an http(s) address or `null` | all `null` | Each backend's address for Light; `null`: the `baseUrl` of that provider in `models.yml`, else the backend's default. Link-local addresses (cloud metadata) are refused; an address that is not on this computer or its network is accepted with a warning. |
| `mode.json:offline.model` | `<backend>/<id>` or `null` | `null` | The local server's model; `null`: the first it serves. |
| `mode.json:offline.thinking` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto` | `medium` | Thinking level on the local server. |
| `mode.json:offline.tools` | list of `read`, `bash`, `edit`, `write`, `grep`, `glob`, `todo`, `ask`, `eval`, `lsp`, `task`, `wait`, `debug` | `read, bash, edit, write, grep, glob, todo` | Built-in tools of a Light process (`--tools`). |
| `mode.json:offline.mcp` | list of MCP server names from the user's `mcp.json` | `["rea"]` | MCP servers a Light process loads. One that is no longer in `mcp.json` is listed as missing (with "Remove from the list"); one switched off in omp is not loaded. |
| `mode.json:offline.skills` | list of skill names or globs | `["reverse-engineer-anything"]` | Skills a Light process loads (`skills.includeSkills`); empty: none. |
| `mode.json:offline.agentsMd` | `true`, `false` | `false` | Also load the user's own `AGENTS.md` from omp's agent folder. |

`mode.json` is in the data folder, mode 0600, `{ "version": 2, "mode", "lightModels", "offline": { … } }`. A file from an earlier version (modes `online` / `offline`) is read as Full with Your models / Light on a local server and rewritten; a file that cannot be read means the defaults.

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/mode` | GET, POST | token | GET: `{ mode, lightModels, offline, mcpServers, mcpOff, missingMcp, backends: { <backend>: { baseUrl, source, error? } }, boot, rev }`. POST: a patch `{ mode?, lightModels?, offline? }` (unknown fields refused, 400); switching to Light on a local server checks the backend's provider first. Every tab is told the new state. |
| `/api/offline/models` | GET | token | Query `backend` (optional, default the chosen one): `{ backend, baseUrl, models }`, the models that server serves. 502 when it cannot be reached. |
| `/api/offline/context` | POST | token | Measure the starting context of a fresh Full and Light process: `{ full, light }`, each a breakdown or an error. Query `force=1` measures again even when nothing changed. |

## Limits and caveats

- Changing the mode affects conversations started afterwards; open ones keep theirs until switched.
- Light on a local server can only use that server's models; flags naming another provider's model are refused, and model presets are not available.
- A `config.yml` that cannot be read stops a Light start (defaults would not be the user's models).
- An MCP server that had not finished starting when the context was measured may be missing from the figure.
- omp reads its configuration only from its agent directory, which is why Light uses directories of its own; they are not edited afterwards.

## Security notes

- A local server address that is not on this computer or its local network sends every prompt and the files it reads there; Settings warns about it. An API key from `models.yml` is sent only to the host `models.yml` names for it. Link-local and cloud-metadata addresses are refused.
- Light's agent directory copies `models.yml` and `mcp.json` privately (0600) and links logins rather than copying them.
- `/api/mode` is open to any page with the token, including remote ones. Agents should change the mode or Light's settings only when the user asks.
