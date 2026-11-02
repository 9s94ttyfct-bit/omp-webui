# Built-in browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every conversation's agent browses in a browser omp-webui owns (CEF inside the Mac app, Chrome for Testing when the server runs alone), and the person sees and uses that conversation's pages in a side-panel Browser tab.

**Architecture:** The server owns one engine behind a `CdpTransport` (CfT over `--remote-debugging-pipe`; CEF over a WebSocket the Mac app opens to the server). A per-conversation CDP proxy on the server's own address (token in the URL, given to omp as `browser.cdpUrl`) shows each conversation only its pages and opens a blank one when it has none. A second WebSocket carries screencast frames and input to the Browser tab; in the Mac app's own window a native CEF view covers the tab instead. Settings installs, updates and clears each engine.

**Tech Stack:** Bun/TypeScript server, React web UI, Swift + Objective-C++ (CEF C++ wrapper) in the Mac app, CEF 156 minimal distribution (pinned `CEF_API_VERSION`), Chrome for Testing, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-01-built-in-browser-design.md`

## Global Constraints

- No debugging port is opened by either engine: CfT `--remote-debugging-pipe`; CEF has `remote_debugging_port = 0`.
- Every conversation's overlay: `browser.cdpUrl: <proxy url>` (when an engine is installed) and `browser.relay: false`; every omp child env: `PI_BROWSER_RELAY=0` (not in `launch.env`).
- Owner of a page = the conversation's session file path (not the liveId: pages outlive omp processes).
- Default page size 1280×800 (CSS px, scale 1; Settings › Browser can change width and height for new pages, kept in `ompw.browserSize`); phone size 390×844, mobile, scale 3; "follow the panel" = the size of the panel that last set it.
- Install / Update / Clear routes answer 403 unless `remote` (verified Cloudflare Access identity) or `local` (`isThisComputer`); a token-only or credential-less network page may view and use but not manage. They are not under `/api/update*`.
- Engines and profiles live in `<dataDir>/browser/`: `cft/<version>/`, `cef/<version>/`, `cft-profile/`, `cef-profile/`, `current.json`, `owners.json`.
- CfT: Stable `chrome` for `mac-arm64` from `https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json`, run with `--headless=new`.
- CEF: newest `stable` `macosarm64` `minimal` build from `https://cef-builds.spotifycdn.com/index.json` whose `include/cef_api_versions.h` lists the app's pinned `CEF_API_VERSION`; verified by the index's `sha1`.
- No omp issue or upstream request is filed.
- All strings en + zh-CN; zh says 浏览器 / 页面 / 对话.

## Review Focus

- A conversation whose omp process ended and restarted (idle reaper, Reopen) keeps its pages and its token: owner is the session file. Test in Task 4.
- Two conversations browse at the same time: neither agent's `browser.open()` lands on the other's page, and the person's new page in conversation A is not adopted by B's agent. Test in Task 4.
- The server restarts while the engine runs (CEF in the app): owners and tokens are read back from `owners.json`, and adopted overlays get the new address. The engine restarts instead (app/CEF restart, Clear): no stale target is shown, every Browser tab starts empty, tokens stay. Both tested in Task 4 (Step 1b).
- A phone's Browser tab on a page laid out at 1280×800: a tap lands on the element under the finger (frame scale and CSS mapping). Test in Task 6.
- Clear while an agent is mid-`browser.open`: the agent gets an error naming the restart, not a hang; after the restart its next open gets a fresh blank page. Test in Task 7.

---

### Task 1: CEF feasibility spike (gate, throwaway in `/tmp/cefspike`)

**Files:** none in the repo. Record the outcome in the ledger (`.superpowers/sdd/2026-11-01-built-in-browser/progress.md`).

Prove each, with a tiny Objective-C++ host built with `clang++` against the CEF 156 minimal distribution (C++ wrapper built with CMake, `-DCEF_API_VERSION=` the newest stable version in `include/cef_api_versions.h`):

