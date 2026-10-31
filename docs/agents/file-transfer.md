---
title: Files tab and file transfer
summary: The side panel's Files tab, which browses, previews and edits the files of a conversation's folder, and downloads or uploads files and folders, with limits for pages that are not on this computer.
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
- **Open in default app**, **Reveal in Finder**, **Open in Finder** (folders): only on a page on this computer with the server on macOS.
- **Transfer files** dialog: **Upload files…**, **Upload folder…** (or drop files on a folder in the tree), **Download folder as ZIP** (shows how many files and bytes the ZIP will hold and what is left out, then **Download ZIP**), **Download by path** (for what the tree hides, such as `dist` or `node_modules`; a folder comes as a ZIP), and **Download this file** on a file. Uploads show progress (**Uploads**, **Cancel all**); a name clash asks **Keep both** (saved as `name (2).ext`), **Replace** or **Skip**. Large files are sent in 8 MB pieces and an interrupted upload resumes; downloads support HTTP `Range` resume.
- **Markdown editor**: a `.md` / `.markdown` file opens over the whole window, source on the left and a live rendering on the right (**Source and preview**, **Source**, **Preview**; on a phone, Source and Preview tabs). Open it with **Open in the Markdown editor** in the file's preview or the large view, in the Changes view, from a link to a Markdown file of the folder in a message or a rendered file, or beside a file a tool wrote or edited. It renders GFM, highlighted code, math (KaTeX), Mermaid diagrams and front matter (as a table of its keys). HTML in the file is shown as text; images load only from the conversation's folder (relative paths) or inline. **Save** / ⌘S saves with the same rules as **Edit** (a file the page may not write is read only). The file is checked every 3 s: changed with nothing unsaved, it is reloaded; changed with unsaved text, the editor offers **Reload**, **Overwrite** or **Show diff** and never overwrites silently. Closing with unsaved text asks first. The chosen view is kept per device in `ompw.mdEditorView` (browser storage, not synced).

### Pages that are not on this computer

A page reached through the tunnel or over a network address is "guarded":

- What a remote page may transfer is set on this computer by **File transfer** (`remote.json:fileTransfer`): `off` (no download, no upload, no ZIP), `download` (download only), `full` (download and upload, the default). A page on this computer is not affected and may always download and upload.
- Hidden files are never listed to it, and names that look like secrets (`.env`, keys, credentials) are neither listed, readable, downloadable nor editable.
- Downloads and ZIPs refuse protected places (`.ssh`, `.aws`, `.omp`, the app's data, launch agents, shell start-up files). Dotfiles and build folders can be downloaded by path except when the conversation's folder is the home folder (or holds it), where only what the Files tab shows can be downloaded.
- Uploads and saves are refused into the home folder (or a folder that holds it), into protected places, into what CI runs on push (`.github/workflows`, `.github/actions`), into folders where an omp-webui keeps its own data, and for hidden names; an executable file or a link is never replaced.
- Opening files in Finder or the default app is refused.

Every download, ZIP, upload and save that ended or was refused by a rule is logged (who asked: the Access email, `local`, or `net:<address>`).

## Where it is

- Side panel of a conversation › **Files** tab. The **Transfer files** button opens the transfer dialog.
- The remote setting: **Settings › App & system › Remote access › File transfer** (Off / Download only / Download and upload), on this computer only.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `remote.json:fileTransfer` | `off`, `download`, `full` | `full` | What a page that is not on this computer may do with the files of a conversation's folder: nothing, download only, or download and upload. Changed only from a page on this computer (via `/api/remote/config`). |

## API routes

Every request names the conversation with `live` (process id) and/or `file` (session file) and a `path` relative to its folder.

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/folder/list` | GET (POST with `fresh=1`) | token | List a folder: query `live`, `file`, `path`, `all=1` (show hidden; ignored for remote pages), `fresh=1` (re-read git). Up to 5,000 entries. |
| `/api/folder/find` | GET (POST with `fresh=1`) | token | Filter files by name: query `q`, `all`, `fresh`. |
| `/api/folder/changes` | GET (POST with `fresh=1`) | token | The folder's changes against the last commit (secret-looking and hidden files omitted for remote pages). |
| `/api/folder/diff` | GET | token | The text diff of one changed file (`path`). |
| `/api/folder/file` | GET, POST | token (POST follows the File transfer setting for remote pages) | GET reads a file for preview (text, image info, whether it is editable for this page). POST saves editor text into the file (up to 1 MB; 409 `conflict` if it changed on disk). |
| `/api/folder/raw` | GET | token | An image's bytes (`nosniff`, cached 60 s). |
| `/api/folder/doc` | GET | token | A PDF or Word document's bytes as an attachment, for the page's viewer. |
| `/api/folder/open` | POST | token (this computer only) | Body `{ live?, file?, path, reveal?, dir? }`: open the file in its default app, reveal it in Finder, or open a folder in Finder. 403 for any page not on this computer. |
| `/api/folder/download` | GET, HEAD | token (remote: needs File transfer `download` or `full`) | A file's bytes as an attachment; `Range` and `If-Range` resume. HEAD checks before starting. |
| `/api/folder/archive` | POST | token (remote: needs `download` or `full`) | Body `{ live?, file?, path, hidden? }`: plan a folder's ZIP (file count, size, what is left out) and get a ticket. |
| `/api/folder/archive/<ticket>` | GET | token (remote: needs `download` or `full`) | Stream the planned ZIP once; the ticket is good for 5 minutes. |
| `/api/folder/upload` | POST | token (remote: needs `full`) | Upload a file or a piece of one: query `live`, `file`, `dir`, `name`, `size`, and for pieces `id`, `offset`; `exists=keep` saves under a free name, `replace=<etag>` replaces the file the page saw. Body is the bytes (max 16 MB per request). |
| `/api/folder/upload/state` | GET | token | Query `id`: how much of an upload arrived (to resume). |
| `/api/folder/upload/cancel` | POST | token | Body `{ id }`: give up an upload and remove what arrived. |

Composer attachments use `/api/upload` (see the composer topic); it is refused to a remote page unless File transfer is `full`.

## Limits and caveats

- One uploaded file: at most 2 GB; one upload request: 16 MB (the page sends 8 MB pieces); one upload: at most 5,000 files (checked by the page).
- A ZIP: at most 50,000 files and 2 GB before compression (413 otherwise); its ticket lasts 5 minutes and is used once.
- An unfinished upload is given up after 30 minutes without a new piece; a body that stops arriving for 30 s fails (`stalled`). Uploads keep at least 1 GB / 5 % of the disk free.
- Concurrent transfers are limited; too many at once answer 429 with `Retry-After`.
- Listing: 5,000 entries per folder; filter: 200 matches; text preview 1 MB; editing 1 MB; images and documents 25 MB.
- A failure answers JSON `{ error, code }` and the `x-omp-webui-error` header with the code (e.g. `off`, `uploadOff`, `secret`, `protected`, `homeFolder`, `outside`, `exists`, `tooLarge`, `busy`, `diskFull`).
- The transfer log is `~/.omp-webui/transfers.jsonl`, moved aside to `transfers.jsonl.1` when it grows large.

## Security notes

- The folder is always the conversation's own; nothing outside it can be listed, read or written through these routes.
- Remote pages never see secret-looking files and cannot carry anything out of, or into, protected places; their uploads into the home folder are refused.
- Only a page on this computer can change `fileTransfer` (it is part of the local-only `/api/remote/config`) and open files on this computer.
- Agents must not change the File transfer setting for the user unless asked; uploading files to the user's folders on their behalf is subject to the same rules as the page.
