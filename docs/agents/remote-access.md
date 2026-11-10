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

1. **Install cloudflared**: on macOS `brew install cloudflared` (needs Homebrew; otherwise install it manually and come back); on Linux and Windows the server downloads Cloudflare's own build for the system (`cloudflared-linux-amd64`/`arm64`/`arm`/`386`, `cloudflared-windows-amd64.exe`/`386.exe`) from cloudflared's latest GitHub release into `~/.omp-webui/cloudflared/`, and keeps it only if its SHA-256 is the one GitHub lists for that file. A `cloudflared` already on `PATH` is used first.
2. **Log in to Cloudflare**: runs `cloudflared tunnel login`; the card shows an "Open the sign-in page" link. Logged in means `~/.cloudflared/cert.pem` exists.
3. **Set up the tunnel**: creates a tunnel named `omp-webui-<hostname with dots as dashes>` (once) and routes the hostname's DNS to it. Needs cloudflared installed, the login done and a saved hostname.
4. **Start the tunnel**: sets `enabled` to true and runs the tunnel; it is restarted with back-off if it ends. Refused if the hostname changed since set-up ("set up the tunnel again") or settings are missing.
5. **Stop the tunnel**: sets `enabled` to false and stops it.

The Access application is created by the user in the Cloudflare dashboard (the card shows a guide: Zero Trust › Access › Applications › Add an application › Self-hosted; same hostname or a wildcard; an Allow policy with the emails; copy the AUD tag). Optional: session duration 1 month to sign in about once a month (both Cloudflare defaults are 24 hours).

**Check the address** makes one unauthenticated GET of `https://<hostname>/` from this computer (10 s limit, redirects not followed) and explains what it found: OK when Cloudflare Access redirects to the matching `<team>.cloudflareaccess.com` sign-in, otherwise where the way in is broken (DNS, tunnel, this app, Access application, wrong team). It changes nothing.

