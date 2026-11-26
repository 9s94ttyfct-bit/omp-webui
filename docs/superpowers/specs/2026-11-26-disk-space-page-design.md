# Disk space page: what each project takes, and cleaning it up — design

Date: 2026-11-26. Size: a project.

## Why

The person's disk fills up (it was at 98%). What takes the room is spread over two places: each project's folder, and the
conversations that ran in it, which omp keeps apart from the folder (`~/.omp/agent/sessions/<folder key>/`: the transcript
`<id>.jsonl` and, beside it, a folder of the same name with its subagents and artifacts, often larger than the transcript).
Some projects' conversations take more than their folder. Nothing in the web UI shows either, so finding what to clean
means `du` in a terminal and guessing which transcripts belong to what. The person wants one place that lists every
project with the room it takes, sorted by it, and lets them free that room there.

## What the person decided

- A "project" is a project folder: every folder directly in the projects folder (Settings › Projects folder, `~/omp` by
  default), plus every other folder conversations ran in. Not the sidebar's projects (named groups of conversations).
- Each project shows its folder's size and its conversations' size apart, and their sum; the list sorts by them.
- The page can clean up, not only show: delete conversations, move the folder or its dependency folders to the Trash.
- Approach 1 below: a page of its own.
- The two cleanups are separate choices: ticking the folder never deletes a conversation, ticking conversations never
  moves the folder. Conversations are deleted for good (omp's `/session delete`); folders go to the Trash (Put Back).

## Goals

- See, for this Mac, every project's folder size, conversations' size (and count) and total, sorted by any of them,
  biggest total first by default, with the disk's free space beside the list.
- From a project's row, in one confirmation: delete some or all of its conversations, and/or move its folder or some of
  its dependency folders to the Trash, with the room that frees shown before confirming.
- Opening the page is instant: it shows what was measured last and measures again in the background.

Non-goals: other Macs' disks (a remote Mac's page shows its own, as every page does); omp's other data (`~/.omp` caches,
logs, plugins), global package caches, Homebrew; emptying the Trash; cleanup suggestions or automatic cleanup; moving a
project; Windows/Linux recycle bins (there the folder part is not offered, as in the delete dialogs).

Anti-goals (failures even if it works): anything removed that was not ticked; a conversation deleted because the folder
was ticked, or the folder moved because conversations were; a size counted twice (a folder inside another listed one, a
project inside the projects folder counted again under the projects folder); "freed" shown for something that failed;
measuring that makes the Mac sluggish while the person works.

## Constraints

- The safety rules of the conversation delete dialogs stand, and their code is reused, not copied
  (`server/sessions/cleanup.ts`, `cleanup-rules.ts`, `cleanup-scan.ts`; docs/superpowers/specs/2026-11-11-delete-session-folder-design.md):
  the home folder, folders above it, system folders, omp-webui's data folder and `~/.omp` are never offered; git work at
  risk is warned about; every move is checked again at the moment it is made; `/usr/bin/trash` only.
- omp refuses to delete a busy conversation, and the server refuses one open elsewhere; those refusals stand.
- Moving to the Trash is allowed for the pages that may do it today (`mayTrash`: this computer's own, or a page allowed
  full file transfer). Deleting conversations follows the delete routes' rules as they are.
- `du` over tens of GB takes seconds to a minute; it must not run for every page load, nor several at once.
- Public repo: no real paths or project names in code, tests, docs or commits.

## Approaches

1. **A page of its own, "Disk space"** (chosen). A nav item beside Usage & cost opens a table: one row per project,
   columns to sort by, a "Clean up…" button per row that opens a dialog. Room for several columns, sorting and the
   actions, and for more kinds of space later.
2. **A part of Settings › Projects folder.** One card cannot hold a sortable table with actions. Rejected.
3. **Sizes in the sidebar's folder filter.** Room for one number and no actions. Rejected.

## Design

### Which rows

Built from the projects folder's subfolders and every conversation's `cwd` (archived ones included: they are on disk):