- [ ] **Step 1:** The host's bundle holds no framework. It calls `cef_load_library("<dir>/Chromium Embedded Framework.framework/Chromium Embedded Framework")` from a directory outside the bundle, sets `framework_dir_path`, `main_bundle_path` (host bundle) and `browser_subprocess_path` (a helper app inside the host's `Contents/Frameworks`, which itself loads the framework by absolute path), `no_sandbox = 1`, `external_message_pump = 1`, `root_cache_path` = a temp profile. A page loads in a windowed browser view. Expected: page renders; `ps` shows helper processes from the helper path.
- [ ] **Step 2:** The host's `NSApplication` subclass implements `CefAppProtocol` (`isHandlingSendEvent` / `setHandlingSendEvent:`) and pumps with `CefDoMessageLoopWork` on `OnScheduleMessagePumpWork`. Expected: typing, scrolling, IME work.
- [ ] **Step 3:** Moving the browser's `NSView` into an off-screen, never-shown window and back keeps the page (a counter in JS keeps counting; no reload). Expected: counter continues.
- [ ] **Step 4:** With `remote_debugging_port = 0`, `CefBrowserHost::SendDevToolsMessage` + `CefDevToolsMessageObserver` drive the page: `Page.navigate`, `Runtime.evaluate`, `Page.startScreencast` (frames arrive), `Input.dispatchMouseEvent`. Record which `Target.*` methods answer on a page's host (`getTargets`, `createTarget`, `attachToTarget` with `flatten`).
- [ ] **Step 5:** Code-signing: sign host and helper with the app's local identity (`scripts/signing-identity.ts` flow) without signing the downloaded framework; launch. Expected: runs (no hardened runtime).
- [ ] **Step 6: Gate.** All five hold → continue. Any fails → stop the plan and bring the result and the spec's fallback options to the person.

### Task 2: Engine transport and the CfT engine

**Files:**
- Create: `server/browser/transport.ts`, `server/browser/cft.ts`
- Test: `tests/contract/browser-cft.test.ts`

**Interfaces:**
- Produces: `interface CdpTransport { send(message: object): void; onMessage(fn: (m: CdpMessage) => void): () => void; onClose(fn: (why: string) => void): () => void; close(): void }`; `type CdpMessage = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string }; sessionId?: string }`; `class CdpClient { constructor(t: CdpTransport); call<T>(method: string, params?: object, sessionId?: string): Promise<T>; on(method: string, fn: (params: any, sessionId?: string) => void): () => void }`; `startCft(opts: { executable: string; profileDir: string; signal?: AbortSignal }): Promise<CdpTransport>`.

