# Built-in browser downloads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Downloads started in the Mac app's built-in browser are saved to ~/Downloads, listed per conversation in the
Browser tab with progress and Cancel, shown in Finder on this Mac and fetched to another device through the tunnel.

**Architecture:** CEF's download handler in the app saves and reports; the app tells the server over `/browser-engine`;
the server keeps a per-conversation list, sends it to that conversation's Browser tabs on `/ws/browser`, takes Cancel
and Show in Finder there, and serves a finished file at `/api/browser/downloads/<id>/file` under the File transfer rules.

**Tech Stack:** Objective-C++ (CEF 156), Swift, Bun/TypeScript server, React + zustand, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-browser-downloads-design.md`

## Global Constraints

- No save dialog; files go to the user's Downloads folder; a taken name becomes `name (1).ext`, `name (2).ext`…
- Pages are told a download's name, never its path.
- A page not on this Mac fetches a file only when File transfer is not `off` (`requireDownload`), never a file that holds a
  private key (same check as the Files tab).
- At most 50 downloads kept per conversation; the oldest finished go first; in memory only.
- An agent's download (`Browser.setDownloadBehavior`) still goes where it asked.
- English and Chinese strings for every new text.

## Review Focus

- A Browser tab of conversation B must not see, cancel or fetch conversation A's download → Task 1 and 2 tests.
- A download whose page closed keeps its conversation → Task 1 test.
- A finished file moved or deleted before it is fetched answers 410 with a sentence, not a 500 → Task 2 test.
- Two downloads with the same name at once must not get the same path → Task 3 (native, checked on the built app).
- Cancel of a finished download is a no-op, not an error → Task 1 test.

---

### Task 1: The list on the server, and the Browser tab's socket

**Files:**
- Modify: `shared/browser-protocol.ts` (types, messages)
- Create: `server/browser/downloads.ts`
- Modify: `server/browser/cef.ts` (`AppMessage`, `ServerToApp`, `CefLink` callback), `server/browser/lazy.ts` (wiring),
  `server/browser/screen.ts` (send list, `download_cancel`, `download_reveal`), `server/main.ts` (`ScreenSocket.local`)
- Test: `tests/unit/browser-downloads.test.ts`, `tests/contract/browser-engine.test.ts`

**Interfaces:**
- Produces (`shared/browser-protocol.ts`):
  `type DownloadState = "progress" | "done" | "cancelled" | "failed"`;
  `interface BrowserDownload { id: string; name: string; state: DownloadState; received: number; total: number | null; startedAt: number; error?: string }`;
  server message `{ t: "downloads"; owner: string; downloads: BrowserDownload[] }`;
  client messages `{ t: "download_cancel"; id: string }`, `{ t: "download_reveal"; id: string }`.
- Produces (`server/browser/cef.ts`): app message `{ t: "download"; download: AppDownload }` with
  `AppDownload { id: string; targetId: string; name: string; path: string; state: DownloadState; received: number; total: number; error?: string }`
  (`total` ≤ 0: unknown); server message `{ t: "download_cancel"; id: string }`; `CefLink` constructor's third parameter
  `onDownload: (d: AppDownload) => void`.
- Produces (`server/browser/downloads.ts`): `class DownloadList { constructor(ownerOf: (targetId: string) => string | null, changed: (owner: string) => void); update(d: AppDownload): void; of(owner: string): BrowserDownload[]; get(id: string): { owner: string; path: string; item: BrowserDownload } | null }`.

- [ ] **Step 1: Unit tests** (`browser-downloads.test.ts`): `update` of a new id for a page owned by "c1" puts it in
  `of("c1")` and calls `changed("c1")`; a later update after `ownerOf` returns null keeps it in "c1"; an id whose page has
  no owner is dropped; 51 finished downloads keep the newest 50; a running one is never dropped for the cap; `total ≤ 0`
  becomes `null`; `of` never carries `path`.
- [ ] **Step 2: Run** `bun test tests/unit/browser-downloads.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** `downloads.ts`, the protocol types, `CefLink` parsing `download`, `LazyBrowser.attachApp`
  passing `onDownload` to a `DownloadList` it owns (owner from `service.registry.ownerOfTarget`, `changed` →
  `service.screen.downloadsChanged(owner)`), `ScreenHub.downloadsChanged(owner)` sending each client of that owner its list,
  `ScreenClient` sending the list after `pages` on watch, `download_cancel` → `link.send` only for its own owner's running
  download, `download_reveal` → `desktop.revealArgv(path)` only when `socket.local` and the download is its owner's and
  done. `ScreenSocket` gains `local: boolean` (from the request, as `/ws` has it).
