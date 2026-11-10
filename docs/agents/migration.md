---
title: Move to another computer
summary: Export conversations, history, memories, settings, plugins, this app's data and (optionally, encrypted) logins into one .ompw file on the old Mac, and import it on the new one with merge or replace, a backup and a restore.
settings: migrate
---

# Move to another computer

## What it does

**Export** (on the old Mac). The server looks through omp's and this app's files and shows what an export would hold, by category, with file counts and sizes, and what is left out and why. The person ticks categories:

| Category id | Shown as | Holds |
|---|---|---|
| `conversations` | Conversations | Sessions with their subagent and advisor transcripts and forks, the images they keep, pins, and the folders conversations were started in with `--session-dir` or `--profile`. |
| `history` | Prompt history | Prompt history (with conversation titles and recaps) and the word predictor. |
| `memories` | Memories | omp's memory banks. |
| `settings` | Settings and instruction files | `config.yml`, models, MCP servers, LSP, keybindings, instruction files (`AGENTS.md`, `RULES.md`…). |
| `customization` | Skills, agents, commands and themes | Skills, agents, commands, rules, prompts, hooks, tools, extensions and themes. |
| `plugins` | Plugins | The plugin registry, marketplaces and installed plugins. |
| `webui` | This app's data | Preferences, favourites, archived conversations, permission choices, the guard's settings, Full / Light mode, the folders it started omp with, remote access settings. |
| `credentials` | Logins | OAuth tokens, API keys, omp's secrets file, remote access secrets, and secret values found inside other files. Only with **Include logins (encrypted)** and a password. |

Left out, with the reason shown: caches (made again when needed), databases rebuilt from the conversations (usage statistics, the search index), what belongs to this computer, what is in use right now (sockets, locks, logs), what is downloaded again from the internet, logins and secrets when Logins are not included, and files this version does not know. Secret values inside configuration files are blanked in the archive unless Logins are included.

Encryption: Logins are always encrypted with the password (at least 8 characters; a strength meter, a passphrase suggestion and **Generate a strong password** help). **Encrypt the whole file** encrypts everything, including file names; a changed file is then refused. Otherwise everything but the logins is readable by whoever has the file. Encryption is AES-256-GCM with a key from scrypt. The password is not stored anywhere; a forgotten password cannot be recovered.

The export runs in the background (phases: looking through the files, writing the archive), then offers **Save the file** (`omp-webui-migration-<host>-<date>.ompw`, a zip with a manifest); **Done** deletes the server's temporary copy. Files that could not be read are listed.