- Each subfolder of the projects folder is a row, with or without conversations (hidden folders skipped, as the folder
  picker skips them). A conversation whose folder is that subfolder or inside it belongs to that row.
- Each other conversation folder is a row of its own, unless it is inside another row's folder, where it belongs to that
  row (the outermost wins), so no folder is measured twice.
- A folder the delete rules protect (home, above home, system, the projects folder itself, the data folders) can be a
  row only for its own conversations: its folder size is not measured ("—"), nothing inside it rolls up into it, and its
  folder part of the dialog is absent. A conversation started in `~` is such a row.
- A folder that is gone (moved, deleted) stays a row while conversations of it remain: its folder is "gone", its
  conversations can still be deleted.
- A conversation belongs to exactly one row: the one its own `cwd` (as recorded in its file) puts it in.
- The projects folder and every folder that contains it are treated like protected folders here (my call, after the
  builder check): a row for their own conversations only, nothing rolls up into them, no folder part in the dialog. So a
  conversation once started in the folder above a custom projects folder neither absorbs the projects nor is offered
  for the Trash with them inside.

### What is measured

- **Folder**: allocated size, `du -sk` (what removing it frees, roughly; APFS clones and hard links make it approximate,
  which the page does not try to correct). Measured on the server, one folder at a time, in the background, with a
  per-folder budget of 60 s; one over budget shows "over N GB" (what it reached) or "unknown".
- **Conversations**: each conversation's transcript plus its artifacts folder (same path without `.jsonl`), summed per
  row, with the count. Subagent transcripts are inside the artifacts folder and so count with their parent.
- **Transcripts inside a project folder** (a `--session-dir` root the server started omp with, `server/sessions/roots.ts`,
  can be anywhere): they count once, under conversations; the folder's size is its `du` minus theirs (my call). The
  folder move is refused while a session root is in it ("holds conversations' files"): moving it would delete
  conversations, which ticking the folder must never do.
- **Total**: folder + conversations (a "—" or unknown folder counts as 0, and the total says so).
- **Last used**: the newest of the row's conversations' `modifiedAt`, else the folder's modification time.

Results are kept in the data folder (`disk-space.json`: per row, the sizes and when each was measured) so the page shows
the last numbers at once, marked with their age; a scan starts when the page opens if the last one is older than 10
minutes, or by the page's Refresh. One scan at a time for the server; pages see it progress (rows update as each folder
is measured; the answer streams or the page polls, the builder's choice). Conversation sizes are cheap (`stat`) and
are always current.

### The page

```
Disk space                               Free on this disk: 17 GB of 461 GB   [Refresh]  measured 3 min ago
Project ▾                  Folder      Conversations      Total ▼    Last used
project-a  ~/omp/project-a   3.5 GB    370 MB · 12        3.9 GB     today       [Clean up…]
project-b  ~/omp/project-b   1.1 GB    2.9 GB · 140       4.0 GB     yesterday   [Clean up…]
(home)     ~                 —         330 MB · 9         330 MB     2 weeks ago [Clean up…]
old-thing  ~/code/old-thing  gone      80 MB · 3          80 MB      in May      [Clean up…]
…                                                         Total 18.6 GB
```

Clicking a column header sorts by it (again: the other way); the choice is remembered as a UI preference. A row's name
opens its folder in the Files panel (when the folder is there) or filters the sidebar to its conversations. A row being
measured shows a spinner in its Folder cell. English and Chinese strings. The page fits a phone (columns collapse to
name, total and the button).

### The "Clean up…" dialog

Two parts, each optional, each with its own checkboxes; nothing is ticked when it opens.

```
Clean up project-b                                                          ~/omp/project-b

Conversations (2.9 GB, 140)                                   These are deleted for good.
  ☐ Select all
  ☐ Fix the login flow             yesterday     420 MB
  ☐ Release 0.3                    May 3         96 MB
  ☐ Ask about icons      running   …             (not offered: it is running)
  …

Folder (1.1 GB)                                         These go to the Trash and can be put back.
  ☐ Move the whole folder to the Trash   1.1 GB
      ⚠ 3 uncommitted changes, 2 commits not pushed
      140 conversations ran here; those you keep stay, but cannot continue in this folder until it is put back.
  Or only its dependency folders:
  ☐ node_modules   840 MB
  ☐ web/.venv      210 MB

                                  [Cancel]  [Delete 2 conversations and move 1 item to the Trash · frees 1.6 GB]
```

