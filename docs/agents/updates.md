---
title: Updates of the app and of omp
summary: How omp-webui updates itself from its GitHub releases (macOS app only), and how it checks for, installs and updates the omp coding agent it drives, by hand or automatically.
settings: update, omp
---

# Updates of the app and of omp

## What it does

Two separate things are kept up to date:

**omp-webui itself** (Settings › App & system › **Updates**). The server looks for the newest public release of omp-webui on GitHub (`GET https://api.github.com/repos/<repo>/releases/latest`, no credentials). With automatic checks on it looks about 20 seconds after it starts and then every 6 hours; **Check now** always looks (two looks within 10 seconds are one). When a newer release with an installer exists, the card shows its notes and **Download and install**. Installing:

1. refuses to start when the disk lacks room (three times the installer's size must be free in the data folder's volume and the app's volume);
2. downloads the installer (`.dmg`) into the `update/` folder of the server's data folder (the macOS app's is in Application Support), checking its size and, when GitHub lists one, its SHA-256 (phase "Downloading v…", with a progress bar and **Cancel**);
3. checks the app in the installer and again its copy (phase "Checking the download…" / "Preparing the new version…"): a valid signature, the same bundle identifier, the version the release says, newer than the installed one (the app never goes back to an older version), and signed by the same certificate as the running app;
4. hands over to a helper that waits for the app to quit, swaps the new app in, keeps the old one until the new one has started, and puts the old one back if the new one does not start ("Restarting to finish the update…"; this phase cannot be cancelled).

After the restart the card shows how it ended ("Updated to v…", or why it did not work out and that the old version is back), with **Dismiss**. If conversations are replying, the install first asks "Update while conversations are replying?" (**Update anyway** stops them; paused or waiting conversations stay in the background). An install that fails before the handover changes nothing and says why (download, checksum, signature, certificate, version, space, folder not writable…), with **Try again**.

The app can install updates only when it is the macOS app (started by its own shell), not run from a temporary copy macOS made (App Translocation: move it to Applications), in a folder the user can write, and properly signed (an ad-hoc signed copy cannot compare signatures). Otherwise the card says why and links the release page to install by hand.

