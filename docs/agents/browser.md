---
title: The built-in browser
summary: The browser each conversation's agent browses in (CEF inside the Mac app, Chrome for Testing when the server runs alone), the side panel's Browser tab that shows and drives that conversation's pages, and Settings › Browser, which installs, updates and clears it.
settings: browser
---

# The built-in browser

## What it does

omp-webui owns the browser its conversations' agents browse in: **CEF** inside the macOS app, or **Chrome for Testing** (CfT) that the server starts itself when it runs alone. Neither opens a debugging port, and the person's own Chrome is never used.

Every page belongs to one conversation (its session file): a conversation's agent sees and uses only its own pages, and the side panel's **Browser** tab of that conversation lists only those. The agent and the person share that conversation's pages: what the agent opens the person sees, and the person can click and type into it while the agent works.

**The Browser tab** (side panel, lower pane by default):

- the conversation's pages as tabs (each with a close button), and **New page** (+);
- **Back**, **Forward**, **Reload** and an address field: Enter goes to what is typed (`localhost:3000` gets `http://`, anything else without a scheme `https://`). With no page yet, the tab says so and the address field opens one;
- the page size: **Desktop** (laid out at 1280×800 by default, or the size set in Settings › Browser, and shown scaled down to the panel, so the agent's screenshots, the Mac, a browser tab and a phone all show the same layout), **Panel** (laid out at the size of the panel that last changed it) and **Phone** (390×844, as a phone). Phone is a phone to the sites too: the page says it is Chrome on an Android phone (user agent and the client hints `Sec-CH-UA-Mobile: ?1` and `Sec-CH-UA-Platform: "Android"`, the browser's own major version) with touch, and is loaded again when it changes between Phone and the other sizes, so a site that sends phones another page sends that one, not its desktop page squeezed onto 390 px; Desktop and Panel send the browser's own user agent again. The page's layout size is shown beside it;
- the page itself: in a browser tab, on a phone and in the app's windows onto other Macs, a live screencast that takes clicks, taps, the wheel (a finger dragged scrolls), keys and typed or composed text (an IME, a phone's keyboard) in the page's own coordinates. The page takes the keyboard only after the person clicks or taps into it; it never takes it from the message box by itself. In the Mac app's own windows a native view of the page is laid over the tab instead, and hides while a menu, popover or dialog of the web page is over it;
- **Full screen** and **Open in a new window**, beside the address field. Full screen shows the conversation's browser over the whole window (`#/s/<file>/browser`: Back, **Exit full screen** or Escape leave it — in the Mac app's native view, which has the keyboard once it is clicked, the app tells the page of an Escape (`ompw-native-escape`) and the full screen ends, while the key still goes on to the page; a reload keeps it); a new window shows it and nothing else (`/?popout#/s/<file>/browser`, a native window in the Mac app, which has its own **Full screen** for the window). It starts on the page the tab showed. The browser is shown in one place at a time: while it is full screen or in a window of its own, the side panel's tab says so and offers **Show it here** (which leaves the full screen, or closes the window), and the full screen does the same while it is in a window. The window tells the app's other pages of the same address that it is open (a `BroadcastChannel`, every second, and when it closes);
- the console strip: what the page logs and the requests that fail, read from that page's own session (never another conversation's). **Send to agent** on an error puts `Console error on <url>: <text>` into the message box.

When the browser is not installed, the tab says so and offers **Install** to a page that may install it (see Security notes); otherwise it points to Settings › Browser. When the browser cannot be used (it failed to start, it restarted), the tab says why.

