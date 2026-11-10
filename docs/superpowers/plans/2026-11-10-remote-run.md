# Run commands on another computer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A conversation on this Mac, when the person turns it on and picks computers from the Macs list, gets a `remote_run` tool that runs a shell command on one of those computers through its existing tunnel and returns output and exit code.

**Architecture:** The macOS app hands each saved computer's Cloudflare Access cookie (`CF_Authorization`, read from that computer's web data store) to the local server over a local-only route; the server keeps it in memory. `remote_run` (a host tool the server serves over the conversation's omp pipe) does `GET https://<host>/` to get the remote app cookie, opens `wss://<host>/ws`, `pty_open` a login shell, types a marker-wrapped command and reads output until the end marker. Per-conversation choice of computers is kept in `<data dir>/remote-run.json`. The guard classifies `remote_run.command` as a shell command with no safe local folder.

**Tech Stack:** Bun + TypeScript server (`server/`), shared pure modules (`shared/`), React + zustand web (`web/src`), Swift macOS app (`macos/`), bun test.

**Spec:** `docs/superpowers/specs/2026-11-10-remote-run-design.md`

## Spike result (verified 2026-11-10 against Server1)

- The app's data store for the team holds `CF_Authorization` for the host (not HttpOnly) and `ompw_token`; JWT `exp` = `iat` + 24 h.
- `GET https://<host>/` with only `Cookie: CF_Authorization=<jwt>` → 200 + `Set-Cookie: ompw_token=…`.
- `new WebSocket("wss://<host>/ws", { headers: { cookie: "CF_Authorization=…; ompw_token=…", origin: "https://<host>" } })` opens; server sends `hello`, `app_update`, `browser_state`.
- `{ t: "pty_open", req: 1, shell: true, args: [], cols: 200, rows: 50 }` → `{ t: "reply", req: 1, ok: true, data: { ptyId } }` (`args: []` is required). `{ t: "pty_input", ptyId, data }`, frames `{ t: "pty_data", ptyId, data }`, `{ t: "pty_exit", ptyId, code }`, `{ t: "pty_kill", ptyId }`.
- Markers written as `"B<nonce>""X"` in the typed line are echoed as typed and printed as `B<nonce>X`, so the echo never matches.

## Global Constraints

- Tool name `remote_run`; arguments `{ computer: string, command: string, cwd?: string, timeout?: number }` (seconds). Default timeout 120 s, max 3600 s. Output to the agent: last 64 KB (65536 chars), marked when cut.
- One tool only (no `remote_computers`): the schema's `computer` is an enum of the conversation's chosen computers' names, and the description lists them. A host tool with no policy is tier `exec`, so it follows the conversation's approval mode exactly like `bash` (no omp restart needed; `server/omp/approval.ts` 148–166).
- Credentials (JWT, `ompw_token`) live in server memory only: never written, logged, sent to a page, or put in tool args/results.
- `POST|DELETE /api/macs/<id>/sign-in` answers only this computer's own requests (`onThisComputer.has(req)` and no remote identity), even though `/api/macs*` is owner-only.
- Only the person's own pages (`isOwnerPage`) may change a conversation's computers; no tool can.
- Conversations whose host tool slot is held by another server ("Set up with AI", "Ask agent for help") are not offered remote_run.
- Calls are refused in a conversation a non-owner page has been on (same rule as `RemoteAiHooks.heldRemotely`).
- Remote computers whose platform is Windows are refused: "Running commands on Windows computers is not supported yet."
- Lapsed or missing sign-in: error text "<name>: not signed in (or the sign-in has lapsed). Open its window from the Macs list and sign in, then try again."
- No real hostnames, user names or paths in committed files (pre-commit hook); tests use `omp.example.com`-style names.
- User-visible strings in `web/src/i18n` for `en` and `zh-CN`.

## Review Focus

1. A command that never ends (`sleep 9999`, `tail -f`) → returns after the timeout with output so far and "timed out", and the remote shell is killed (`pty_kill`). Test in Task 2.
2. A multi-line command with quotes, `$`, heredoc and non-ASCII text → runs exactly as given (base64 + `eval`). Test in Task 1 (script) and Task 2 (fake remote runs a real shell).
3. `cwd` that does not exist → non-zero exit and the shell's error in output, never silently home. Test in Task 2.
4. The agent's cancel (turn stopped) mid-command → the call ends promptly and the remote pty is killed. Test in Task 2.
5. A JWT in the body that is not a JWT or already expired → 400, nothing kept. Test in Task 3.

---

### Task 1: Shared contract — script builder, output parser, tool definition

**Files:**
- Create: `shared/remote-run.ts`
- Test: `tests/unit/remote-run.test.ts` (follow the location/style of existing unit tests in `tests/`)

**Interfaces:**
- Produces:
  - `REMOTE_RUN_TOOL = "remote_run"`, `REMOTE_RUN_TIMEOUT_S = { default: 120, max: 3600 }`, `REMOTE_RUN_OUTPUT_TAIL = 65536`.
  - `remoteRunLine(command: string, cwd: string | null, nonce: string): string` — the line typed into the remote login shell, ending in `"\r"`, starting with a space (kept out of history where the shell ignores leading-space lines): prints `B<nonce>X` on its own line, `cd -- '<cwd>'` (single-quote escaped) when given, then `eval "$(printf %s '<base64 of command>' | base64 -d)"`, then prints `E<nonce>X <exit code>`. The cd and eval joined with `&&` so a failed cd yields its own non-zero status. Markers in the line spelled `"B<nonce>""X"`.
  - `parseRemoteRun(raw: string, nonce: string): { done: boolean; output: string; exitCode: number | null }` — strips ANSI/OSC escapes and `\r`, takes the text after the last `B<nonce>X\n` line up to `E<nonce>X <n>`; `done` once the end marker line with a number is complete.
  - `tailOutput(text: string, max = REMOTE_RUN_OUTPUT_TAIL): { text: string; cut: boolean }`.
  - `remoteRunTool(computers: readonly string[]): HostToolDefinition` (type from `shared/guided-goal.ts`).
  - `parseRemoteRunArgs(args: unknown, computers: readonly string[]): { computer, command, cwd: string | null, timeoutS: number } | { error: string }` (timeout clamped to 1..3600, default 120).

- [ ] Step 1: tests — `remoteRunLine` output run through a real `sh -c`/`zsh -c` subprocess for: `echo "a b" && printf '%s' "$HOME" | wc -c`, a heredoc, `exit 3`-style `false` (exit 1), non-ASCII `echo 你好`, `cwd` that does not exist (exit ≠ 0, output names the folder), single quote in cwd; assert `parseRemoteRun` of the captured output gives exact output and exit code. Also `parseRemoteRun` on the spike's frame text with echo + escapes (`"\u001b[?2004l\r\r\nB…X\r\n…E…X 0\r\n"`) and on partial input (`done: false`). `parseRemoteRunArgs` rejects unknown computer, empty command, clamps timeout.
- [ ] Step 2: run, see fail. Step 3: implement. Step 4: run, see pass. Step 5: commit `feat(remote-run): shared script builder and parser`.

### Task 2: Server — remote client and sign-ins

**Files:**
- Create: `server/remote-run/sign-ins.ts`, `server/remote-run/client.ts`
- Test: `tests/unit/remote-run-client.test.ts` (a fake remote: a local `Bun.serve` that checks `Cookie`/`Origin`, sets `ompw_token` on `GET /`, serves `/ws` speaking the pty frames by running a real `zsh -il`/`sh -i` via `Bun.Terminal` or plain spawn echoing input)

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `class RemoteSignIns { set(macId: string, jwt: string): { expires: string }; clear(macId: string): void; get(macId: string): { jwt: string; expires: string } | null; signedInUntil(macId: string): string | null }` — `set` throws `RemoteSignInError` (status 400) for a malformed or expired JWT (`exp` from the payload, no signature check: the remote verifies); `get` returns null once expired.
  - `runRemote(o: { host: string; jwt: string; command: string; cwd: string | null; timeoutMs: number; signal: AbortSignal; origin?: string /* tests: "http://127.0.0.1:<port>" */ }): Promise<RemoteRunResult>`; `interface RemoteRunResult { exitCode: number | null; output: string; cut: boolean; timedOut: boolean; cancelled: boolean; ms: number }`; throws `RemoteNotSignedIn` when `GET /` does not answer 200 with `ompw_token` (Access redirect, 401, 403), `RemoteUnsupported` when `GET /api/diagnostics` (with both cookies) reports Windows.
  - The `ompw_token` per host may be cached in memory (module-level map) and refreshed once on a 401/403 from the socket.
- Behaviour: fresh socket + `pty_open { shell: true, args: [], cols: 200, rows: 50 }` per call; send `remoteRunLine` once the first `pty_data` arrives (the prompt) or after 1.5 s; on done/timeout/abort send `pty_kill` and close; `pty_exit` before done → result with `exitCode` null and output so far.
- [ ] Steps: failing tests for success, non-zero exit, timeout (Review Focus 1), cwd missing (3), abort (4), lapsed sign-in (redirect → `RemoteNotSignedIn`), Windows refusal; `RemoteSignIns` tests incl. Review Focus 5; implement; pass; commit `feat(remote-run): remote client and in-memory sign-ins`.

### Task 3: Server — service, routes, tool serving

**Files:**
- Create: `server/remote-run/service.ts` (selection store `<data dir>/remote-run.json` `{ version: 1, conversations: { [sessionKey]: string[] /* mac ids */ } }`, mode 0600, written whole + rename; `HostToolServer` per conversation)
- Modify: `server/main.ts` (routes, wiring at conversation open/resume and on selection change), `server/saved-macs.ts` (`/api/macs` list adds `signedInUntil` per Mac; `POST|DELETE /api/macs/<id>/sign-in` local-only), `shared/macs.ts` (type), `shared/protocol.ts` (whatever the page needs: a conversation's chosen computers in its info and a message/route to change them — follow how the advisor per-conversation choice travels)
- Test: `tests/unit/remote-run-service.test.ts`, contract test beside the existing `/api/macs` contract tests if any

**Interfaces:**
- Consumes: Task 1, Task 2.
- Produces for Task 4 (web): the conversation info field `remoteComputers: string[]` (mac ids) and the way to set it (e.g. WS `{ t: "remote_computers", liveId, macIds }` or `POST /api/remote-run`), refused with 403 for non-owner pages; `/api/macs` entries gain `signedInUntil: string | null`.
- Produces for Task 5 (app): `POST /api/macs/<id>/sign-in` body `{ jwt }` → 200 `{ signedInUntil }` / 400; `DELETE` → 204; 403 unless this computer's own request; 404 unknown id.
- Behaviour: when a conversation with a non-empty choice is opened/resumed (and its host slot is free), `live.serveHostTools(server)`; on change, re-serve with the new enum or `serveHostTools(null)` when empty; forget ids of Macs removed from the list; `call` refuses when `heldRemotely(liveId)`, maps errors to the texts in Global Constraints, result text: `"<name> · exit <code> · <s>s[ · timed out][ · output cut to the last 64 KB]\n<output>"`, `isError` when exit ≠ 0 or timed out.
- [ ] Steps: failing tests (selection persistence & pruning, refusal for non-owner-held conversations, local-only sign-in route incl. a remote-identity request → 403, tool re-serving on change), implement, pass, commit `feat(remote-run): per-conversation computers and remote_run tool`.

### Task 4: Guard — classify remote commands

**Files:**
- Modify: `shared/remote-risk.ts` (`classify`: `remote_run` → `classifyShell(command, remoteCtx, null)` with `roots: []`, `temp: []`, `home` set to a value no local path matches, `protect: []`, no ports/hosts; detail first line `Run on <computer>:`), wherever the approval card/guard card renders the detail if it needs the computer name.
- Test: existing remote-risk/guard test file(s) — add cases.

- [ ] Steps: failing tests — `rm -rf /tmp/x` flagged (no safe temp), `rm -rf ~/old` flagged, `sudo systemctl restart nginx` flagged, `ls -la /var/log` not flagged, `cat ~/.ssh/id_rsa` flagged (protected name), detail names the computer; implement; pass; commit `feat(guard): read remote_run commands as shell commands with no safe folder`.

### Task 5: Web — choosing computers, sign-in state

**Files:** session controls component that hosts the per-conversation advisor switch (find it), `web/src/lib/macs.ts`, `web/src/components/MachineSwitcher.tsx`, `web/src/i18n/*` (en + zh-CN).

- "Remote computers" in the conversation's session controls: one checkbox per saved computer (name, host, "Signed in until <date>" / "Not signed in — open its window to sign in"); hidden when the list is empty; disabled for non-owner pages and for conversations holding other server tools, with a line saying why.
- Machine switcher: the same sign-in state per Mac.
- [ ] Steps: component test only if the repo has them for these components; `bun run typecheck`, lint; commit `feat(remote-run): choose a conversation's remote computers`.

### Task 6: macOS app — hand over sign-ins

**Files:** `macos/remotemacs.swift` (pure: which cookie, which host, body), a new `macos/remotesignin.swift` (reads `CF_Authorization` for `mac.host` from `WKWebsiteDataStore(forIdentifier: mac.storeIdentifier).httpCookieStore`, posts it to the local server's `/api/macs/<id>/sign-in` the way the app already calls its server's local routes; `DELETE` when absent), register in the build file list (`scripts/app.ts` swiftc sources), harness test in `tests/support/swift/remote/main.swift` for the pure part.

- Triggers: server ready; Mac list change; `WKHTTPCookieStoreObserver.cookiesDidChange` on each store in use; remote window finishing sign-in.
- [ ] Steps: harness test for cookie pick (host match, name, not expired), implement, build the app (`bun run app` or the repo's app build script), commit `feat(app): hand the Macs' Access sign-ins to the local server`.

### Task 7: Docs, release notes, live check, release

- Docs: `docs/agents/remote-access.md` new section "Running commands on another computer"; `docs/TECHNICAL.md`, `docs/TECHNICAL.zh-CN.md`; `release-notes/v0.23.0.md`; `package.json` version 0.23.0 (follow the last release's commit for what else moves with the version).
- Live check: a dev server on a spare data dir/port, POST the sign-in from the app store (as the spike did, never printing it), a conversation with Server1 chosen, ask the agent to run `uname -a; whoami` there; then `cwd` missing, and a timeout of 5 s on `sleep 30`.
- Full checks: `bun run typecheck`, lint, unit, contract, e2e as the repo's `test` scripts define; push; CI green; `GH_TOKEN=$(gh auth token --user 9s94ttyfct-bit) bun scripts/release-local.ts v0.23.0`.
