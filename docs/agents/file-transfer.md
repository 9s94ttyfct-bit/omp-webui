---
title: Files tab and file transfer
summary: The side panel's Files tab, which browses, previews and edits the files of a conversation's folder, and downloads or uploads files and folders, with limits for pages that hold only the access token.
settings:
---

# Files tab and file transfer

## What it does

The **Files** tab of a conversation's side panel shows the folder the conversation works in (the server looks the folder up from the conversation; a page never names a folder, and every path is resolved inside it: `..`, absolute paths and links that lead out are refused).

- **Browse**: a tree of the folder, with git marks when it is in a repository, and **Show hidden files** (dotfiles, dependency and build folders are hidden by default). Expanded folders are watched (up to 64 per page) and refresh when files change.
- **Filter files**: finds files by name (up to 200 matches; a very large folder may be searched only partly).
- **Changes**: the files that differ from the last commit (Working tree), or the changes by turn, with a per-file diff.
- **Preview**: text/code, Markdown and SVG (first 1 MB of text shown), images (up to 25 MB), PDF and Word documents (up to 25 MB); **Open large in the main area**.
- **Edit**: text files up to 1 MB can be edited and saved (**Edit**, **Save**). If the file changed on disk after it was opened, a save is refused and the editor offers **Reload** or **Overwrite**. Non-UTF-8 files are not rewritten.
- **Open in default app**, **Reveal in Finder**, **Open in Finder** (folders): only on the person's own page (this computer's, or one signed in through Cloudflare Access) with the server on macOS. They act on the Mac the server runs on.
- **Transfer files** dialog: **Upload files…**, **Upload folder…** (or drop files on a folder in the tree), **Download folder as ZIP** (shows how many files and bytes the ZIP will hold and what is left out, then **Download ZIP**), **Download by path** (for what the tree hides, such as `dist` or `node_modules`; a folder comes as a ZIP), and **Download this file** on a file. Uploads show progress (**Uploads**, **Cancel all**); a name clash asks **Keep both** (saved as `name (2).ext`), **Replace** or **Skip**. Large files are sent in 8 MB pieces and an interrupted upload resumes; downloads support HTTP `Range` resume.
- **Markdown editor**: a `.md` / `.markdown` file opens over the whole window, source on the left and a live rendering on the right (**Source and preview**, **Source**, **Preview**; on a phone, Source and Preview tabs). Open it with **Open in the Markdown editor** in the file's preview or the large view, in the Changes view, from a link to a Markdown file of the folder in a message or a rendered file (a link with `#section` opens the file at that heading), or beside a file a tool wrote or edited. It renders GFM, highlighted code, math (KaTeX), Mermaid diagrams and front matter (as a table of its keys). Headings get GitHub's ids, so a table of contents (`[Install](#install)`) scrolls the preview to the heading; a task list's boxes are named by their tasks for a screen reader. HTML in the file is shown as text; images load only from the conversation's folder (relative paths) or inline. **Save** / ⌘S saves with the same rules as **Edit** (a file the page may not write is read only). The file is checked every 3 s: changed with nothing unsaved, it is reloaded; changed with unsaved text, the editor offers **Reload**, **Overwrite** or **Show diff** and never overwrites silently. Closing with unsaved text asks first; one Esc closes it, also on the screen that says the file cannot be opened. The chosen view is kept per device in `ompw.mdEditorView` (browser storage, not synced).

### The person's own pages and the other pages

- The person's own pages are the page on this computer and a page signed in through Cloudflare Access. They may do everything with the folder's files whatever **File transfer** says: they see, read, download and zip everything in the folder, hidden files, secrets (`.env`, private keys, credentials) and protected places included, and they upload and save anywhere in the folder, into the home folder, protected places, what CI runs on push (`.github/workflows`, `.github/actions`), hidden names and files that look like secrets included.
- What any other page (one holding only the access token: a network address, a reverse proxy without Access) may transfer is set by **File transfer** (`remote.json:fileTransfer`): `off` (no download, no upload, no ZIP), `download` (download only), `full` (download and upload, the default).
- Such a page is also "guarded": hidden files are never listed to it, and names that look like secrets (`.env`, keys, credentials) are neither listed, readable, downloadable nor editable. The composer's `@` completion (`/api/files`) follows the same rule: it offers such a page no dotfile and no name that looks like a secret. Its downloads and ZIPs refuse protected places (`.ssh`, `.aws`, `.omp`, the app's data, launch agents, shell start-up files). Dotfiles and build folders can be downloaded by path except when the conversation's folder is the home folder (or holds it), where only what the Files tab shows can be downloaded. Its uploads and saves are refused into the home folder (or a folder that holds it), into protected places, into what CI runs on push, for hidden names and for files that look like secrets (by name, or by a private key in them). It cannot open files in Finder or the default app.
- For every page, the person's own included: nothing is uploaded or saved into a folder where an omp-webui keeps its own data, an executable file or a link is never replaced, and a save is refused for a non-UTF-8 file, one over 1 MB, or one that changed on disk since it was opened.

Every download, ZIP, upload and save that ended or was refused by a rule is logged (who asked: the Access email, `local`, or `net:<address>`).

## Where it is

- Side panel of a conversation › **Files** tab. The **Transfer files** button opens the transfer dialog.
- The remote setting: **Settings › App & system › Remote access › File transfer** (Off / Download only / Download and upload), changed from the person's own page.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `remote.json:fileTransfer` | `off`, `download`, `full` | `full` | What a page that holds only the access token (not this computer's, not signed in through Cloudflare Access) may do with the files of a conversation's folder: nothing, download only, or download and upload. The person's own pages are not affected. Changed only from the person's own page (via `/api/remote/config`). |