**Settings › Browser**: **Use the built-in browser** (on by default; off, there is no Browser tab in the side panel, every page of the browser closes, no conversation is given its endpoint and omp's own browser is turned off too, `browser.enabled: false` in each conversation's overlay, so the agents have no browser at all until it is turned on again; only a page that may manage the browser can turn it off or on), the engine this server drives, the version installed and the newest one known (**Check for a newer version** looks it up), **Install** / **Update** (download into the data folder with progress and **Cancel**), **Clear browser data** (asks first; removes logins, cookies, storage and the cache: CfT restarts and its pages close; with CEF the app restarts by itself and removes the profile as it starts, and every Browser tab starts empty), **Uninstall** (asks first; removes the engine and its profile: CfT stops and its folders go now; with CEF the app restarts by itself and removes `cef/` and `cef-profile/` as it starts, before loading anything; until it is installed again the conversations' agents use omp's own browser, unless the browser is turned off), a note while the app still has to restart to finish (it was not restarted: the person cancelled the quit question), and **Size of new pages** (width × height of the Desktop layout).

**How a conversation's agent browses in it.** omp's browser tool is pointed at the built-in browser, never at omp's own hidden Chromium or the person's Chrome. The server writes two lines into the conversation's own settings overlay (the `--config` file omp is started with and reloads when it changes): `browser.cdpUrl`, the conversation's endpoint, and `browser.relay: false`; and it starts every omp with `PI_BROWSER_RELAY=0`, so omp's relay to the person's Chrome is off either way. The endpoint is `http://<token>@127.0.0.1:<port>`: omp asks it for `/json/version` (the token travels as the URL's user name) and is sent on to `/browser-cdp/<token>/devtools/browser`. Each conversation has a token of its own, kept with the page owners in `owners.json` in the data folder; a conversation gets its endpoint once it has a session file, and the server writes it again when it comes up on another port or when the browser is installed. While the browser is not installed no `browser.cdpUrl` is written, and omp uses its own hidden Chromium as before.

What the endpoint lets a conversation see: its own pages only. Target discovery, the target list and attaching see nothing else, and a command that names another conversation's page or session is refused (`Not this conversation's page`). A page the conversation creates, and a page one of its pages opens (`window.open`, a link to a new tab), is that conversation's and shows as another tab of its Browser tab, never as a window. omp attaches to a page that is there rather than making one, so a conversation with no page gets a blank one before its first answer, and that is the page its Browser tab shows. `Browser.close` from the agent ends its own connection, not the browser. Commands about the whole browser (cookies, downloads) go through: the login state is one, shared by every conversation and the person.

Deleting a conversation closes its pages and forgets its token; archiving it closes its pages. A conversation moved to another folder (omp's `/move`) keeps its pages and its endpoint.

**What a session sets on a page ends with it (CEF).** Over CEF every session on a page shares the page's one DevTools channel, so the server remembers, per page, what each session sets that lasts (`Fetch.enable`, `Emulation.set*` such as the size and the user agent, `Network.setExtraHTTPHeaders`, `Page.setInterceptFileChooserDialog`, …: `LASTING` in `server/browser/cef.ts`) and, when that session detaches or its connection ends, gives the page back what the session before it set, or undoes it (`Fetch.disable`, `Emulation.clearDeviceMetricsOverride`, …). A held request goes to the session that holds the interception now. Chrome for Testing gives each session its own state and needs none of this.

**Windows popped out for one conversation.** Each window says over a `BroadcastChannel` that it is open, with an id of its own, and the other pages show the browser in the panel again only when no window of that conversation is open: closing one of two windows leaves it out of the panel until the other one closes (or stops saying so for a few seconds, as a crash does).

**The engines.** Without the Mac app the engine is Chrome for Testing: the server installs it from Settings › Browser and starts it itself, headless, the first time a conversation or a Browser tab needs it, speaking to it over `--remote-debugging-pipe` (Chrome reads and writes CDP on two inherited pipes and opens no port). In the Mac app the engine is CEF, inside the app's own process: the app starts its server with `OMP_WEBUI_BROWSER_ENGINE=cef`, the server installs CEF into the data folder (only a build that supports the CEF API version the app was built against), and the app loads it from there at launch. The app connects to the server's `/browser-engine` WebSocket and, on it, reports its pages and carries each page's DevTools channel; the server answers the browser-level CDP `Target` domain itself from that list, so CEF opens no debugging port either. CEF is loaded once per run of the app, so after installing it, a new CEF version or Clear the app restarts by itself: the server tells this computer's app, which quits as it does for ⌘Q (without offering Run in Background: while a conversation is still working it asks first, and paused conversations and ones waiting out a usage limit stay) and opens again, deleting the profile first after a Clear and then loading the installed version. If the person cancels that question, the app keeps running as it was and Settings › Browser says *Restart the app to finish*. Each engine has a profile of its own: logins are not carried from one engine to the other.

**In the Mac app's own windows.** The app's main window and its pop-outs, while CEF runs, lay CEF's own view of the page over the Browser tab instead of the screencast; one view at a time, in the window whose tab placed it last (a tab of another window that hides or is covered does not take it away, and a window that closes gives it back to the hidden window). The tab tells the app where its page area is, the page's layout size and its size mode, and tells the server the room the view has (`fit`); the server lays the page out at its size (Desktop, Panel, Phone) with a scale that fits it into that room, drawn sharp at the screen's own pixel ratio (a phone keeps its own), and the app places the view there, centred at the top and cut to its size, hides it while a menu, popover or dialog of the web page is over it, and moves it to a hidden window when the tab shows no page (the page keeps running, and other windows still see it through the screencast). The fit ends with the tab that set it (it stops watching, or its socket closes): the page is drawn unscaled for the screencasts again. Closing the window keeps every page running in that hidden window; quitting the app closes them. **Developer tools** there opens CEF's own DevTools window for the page. Browser tabs, phones and windows onto other Macs always show the screencast; a window onto another Mac shows that Mac's browser (its pages, its logins, its `localhost`), never this Mac's. A page takes the keyboard only when clicked: never because it loaded or the agent navigated it.

## Where it is

- Side panel › **Browser** tab of a conversation (a conversation not saved to a file yet has no pages).
- **Settings › App & system › Browser** (`#/settings/app`), found by the search as *Browser*.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.browserSize` | `<width>x<height>`, each 320–3840 CSS px | unset (1280×800) | Synced preference. The Desktop layout size a page gets the first time a Browser tab shows it. |
| `ompw.browser` | `on`, `off` | unset (on) | Synced preference. Off: no Browser tab, every page closed, no endpoint, and `browser.enabled: false` in every conversation's overlay. `/api/prefs` refuses to change it (403) from a page that may not manage the browser. |

Other stored values: the engines and profiles are in `browser/` of the server's data folder (`cft/<version>/`, `cef/<version>/`, `cft-profile/`, `cef-profile/`, `current.json`, which says what is installed and holds a CEF Clear or Uninstall that the app carries out when it starts again, and `owners.json`, which page belongs to which conversation and each conversation's endpoint token). Only the installed version is kept: the server removes the CfT versions an update replaced, and the app the CEF ones, when it starts and before it loads CEF. `browser/` is not moved to another computer (Move to another computer): the new computer installs its own browser and signs in again.

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/browser` | GET | token | The install state: `engine` (`cft` or `cef`), `installed` version, `latest`, the running `job` (`install`, `update`, `clear` or `uninstall`, bytes received/total), `error`, `restartNeeded`, and `canManage` (whether this page may install, update, clear and uninstall). |
| `/api/browser/check` | POST | token, and this computer or a verified Access sign-in | Look up the newest version now; answers the state. |
| `/api/browser/install` | POST | token, and this computer or a verified Access sign-in | Install the newest version, or update to it (202; progress comes as `browser_state` on the page's socket). |
| `/api/browser/cancel` | POST | token, and this computer or a verified Access sign-in | Stop an install or update. |
| `/api/browser/clear` | POST | token, and this computer or a verified Access sign-in | Clear the browser's profile (202). |
| `/api/browser/uninstall` | POST | token, and this computer or a verified Access sign-in | Remove the engine and its profile (202; with CEF the app removes them at its next start, and is asked to restart). |

The five POST routes answer 403 with `problem: "browserNotHere"` to any other page. The Browser tab talks over its own WebSocket, `/ws/browser` (same sign-in as the page's socket): the page list, console entries and JPEG frames from the server; watch, open, close, navigate, size, fit (the Mac app's own view) and input from the page.

The browser's own endpoints, outside `/api`:

| Endpoint | Kind | Access | Purpose |
|---|---|---|---|
| `/browser-cdp/<token>/json/version`, `/json`, `/json/list` | GET | this computer only, without an `Origin` header (never a web page), the conversation's token | A conversation's CDP discovery: the browser's version and `webSocketDebuggerUrl`, and the list of its own pages (making a blank one when it has none). 401 for a token that is no conversation's, 403 while the browser is turned off, 503 while the browser cannot be used. |
| `/json/version`, `/json`, `/json/list` | GET | as above, with the token as the URL's user name (HTTP Basic) | The same discovery at the server's root, for the endpoint omp is given (`http://<token>@127.0.0.1:<port>`). |
| `/browser-cdp/<token>/devtools/browser`, `/browser-cdp/<token>/devtools/page/<id>` | WebSocket | as above | The conversation's CDP connection: the whole browser seen as its own pages, or one of its pages. |
| `/browser-engine` | WebSocket | this computer only, without an `Origin` header, only while the engine is CEF, and only with the exact token the app started the server with (`x-omp-webui-token` equal to `OMP_WEBUI_TOKEN`, whatever `OMP_WEBUI_AUTH` says) | The Mac app's CEF: its pages and each page's DevTools channel; the server asks it to make and close pages. |