- [ ] **Step 1: Failing test** `"CfT over a pipe answers Browser.getVersion, opens a page, and closes when its transport closes"`: executable from `OMPW_BROWSER_EXECUTABLE` (CI: Playwright's `chromium.executablePath()`), assert `product` starts with `HeadlessChrome/` or `Chrome/`, `Target.createTarget({url:"about:blank"})` returns a `targetId`, after `close()` the process has exited within 5 s, and `lsof -nP -iTCP -sTCP:LISTEN -p <pid>` lists nothing (no port).
- [ ] **Step 2:** Run `bun test tests/contract/browser-cft.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `startCft`: `Bun.spawn([exe, "--headless=new", "--remote-debugging-pipe", "--user-data-dir=" + profileDir, "--no-first-run", "--no-default-browser-check", "--disable-background-networking"], { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] })`; Chrome reads fd 3 and writes fd 4, messages NUL-terminated JSON (verified: Bun exposes `proc.stdio[3]`/`[4]` as fd numbers). `CdpClient` keeps an id counter and pending map, rejects pending calls on close.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `Browser: CDP transport and the CfT engine`.

### Task 3: Install manager (CfT and CEF), state, routes

**Files:**
- Create: `server/browser/install.ts`, `server/browser/lazy.ts`
- Modify: `server/main.ts` (routes in `api()`, gate, first state frame on WS `open`), `shared/protocol.ts` (`{ t: "browser_state"; state: BrowserState }`), `server/migrate/layout.ts` (`browser` → engines: cache; profiles + `owners.json`: machine)
- Test: `tests/unit/browser-install.test.ts`, `tests/unit/browser-gate.test.ts`

**Interfaces:**
- Consumes: `download()` from `server/update/steps.ts`.
- Produces: `type EngineKind = "cft" | "cef"`; `interface BrowserState { rev: number; engine: EngineKind; installed: { version: string } | null; latest: string | null; job: { kind: "install" | "update" | "clear"; received: number; total: number } | null; error: string | null; restartNeeded: boolean; canManage: boolean }`; `class BrowserInstaller { state(canManage: boolean): BrowserState; check(): Promise<void>; install(): Promise<void>; cancel(): void; clear(): Promise<void>; executable(): string | null; profileDir(): string; onChange(fn: () => void): () => void }`; routes `GET /api/browser`, `POST /api/browser/{check,install,cancel,clear}`; `canManageBrowser(remote: RemoteIdentity | null, local: boolean): boolean`.

- [ ] **Step 1: Failing tests.** `browser-gate`: `canManageBrowser(null,false)===false`, `(null,true)===true`, `({email:"a@b",validUntil:…},false)===true`; a POST to `/api/browser/install` from a token-only network request answers 403 with problem `browserNotHere`, and from a loopback request 202. `browser-install` (with a fake fetch serving a CfT JSON and a zip; a CEF index with `sha1` and a `.tar.bz2` whose `include/cef_api_versions.h` lacks the pinned version): install puts `cft/<version>/` and `current.json`; a wrong `sha1` leaves nothing; a CEF build without the pinned API version is skipped for the next older stable one; `cancel()` mid-download leaves no partial directory; `clear()` with CfT running stops it, removes `cft-profile/`, starts again.
- [ ] **Step 2:** Run `bun test tests/unit/browser-install.test.ts tests/unit/browser-gate.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Engine kind: `cef` when the server was started by the app (`OMP_WEBUI_SHELL` env the app already sets — check `main.swift:511-523`; add `OMPW_BROWSER_ENGINE=cef` there if none fits), else `cft`. Extraction: `unzip -q` / `tar xjf` into `<version>.part`, then rename. CEF install/update/clear set `restartNeeded` and ask the app to restart through the existing shell events stream (`{type:"browserRestart"}`); the app deletes `cef-profile/` before starting CEF when `current.json` says `clearPending`. State goes to every page the server lets in (not `broadcastLocal`), `canManage` per socket from `WsData.remote`/`local`. `OMPW_BROWSER_EXECUTABLE` short-circuits `executable()` (tests, CI).
- [ ] **Step 4:** Run → PASS; `npm run -s typecheck`.
- [ ] **Step 5:** Commit `Browser: install, update and clear each engine`.

### Task 4: Page registry and per-conversation CDP proxy

**Files:**
- Create: `server/browser/registry.ts`, `server/browser/proxy.ts`
- Modify: `server/main.ts` (route `/browser-cdp/<token>/…` before `auth.allowed`: loopback peer + valid token only; WS upgrade with `WsData.kind = "cdp"`; every websocket handler branches on `kind`)
- Test: `tests/unit/browser-proxy.test.ts` (fake transport), `tests/contract/browser-proxy.test.ts` (CfT + `puppeteer-core`)

