# Run commands on another computer — design

Status: proposed, 2026-11-10. A project; full design.

## Intent

The person runs omp-webui on this Mac, which has the stronger models, and also on other computers they manage (servers),
each reached through its own Cloudflare tunnel behind Cloudflare Access. Today they can already open a remote computer's
page from this Mac (the Macs list, a remote window in the macOS app) and type commands into its Terminal by hand.

They want this Mac's agent to do that: run commands on a chosen remote computer, mainly for server administration, while the
model, the conversation and its approval stay on this Mac.

## What it is for (the person's words)

- "用我这台电脑的客户端 agent 在另一台电脑的客户端执行命令，主要用于服务器管理等，因为我这台电脑可以访问更强大的模型."
- "直接用已有的远程连接": reuse the existing remote connection (tunnel + Access + the remote computer's Terminal), not SSH and
  not a new kind of credential.
- Sign-in: option 1, reuse the macOS app's existing sign-in to that computer.
- Turned on per conversation, choosing its computers; calls follow the conversation's approval mode; pages signed in
  through Access may use it like this Mac's own page.

Calls made by the designer (the person may correct them): one fresh login shell per call; output tail 64 KB; time limit
120 s default, 3600 s max; sign-in kept in memory only and handed over by the app only from this Mac; the guard reads
remote commands with no safe folder; conversations already holding server tools ("Set up with AI", "Ask agent for help")
are left out; Windows remote computers refused for now.

## Goals

- A conversation on this Mac can run a shell command on a remote computer from this Mac's Macs list and get back its output
  and exit code.
- Nothing changes on the remote computer: it serves the call exactly as it serves its Terminal to the person's own page
  signed in through Access (v0.22.5 and later).
- The person turns it on **per conversation** and chooses which saved computers that conversation may use. Off in every
  conversation by default; other conversations cannot reach any remote computer.
- Calls follow the conversation's approval mode, like `bash`; the guard on this Mac still holds back high-risk commands.
- The person's own pages (this Mac's, and one signed in through Access, e.g. a phone) may turn it on and approve calls.

## Non-goals

- SSH, or computers that run no omp-webui.
- Cloudflare Access service tokens or any stored Cloudflare credential.
- Interactive programs (an editor, a password prompt, `top`): a command gets no input after it starts.
- File upload/download tools; the agent uses shell commands (`cat`, heredocs) instead.
- Windows remote computers (their Terminal is PowerShell/cmd). Refused with a clear message for now.
- Running a remote computer's own agent or conversations.

## Anti-goals (a failure even if it works)

- A credential (the Access cookie, the remote app cookie) written to disk by the server, sent to a page, put in a tool's
  arguments or results, or kept in the session file.
- A page that is not the person's own (holds only the token) able to make this Mac run commands on another computer.
- Agents able to turn it on for a conversation or add computers to it.

## Constraints (verified)

- The remote computer's Terminal: the page's WebSocket sends `pty_open` with `shell: true` (a login shell in the given
  folder), `pty_input`, `pty_kill`; the server answers `pty_data` and `pty_exit` (`server/main.ts` `pty_open` …,
  `server/pty.ts`). A page signed in through Access is the person's own and may always open a shell (v0.22.5).
- A remote request must be addressed to the configured hostname, name no other origin (`Origin` must be
  `https://<hostname>` when present), and carry the Access JWT (`CF_Authorization` cookie). With the JWT alone, `GET /`
  answers 200 and sets the app's own cookie `ompw_token`; the API then needs both (`tests/e2e/remote-flow.spec.ts`
  222–237).
- The macOS app keeps each remote computer's sign-in in its own `WKWebsiteDataStore`; the server cannot read it
  (`macos/remotewindow.swift`). `remote-macs.json` holds `storeId` and `team` (`server/saved-macs.ts` 130–139); the app works
  out the store from them (the team's store when the team is known, else the computer's own, `macos/remotemacs.swift`
  155–173). The list itself is the server's `<data dir>/remote-macs.json`, with no secret in it.
- The server already gives a conversation tools it answers itself over that conversation's omp pipe
  (`Live.serveHostTools`, `server/omp/host-tools.ts`; example `server/remote-ai.ts`). A conversation holds one such set
  (`hostServer`), and its tool policies are fixed when its omp process starts (`server/live.ts` ~4629–4636). Tool calls with
  a `command` field are classified by the guard's shell rules (`shared/remote-risk.ts` `classify`), which run inside omp's
  process and read paths against this Mac's home, temp and protected folders.
- `/api/macs*` is owner-only, which lets pages signed in through Access in too (`server/this-computer.ts` 57–72); there is
  no local-only route list. `/api/meta` carries no OS; `/api/diagnostics` does.
- The terminal's `cwd`, when it does not exist, quietly becomes the home folder (`server/pty.ts` 7–9).
- This Mac's default approval mode is `yolo` (Auto-approve).
- This Mac's list has one remote computer today, a real server ("Server1"), used for the live check.

## Constraints (not yet verified; first step of the build)

- `WKHTTPCookieStore.getAllCookies` on that data store returns the `CF_Authorization` cookie (it is HttpOnly) for the host.
- Bun's `WebSocket` client to `wss://<host>/…` with `Cookie` and `Origin` headers passes Cloudflare Access and the remote
  server's checks.