- [ ] **Step 4: Run** the unit test — PASS.
- [ ] **Step 5: Contract test** in `browser-engine.test.ts`: fake app hello + page + `download` for a page of conversation
  A; a `/ws/browser` socket watching A gets `downloads` with the name and no path; one watching B gets an empty list;
  `download_cancel` from B sends nothing to the app, from A sends `{t:"download_cancel", id}`. Run — PASS.
- [ ] **Step 6: Commit.**

### Task 2: Fetching a finished file

**Files:**
- Modify: `server/transfer-download.ts` (export `serveFile`, `download` uses it), `server/main.ts` (route before
  `browser.handle`), `server/browser/lazy.ts` (`downloadFile(req, id, env)`)
- Test: `tests/contract/browser-engine.test.ts`

**Interfaces:**
- Produces: `serveFile(req: Request, abs: string, name: string, env: TransferEnv, trace: Trace, deps: DownloadDeps): Promise<Response>`
  (the body of `download` after the path is resolved: secret check, Range/If-Range, gate, log).
- Route: `GET|HEAD /api/browser/downloads/<id>/file` → 404 unknown id, 409 not finished, 410 file gone, else `serveFile`.

- [ ] **Step 1: Contract tests:** a finished download whose path is a temp file → 200 with its bytes and
  `content-disposition` naming it; `Range: bytes=2-` → 206; unknown id → 404; running → 409; file deleted → 410; with
  File transfer `off`, a request through the fake tunnel (as `remote-auth.test.ts` makes one) → 403, a local one → 200.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `serveFile` (move, not copy, `download`'s body), the route and `downloadFile`.
- [ ] **Step 4: Run** the new tests and `tests/contract/folder-transfer*.test.ts` — PASS.
- [ ] **Step 5: Commit.**

### Task 3: CEF saves and reports downloads

**Files:**
- Modify: `macos/cef/CEFHost.mm`, `macos/cef/CEFHost.h`, `macos/browserlink.swift`

**Interfaces:**
- Consumes: Task 1's `AppDownload` / `download_cancel`.
- Produces: `+ (void)setDownloadObserver:(void (^_Nullable)(NSDictionary<NSString*, id>* download))observer;`
  `+ (void)cancelDownload:(NSString*)downloadId;`

- [ ] **Step 1:** `Client` is a `CefDownloadHandler`: `OnBeforeDownload` continues to a free path in
  `NSDownloadsDirectory` (names reserved while running), no dialog; `OnDownloadUpdated` reports the `AppDownload` fields
  (target id from `gPages`, path from `GetFullPath`, `failed` with the interrupt reason), progress at most every 250 ms
  per download, keeps the callback while running. Log `OnBeforeDownload` once with `LOG(WARNING)` while checking the cause.
- [ ] **Step 2:** `browserlink.swift` sends `download`, takes `download_cancel`.
- [ ] **Step 3:** `bun run app`; run the built app with a scratch data folder; click a download link in the Browser tab;
  the log line shows the handler ran; the file is in Downloads; a second same-name download gets `(1)`; Cancel stops one;
  `xattr -p com.apple.quarantine` on the file (set it from the handler if missing). Remove the log line.
- [ ] **Step 4:** `bun test tests/unit/cef-build.test.ts tests/unit/app-build.test.ts` — PASS. Commit.

### Task 4: The Browser tab

**Files:**
- Modify: `web/src/store/browser-screen.ts` (`downloads` in the store, toasts on start/done/failed),
  `web/src/components/BrowserTab.tsx` (toolbar button + list)
- Create: `web/src/components/BrowserDownloads.tsx`
- Modify: `web/src/i18n/*` (browser strings, en + zh-CN)
- Test: `tests/e2e/browser-downloads.spec.ts` (the `/ws/browser` socket stubbed with `page.routeWebSocket`)

- [ ] **Step 1: e2e:** a `downloads` message with one running and one done → the button shows "1"; the list shows the
  name, a progress bar with its percent, Cancel (sends `download_cancel`), and for the done one Show in Finder on a local
  page (sends `download_reveal`) or Download to this device on a remote one (`meta.remote`; a link to
  `/api/browser/downloads/<id>/file`); a new download and a finished one each toast once; Chinese labels; axe clean.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS, with `browser*.spec.ts`. Commit.

### Task 5: Docs, release notes, full checks

- [ ] `docs/agents/browser.md` (downloads section; correct the ~/Downloads line), `docs/TECHNICAL.md`,
  `docs/TECHNICAL.zh-CN.md`, `release-notes/v0.22.2.md`, `package.json` 0.22.2, `tests/e2e/timings.json`.
- [ ] `bunx tsc --noEmit -p .`, `bun run lint`, `bun run test:all`, affected e2e — all pass. Commit, push, CI green,
  `bun scripts/release-local.ts v0.22.2`.
