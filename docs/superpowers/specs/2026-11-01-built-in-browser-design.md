# Built-in browser — design

Status: proposed, 2026-11-01. A project; full design.

## Intent

Today an agent that browses uses omp's own hidden Chromium, or the person's real Chrome through omp's relay. The person
cannot see what the agent does on a page, cannot step in to log in or pass a captcha, and cannot look at the site they
are building next to the conversation that builds it. The relay also drives the person's own browser and logged-in
tabs.

The web UI gets a browser of its own: the agent of every conversation browses in it, and the person sees and uses the
same pages in the conversation's side panel, on the Mac and from a phone.

## What it is for (the person's words)

- Watching what the agent does on a page, and stepping in now and then (a login, a captcha).
- Previewing the site they are developing (a dev server on `localhost`) and debugging it with the agent.

Not for everyday browsing: no bookmarks, download manager, history UI or multi-window browsing.

## Goals

- One browser, managed by omp-webui, with **one login state** (one profile) shared by every conversation and by the
  person. It is the engine's own: CEF's profile on the Mac, CfT's when the server runs alone; logins are not carried
  from one engine to the other.
- Every conversation's omp browses in it, never in the person's own Chrome.
- A conversation's side panel has a **Browser** tab showing that conversation's pages, live, that the person can click
  and type into.
- A console strip under the page lists console output and failed requests, with one action to send an error to the
  conversation's agent.
- Settings installs, updates and clears the browser; the browser updates independently of the app.

## Non-goals

- Everyday-browser features (bookmarks, downloads UI, history, extensions, popup windows as separate windows).
- Full Chrome DevTools in the web page or on a phone (the Mac has a button for a native DevTools window, see below).
- Coordinating the person's and the agent's input (see "Input").

## Anti-goals

- The agent never drives the person's own Chrome (omp's relay is off for every conversation).
- Nothing steals focus: the browser never brings itself or the app forward, and a page the agent opens never takes the
  keyboard from what the person is typing in.
- Closing the app's window never closes or reloads a page.
- A local program other than omp-webui and the conversations' omp processes cannot drive the logged-in browser through an
  open debugging port.
- Screencast frames never delay the conversation's own messages.

## Decided with the person

1. **Engine.** With the Mac app, **CEF is the only browser**: the agent drives it through its CDP, and every side panel
   (in the app, a browser tab, a phone) shows its pages. Without the Mac app (the server run alone), the server runs
   **Chrome for Testing (CfT)** headless instead. Reason: one Chromium profile can be open in one process at a time,
   and Chromium versions migrate a profile forward, so two engines cannot share one login state.
2. **CEF runs inside the Mac app's process** (approach A below).
3. **Lifetime.** Pages belong to the app's process, not to a window. When closing the window leaves the app running in
   the background (the app's existing choice on close: run in the background, in the menu bar), every page keeps running;
   reopening the window shows them again without a reload. Only quitting the app ends the browser. Without the app, CfT
   lives as long as the server. (Keeping CEF's views alive off-window is part of the spike.)
4. **Which pages a conversation shows.** Only the pages that conversation's agent opened, and the pages the person
   opened from that conversation's Browser tab. Other conversations' pages are not listed. The login state is shared by
   all.
5. **Input.** The person's and the agent's input both go to the page as they come; no lock, no handover.
6. **Where the native view is.** In the app's window, the Browser tab's area is covered by a native CEF view that follows
   the panel's position and size. Everywhere else (a browser tab, a phone, the app's remote windows) that area shows the
   CDP screencast, which takes clicks, scrolling and typing.
7. **Console.** A strip under the page: console messages and failed requests (read over CDP), an action that sends a
   chosen error to the agent as text in the composer. On the Mac, a button opens CEF's own DevTools window for the page.
8. **Settings.** Install, update and clear data for the browser, independent of the app's version (from an earlier
   conversation).