## API routes

Every request names the conversation with `live` (process id) and/or `file` (session file) and a `path` relative to its folder.

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/folder/list` | GET (POST with `fresh=1`) | token | List a folder: query `live`, `file`, `path`, `all=1` (show hidden; ignored for a guarded page), `fresh=1` (re-read git). Up to 5,000 entries. On macOS the person's own page is told `local: true` (it may open files on the Mac). |
| `/api/folder/find` | GET (POST with `fresh=1`) | token | Filter files by name: query `q`, `all`, `fresh`. |
| `/api/folder/changes` | GET (POST with `fresh=1`) | token | The folder's changes against the last commit (secret-looking and hidden files omitted for a guarded page). |
| `/api/folder/diff` | GET | token | The text diff of one changed file (`path`). |
| `/api/folder/file` | GET, POST | token (POST follows the File transfer setting for a page that is not the person's own) | GET reads a file for preview (text, image info, whether it is editable for this page). POST saves editor text into the file (up to 1 MB; 409 `conflict` if it changed on disk). |
| `/api/folder/raw` | GET | token | An image's bytes (`nosniff`, cached 60 s). |
| `/api/folder/doc` | GET | token | A PDF or Word document's bytes as an attachment, for the page's viewer. |
| `/api/folder/open` | POST | token (the person's own page) | Body `{ live?, file?, path, reveal?, dir? }`: open the file in its default app, reveal it in Finder, or open a folder in Finder, on the Mac the server runs on. 403 for a page that holds only the token. |
| `/api/folder/download` | GET, HEAD | token (a page not the person's own: needs File transfer `download` or `full`) | A file's bytes as an attachment; `Range` and `If-Range` resume. HEAD checks before starting. |
| `/api/folder/archive` | POST | token (a page not the person's own: needs `download` or `full`) | Body `{ live?, file?, path, hidden? }`: plan a folder's ZIP (file count, size, what is left out) and get a ticket. |
| `/api/folder/archive/<ticket>` | GET | token (a page not the person's own: needs `download` or `full`) | Stream the planned ZIP once; the ticket is good for 5 minutes. |
| `/api/folder/upload` | POST | token (a page not the person's own: needs `full`) | Upload a file or a piece of one: query `live`, `file`, `dir`, `name`, `size`, and for pieces `id`, `offset`; `exists=keep` saves under a free name, `replace=<etag>` replaces the file the page saw. Body is the bytes (max 16 MB per request). |
| `/api/folder/upload/state` | GET | token | Query `id`: how much of an upload arrived (to resume). |
| `/api/folder/upload/cancel` | POST | token | Body `{ id }`: give up an upload and remove what arrived. |

Composer attachments use `/api/upload` (see the composer topic); it is refused to a page that is not the person's own unless File transfer is `full`.

Another computer of the person's copying files from or to this one (its agent's `remote_copy`, see remote-access, *Running commands on another computer*) uses `/api/remote-run/file` and `/api/remote-run/file/<id>`: owner-only (a page signed in through Cloudflare Access, which that computer's server comes as; a page that holds only the token is answered 403 whatever **File transfer** says), with paths of this computer's own (absolute or `~/…`) rather than a conversation's folder. They write into no folder an omp-webui keeps its data in, never replace the home folder or what holds it, keep the same free disk space as uploads, and are logged in the same log (`copy-send`, `copy-receive`).

## Limits and caveats

- One uploaded file: at most 2 GB; one upload request: 16 MB (the page sends 8 MB pieces); one upload: at most 5,000 files (checked by the page).
- A ZIP: at most 50,000 files and 2 GB before compression (413 otherwise); its ticket lasts 5 minutes and is used once.
- An unfinished upload is given up after 30 minutes without a new piece; a body that stops arriving for 30 s fails (`stalled`). Uploads keep at least 1 GB / 5 % of the disk free.
- Concurrent transfers are limited; too many at once answer 429 with `Retry-After`.
- Listing: 5,000 entries per folder; filter: 200 matches; text preview 1 MB; editing 1 MB; images and documents 25 MB.
- A failure answers JSON `{ error, code }` and the `x-omp-webui-error` header with the code (e.g. `off`, `uploadOff`, `secret`, `protected`, `homeFolder`, `outside`, `exists`, `tooLarge`, `busy`, `diskFull`).
- The transfer log is `<data dir>/transfers.jsonl` (`~/.omp-webui/transfers.jsonl` for the web version, `~/Library/Application Support/omp-webui/transfers.jsonl` for the macOS app, or under `OMP_WEBUI_DATA_DIR`), moved aside to `transfers.jsonl.1` when it grows large.

## Security notes

- The folder is always the conversation's own; nothing outside it can be listed, read or written through these routes.
- The person's own page (this computer's, or one signed in through Cloudflare Access) reads, downloads, uploads and saves like the page on this computer, secrets and protected places included; only the folders where an omp-webui keeps its own data are closed to every page. A page holding only the token never sees secret-looking files, cannot carry anything out of protected places, writes into none of them, and uploads nothing into the home folder.
- Only the person's own page can change `fileTransfer` (it is part of the owner-only `/api/remote/config`) and open files on the Mac the server runs on.
- Agents must not change the File transfer setting for the user unless asked; uploading files to the user's folders on their behalf is subject to the same rules as the page.