- The JWT's lifetime (the Access application's session duration) is long enough to be useful; when it lapses, Access
  answers a redirect and the call must say "sign in again".

## Approaches

1. **SSH** (omp has SSH host settings, `omp ssh add`). Standard for servers, but needs the server reachable over SSH from
   this Mac and is not the existing connection. Dropped: the person asked to reuse the existing remote connection.
2. **Existing remote connection, the app's sign-in** (chosen). This Mac's server connects to the remote computer's own
   page WebSocket through its tunnel, with the Access cookie the macOS app already holds, and runs the command in a login
   shell there. No change on the remote computer or in Cloudflare. Costs: the sign-in lapses with the Access session
   (24 h by default, up to a month) and is renewed by opening that computer's window; macOS app only.
3. **Existing remote connection, an Access service token.** No lapse, but a secret stored on this Mac, a Cloudflare
   dashboard step, and the remote server must learn to accept service tokens (both computers upgraded). Dropped by the
   person's choice.

## Design

### Sign-in handoff (macOS app → this Mac's server)

- The app reads `CF_Authorization` for each saved computer's host from that computer's data store (worked out from
  `storeId`/`team` as the remote window does) and posts it to this Mac's server: `POST /api/macs/<id>/sign-in` `{ jwt }`;
  `DELETE` when it is gone.
- That route answers **only this computer's own app/page** (a loopback request that did not come through the tunnel), not a
  page signed in through Access: `/api/macs*` is owner-only, so the route checks this itself.
- The app does this at server start and when the store's cookies change (`WKHTTPCookieStoreObserver`), e.g. after the
  person signs in again in that computer's window.
- The server keeps it **in memory only**, per computer, with its expiry read from the JWT's `exp`. It is never written,
  logged, or sent to a page. Pages see only the state: "Signed in until <date>" / "Open its window to sign in".

### Running a command (this Mac's server → remote computer)

- `GET https://<host>/` with the JWT → read `ompw_token` from `Set-Cookie` (kept in memory beside the JWT; renewed on 401).
- Open `wss://<host>/<the page WebSocket path>` with `Cookie: CF_Authorization=…; ompw_token=…` and
  `Origin: https://<host>`.
- `pty_open` `{ shell: true, cols: 200, rows: 50 }`; write the command wrapped in begin/end markers carrying a random nonce
  and `$?`, written so the shell's echo of the line cannot match them; collect `pty_data` between the markers, strip
  terminal escapes; then `pty_kill` and close.
- One fresh login shell per call (no state carried between calls; a stuck call cannot affect the next). `cwd` is a
  parameter, entered by the wrapper itself (`cd -- <cwd>`), and the call fails with a clear error when it does not exist
  (the terminal's own `cwd` would quietly fall back to home).
- Time limit per call: default 120 s, at most 3600 s; on timeout or the agent's cancel, `pty_kill` and return what was
  read, marked as cut short.
- Output given to the agent: the last 64 KB, marked when cut.
- A remote computer whose `/api/diagnostics` names Windows is refused ("not supported yet").

### Tools (served by this Mac's server)

- `remote_computers`: the computers this conversation may use, each with name, host and sign-in state. Read-only, always
  allowed.
- `remote_run` `{ computer, command, cwd?, timeout? }`: the above; returns exit code, output, computer, and how long it ran.
  Refused for a computer the conversation was not given.
- Turned on in a conversation from its session controls: "Remote computers" with a checkbox per saved computer. Saved with
  the conversation (so it survives a restart of the server and a resume); only the person's own pages may change it, no
  tool can. Giving a running conversation the tools for the first time restarts its omp process (tool policies are fixed
  at start) and the conversation continues; changing the chosen computers later does not.
- Not offered in conversations whose tool slot is already held ("Set up with AI", "Ask agent for help"): one set per
  conversation (`hostServer`).
- Refused in a conversation that a page which is not the person's own has been on (the same rule as `remote-ai.ts`
  `heldRemotely`).

### Approval and guard (on this Mac)

- `remote_run` follows the conversation's approval mode exactly like `bash` (Auto-approve runs it without asking).
- The guard classifies `remote_run.command` with the shell rules, in a **remote context**: no project folder, no safe temp or
  home on this Mac; `~` and absolute paths are the remote computer's. So deleting or overwriting anywhere there counts as
  outside the project; sudo, force-push, piped downloads, protected names (`~/.ssh` …) are flagged as for `bash`. This is a
  change in `shared/remote-risk.ts` (it runs inside omp's process). The approval card names the computer: "Run on Server1:".
- `confirmRisky` (remote pages' Allow/Deny) covers it like any classified call.

### Macs list (this Mac)

- Each saved computer shows its sign-in state, with "Open its window to sign in" when it has lapsed or is missing.

## Left to the builder

- The exact marker format and escape stripping; the remote WebSocket path and frame shapes (read from `server/main.ts`).
- Where "Remote computers" sits in the session controls and where the sign-in state shows (`MachineSwitcher`, the Macs
  settings), following what is there.
- Docs: `docs/agents/remote-access.md` (a new section), `docs/TECHNICAL.md` and `TECHNICAL.zh-CN.md`, release notes.
- Tests: unit tests for the marker parser and the guard classification of `remote_run`; an integration test against a
  second local server standing in for the remote computer (as `remote-flow.spec.ts` stands in for the tunnel); a live check
  against Server1.