9. **Use.** Watching what the agent does, and previewing a site in development. Not everyday browsing.
10. **No debugging port** is opened, for either engine (see "The browser and its CDP channel").
11. **The agent's page.** One shared page per conversation now (the proxy makes up what omp does not do); omp's own
    pages if a later omp release offers them. No request is filed with omp.
12. **Page size.** A fixed desktop size by default, shown scaled; per page, "follow the panel" or a phone size.

## Approaches considered

- **A — CEF inside the app's process (picked).** CEF's files are downloaded into the data folder and loaded by the app at
  launch, or as soon as Settings has installed them. The native view is a child view of the app's window placed over the
  panel; when the window closes, the browser views move to a hidden window and keep running. Costs: the app's
  `NSApplication` must implement the protocol CEF requires on macOS and the app pumps CEF's message loop; **updating CEF
  needs the app restarted** (a loaded CEF cannot be swapped in-process), which reloads the pages; a CEF crash takes the
  app down.
- **B — CEF in a helper process** whose borderless window floats over the main window's panel. Updates and crashes stay
  out of the app, but the two windows lag and misalign while the main window moves or resizes, ordering and focus are
  hard to keep right (against "nothing steals focus"), and it does not read as one panel. Not picked.
- Dropped: bundling CEF in the app (ties its version to the app's, against independent updates); embedding another
  process's view (no public macOS API).

## The design

### The browser and its CDP channel — no debugging port

Chromium's debugging port has no authentication: any local program that finds it can drive the logged-in browser. So
**no debugging port is opened at all** (decided with the person):

- **CfT** (server alone) is started by the server with `--remote-debugging-pipe`; the server holds the pipe.
- **CEF** (Mac app) is driven over the channel the app already has with the server: the app passes CDP messages
  between the server and CEF (CEF's DevTools message API per browser) and itself provides what a browser-level CDP
  endpoint answers (the list of targets, creating and closing pages, attaching to one). Screencast frames travel on
  this channel too. The spike (below) checks how much of the browser-level domain CEF already answers.
- **The server is the only client.** It serves a CDP proxy on its own address. Each conversation's omp is given a
  per-conversation URL with a token (`browser.cdpUrl` in the conversation's per-process `--config` overlay,
  `server/omp/approval.ts` `ProcessOverlay`). A request without a valid token is refused.

### Which pages a conversation's agent sees and uses

What omp 18.15 does with `browser.cdpUrl` (found by the builder check in omp's bundled source and
`omp://tools/browser.md`): it **does not create pages**. `browser.open()` attaches to an existing page, the visible one
first, else the first; every tab name (`main`, `docs`, …) lands on that same page; with no page at all it fails ("No
page targets available"); closing a tab leaves the page open. Only omp's relay mode opens tabs of its own.

Decided with the person: **one shared page per conversation now, omp's own pages later.**

- **Now.** The proxy gives each conversation's connection a view of the browser that holds only that conversation's
  pages: target discovery, the target list, attach and target events are filtered by conversation. When the
  conversation has no page, the proxy opens a blank one for it before omp looks. So the agent works on the page the
  conversation's Browser tab shows, the same page the person sees; a second tab name of the agent lands on it too. Other
  commands pass through as they are, including ones that act on the whole browser (clearing cookies, download
  behaviour): the agent is the person's own (**call made here**).
- **Target commands are scoped too.** A page a conversation's connection creates (`Target.createTarget`) is that
  conversation's. Any command naming a page of another conversation (attach, close, activate, a session on it) is
  refused, so the page boundary cannot be crossed by a command; only whole-browser state (cookies, downloads) is
  shared, as above.
- **Later.** No request is filed with omp (decided with the person). If an omp release comes to open pages of its own by
  name when connected to a browser, leaving existing pages alone, the web UI may then require that release, stop
  opening the blank page, and show each agent tab name as its own page in the conversation's Browser tab. The filtering
  stays.
- A page the person opens from a conversation's Browser tab is created by the server for that conversation.
- A page opened by another page (`window.open`, a link with `target=_blank`) belongs to its opener's conversation and
  shows as another tab of it, not as a window.
- A conversation that is deleted or archived has its pages closed (**call made here**: otherwise they pile up with no
  panel to show them).

### Never the person's Chrome

- Every conversation's overlay sets `browser.relay: false`, and the server starts omp with `PI_BROWSER_RELAY=0`.
- An agent that asks for the relay or another browser explicitly in its own code (`app.relay`, `app.cdp_url`,
  `app.path`) is not blocked: `app.path` is how agents test Electron apps, and the relay drives Chrome only where the
  person installed omp's relay extension (**call made here**).
- When the built-in browser is not installed, the overlay sets only the relay off: the agent uses omp's own hidden
  Chromium, and the Browser tab offers the install (**call made here**).

### The Browser tab

- A new side-panel tab (`shared/panes.ts` `PANEL_TABS`, `RightPanel.tsx`, lazy chunk, en/zh strings).
- Top: the conversation's pages as tabs, an address field, back / forward / reload, and "new page".
- Middle: the page. In the app's window: the native view, placed from the panel's rectangle that the page reports to
  the app (on layout, resize, panel drag, tab switch, scroll). Elsewhere: the screencast.
- Bottom: the console strip (decision 7). Its console messages and failed requests are read from that page's own CDP
  session, so a conversation never sees another conversation's page's output.
- The native view hides while something of the web page has to be above it (a menu, a popover, a dialog), and shows again
  when it closes (**call made here**: simplest correct behaviour).
- A conversation with no pages shows an empty state with the address field.

### Screencast and input (everywhere but the app's own window)

- **The page's size** (decided with the person): by default a page lays out at a fixed desktop size (1280×800, changed
  in Settings) and is shown scaled down to the panel, so the agent's screenshots, the Mac, a browser tab and a phone all
  show the same layout. A control beside the address field switches that page to "follow the panel" or to a phone
  size, for previewing a responsive layout. In "follow the panel", the page takes the size of the panel that last
  changed it. The native view on the Mac shows the same size and scale as the screencast does.
- Frames come from CDP's screencast of the page shown, only while some panel shows it.
- Frames do not go through the conversation's JSON socket (`/ws` sends only strings, with backpressure that would hold up
  chat messages); the builder gives them their own connection.
- Input: mouse, wheel and keys are sent over CDP input events; text from a phone's keyboard and IME is inserted as text.
  Coordinates are mapped from the shown frame (with its scale) to the page's CSS pixels.

### A remote Mac (the app's remote windows)

The person's app can open a window on another Mac's omp-webui (`macos/remotewindow.swift`: a `WKWebView` on that Mac's
site). There, a conversation's agent runs on the other Mac, so its pages are in **the other Mac's browser** (its CEF,
or its CfT when it runs the server alone), and that is what the remote window's Browser tab shows:

- The remote window's Browser tab always shows the **screencast** from the other Mac's server, with input going back to
  it, as a browser tab or a phone does. The local Mac's CEF never covers a remote window, and its pages are never
  listed there.
- So what the person sees is what the agent on the other Mac sees: the same page, the same login state (the other Mac's),
  and `localhost` is the other Mac's dev server.
- The local app's CEF is not needed for this: a Mac without the browser installed can watch and use a remote Mac's
  browser.
- The screencast goes over the remote connection (the local network or the tunnel), so it is less smooth than the native
  view; the frame size and rate follow what the connection carries (left to the builder, with the screencast policy).

### Lifetime in the app

- CEF starts with the app (or when installed), not with the window.
- Closing the window moves the views into a hidden window; reopening it moves them back. No page reloads.
- Quitting the app (including "Quit and End …") closes the browser; the conversations' omp lose their pages, as with any
  closed browser.
- An app update or a CEF update restarts the app. **Pages are not restored**: after the restart every Browser tab is
  empty (**call made here**: restoring them means keeping their URLs and owners on disk, left for later).
- **A restart of the server alone** (the app restarts a crashed server; CEF keeps running, and the server may come back
  on another port) keeps the page → conversation map and the conversations' tokens: they are kept on disk in the data
  folder, and the overlays of the conversations the new server takes over are rewritten with the new address (**call
  made here**: otherwise every page would lose its conversation).

### Focus

- A page the agent opens or navigates never takes keyboard focus from the composer or another app.
- The native view takes focus only when the person clicks into it.
- Nothing brings the app forward.

### Settings › Browser

- Shows what is installed (CEF in the app, CfT for the server alone), its version, and whether a newer one exists.
- Install / Update download into the data folder with progress and Cancel, like the app's own update.
- Update of CEF says the app restarts and the Browser tabs start empty.
- **Clear browser data** removes the profile (logins, cookies, storage, cache). It asks first, then restarts the app
  (CfT: the server restarts CfT) and deletes the profile before the browser starts again (**call made here**: a running
  browser keeps its profile open, and clearing it live over CDP misses saved data).
- Who may install, update and clear (decided with the person): **every page the server lets in as the person** — a page
  at this computer, and a remote one signed in with the person's account (through the tunnel: the Cloudflare Access
  sign-in `server/remote-auth.ts` verifies; on the network: the server's access token, `server/auth.ts`). That includes
  the app's remote windows, a browser tab and a phone. Clear asks first, wherever it is pressed. No pairing: the person
  judged that a page signed in as them is them (the risk they accepted: whoever holds the account can clear the
  browser's logins). The check is the server's own authentication of the request, as for any other route.

### Data

- Under the data folder: the CEF files (versioned), the CfT files (versioned), and **one profile per engine**. The two
  engines never open the same profile. In practice a person on the Mac only ever uses CEF's.
- New data-folder entries are classified in `server/migrate/layout.ts` (binaries: cache; profiles: machine-only).

### Docs

- `docs/TECHNICAL.md` and its zh-CN copy, a new `docs/agents/browser.md`, and the agent docs that mention omp's browser
  or relay.

## Risk that decides the first step

CEF's macOS tutorial lays the app out with `Chromium Embedded Framework.framework` and the helper apps (`… Helper.app`,
GPU, Renderer, Plugin) inside the host's `Contents/Frameworks`, and its code-signing notes sign that nested code. This
design downloads CEF into the data folder instead, so it relies on CEF's macOS settings that point elsewhere (the
framework directory, the main bundle path and the subprocess path in `CefSettings`) and on helpers signed outside the
app's bundle. That is **not verified**. The spike (below) proves or refutes it before anything else is built. If it does
not hold, the fallback options are: put CEF into the app's bundle at install time (it changes the app's signed contents,
so the app's signature and its fixed designated requirement have to be renewed by the installer), or bundle CEF with
the app (against "updates independently"). Either one goes back to the person before work continues.

## Left to the builder

- Spike CEF in the app first, before the rest: the `NSApplication` protocol, the message pump, loading CEF from the data
  folder after launch, the helper processes' signing (the app is signed with a local certificate, no hardened runtime,
  no entitlements, not notarized: `scripts/signing-identity.ts`), the off-window views, CDP over CEF's DevTools message
  API with no port (how much of the browser-level `Target` domain it answers), and showing a page at a fixed size scaled
  in the native view. Report what does not hold.
- Where CEF and CfT builds are downloaded from, and how a newer version is found (to be verified; candidates are CEF's
  published builds and CfT's version endpoints).
- The app ↔ server channel's framing for CDP messages and frames, and the screencast connection to the page.
- The proxy's token scheme and how omp's `cdpUrl` (an HTTP discovery endpoint plus a WebSocket) is served through it.
- The frame rate, quality and size policy of the screencast.
- The tests: e2e against CfT for the Browser tab, screencast and input; the proxy's refusal of untokened clients; the
  per-conversation filtering (an agent never sees another conversation's page) and the blank page; the overlay keys and
  `PI_BROWSER_RELAY=0`; a smoke run of the Mac app with CEF.
