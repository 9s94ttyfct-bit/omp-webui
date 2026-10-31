---
title: Remote access
summary: Reaching omp-webui from other devices through a Cloudflare tunnel protected by Cloudflare Access, with per-feature limits on what remote pages may do.
settings: remote, remote-shell
---

# Remote access

## What it does

The server runs `cloudflared`, which carries `https://<hostname>` to this computer's omp-webui server; Cloudflare Access asks who the visitor is before anything is served. omp-webui verifies every remote request itself: the request must be addressed to the configured hostname exactly (and, if it names an origin, to `https://<hostname>`), and carry a Cloudflare Access JWT (the `cf-access-jwt-assertion` header or a `CF_Authorization` cookie) that is RS256-signed by the team's published keys, issued by `https://<team>.cloudflareaccess.com`, for the configured AUD, unexpired (60 s clock skew allowed) and for an email on the allow-list (compared case-insensitively, ASCII only). A verified remote page is given the access-token cookie; it never sees or exchanges the token itself. Each new Access session is logged to the server console ("remote access by <email>").

Remote access is on only when it is enabled **and** hostname, team, AUD and at least one email are all set; a half-filled or unreadable `remote.json` means off. When the hostname, team, AUD or allow-list change (or remote access is turned off), remote pages connected under the old settings are disconnected and must pass Access again; their conversations continue. A remote page's WebSocket is closed (code 4401) when its Access token expires, and the page reconnects through Access.

Set-up steps (each a button on the card, and each a method the AI help can call):

1. **Install cloudflared**: `brew install cloudflared` (needs Homebrew; otherwise install it manually and come back).
2. **Log in to Cloudflare**: runs `cloudflared tunnel login`; the card shows an "Open the sign-in page" link. Logged in means `~/.cloudflared/cert.pem` exists.
3. **Set up the tunnel**: creates a tunnel named `omp-webui-<hostname with dots as dashes>` (once) and routes the hostname's DNS to it. Needs cloudflared installed, the login done and a saved hostname.
4. **Start the tunnel**: sets `enabled` to true and runs the tunnel; it is restarted with back-off if it ends. Refused if the hostname changed since set-up ("set up the tunnel again") or settings are missing.
5. **Stop the tunnel**: sets `enabled` to false and stops it.

The Access application is created by the user in the Cloudflare dashboard (the card shows a guide: Zero Trust › Access › Applications › Add an application › Self-hosted; same hostname or a wildcard; an Allow policy with the emails; copy the AUD tag). Optional: session duration 1 month to sign in about once a month (both Cloudflare defaults are 24 hours).

**Check the address** makes one unauthenticated GET of `https://<hostname>/` from this computer (10 s limit, redirects not followed) and explains what it found: OK when Cloudflare Access redirects to the matching `<team>.cloudflareaccess.com` sign-in, otherwise where the way in is broken (DNS, tunnel, this app, Access application, wrong team). It changes nothing.

