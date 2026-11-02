---
title: The built-in browser
summary: The browser each conversation's agent browses in (CEF inside the Mac app, Chrome for Testing when the server runs alone), the side panel's Browser tab that shows and drives that conversation's pages, and Settings › Browser, which installs, updates and clears it.
settings: browser
---

# The built-in browser

## What it does

omp-webui owns the browser its conversations' agents browse in: **CEF** inside the macOS app, or **Chrome for Testing** (CfT) that the server starts itself when it runs alone. Neither opens a debugging port, and the person's own Chrome is never used.

Every page belongs to one conversation (its session file): a conversation's agent sees and uses only its own pages, and the side panel's **Browser** tab of that conversation lists only those.

**The Browser tab** (side panel, lower pane by default):

- the conversation's pages as tabs (each with a close button), and **New page** (+);
- **Back**, **Forward**, **Reload** and an address field: Enter goes to what is typed (`localhost:3000` gets `http://`, anything else without a scheme `https://`). With no page yet, the tab says so and the address field opens one;
- the page size: **Desktop** (laid out at 1280×800 by default, or the size set in Settings › Browser, and shown scaled down to the panel, so the agent's screenshots, the Mac, a browser tab and a phone all show the same layout), **Panel** (laid out at the size of the panel that last changed it) and **Phone** (390×844, as a phone). The page's layout size is shown beside it;
- the page itself: in a browser tab, on a phone and in the app's windows onto other Macs, a live screencast that takes clicks, taps, the wheel (a finger dragged scrolls), keys and typed or composed text (an IME, a phone's keyboard) in the page's own coordinates. The page takes the keyboard only after the person clicks or taps into it; it never takes it from the message box by itself. In the Mac app's own window a native view of the page is laid over the tab instead, and hides while a menu, popover or dialog of the web page is over it;
- the console strip: what the page logs and the requests that fail, read from that page's own session (never another conversation's). **Send to agent** on an error puts `Console error on <url>: <text>` into the message box.

When the browser is not installed, the tab says so and offers **Install** to a page that may install it (see Security notes); otherwise it points to Settings › Browser. When the browser cannot be used (it failed to start, it restarted), the tab says why.

**Settings › Browser**: the engine this server drives, the version installed and the newest one known (**Check for a newer version** looks it up), **Install** / **Update** (download into the data folder with progress and **Cancel**), **Clear browser data** (asks first; removes logins, cookies, storage and the cache: CfT restarts and its pages close; with CEF the app restarts to do it and every Browser tab starts empty), a note when the app has to restart to finish, and **Size of new pages** (width × height of the Desktop layout).

## Where it is

- Side panel › **Browser** tab of a conversation (a conversation not saved to a file yet has no pages).
- **Settings › App & system › Browser** (`#/settings/app`), found by the search as *Browser*.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.browserSize` | `<width>x<height>`, each 320–3840 CSS px | unset (1280×800) | Synced preference. The Desktop layout size a page gets the first time a Browser tab shows it. |

Other stored values: the engines and profiles are in `browser/` of the server's data folder (`cft/<version>/`, `cef/<version>/`, `cft-profile/`, `cef-profile/`, `current.json`, and `owners.json`, which page belongs to which conversation).

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/browser` | GET | token | The install state: `engine` (`cft` or `cef`), `installed` version, `latest`, the running `job` (`install`, `update` or `clear`, bytes received/total), `error`, `restartNeeded`, and `canManage` (whether this page may install, update and clear). |
| `/api/browser/check` | POST | token, and this computer or a verified Access sign-in | Look up the newest version now; answers the state. |
| `/api/browser/install` | POST | token, and this computer or a verified Access sign-in | Install the newest version, or update to it (202; progress comes as `browser_state` on the page's socket). |
| `/api/browser/cancel` | POST | token, and this computer or a verified Access sign-in | Stop an install or update. |
| `/api/browser/clear` | POST | token, and this computer or a verified Access sign-in | Clear the browser's profile (202). |

The four POST routes answer 403 with `problem: "browserNotHere"` to any other page. The Browser tab talks over its own WebSocket, `/ws/browser` (same sign-in as the page's socket): the page list, console entries and JPEG frames from the server; watch, open, close, navigate, size and input from the page.

## Limits and caveats

- Pages are not restored after the browser or the app restarts (an update, Clear): every Browser tab starts empty. A restart of the server alone keeps which page is whose.
- The screencast follows what the connection carries: through the tunnel it is less smooth than on this computer.
- A page sized by Settings › Browser is sized when a Browser tab first shows it; a page shown before keeps its size.

## Security notes

- Installing, updating and clearing are for a page on this computer or a page signed in through Cloudflare Access with the person's account; a page that holds only the access token (or none, with authentication off) may view and use the Browser tab but not manage the browser. The server decides from the request's own authentication.
- Downloads come only from Google's storage (CfT, checked against the MD5 Google lists) and CEF's build server (checked against the index's SHA-1).
- Every Chrome omp-webui starts uses a mock keychain and a basic password store, so macOS never asks for the keychain.
