---
title: The macOS app
summary: The native macOS app around the web UI: what quitting does (ask, run in background, quit), the menu bar icon, keeping the Mac awake, windows onto other Macs, and the server stream the app's notifications and menu come from.
settings: quit, sleep
---

# The macOS app

## What it does

The macOS app is a native window around the same page a browser gets. It starts its own server (data in its Application Support folder, port 7878 or the next free one) with the user's login shell environment, so omp and the tools it runs find what they find in a terminal. The app's main window is the whole app: its close button quits (as configured below). Pop-out windows (a subagent's live view) and windows onto other Macs are separate windows that close on their own.

**Quitting.** ⌘Q, the app menu, the window's close button and the Dock all do what Settings › Quitting the app says:

- **Ask** (default): a question with **Run in Background**, **Quit** and **Cancel**, and a **Don't ask again** box that makes Run in Background or Quit the standing answer.
- **Run in background**: the window closes and omp-webui keeps running: conversations carry on and remote access stays on. The app leaves the Dock and ⌘-Tab; the menu bar icon brings the window back.
- **Quit**: stops the server and the conversations that are working, with a warning first while any is working.

When something is at risk the question says what: conversations still working (quitting stops them; **Quit Anyway** / **Quit and End It/Them**), paused conversations (they stay frozen in the background, with running tools, and continue when the app is opened again; **Quit and End Paused**), conversations waiting for a usage limit (they stay in the background and omp retries when the limit resets; **Quit and End Waiting**), or an omp install/update in progress (it is not stopped and finishes in the background). Logging out, restarting, shutting down and updating the app always quit without asking; with the window already in the background, quitting only asks whether to quit. If the server does not answer, the app quits.

**Menu bar icon** (a `>_` in a rounded box). Its menu: **Open omp-webui**; how many conversations are working, need your input, or are paused ("No conversations working" otherwise); "N questions waiting" (opens the Questions page) and "N conversations finished" when there are any; **Pause All Conversations** (every conversation whose turn is open) and **Resume All Paused Conversations**; one line per provider with what is left of its quota window that runs out first and when it frees up; **Quit omp-webui**. Beside the icon: the number of conversations and questions waiting for the person, and a ✓ when a run finished since the menu was last opened. The icon is always there while the app runs in the background; beside the window only while **Always show the menu bar icon** is on (default on).

**Notifications.** The app shows notifications itself (the page in its window shows none), from a stream its server sends it: when a conversation needs the person (a tool approval or question) or finishes, unless the person is looking at that conversation in the app's focused window. Clicking one opens the window on that conversation. Whether they are wanted is Settings › Conversations & files › Notifications; macOS's permission is the app's (see the notifications topic). This works with no window open.

**Keep the Mac awake.** While a conversation is working the server runs macOS's `caffeinate -i` so that the Mac does not go to idle sleep and cut a turn in half. The display still sleeps, and closing the lid still sleeps the Mac. A conversation that is paused, waiting for an answer, waiting out a provider's usage limit, or held at the quota floor does not keep the Mac awake. When the Mac does sleep, each conversation that was working gets a line in its transcript saying it was interrupted and what followed when it woke; nothing is sent again on the person's behalf. This is the server's doing, so it applies to the web version on a Mac too; on a machine that is not a Mac it is not available.

**Other Macs** (macOS 14 and later). The app keeps a list of up to 10 other Macs whose omp-webui is reachable through remote access (Cloudflare Access; see the remote-access topic), and opens a window onto each: the page that Mac serves, in a web view with its own sign-in store (one per Cloudflare team, so one Access sign-in covers that team's Macs), a content blocker that keeps the remote page away from this Mac and its network, and a bar above the page the page cannot paint over: **REMOTE**, the Mac's name and host, where the sign-in stands (Connecting…, Signing in at …, Connected, Sign-in refused, Different sign-in team, Stopped an unexpected page, Can't reach this Mac) and **Disconnect**. Adding a Mac checks its address first (that it is behind Cloudflare Access, and which team). A Mac's address must be an https public host name: no port, path, user name, IP address, private name (`localhost`, `.local`…), trailing dot, or Cloudflare Access sign-in domain; names are at most 60 characters and unique. Per Mac, the person can turn on notifications of that Mac's conversations (off until turned on): the app then keeps a connection to that Mac's `/api/notify/events`, signed in with the same cookies as that Mac's window, and shows that Mac's notices named by the Mac; a click opens that Mac's window.

## Where it is

- **Settings › App & system › Quitting the app** (`#/settings/app`; shown only in the macOS app): **When you quit the app**: Ask / Run in background / Quit, and **Always show the menu bar icon**.
- **Settings › App & system › Sleep**: **Keep the Mac awake while a conversation works**. Disabled on a remote page ("This is changed on the computer omp-webui runs on…") and on a server that is not on a Mac.
- The menu bar icon (see above).
- **Macs** menu in the app's menu bar (between View and Window, macOS 14+): the saved Macs (each opens its window), **Add Mac…** (sheet "Add a Mac": Name, Address, **Check**, **Add**, **Add Anyway**), **Manage Macs…** (rename, **Sign Out** — also signs out the other Macs of the same Cloudflare team —, **Forget…**; shows Address, Cloudflare team, Last connected), and "Notify me about conversations of:" with one switch per Mac.
- Sidebar machine switcher (a row under New chat, shown once at least one other Mac is saved, not in a window onto another Mac): **This Mac** and each saved Mac with when the app last opened it; **Add Mac…** on this computer. A saved Mac opens in the app's window for it, or in a new browser tab in a browser.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.quitAction` | `ask`, `background`, `quit` | unset (`ask`) | Synced preference. What quitting the macOS app does. The app reads it from the server when asked to quit, and writes it when the person ticks **Don't ask again**. Any other value reads as `ask`. |
| `ompw.menuIcon` | `on`, `off` | unset (on) | Synced preference. Whether the menu bar icon is shown while the app also has its window. It is always shown while the app runs in the background. The app hears changes from `/api/shell/events`. |
| `ompw.keepAwake` | `on`, `off` | unset (on) | Synced preference. Whether the server keeps the Mac from idle sleep while a conversation works. Applied by the server as it changes. Only a page on this computer may change it (`/api/prefs` refuses it from any other page). |

Other stored values:

| Stored in | Content | Effect |
|---|---|---|
| `remote-macs.json` in the data folder | `{ version: 1, macs: [ { id, name, host, team, storeId, added, lastConnected } ] }`, at most 10 entries, mode 0600 | The other Macs. Written only by the server (the app asks it through `/api/macs*` and reads the file itself, so the Macs menu works while the server is down). Holds no secret: the sign-in is in the app's web data store that `storeId` names. An unreadable file is kept as `remote-macs.json.damaged` before the next change. |

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/macs` | POST | local-only | Add a Mac: body `{ name, address, team? }`. Returns `{ mac }`. 400 with `{ error, problem }` when the name or address is refused or the list is full. Every open page is told the list changed (pages read it from `/api/meta` as `macs`). |
| `/api/macs/<id>` | DELETE | local-only | Forget a Mac (the app deletes its saved sign-in itself). Returns `{ ok: true }`; 404 if unknown. |
| `/api/macs/<id>/rename` | POST | local-only | Body `{ name }`. Returns `{ mac }`. |
| `/api/macs/<id>/connected` | POST | local-only | The app had a window of this Mac signed in: sets `lastConnected`. |
| `/api/macs/<id>/team` | POST | local-only | Body `{ team }`: keep the Cloudflare team of this Mac's sign-in (only the first one seen is kept). |
| `/api/shell` | — | local-only | Prefix of the macOS app's own routes below (no route of its own). |
| `/api/shell/events` | GET | local-only | The app's stream: newline-delimited JSON, query `lang`, `epoch`, `since`. Lines `{ t: "state", epoch, working, asking, paused, menuIcon, questions, finished }` (first, then on every change), `{ t: "attention", seq, id, kind, title, body, liveId, file }` (`kind` `asking` or `finished`; only while notifications are on; missed ones re-sent after `since`), and an empty heartbeat line every few seconds. |
| `/api/shell/quota` | GET | local-only | The menu bar icon's quota lines: `{ lines: [...] }`, in the saved language else `lang`; empty when omp or a provider cannot say. |
| `/api/shell/pause-all` | POST | local-only | Pause every conversation whose turn is open (working or waiting for an answer). Returns `{ changed, of }`. |
| `/api/shell/resume-all` | POST | local-only | Resume every paused conversation. Returns `{ changed, of }`. |
| `/api/shell/background` | POST, DELETE | local-only | POST: the app is about to close its window for Run in Background, so the terminals of that page are held (with the tail of their output) for the window that opens next, for 10 s. DELETE: the window came back first. Returns `{ held }`. |
| `/api/notify/events` | GET | token; only for a request that came through Cloudflare Access (another Mac's app, with that Mac's window cookies) or from this computer | The same stream as `/api/shell/events`, for the app of another Mac that has this one in its list. It does not depend on this Mac's notification setting, and ends when the Access token expires or remote access is changed or turned off. A page over a network address is refused (403). |

The app also uses routes documented elsewhere: `/api/prefs` (quit choice, language), `/api/lives` and `/api/omp` (what a quit would stop), `/api/lives/end-kept` (the "Quit and End…" answers), `/api/remote` (whether remote access is on).

## Limits and caveats

- Quitting the app, Run in Background and the menu bar icon exist only in the macOS app; a browser has none of them.
- Windows onto other Macs, the Macs menu and other Macs' notifications need macOS 14 or later, and remote access set up on the other Mac.
- At most 10 other Macs; a name at most 60 characters.
- Keep awake holds off idle sleep only; the display and a closed lid still sleep. It needs macOS's `caffeinate`.
- A conversation waiting out a usage limit counts as working on the menu bar icon but does not keep the Mac awake.

## Security notes

- `/api/macs*` and `/api/shell*` are local-only: a page through the tunnel or the network cannot change the list of Macs or read the app's stream (which holds conversation titles), whatever token it holds. The server checks `/api/macs*` a second time itself.
- `/api/notify/events` is deliberately not local-only: it admits a request that passed Cloudflare Access (valid token for this application, an allowed email) and holds the access token, or one from this computer; a page on a network address is refused.
- A window onto another Mac has its own data store and a content blocker keeping that page away from this Mac and its network; signing out deletes the saved sign-in from this computer only and changes nothing on the other Mac.
- The keep-awake switch can be changed only on this computer, so a remote page cannot let the Mac sleep under conversations it is driving.
- Agents should not change the quit behaviour, the menu icon, keep-awake or the list of Macs unless the user asks.