- The conversation list is every conversation of the row (scrolls inside the dialog), newest first, each with its title,
  date and size. One the delete route would refuse (busy: a turn is running; or open in another omp) is shown, not
  tickable, with why. One that is open here but idle is tickable: deleting it ends its process, as the delete routes do.
- The folder part is the delete dialogs' preview for that folder, with one rule changed for this page (below). Ticking
  the whole folder makes the dependency boxes moot, as in the delete dialogs. Absent where there is no Trash command, for
  a protected or gone folder, and for a page not allowed to move to the Trash (it says so).
- The confirm button says what will happen and the room it frees (the sizes of what is ticked); disabled with nothing
  ticked.
- Order on confirm: the ticked conversations are deleted first (the existing bulk route, with no Trash picks), then the
  ticked paths are checked again and moved. A conversation omp refused stays and is reported; the folder move is still
  made if its checks pass as things are then. The answer reports each item; the page shows what was not done, and the
  row is measured again.

### The one rule that differs from the delete dialogs

In the delete dialogs a folder is refused while any other conversation uses it ("inUse"), because the move goes with
deleting one conversation. Here the person decides about the folder itself, knowing which conversations ran in it, so
only what is alive blocks the move (my call on "alive", after the builder check): an omp process of this server that is
not exited (`users.active` in `cleanup.ts`: open in a page, idle or busy) working in the folder or inside it, unless its
conversation is among those ticked for deletion (deleted first, which ends it); a Terminal tab there; a process of this
user whose working folder is in it (`lsof`, as today); and a sidebar project whose folder is it or inside it (that
project would lose its folder). Conversations with no process do not block it; the dialog states how many there are
and what happens to the ones kept. Everything else is the delete dialogs' rules unchanged: protected folders,
`containsOther` for folders of other rows inside it, git risk warning and its re-check, the real path re-check,
`/usr/bin/trash`, the dependency folder rules.

### Server

- `GET /api/disk-space`: the rows with their last measurements, the scan's state, and the disk's free/total space (the
  same reading as the host disks).
- `POST /api/disk-space/scan`: start a scan (no-op while one runs).
- `POST /api/disk-space/preview` `{ folder }`: the row's conversations (file, title, date, size, whether it can be
  deleted) and the folder part (the cleanup preview with the rule above).
- `POST /api/disk-space/clean` `{ folder, files: string[], trash: TrashPick[] }`: delete the files (each must belong to
  that row now), then move the picks (each re-checked as above). `trash` non-empty requires `mayTrash`.
- Built on `DeleteCleanup` (a mode or a parameter for the in-use rule rather than a second copy), the store's sessions
  for rows and conversation sizes, and the projects setting for the projects folder.

## Tests

- Unit: row building (rollup into the outermost row, protected folders do not roll up, a gone folder, a conversation in
  exactly one row, no double counting); conversation size includes the artifacts folder; the in-use rule of this page
  (running things block, a stopped conversation does not, a sidebar project does).
- Contract (real server, stand-in `trash` command): preview and clean through the routes; ticking only the folder
  deletes no conversation; ticking only conversations moves nothing; a file not of that row is refused; a path not in
  the preview is refused; a page without `mayTrash` cannot move.
- e2e: the page lists rows from fixture folders and sorts by each column; the dialog sends exactly what was ticked and
  shows the result; phone layout.

## Left to the builder

How scan progress reaches the page; the nav item's icon and where it sits by default, and how a saved nav layout
without it gets it; how the scan keeps its load low (one `du` at a time, a lower priority); the exact sort of rows with
equal totals; layout details of the dialog on a phone.