**Import** (on the new Mac, after installing omp and omp-webui). The file is uploaded to the server in pieces of 32 MiB, then checked (manifest and every checksum). A file encrypted as a whole first asks for its password (**Open the file**). The preview shows where it was made (computer, user, home folder, omp and omp-webui versions, date), per category how many items are new here, the same, or different, and warnings: made with a newer omp or omp-webui, a different home folder (conversation folders under it are rewritten to this Mac's), not enough free disk space, files missing from the archive. Then:

- **Merge**: what is on this Mac stays; what is missing is added. If both have the same conversation, this Mac's is kept, unless the file's is the same conversation continued.
- **Replace**: where both have the same item, the file's wins. A secret value the file holds only blanked (it was made without logins, or they were not restored) is no value to replace: where this Mac has one at the same place, this Mac's stays, and the summary counts them.
- In both, things that are only on this Mac are never deleted.
- **Restore logins** with their password (not asked again for a file encrypted as a whole).

Before anything that exists is changed it is copied to a backup folder (`migration-backups` in the data folder). The summary lists conversations and files added, kept, updated, replaced, merged or skipped, the backup folder, conversation folders not on this Mac yet, settings values that still point at the old Mac, and notes: logins restored or why not (omp here keeps them in an older layout, the file held none, not chosen), secret values left blank, remote access settings imported but **switched off** (or this Mac's own kept), memory banks renamed for new paths, idle conversation processes closed so their files could be written, conversations open in a terminal left as they are, plugin links made again. If an import fails, what it wrote is kept with lists of what it changed and made, and **Restore** puts everything back and removes what it made.

One export or import runs at a time; its state outlives the page and is read again when the page returns.

## Where it is

- **Settings › App & system › Move to another computer** (`#/settings/app`; "Migration" in the Settings index). Sections **Export** (category table, **Not included (N)**, **Include logins (encrypted)**, **Encrypt the whole file**, Password / Repeat the password, **Export**, progress, **Save the file**, **Done**) and **Import** (**Choose a file…**, upload progress and **Cancel the upload**, the password prompt, **What the file holds**, **When something is on both Macs**: Merge / Replace, **Import**, the summary, **Restore** after a failure).
- A page that holds only the access token (not this computer's, not signed in through Cloudflare Access) sees only "This page cannot move data: do it from the page on the Mac the server runs on, or from a page signed in through Cloudflare Access."

## Settings

None of its own. The guard's settings (`guard.json`), Full / Light mode, remote access settings and the synced preferences travel in the `webui` category; see their topics.

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/migrate` | — | owner-only | Prefix of the routes below (no route of its own). |
| `/api/migrate/plan` | GET | owner-only | What an export would hold: `{ host, home, ompVersion, serverVersion, categories: [{ id, files, bytes }], totalFiles, totalBytes, leftOut: [{ path, reason, bytes }], secretFiles: [{ path, values, category }], sessionDirs, profiles, busy }`. |
| `/api/migrate/state` | GET | owner-only | `{ export, import }`: the current export and import status (or null). |
| `/api/migrate/export` | POST | owner-only | Start an export: body `{ categories?, credentials?, wholeFile?, password? }` (no `categories`: every data category). Password required (min 8) with `credentials` or `wholeFile`. 409 when another export or import runs. Returns the export status. |
| `/api/migrate/export/cancel` | POST | owner-only | Cancel the running export (nothing is kept). |
| `/api/migrate/export/file` | GET | owner-only | Download the finished archive (`application/octet-stream`, as an attachment). 404 when there is none. |
| `/api/migrate/export/discard` | POST | owner-only | Forget the finished export and delete its archive. |
| `/api/migrate/import/begin` | POST | owner-only | Body `{ name, size }`: start an upload (any earlier import is discarded). |
| `/api/migrate/import/chunk` | POST | owner-only | Raw bytes of one piece, query `offset=<n>`; a piece must continue where the upload stopped (a piece sent again replaces what it wrote). |
| `/api/migrate/import/verify` | POST | owner-only | The upload is complete: check the archive in the background; the status becomes `locked` (needs its password), `ready` (with a preview) or `failed`. |
| `/api/migrate/import/unlock` | POST | owner-only | Body `{ password }`: open an archive encrypted as a whole. A wrong password is refused and it stays locked. |
| `/api/migrate/import/apply` | POST | owner-only | Body `{ mode: "merge"\|"replace", credentials?, password? }`: import. Refused (409) while conversations are working, or when the disk lacks room; status goes `applying`, then `done` with a summary or `failed` with the backup. |
| `/api/migrate/import/restore` | POST | owner-only | Put back what a failed import changed from its backup (refused while conversations are working). |
| `/api/migrate/import/discard` | POST | owner-only | Abandon the import and delete the uploaded file (not while it is being applied). |

Errors are `{ error, code, params }` with codes such as `migrateBusy`, `migrateWorking`, `migrateNothingChosen`, `migratePasswordMissing`, `migratePasswordShort`, `migrateNotArchive`, `migrateUpload`, `migrateNotReady`, `migrateFilePasswordWrong`, `migrateDiskSpace`, `migrateNoBackup`.

## Limits and caveats

- An archive may be at most 1 TB; one of a newer format than this version knows is refused.
- Importing needs every conversation of this server to be idle; idle conversation processes are closed so their files can be written. Conversations open in a terminal are left alone.
- Logins are not restored when this Mac's omp keeps them in an older layout than the omp that made the file: update omp, then sign in again.
- Remote access arrives switched off and must be turned on again on the new Mac; secret values blanked in the archive must be entered again.
- Caches, usage statistics and the search index are not moved; they are rebuilt.
- The built-in browser (`browser/` in the data folder: its engines, and its logins, cookies and storage) is not moved: on the new Mac it is installed again from Settings › Browser and sites are signed in to again.
- Settings values that name the old Mac's paths are listed after the import for the person to check.

## Security notes

- Every `/api/migrate*` route is owner-only: an archive holds every conversation (and, with a password, every login), and an import rewrites the user's files, so only the person's own page (this computer's, or one signed in through Cloudflare Access) may do either; a page that holds only the token (a network address, a proxy without Access) is refused (403).
- Without **Encrypt the whole file**, anyone who gets the file can read the conversations in it; logins are always encrypted. The person should keep the file private and delete it when done.
- The password is never stored, in the app or in the file. scrypt parameters in a file are only accepted within what this version makes, so a hostile file cannot demand an expensive key derivation.
- The guard's settings are adopted as imported (see the guard topic).
- Agents should not start an export or import unless the user asks.