**omp** (Settings › App & system › **omp**). The card shows the installed omp version, its location, how it was installed (Homebrew, Bun, npm, omp's installer, mise, Nix, managed by another tool, or unknown) and what updating does for that method, and the range of omp versions this omp-webui is made for (currently `>=18.11.0 <19.0.0`) with whether the installed version is in it. The server looks up the latest omp release the way `omp update` does (the npm registry for package-manager installs, omp's build service for the standalone binary, on the channel omp's own `update.channel` setting names): about 1.5 s after start and every 6 hours, plus **Check now**.

- **Update omp** runs `omp update`. It waits until no conversation is working, paused or waiting for an answer ("Waiting for N conversations to finish before updating omp…"); **Update anyway** waits only for the working ones. Conversations already open keep the old omp until they are closed. An update cannot be stopped once it runs; a waiting one can be cancelled.
- A release outside the supported range needs confirmation ("Update to an untested omp?").
- **Update omp automatically** (off by default): when a newer supported release is known and no conversation is working, paused or waiting, the server runs `omp update` by itself. It never moves outside the supported range, and does not retry a release whose automatic update failed. While held back it says by what.
- An omp installed with Nix, managed by another tool, or installed in an unknown way is not updated by the app (**Update omp** is not offered and the automatic switch is disabled).
- **Run the first-time setup again** reopens the setup steps (Sign in, Model, Permissions, Done).

When omp is not found or does not start, the app shows **Install omp to get started** instead of the conversations: choices Homebrew (recommended where present), omp's installer (standalone binary in `~/.local/bin`) and Bun, each with the command it runs, the installer output, **Cancel**, and **I installed it myself — look again**. After an install the first-time setup follows.

## Where it is

- **Settings › App & system › Updates** (`#/settings/app`): installed and latest version, last check, **Check now**, release notes and **Release page**, **Download and install**, progress and **Cancel**, outcome with **Dismiss**, and the checkbox **Check for updates automatically** ("Looks at start and every 6 hours. “Check now” always works, whatever this is set to."). A page that is not on this computer sees only "Updates are not available on a remote page: the app can only be updated from the Mac it runs on."
- Sidebar footer: **Update available · v…** while a newer omp-webui release is known; a click opens the Updates card.
- **Settings › App & system › omp**: version, location, install method, supported range, **Check now**, **Update omp**, **Update omp automatically**, **Run the first-time setup again**. A remote page sees the card too, with the note that it changes the omp of the computer omp-webui runs on.
- A notice at the top of the main area for omp: "omp X is available — you have Y." (**Release notes**, **Update**, **Later**), the waiting / updating states with **Show output**, **Cancel**, **Update anyway**, the result, and a warning when the installed omp is outside the supported range (**Dismiss**).

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.appUpdateCheck` | `on`, `off` | unset (on) | Synced preference. Whether the server looks for a newer omp-webui release on its own (shortly after start and every 6 hours). **Check now** works either way. |
| `ompw.omp.dismissed` | JSON object `{ update?: <version>, compat?: <version> }` | unset | Synced preference. The omp notices put away: `update` names the omp release whose "is available" notice was put away with **Later**, `compat` the installed omp whose out-of-range warning was dismissed. A notice comes back when the version it names changes. |

Other stored values:

| Stored in | Field | Values | Default | Effect |
|---|---|---|---|---|
| `omp.json` in the data folder | `autoUpdate` | `true`, `false` | `false` | **Update omp automatically**. Set through `/api/omp/settings`. |
| `omp.json` in the data folder | `onboarding` | `true`, `false` | `false` | The first-time setup is pending (set after an install, or by **Run the first-time setup again**). |

Environment: `OMP_WEBUI_UPDATE_CHECK=off` stops the automatic look-ups for both omp-webui and omp (Check now still works); `OMP_WEBUI_UPDATE_INTERVAL_MS` changes how often omp is looked up.

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/update` | GET | local-only | `{ state }`: installed version, whether this copy can install (`install.allowed` or the reason), `checking`, `checkedAt`, `latest` release, `newer`, the last check `failure`, the running `job` (phase `downloading`, `verifying`, `staging`, `handover`; bytes received/total), `failed` and `outcome`. |
| `/api/update/check` | POST | local-only | Look for a release now; returns `{ state }`. |
| `/api/update/install` | POST | local-only | Body `{ tag, anyway? }`: start installing that release. 409 with `{ code, params, error }` when refused: `blocked` (this copy cannot replace itself), `busy`, `nothingToInstall`, or `replying` (conversations are working or waiting; send `anyway: true` to go on). |
| `/api/update/cancel` | POST | local-only | Stop a download or the checks after it (not after the handover). |
| `/api/update/dismiss` | POST | local-only | Clear the shown failure and outcome. |
| `/api/omp` | GET | token | `{ state, log }`: omp status (`ready`, `missing`, `broken`), path, version, install method, supported range and verdict, latest release (`newer`, `compat`, changelog), `autoUpdate`, what an automatic update waits for, `onboarding`, the current job; `log` is the job's output. |
| `/api/omp/check` | POST | token | Look up the latest omp release now. |
| `/api/omp/update` | POST | token | Body `{ acknowledgeCompat?, anyway? }`: run `omp update` (now, or once conversations have finished). 409 with a `code`: `not_ready`, `not_updatable`, `busy`, `up_to_date`, `outside_compat` (repeat with `acknowledgeCompat: true`). `anyway: true` on a waiting update stops it waiting for paused/asking conversations. |
| `/api/omp/cancel` | POST | token | Cancel a waiting update, stop an install, or dismiss an ended job. A running update cannot be stopped (409). |
| `/api/omp/install` | POST | token | Body `{ method }` (`homebrew`, `installer`, `bun`): install omp when it is missing or broken. |
| `/api/omp/recheck` | POST | token | Look for omp again (re-reading the login shell's environment), after the user installed or fixed it. |
| `/api/omp/settings` | POST | token | Body `{ autoUpdate: true\|false }`. |
| `/api/omp/onboarding` | POST | token | Body `{ pending: true\|false }`: start or finish the first-time setup. |

Every omp route answers with the new `{ state, log }`; errors are `{ error, code? }`.

## Limits and caveats

- Only the macOS app can install its own updates; the web version (or a copy started another way) only shows that a release exists and links its page.
- Installing an omp-webui update restarts the app, which stops conversations that are replying.
- GitHub's anonymous rate limit can stop look-ups for a while; the card says when it will look again.
- An omp update waits for paused and asking conversations too unless **Update anyway** is used; conversations that stay open keep running the old omp until restarted.
- A new omp release outside the supported range is never installed automatically.
- The job output kept for the omp card is capped at 256 KB.

## Security notes

- All `/api/update*` routes are local-only: a page through the tunnel or the network cannot replace the app, whatever token it holds. Update state is sent only to pages on this computer.
- A downloaded app is installed only if its signature is valid and made with the same certificate as the running app, so a file merely published under a release's name is refused.
- The `/api/omp*` routes are open to any page with the access token, including remote ones: such a page can update or install the omp of the computer omp-webui runs on.
- Agents should not install updates or switch automatic updates on or off unless the user asks.