**AI help** ("Let the AI help with remote access", off by default): **Set up with AI** starts a conversation (in its own folder, `~/.omp-webui/remote-help`) whose agent gets nine tools: `remote_access_guide`, `remote_access_status`, `remote_access_check` (read-only, always allowed) and `remote_access_install`, `remote_access_login`, `remote_access_save`, `remote_access_setup`, `remote_access_start`, `remote_access_stop` (go through omp's tool approval). They call the same code as the card's buttons. The agent may save only hostname, team, AUD and emails; it can never change `enabled`, `autostart` or the AI-help switch, never sees a token, the login URL or tunnel credentials, and is refused while a page that is not on this computer is attached to that conversation. Turning the switch off takes the tools away from every conversation at once.

**Confirm risky commands from remote pages** (`confirmRisky`, off by default): when a page that is not on this computer sends or steers a turn, a high-risk tool call (sudo, deleting/overwriting outside the project folder, `git push --force`, `git reset --hard`, a download piped into a shell, broad permission changes, `~/.ssh`, `~/.omp` or this app's data, launchctl, osascript, tunnels, the remote-access tools) waits for Allow or Deny on that page before it runs. Everything else follows the conversation's permission mode; a page on this computer is never asked. If the conversation's omp started without the gate, a remote page's turn is refused with an explanation ("Continue it on this computer, or open it again there").

**Let remote pages open a shell** (`remoteShell`, on by default): the side panel's Terminal tab is a login shell on this computer in the conversation's folder. With this on, a remote page can open one too; turning it off refuses new shells to remote pages ("Shells are off for remote pages …") and ends the ones they have open. The same switch covers omp's own shell console (any omp command line containing `shell`) on the Commands & terminal page.

**Share these settings with another Mac**: **Export settings** saves `omp-webui-remote-access.json` holding only team, AUD and emails (no hostname, tunnel or credentials); **Import settings…** fills the form from such a file (max 64 KB, max 200 emails, version 1) and the user then adds this Mac's hostname and saves. One Access application with a wildcard domain can serve several Macs.

### What a remote page can and cannot do

A page reached through the tunnel (or over a network address, see server-and-security) holding a valid login:

- **Can**: use conversations (read, send, steer, approve), start new chats, read most settings, download/upload files as `fileTransfer` allows (see file-transfer), open a Terminal shell if `remoteShell` is on, receive push notifications.
- **Cannot**: any `/api/remote*`, `/api/guard*`, `/api/update*`, `/api/migrate*`, `/api/memory*`, `/api/shell*`, `/api/macs*` route (403); change a conversation's guard or see the Guard page; change the projects folder, the model guidance templates, the unattended instruction or "Keep the Mac awake"; use `/?token=` or `/api/auth`. Settings shows "This page is not on the Mac the server runs on, so the tunnel cannot be changed from here."

## Where it is

- **Settings › App & system › Remote access** (`#/settings/app`): status ("Tunnel: Off / Starting… / Connected / Not running"), public address with Copy, the five step buttons, Hostname, Cloudflare team, Application AUD (AUD tag), Allowed e-mail addresses (one per line), Start the tunnel with the app, Confirm risky commands from remote pages, File transfer, Let remote pages open a shell, Let the AI help with remote access, Set up with AI, Check the address, the Access application guide, and Share these settings with another Mac.
- A remote indicator ("Remote off / Remote starting… / Remote connected / Remote not running") links to Settings › Remote access.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `remote.json:enabled` | `true`, `false` | `false` | Whether remote access is wanted. Set to `true` by Start the tunnel and `false` by Stop the tunnel; remote access is on only if hostname, team, aud and emails are also set. |
| `remote.json:hostname` | A DNS name of at least two labels (letters, digits, dashes; max 253 chars; last label not all digits), lower-cased; or `""` | `""` | The public name, e.g. `omp.example.com`; the public URL is `https://<hostname>`. |
| `remote.json:team` | 1–63 of `a-z`, `0-9`, `-`, lower-cased; or `""` | `""` | Cloudflare team: the first part of `<team>.cloudflareaccess.com`. |
| `remote.json:aud` | 64 hexadecimal characters, lower-cased; or `""` | `""` | AUD tag of the Access application; tokens for another application are refused. |
| `remote.json:emails` | List of email addresses (printable ASCII, max 254 chars each), lower-cased, de-duplicated | `[]` | Allow-list: only these addresses get in, even if the Access policy allows more. |
| `remote.json:autostart` | `true`, `false` | `false` | Start the tunnel when the server starts (only if remote access is complete, a tunnel was set up and cloudflared is installed). |
| `remote.json:confirmRisky` | `true`, `false` | `false` | Ask the remote page to Allow/Deny high-risk tool calls in turns it drives. |
| `remote.json:remoteShell` | `true`, `false` | `true` | Whether pages not on this computer may open a Terminal shell; off also ends their open shells. |

`remote.json` also holds `tunnelId` and `tunnelName`, written by the server at set-up and never settable from a page. The AI-help switch is stored separately:

| Stored in | Field | Values | Default | Effect |
|---|---|---|---|---|
| `~/.omp-webui/remote-ai.json` | `enabled` | `true`, `false` | `false` | "Let the AI help with remote access". |

The environment variable `OMP_WEBUI_REMOTE_CONFIG` overrides the path of `remote.json`; `OMP_WEBUI_REMOTE_CHECK_URL` overrides the URL used by Check the address.

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/remote` | GET | local-only | Snapshot: `config`, tunnel `status` (`off`, `starting`, `connected`, `error` + message), `installed`, `loggedIn`, `url`, `loginUrl` (while a login is pending), `ai` (`enabled`, conversations holding the tools). |
| `/api/remote/config` | POST | local-only | Save a partial config (`enabled`, `hostname`, `team`, `aud`, `emails`, `autostart`, `confirmRisky`, `fileTransfer`, `remoteShell`); an invalid value refuses the whole change (400); `tunnelId`/`tunnelName` are ignored. `enabled: false` also stops the tunnel. |
| `/api/remote/install` | POST | local-only | Install cloudflared with Homebrew. |
| `/api/remote/login` | POST | local-only | Start `cloudflared tunnel login`; returns the snapshot plus `loginUrl`. |
| `/api/remote/setup` | POST | local-only | Create the tunnel (if none) and route the hostname's DNS to it. |
| `/api/remote/start` | POST | local-only | Enable remote access and start the tunnel. |
| `/api/remote/stop` | POST | local-only | Disable remote access and stop the tunnel. |
| `/api/remote/check` | POST | local-only | Check the public address from outside; returns `{ url, verdict, status, message }`. 400 if no hostname. |
| `/api/remote/ai` | POST | local-only | Body `{ enabled: true\|false }`: turn the AI help switch on or off. |
| `/api/remote/ai/start` | POST | local-only | Start a "Set up with AI" conversation holding the remote-access tools. |

All other methods on these routes answer 405.

## Limits and caveats

- Needs a Cloudflare account, a domain on Cloudflare and an Access application the user creates in the dashboard; omp-webui never asks for or stores a Cloudflare API token or password.
- Install uses Homebrew only.
- Confirm risky commands is a best effort that reads the command or path a call carries; it is not a sandbox.
- Changing the hostname after set-up requires Set up the tunnel again before Start.
- When the server starts, a tunnel left by a crashed earlier server is ended first.

## Security notes

- Every `/api/remote*` route is local-only: refused to any page not on this computer whatever token it holds, because a remote page that could change the tunnel or allow-list could let anybody in.
- `remote.json` is written with mode `0600`; it holds no secrets (tunnel credentials stay in `~/.cloudflared`).
- Anyone allowed through Access can drive conversations on this computer; with `remoteShell` on they also get a login shell that the guard does not see. Recommend turning `confirmRisky` on and `remoteShell` off if the user is worried.
- Agents must not enable remote access, change the allow-list, hostname, shell or file-transfer switches, or turn on the AI help on the user's behalf unless the user explicitly asks; in a "Set up with AI" conversation the agent still cannot change `enabled`, `autostart` or the AI-help switch.
