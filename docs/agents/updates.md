---
title: Updates of the app and of omp
summary: How omp-webui updates itself from its GitHub releases (the macOS app and the Windows launcher; the Linux package checks and links), and how it checks for, installs and updates the omp coding agent it drives, by hand or automatically.
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

**Install updates automatically** (off by default; offered only where this copy can install its updates): once a newer release with an installer for this system is known and no conversation is working, asking, paused or waiting, the server starts the same install by itself (it looks every minute, and after each check), and the app restarts on the new version. While conversations hold it, the card says "Installs vX by itself once the conversations finish (N still open)." An automatic install that fails, is cancelled or is rolled back is not started again by itself for that version (`auto-skip.json` in the `update/` folder); **Try again** and **Download and install** still work.

**The Windows launcher** updates itself the same way, from the release's zip for its processor: `omp-webui-vX.Y.Z-windows-x64.zip`, or `omp-webui-vX.Y.Z-windows-arm64.zip` for an Arm launcher (from 0.19.0; `installerPlatformOf` in `server/update/release.ts` picks it by the processor the launcher runs as, so an x64 launcher that Windows emulates on an Arm machine keeps taking the x64 zip, and a release without the arm64 zip has no installer for an Arm launcher). Either is taken only with the SHA-256 GitHub lists for it. The download is checked for size and SHA-256; the zip's members are listed first and a zip with anything that could unpack outside its one top folder, `omp-webui-windows-<arch>/` for the launcher's processor (an absolute or drive path, `..`, a link, another processor's folder), is refused; it is unpacked next to the install folder as `<folder>.updating`, which must hold `omp-webui.exe` and `web/index.html`, and `omp-webui.exe --version` must print the release's version. Then a hidden PowerShell helper waits for the server to exit (the server exits itself and its console window closes), renames the install folder to `<folder>.previous` and the new one into its place, and starts the new `omp-webui.exe` in a console of its own, which opens the page. The old folder is removed once the new version has started; if the new one does not start, it is put aside and the old folder is put back and started. The install folder is the one `omp-webui.exe` is in (`OMP_WEBUI_APP_FOLDER`, set by the launcher when the `web` folder is beside it); the folder that holds it must be writable by the user (not under Program Files), or the card says the update cannot replace it. The data folder is outside the install folder and untouched. Version 0.16.0 has no updater on Windows: from it, update by hand once.

**omp** (Settings › App & system › **omp**). The card shows the installed omp version, its location, how it was installed (Homebrew, Bun, npm, omp's installer, mise, Nix, managed by another tool, or unknown) and what updating does for that method, and the range of omp versions this omp-webui is made for (currently `>=18.12.3 <19.0.0`) with whether the installed version is in it. The server looks up the latest omp release the way `omp update` does (the npm registry for package-manager installs, omp's build service for the standalone binary, on the channel omp's own `update.channel` setting names): about 1.5 s after start and every 6 hours, plus **Check now**.

- **Update omp** runs `omp update`. It waits until no conversation is working, paused or waiting for an answer ("Waiting for N conversations to finish before updating omp…"); **Update anyway** waits only for the working ones. Conversations already open keep the old omp until they are closed. An update cannot be stopped once it runs; a waiting one can be cancelled.
- A release outside the supported range needs confirmation ("Update to an untested omp?").
- **Update omp automatically** (off by default): when a newer supported release is known and no conversation is working, paused or waiting, the server runs `omp update` by itself. It never moves outside the supported range, and does not retry a release whose automatic update failed. While held back it says by what.
- An omp installed with Nix, managed by another tool, or installed in an unknown way is not updated by the app (**Update omp** is not offered and the automatic switch is disabled).
- **Run the first-time setup again** reopens the setup steps (Sign in, Model, Permissions, Done).

When omp is not found or does not start, the app shows **Install omp to get started** instead of the conversations: choices Homebrew (recommended where present), omp's installer (standalone binary in `~/.local/bin`; on Windows omp's PowerShell installer, into `%LOCALAPPDATA%\omp`) and Bun, each with the command it runs, the installer output, **Cancel**, and **I installed it myself — look again**. After an install the first-time setup follows.