**Interfaces:**
- Consumes: `CdpTransport`, `CdpClient` (Task 2).
- Produces: `class PageRegistry { tokenFor(owner: string): string; ownerOf(token: string): string | null; pagesOf(owner: string): string[]; ownerOfTarget(targetId: string): string | null; adopt(targetId: string, owner: string): void; rekey(oldOwner: string, newOwner: string): void; closeOwner(owner: string): Promise<void>; load(generation: string): Promise<void> /* owners.json; drops target owners when the generation differs */ }`; `cdpUrlFor(owner: string, origin: string): string` → `${origin}/browser-cdp/${token}`; `class CdpProxy { connect(owner: string, ws: ServerWebSocket): void }` answering `/json/version` (`webSocketDebuggerUrl` back through the proxy), `/json/list` (owner's pages only).

- [ ] **Step 1: Failing tests.** Unit (scripted fake browser): conversation A's connection receives `Target.targetCreated`/`targetInfoChanged`/`attachedToTarget` only for A's targets; `Target.getTargets` lists only A's; `Target.attachToTarget`/`closeTarget`/`activateTarget` naming B's `targetId`, or a command on B's `sessionId`, answers error `-32000 "Not this conversation's page"`; a target created through A's connection, or opened by A's page (`openerId`), becomes A's; connecting with no page creates one `about:blank` before the first `Target.getTargets` answer; `owners.json` written on each change and read back by a new registry (same tokens, same owners). Contract: `puppeteer.connect({browserURL: cdpUrlFor("A")})` → `browser.pages()` has exactly A's blank page; B's connection never sees it; `page.goto("data:text/html,…")` on A, then a new registry from `owners.json` maps the target to A.
- [ ] **Step 1b: Failing tests (engine generation and owner changes).** `owners.json` stores the engine's generation (a random id the engine gets at each start): a registry loaded with the same generation (server-only restart) keeps every target's owner; one loaded after the engine restarted (app/CEF restart, CfT restart, Clear) drops all target owners but keeps each conversation's token, so every Browser tab starts empty. `registry.rekey(oldFile, newFile)` moves pages and token to the new session file (omp `/move`, `POST /api/session/move`); a conversation whose omp switched to a new session (`/new`, fork, branch) keeps its old pages under the old file, and the new session gets its own token.
- [ ] **Step 2:** Run both → FAIL.
- [ ] **Step 3:** Implement. The proxy speaks the browser-level protocol to omp, rewriting nothing but filtering by `targetId`/`sessionId`; it keeps `sessionId → targetId` from `attachedToTarget`. Only the owner's own CDP traffic passes; whole-browser methods (`Storage.*`, `Browser.setDownloadBehavior`) pass through (spec call). Tokens: 32 random bytes, base64url.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `Browser: per-conversation CDP proxy and page owners`.

### Task 5: Conversations use the proxy

**Files:**
- Modify: `server/omp/approval.ts` (`ProcessOverlay.browser: { cdpUrl: string | null } `, `setBrowser(cdpUrl: string | null): Promise<void>`, written as `browser.cdpUrl` + `browser.relay: false`), `ApprovalStore.create/restore`, `server/omp/parked.ts` (`overlay.browserCdpUrl`), `server/live.ts` (spawn, adopt, record copy, env `PI_BROWSER_RELAY: "0"` in both env branches at `live.ts:1535-1550`), `server/sessions/actions.ts` + `main.ts` archive `onChange` (call `registry.closeOwner(file)`)
- Test: `tests/unit/approval-overlay.test.ts` (extend), `tests/unit/browser-wiring.test.ts`, `tests/e2e/browser-agent.spec.ts` (live model, skipped without a model like the other live specs)

**Interfaces:**
- Consumes: `PageRegistry.closeOwner`, `cdpUrlFor`.

- [ ] **Step 1: Failing tests.** Overlay text contains `browser:\n  cdpUrl: "http://127.0.0.1:…/browser-cdp/…"\n  relay: false` when installed, only `relay: false` when not; a parked record round-trips `browserCdpUrl`; an adopted overlay is rewritten with the new server's origin; the spawned env has `PI_BROWSER_RELAY=0` and `launch.env` does not; deleting or archiving a conversation calls `closeOwner(file)`. Live e2e: the agent is asked to open `data:text/html,<title>ompw-agent</title>` with its browser; the conversation's registry pages include a target titled `ompw-agent`; a second conversation's pages do not.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement through every overlay path the scout listed (create, restore/park/adopt, `ParkedRecord.overlay`, spawn, adopt, record copy). When a process's session file changes (the server's existing session-change handling in `live.ts`, and the `/move` route), call `registry.rekey` for a move, or `overlay.setBrowser(cdpUrlFor(newFile))` for a new session. Test both in `browser-wiring.test.ts`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `Browser: every conversation browses through its own proxy`.

### Task 6: Screencast and input socket

**Files:**
- Create: `server/browser/screen.ts`, `shared/browser-protocol.ts`
- Modify: `server/main.ts` (`/ws/browser` upgrade, `WsData.kind = "screen"`, same auth as `/ws`)
- Test: `tests/unit/browser-screen.test.ts`, `tests/contract/browser-screen.test.ts`

**Interfaces:**
- Produces (`shared/browser-protocol.ts`): client→server `{t:"watch"; owner: string; targetId: string | null; panel: {w: number; h: number}} | {t:"unwatch"} | {t:"open"; owner: string; url: string} | {t:"close"; targetId: string} | {t:"navigate"; targetId: string; action: "url" | "back" | "forward" | "reload"; url?: string} | {t:"size"; targetId: string; mode: "desktop" | "panel" | "phone"} | {t:"input"; targetId: string; event: MouseInput | WheelInput | KeyInput | TextInput}`; server→client JSON `{t:"pages"; owner: string; pages: PageInfo[]}`, `{t:"console"; targetId: string; entry: ConsoleEntry}` and binary frames `[u32 header length][JSON {targetId, w, h, scale, seq}][JPEG]`; `PageInfo = {targetId, url, title, mode, w, h, canBack, canForward}`; `ConsoleEntry = {level: "log"|"info"|"warn"|"error"; text: string; source: "console"|"network"; url?: string; time: number}`.
- `pageSizeFor(mode, panel): {w, h, scale, mobile}` (desktop 1280×800×1; phone 390×844×3 mobile; panel = panel w×h ×1).
- `frameToPage(x, y, frame, page): {x, y}` maps a point in the shown frame to CSS px.

- [ ] **Step 1: Failing tests.** Unit: `pageSizeFor` values above; `frameToPage` for a 1280×800 page shown at 640×400 maps (320,200)→(640,400) and clamps outside points; console entries are only sent to sockets watching that `targetId`. Contract (CfT): watching a page yields a JPEG frame within 2 s; an input click at the frame position of a button on a 1280×800 page shown at 390 px wide changes its text; `{t:"size",mode:"phone"}` makes `innerWidth` 390; a `console.error("x")` arrives as a `console` entry; a failed `fetch` to a closed port arrives as `source:"network"`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: one server-owned CDP session per watched target (attached with the engine's own client, not through the proxy), `Page.startScreencast {format:"jpeg", quality:70, maxWidth: panel.w*dpr, maxHeight: panel.h*dpr}` while at least one socket watches, `Page.screencastFrameAck`; size via `Emulation.setDeviceMetricsOverride`; text via `Input.insertText`; console via `Runtime.consoleAPICalled` + `Log.entryAdded` + `Network.loadingFailed`. Frames are sent with `ws.send(binary)`, dropped (not queued) while `ws.getBufferedAmount()` > 1 MiB.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `Browser: screencast and input`.

### Task 7: Browser tab and Settings card (web)

**Files:**
- Create: `web/src/components/BrowserTab.tsx`, `web/src/components/BrowserScreen.tsx`, `web/src/components/BrowserConsole.tsx`, `web/src/components/settings/BrowserSettings.tsx`, `web/src/store/browser.ts`, `web/src/i18n/browser.ts`, `web/src/i18n/zh-CN/browser.ts`
- Modify: `shared/panes.ts` (`"browser"` in `PANEL_TABS`, second row of `DEFAULT_ROWS`), `RightPanel.tsx` (lazy tab, `Globe` icon, `t("panel.tabBrowser")`), `web/src/i18n/panel-later.ts` + `zh-CN/panel.ts`, `SettingsPage.tsx` (`part("app", …)`), `web/src/lib/settings-search.ts`, `store/app.ts` (dispatch `browser_state`), tests that list every tab id (`tests/unit/panel-panes.test.ts`, `tests/e2e/split-panel.spec.ts`), `tests/e2e/timings.json`
- Test: `tests/e2e/browser-tab.spec.ts`, `tests/e2e/browser-settings.spec.ts`

**Interfaces:**
- Consumes: `shared/browser-protocol.ts`, `BrowserState`, `insertIntoComposer(text, focus)` (`web/src/lib/composer-bridge.ts`).
- Produces: `ompwBrowser` bridge messages for Task 9: `{type:"place"; targetId: string; rect: {x,y,w,h}; mode: "desktop"|"panel"|"phone"} | {type:"cover"; covered: boolean} | {type:"hide"} | {type:"devtools"; targetId: string}`; the tab uses the bridge instead of `BrowserScreen` when `window.webkit?.messageHandlers?.ompwBrowser` exists and the page is the app's own window.

- [ ] **Step 1: Failing e2e** (server with `OMPW_BROWSER_EXECUTABLE`): the Browser tab of a conversation lists its pages; typing an address and Enter loads it and the frame shows it; back/forward/reload; "New page" adds a tab owned by that conversation, not shown in another conversation's Browser tab; the size switch shows Desktop/Panel/Phone; the console strip lists a `console.error` and "Send to agent" puts `Console error on <url>: <text>` into the composer; with no engine installed the tab says so and offers Install only when `canManage`; Settings › Browser shows version, Install/Update with progress and Cancel, Clear asks first; zh-CN labels; a phone viewport (iPhone 13) taps a button on the 1280×800 page; Review Focus: Clear during an agent open is reported, not hung.
- [ ] **Step 2:** Run `bun scripts/e2e.ts tests/e2e/browser-tab.spec.ts tests/e2e/browser-settings.spec.ts --workers=1` → FAIL.
- [ ] **Step 3:** Implement. `BrowserScreen` draws frames on a `<canvas>` sized to the panel, letterboxed, maps pointer/wheel/keys with `frameToPage`, and sends composed text (IME `compositionend`, mobile `beforeinput`) as `TextInput`. With the native bridge, the tab sends `cover: true` while any menu, popover or dialog of the page overlaps the panel's rectangle (Radix `data-state="open"` portals) and `cover: false` when none does. The tab and card are lazy chunks; strings are registered in their own module (first-load rule `tests/unit/i18n-first-load.test.ts`).
- [ ] **Step 4:** Run → PASS; update timings; `npm test` (panel tab lists, i18n first-load, timings coverage).
- [ ] **Step 5:** Commit `Browser: the Browser tab and Settings › Browser`.

### Task 8: CEF in the Mac app — build and lifecycle

**Files:**
- Create: `third_party/cef/` (the pinned distribution's `include/`, `libcef_dll/`, `LICENSE.txt`, `VERSION` = `156.0.15+gcf671c0+chromium-156.0.8078.80`, `API_VERSION`), `macos/cef/CEFHost.h`, `macos/cef/CEFHost.mm`, `macos/cef/OmpApplication.h`, `macos/cef/OmpApplication.mm`, `macos/cef/helper.mm`, `macos/browser.swift`
- Modify: `scripts/app.ts` (build the wrapper and bridge with `clang++ -std=c++20 -fobjc-arc -DCEF_API_VERSION=$(API_VERSION)` into a static lib; `swiftc -import-objc-header macos/cef/CEFHost.h`; build four helper apps `omp-webui Helper.app`, `… (GPU)`, `… (Renderer)`, `… (Plugin)` into `Contents/Frameworks` with their Info.plists; sign them), `macos/main.swift` (`OmpApplication.shared` instead of `NSApplication.shared`; start CEF when `<appdata>/browser/current.json` names a CEF version; `OMPW_BROWSER_ENGINE=cef` in the server env)
- Test: `tests/unit/app-build.test.ts` (extend: helper bundles listed, signed); smoke run (Step 4)

**Interfaces:**
- Produces (`CEFHost.h`, Objective-C): `+ (BOOL)startWithFramework:(NSString*)frameworkDir profile:(NSString*)profileDir error:(NSError**)e; + (void)shutdown; + (NSView* _Nullable)viewForTarget:(NSString*)targetId; + (void)createPage:(NSString*)url reply:(void(^)(NSString* targetId))reply; + (void)closePage:(NSString*)targetId; + (void)sendCdp:(NSString*)targetId message:(NSString*)json; + (void)setCdpObserver:(void(^)(NSString* targetId, NSString* json))fn; + (void)showDevTools:(NSString*)targetId; + (void)parkAll:(NSWindow*)hidden`.

- [ ] **Step 1: Failing check:** `bun scripts/app.ts` then `test -d "dist/omp-webui.app/Contents/Frameworks/omp-webui Helper (Renderer).app"` → fails.
- [ ] **Step 2:** Implement what Task 1 proved, in the shapes above. Pages are `CefBrowser`s in windowed mode; a hidden borderless window (`isReleasedWhenClosed = false`, never ordered front) parks every view when `MainWindow.close()` runs and on start.
- [ ] **Step 3:** Run the build check → PASS; `npm test` (app build tests).
- [ ] **Step 4: Smoke:** with CEF installed into the app data folder, launch the app, open a page through `CEFHost createPage`, close the window choosing *Run in the background*, reopen: the page's JS counter kept counting. Screenshot proof.
- [ ] **Step 5:** Commit `Browser: CEF inside the Mac app`.

### Task 9: CEF engine to the server, and the native view over the tab

**Files:**
- Create: `server/browser/cef.ts`, `macos/browserlink.swift`
- Modify: `server/main.ts` (`/browser-engine` WS from the app only: loopback + app token + `x-ompw-shell: 1`), `macos/main.swift` (the main window's content becomes a container: web view + browser views above it; `ompwBrowser` script handler with the reply/`isOwnPage` checks of `droppaths.swift:64-99`), `server/browser/install.ts` (CEF state from the app)
- Test: `tests/unit/browser-cef.test.ts` (fake app socket), smoke run

**Interfaces:**
- Consumes: `CEFHost` (Task 8), `CdpTransport` (Task 2), bridge messages (Task 7).
- Produces: `startCefEngine(socket): CdpTransport` presenting a browser-level endpoint: `Target.getTargets`, `createTarget`, `closeTarget`, `attachToTarget {flatten:true}`, `setDiscoverTargets`, `targetCreated/Destroyed/InfoChanged` emulated in `cef.ts` from the app's page list; page-level messages forwarded by `sessionId → targetId` to `CEFHost sendCdp` (whatever Task 1 Step 4 found the page host already answers is passed through instead).

- [ ] **Step 1: Failing unit tests:** the emulated endpoint answers `Target.getTargets` from the app's pages; `createTarget` asks the app and resolves with its `targetId`; a page message with a `sessionId` reaches the app tagged with its `targetId`; the app's page closing emits `Target.targetDestroyed`; Task 4's proxy unit suite passes against this transport.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. Native view: `place` sets the view's frame from the rect (page coordinates → window coordinates, flipped), applies the page size by `Emulation.setDeviceMetricsOverride` with the view's scale; `cover` hides/shows; the view never calls `makeFirstResponder` unless clicked; `devtools` opens CEF's DevTools window. Only the main window's configuration gets the `ompwBrowser` handler; remote windows (`macos/remotewindow.swift`) never do, so they always use the screencast. **Step 4:** Run → PASS.
- [ ] **Step 5: Smoke (real app):** a conversation's agent opens a page; the app window's Browser tab shows it natively; a remote window onto this Mac shows the screencast of the same page; clicking in the native view works and the composer keeps focus until then. Screenshots.
- [ ] **Step 6:** Commit `Browser: CEF engine and the native view`.

### Task 10: Docs and final checks

**Files:**
- Create: `docs/agents/browser.md`
- Modify: `docs/TECHNICAL.md`, `docs/TECHNICAL.zh-CN.md`, agent docs that mention omp's browser/relay (`rg -l "relay|browser" docs/agents`), the docs index the help draws on.

- [ ] **Step 1:** Write the docs from the spec (what the person sees, where, settings, limits: one shared page per conversation, pages not restored after a restart, CEF update restarts the app).
- [ ] **Step 2:** Run `npm test`, `npm run -s typecheck`, `npm run -s lint`, the browser e2e specs and the affected panel specs → all pass.
- [ ] **Step 3:** Commit `Browser: docs`.