## Limits and caveats

- One set of pages per conversation, shared by its agent and the person. omp attaches to a page and makes none of its own, so every tab name the agent uses (`main`, `docs`) lands on that conversation's current page.
- A conversation not saved to a file yet has no pages and no endpoint; until it has one its agent uses omp's own hidden Chromium.
- With CEF, a conversation is given its endpoint only while the app's CEF is connected: before the restart that follows an install, or when CEF failed to load, its agent uses omp's own hidden Chromium, and the endpoints are given once the app's CEF says hello.
- Pages are not restored after the browser or the app restarts (an update, Clear, quitting the app): every Browser tab starts empty. A restart of the server alone keeps which page is whose and each conversation's endpoint.
- Installing CEF, a new CEF version and Clear with CEF restart the app, which stops the conversations that are working (after the quit question) as any quit does.
- The screencast follows what the connection carries: through the tunnel it is less smooth than on this computer.
- A page sized by Settings › Browser is sized when a Browser tab first shows it; a page shown before keeps its size.

## Security notes

- Installing, updating and clearing are for a page on this computer or a page signed in through Cloudflare Access with the person's account; a page that holds only the access token (or none, with authentication off) may view and use the Browser tab but not manage the browser. The server decides from the request's own authentication.
- No engine opens a debugging port: CfT is driven over a pipe the server holds, CEF over the app's `/browser-engine` connection. A conversation's endpoint answers only this computer, never a request with an `Origin` (so no web page, through the tunnel or not), and only with a token the server gave a conversation; with it, a conversation reaches only its own pages.
- `/browser-engine` takes only the app that started the server: on this computer, with the app's own token, and only when the server was started for CEF.
- In the Mac app, the view over the Browser tab takes messages only from the main frame of the server's own page in the app's own windows (the main window and its pop-outs).
- Commands about the whole browser are not filtered: any conversation's agent can read or clear the shared cookies, as the person can. An agent that asks omp for another browser in its own call (omp's relay, another CDP address, an app path) is not stopped.
- Downloads come only from Google's storage (CfT, checked against the MD5 Google lists) and CEF's build server (checked against the index's SHA-1).
- The engines never use the macOS keychain: CfT runs with `--use-mock-keychain --password-store=basic`, CEF with `--use-mock-keychain`, so macOS never asks for the keychain. The profiles are kept by the data folder's own permissions.
- Chrome's sandbox is kept wherever it works. On Linux it needs unprivileged user namespaces, which Ubuntu 23.10 and later (AppArmor), many containers and CI runners refuse: there Chrome for Testing aborts at once ("No usable sandbox!"), and the server starts it again with `--no-sandbox` and logs that it runs without one.