On Windows, omp-webui runs from `omp-webui.exe` (the release's `omp-webui-vX.Y.Z-windows-x64.zip`, or `omp-webui-vX.Y.Z-windows-arm64.zip` on Windows on Arm): a double-click starts the server and opens the page in the default browser; closing its console window stops it. It updates itself as described above. The server exits for the update only once the PowerShell helper has said it runs (within 10 seconds); a helper that does not (a policy that allows only signed scripts, security software) is ended, and the install fails with nothing changed and the server still running. On Windows on Arm there is no built-in browser engine (Chrome for Testing has no Windows Arm build), and cloudflared is the amd64 build, which Windows emulates.

On Linux, omp-webui runs from the Linux package (the release's `omp-webui-vX.Y.Z-linux-x64.tar.gz` or `-linux-arm64.tar.gz`): its `install.sh` installs it for the user into `~/.local/share/omp-webui` with an `omp-webui` command in `~/.local/bin` and an applications-menu entry that starts it in a terminal (closing the terminal stops it). It does not install its own updates: the Updates card shows a newer release with the tarball for this processor and says to download the new package and run its `install.sh` again (quit omp-webui first). `./install.sh --uninstall` removes it; the data folder is kept.

## Where it is

- **Settings › App & system › Updates** (`#/settings/app`): installed and latest version, last check, **Check now**, release notes and **Release page**, **Download and install**, progress and **Cancel**, outcome with **Dismiss**, the checkbox **Check for updates automatically** ("Looks at start and every 6 hours. “Check now” always works, whatever this is set to.") and, where this copy can install, **Install updates automatically**. A page that is not on this computer sees only "Updates are not available on a remote page: the app can only be updated from the Mac it runs on."
- Sidebar footer: **Update available · v…** while a newer omp-webui release is known; a click opens the Updates card.
- **Settings › App & system › omp**: version, location, install method, supported range, **Check now**, **Update omp**, **Update omp automatically**, **Run the first-time setup again**. A remote page sees the card too, with the note that it changes the omp of the computer omp-webui runs on.
- A notice at the top of the main area for omp: "omp X is available — you have Y." (**Release notes**, **Update**, **Later**), the waiting / updating states with **Show output**, **Cancel**, **Update anyway**, the result, and a warning when the installed omp is outside the supported range (**Dismiss**).

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.appUpdateCheck` | `on`, `off` | unset (on) | Synced preference. Whether the server looks for a newer omp-webui release on its own (shortly after start and every 6 hours). **Check now** works either way. |
| `ompw.appAutoUpdate` | `on`, `off` | unset (off) | Synced preference. Whether the server installs a newer omp-webui release by itself once no conversation is working, asking, paused or waiting (then the app restarts). Needs a copy that can install its updates (the macOS app, the Windows launcher). |
| `ompw.omp.dismissed` | JSON object `{ update?: <version>, compat?: <version> }` | unset | Synced preference. The omp notices put away: `update` names the omp release whose "is available" notice was put away with **Later**, `compat` the installed omp whose out-of-range warning was dismissed. A notice comes back when the version it names changes. |

Other stored values:

| Stored in | Field | Values | Default | Effect |
|---|---|---|---|---|
| `omp.json` in the data folder | `autoUpdate` | `true`, `false` | `false` | **Update omp automatically**. Set through `/api/omp/settings`. |
| `omp.json` in the data folder | `onboarding` | `true`, `false` | `false` | The first-time setup is pending (set after an install, or by **Run the first-time setup again**). |

Environment: `OMP_WEBUI_UPDATE_CHECK=off` stops the automatic look-ups for both omp-webui and omp (Check now still works), and the built-in browser's automatic updates (Settings › Browser); `OMP_WEBUI_UPDATE_INTERVAL_MS` changes how often omp is looked up.

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/update` | GET | token, and this computer or a verified Access sign-in | `{ state }`: installed version, whether this copy can install (`install.allowed` or the reason), `checking`, `checkedAt`, `latest` release, `newer`, the last check `failure`, the running `job` (phase `downloading`, `verifying`, `staging`, `handover`; bytes received/total), `failed` and `outcome`. |
| `/api/update/check` | POST | token, and this computer or a verified Access sign-in | Look for a release now; returns `{ state }`. |
| `/api/update/install` | POST | token, and this computer or a verified Access sign-in | Body `{ tag, anyway? }`: start installing that release. 409 with `{ code, params, error }` when refused: `blocked` (this copy cannot replace itself), `busy`, `nothingToInstall`, or `replying` (conversations are working or waiting; send `anyway: true` to go on). |
| `/api/update/cancel` | POST | token, and this computer or a verified Access sign-in | Stop a download or the checks after it (not after the handover). |
| `/api/update/dismiss` | POST | token, and this computer or a verified Access sign-in | Clear the shown failure and outcome. |
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

- Only the macOS app and the Windows launcher can install their own updates; the Linux package checks for releases and links its tarball (install it with its `install.sh`), and the web version (or a copy started another way) only shows that a release exists and links its page. On a Windows or Linux processor no zip or package is built for (other than x64 and arm64), and on Windows on Arm for a release without the arm64 zip, the release is shown without an installer.
- Installing an omp-webui update restarts the app, which stops conversations that are replying.
- GitHub's anonymous rate limit can stop look-ups for a while; the card says when it will look again.
- An omp update waits for paused and asking conversations too unless **Update anyway** is used; conversations that stay open keep running the old omp until restarted.
- A new omp release outside the supported range is never installed automatically.
- The job output kept for the omp card is capped at 256 KB.

## Security notes

- The `/api/update*` routes are for the person's own page: one on this computer, or one signed in through Cloudflare Access (Settings › Updates works from a phone through the tunnel too; the app restarts on the computer it runs on, and the page reconnects once it is back). A page on the network that holds only the token is refused them (403, "The app is updated on the computer omp-webui runs on, or from a page signed in through Cloudflare Access"), and a route under `/api/update` that is not one of these is this computer's alone. Update state is sent only to those pages.
- A downloaded macOS app is installed only if its signature is valid and made with the same certificate as the running app, so a file merely published under a release's name is refused. The Windows launcher is unsigned: its zip is installed only with the SHA-256 GitHub lists for it, which guards against a broken or altered download, not against a compromised release or account.
- The `/api/omp*` routes are open to any page with the access token, including remote ones: such a page can update or install the omp of the computer omp-webui runs on.
- Agents should not install updates or switch automatic updates on or off unless the user asks.