**AI help** ("Let the AI help with remote access", off by default): **Set up with AI** starts a conversation (in its own folder, `~/.omp-webui/remote-help`) whose agent gets nine tools: `remote_access_guide`, `remote_access_status`, `remote_access_check` (read-only, always allowed) and `remote_access_install`, `remote_access_login`, `remote_access_save`, `remote_access_setup`, `remote_access_start`, `remote_access_stop` (go through omp's tool approval). They call the same code as the card's buttons. The agent may save only hostname, team, AUD and emails; it can never change `enabled`, `autostart` or the AI-help switch, never sees a token, the login URL or tunnel credentials, and is refused while a page that is not the person's own (one that holds only the access token, without a Cloudflare Access sign-in) has been on that conversation; a message sent from the person's own page (this computer's, or one signed in through Access) lifts it. Turning the switch off takes the tools away from every conversation at once.

**Confirm risky commands from remote pages** (`confirmRisky`, off by default): when a page that is not on this computer sends or steers a turn, a high-risk tool call (sudo, deleting/overwriting outside the project folder, `git push --force`, `git reset --hard`, a download piped into a shell, a command put together when it runs (`$r -rf ~`, `$(echo rm) …`, `eval "$x"`, a script piped into `sh`), a command run on another computer (`ssh host cmd`), reading a stored password or token (`security find-generic-password -w`, `gh auth token`), changing scheduled jobs or services (`crontab -r`, `systemctl stop`), broad permission changes, `~/.ssh`, `~/.omp` or this app's data, launchctl, osascript, tunnels, the remote-access tools) waits for Allow or Deny on that page before it runs. Everything else follows the conversation's permission mode; a page on this computer is never asked. If the conversation's omp started without the gate, a remote page's turn is refused with an explanation ("Continue it on this computer, or open it again there"). The check reads POSIX shells (sh, bash, zsh) and, on Windows, `cmd.exe` and PowerShell too (`del /s`, `rd /s`, `Remove-Item -Recurse`, `iwr … | iex`, `-EncodedCommand`, `reg`, `schtasks`, `runas`), with Windows paths (`C:\Users\…`, `%USERPROFILE%`, `$env:APPDATA`, the Startup folder) compared case-insensitively.

**Let remote pages open a shell** (`remoteShell`, on by default): the side panel's Terminal tab is a login shell on this computer in the conversation's folder. The person's own pages (this computer's, and one signed in through Cloudflare Access) may always open one. With this on, a page that holds only the access token can open one too; turning it off refuses new shells to those pages ("Shells are off for remote pages …") and ends the ones they have open. The same switch covers omp's own shell console (any omp command line containing `shell`) on the Commands & terminal page.

**Share these settings with another computer**: **Export settings** saves `omp-webui-remote-access.json` holding only team, AUD and emails (no hostname, tunnel or credentials); **Import settings…** fills the form from such a file (max 64 KB, max 200 emails, version 1) and the user then adds this computer's hostname and saves. One Access application with a wildcard domain can serve several computers.

### What a remote page can and cannot do

A page reached through the tunnel and signed in through Cloudflare Access is the person's own, like the page on this computer: it may do everything that page may, every owner-only route included (remote access itself, the list of Macs, the guard and the Guard page, updates, Move to another computer, Memory, the macOS app's routes, Ask agent for help, Start at login, stopping the server), the projects folder, the unattended instruction, "Keep the Mac awake", the guidance conflict check, opening files on the Mac and file transfer whatever **File transfer** says. What stays tied to this computer: **Confirm risky commands from remote pages** applies to its turns, preferences kept per device are its own, the built-in browser's engine endpoints answer only this computer, and it cannot use `/?token=` or `/api/auth`.

A page that holds only the token (over a network address, see server-and-security, or behind a reverse proxy without Access):

- **Can**: use conversations (read, send, steer, approve), start new chats, read most settings, download/upload files as `fileTransfer` allows (see file-transfer), open a Terminal shell if `remoteShell` is on, receive push notifications.
- **Cannot**: any owner-only route (`/api/remote*`, `/api/macs*`, `/api/remote-run*`, `/api/guard*`, `/api/update*`, `/api/migrate*`, `/api/memory*`, `/api/shell*`, `/api/settings-help*`, `/api/login-start`, `/api/shutdown`) (403); see the Guard page or change the guard; change the guidance or run its conflict check; manage the built-in browser; change the projects folder, the unattended instruction or "Keep the Mac awake"; open files in Finder or the default app; use `/?token=` or `/api/auth`. Settings shows "This page cannot change the tunnel: change it on the computer the server runs on, or from a page signed in through Cloudflare Access."
- **An update restarts the app, and the tunnel comes back with it**: when the tunnel runs as the app is ended for an update (one started from a phone, from this computer, or by itself), the next server starts it again even if **Start the tunnel with the app** is off (`<data dir>/remote-resume.json`, followed only within 10 minutes). The remote page reconnects once the new server is up.

### Running commands on another computer (`remote_run`)

This Mac's agent can run shell commands on another computer of the person's that runs omp-webui (v0.22.5 or later) with its own tunnel, and is in this Mac's list of Macs (the Macs menu / machine switcher). Typical use: looking after a server with the models this Mac has.

- **Turned on per conversation**: the conversation's session controls › **Remote computers**, one checkbox per saved computer. Off in every conversation by default. Only the person's own pages (this computer's, and one signed in through Cloudflare Access) may change it; no tool can. Kept per session file in `<data dir>/remote-run.json` (follows a moved session file; a computer taken out of the Macs list is taken out of every conversation). Not offered in a conversation whose server tools slot is held by "Set up with AI" or "Ask agent for help".
- **The tool**: `remote_run` `{ computer, command, cwd?, timeout? }`. `computer` is one of the names the conversation was given; `timeout` in seconds, 120 by default, at most 3600. Each call opens a fresh login shell on that computer through its tunnel (the same as its Terminal tab for a page signed in through Access), runs the command in a subshell with no input (`stdin` is `/dev/null`), and returns the exit code, how long it ran and the last 64 KB of output. Nothing carries over between calls (pass `cwd`; a `cwd` that does not exist fails with the shell's error). On timeout or when the turn is stopped the remote shell is ended and what was read is returned. Windows computers are refused ("not supported yet").
- **Approval**: it follows the conversation's approval mode exactly like `bash` (Auto-approve runs it without asking). The guard reads `command` as a shell command with no safe folder on that computer: deleting or overwriting anything there, `sudo`, `~/.ssh` and the other protected names, piped downloads and so on are held like the same command on this Mac; the card says "Run on <name>:". **Confirm risky commands from remote pages** covers it too. A conversation that a page holding only the token has been on is refused.
- **Sign-in**: the call needs that computer's Cloudflare Access token. The Mac app reads it (`CF_Authorization` for the computer's host) from the web data store of its window onto that computer and hands it to this Mac's server (`POST /api/macs/<id>/sign-in`, answered only to this computer's own app); the server keeps it in memory only, never on disk, in a page, in a tool's arguments or results. It lapses with the Access application's session duration (24 h by default; up to 1 month in the Cloudflare dashboard); then the call answers "not signed in (or the sign-in has lapsed). Open its window from the Macs list and sign in, then try again." The machine switcher and **Remote computers** show until when each computer is signed in. A browser-only install (no Mac app) has no sign-ins to hand over, so the tool cannot reach anything there.
- **Not for**: interactive programs (editors, password prompts, `top`), file transfer (use `cat`, heredocs), computers that do not run omp-webui (use SSH yourself).

## Where it is

- **Settings › App & system › Remote access** (`#/settings/app`): status ("Tunnel: Off / Starting… / Connected / Not running"), public address with Copy, the five step buttons, Hostname, Cloudflare team, Application AUD (AUD tag), Allowed e-mail addresses (one per line), Start the tunnel with the app, Confirm risky commands from remote pages, File transfer, Let remote pages open a shell, Let the AI help with remote access, Set up with AI, Check the address, the Access application guide, and Share these settings with another computer.
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
| `remote.json:remoteShell` | `true`, `false` | `true` | Whether pages that hold only the access token (not this computer's, not signed in through Cloudflare Access) may open a Terminal shell; off also ends their open shells. The person's own pages always may. |

`remote.json` also holds `tunnelId` and `tunnelName`, written by the server at set-up and never settable from a page. The AI-help switch is stored separately:

| Stored in | Field | Values | Default | Effect |
|---|---|---|---|---|
| `~/.omp-webui/remote-ai.json` | `enabled` | `true`, `false` | `false` | "Let the AI help with remote access". |

The environment variable `OMP_WEBUI_REMOTE_CONFIG` overrides the path of `remote.json`; `OMP_WEBUI_REMOTE_CHECK_URL` overrides the URL used by Check the address.

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/remote` | GET | owner-only | Snapshot: `config`, tunnel `status` (`off`, `starting`, `connected`, `error` + message), `installed`, `loggedIn`, `url`, `loginUrl` (while a login is pending), `ai` (`enabled`, conversations holding the tools). |
| `/api/remote/config` | POST | owner-only | Save a partial config (`enabled`, `hostname`, `team`, `aud`, `emails`, `autostart`, `confirmRisky`, `fileTransfer`, `remoteShell`); an invalid value refuses the whole change (400); `tunnelId`/`tunnelName` are ignored. `enabled: false` also stops the tunnel. |
| `/api/remote/install` | POST | owner-only | Install cloudflared: Homebrew on macOS, Cloudflare's checked build from GitHub on Linux and Windows. |
| `/api/remote/login` | POST | owner-only | Start `cloudflared tunnel login`; returns the snapshot plus `loginUrl`. |
| `/api/remote/setup` | POST | owner-only | Create the tunnel (if none) and route the hostname's DNS to it. |
| `/api/remote/start` | POST | owner-only | Enable remote access and start the tunnel. |
| `/api/remote/stop` | POST | owner-only | Disable remote access and stop the tunnel. |
| `/api/remote/check` | POST | owner-only | Check the public address from outside; returns `{ url, verdict, status, message }`. 400 if no hostname. |
| `/api/remote/ai` | POST | owner-only | Body `{ enabled: true\|false }`: turn the AI help switch on or off. |
| `/api/remote/ai/start` | POST | owner-only | Start a "Set up with AI" conversation holding the remote-access tools. |

All other methods on these routes answer 405.

## Limits and caveats

- Needs a Cloudflare account, a domain on Cloudflare and an Access application the user creates in the dashboard; omp-webui never asks for or stores a Cloudflare API token or password.
- Install uses Homebrew on macOS; on Linux and Windows it needs GitHub reachable (`api.github.com` and the release download) and a processor Cloudflare builds for.
- On Windows the remote Terminal shell is PowerShell (`pwsh`, else Windows PowerShell, else `cmd`).
- Confirm risky commands is a best effort that reads the command or path a call carries; it is not a sandbox.
- Changing the hostname after set-up requires Set up the tunnel again before Start.
- When the server starts, a tunnel left by a crashed earlier server is ended first.

## Security notes

- Every `/api/remote*` route is owner-only: refused to a page that holds only the token (a network address, a proxy without Access), because a page that could change the tunnel or allow-list could let anybody in. A page signed in through Access may change them, `confirmRisky` included.
- `remote.json` is written with mode `0600`; it holds no secrets (tunnel credentials stay in `~/.cloudflared`).
- Anyone allowed through Access can drive conversations on this computer and change every setting, remote access included, and open a login shell that the guard does not see. With `remoteShell` on, a page holding only the token gets that shell too. Recommend turning `confirmRisky` on and `remoteShell` off if the user is worried.
- Agents must not enable remote access, change the allow-list, hostname, shell or file-transfer switches, or turn on the AI help on the user's behalf unless the user explicitly asks; in a "Set up with AI" conversation the agent still cannot change `enabled`, `autostart` or the AI-help switch.
