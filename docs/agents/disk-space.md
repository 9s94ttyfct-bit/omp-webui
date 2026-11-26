---
title: Disk space
summary: The Disk space page: what each project folder and its conversations take on disk, measured in the background, sortable, and a Clean up dialog per folder that deletes chosen conversations and moves the folder or its dependency folders to the Trash.
settings:
---

# Disk space

## What it does

**The table.** One row per folder of the projects folder (Settings › Conversations & files › *Projects folder*, by default `~/omp`), with or without conversations, and one per other folder conversations ran in (*outside the projects folder*). A conversation belongs to the row whose folder holds its own (a conversation in `~/omp/app/web` is `app`'s; a folder reached through a link counts as the folder it names); a folder outside the projects folder that is inside another such folder is counted with the outermost one. The home folder, the system's folders, omp's and omp-webui's data, the projects folder itself and every folder above it are rows only for the conversations that ran exactly there: their folder is not measured (*not measured*) and nothing inside them is added to them (a link in the projects folder to one of them is not a project either). A folder that is gone stays a row while conversations name it (*folder gone*), unless it was inside a project's folder: then its conversations are that project's.

Each row shows its name with its path, the size of its folder, how many conversations ran there and what they take (each conversation's transcript and its folder of subagent transcripts and kept files), the total (folder plus conversations; a transcript kept inside the folder is counted once, under conversations; *folder not counted* while the folder's size is not known), and when it was last used (its newest conversation, else the folder's modification time). The header shows the free and total space of the disk the projects folder is on, and when the folders were last measured. The footer adds up the totals. A click on a column header sorts by it (again: the other way; a folder whose size is not known, or a row never used, comes last); the sort is remembered. On a phone only the name, the total and the button are shown.

**Measuring.** Folder sizes are the space allocated on disk (`du -sk`, at a lower priority), measured by one background scan at a time, one folder at a time, those measured longest ago first. A folder may take 30 seconds (*too slow to measure* past that) and a whole scan 5 minutes; what a scan did not reach keeps its last size. Opening the page starts a scan when the last one finished more than 10 minutes ago; **Refresh** starts one at once. While a scan runs the page shows *Measuring N of M…* and updates every two seconds. The sizes are kept across restarts and across a change of the projects folder (by the folder's real path).

**Clean up….** Each row's dialog lists its conversations (newest first, each with its date and size; *Select all*) and, below, what its folder offers to the Trash: the whole folder, or only its dependency folders (`node_modules`, `.venv`, `target`, …), as the delete dialogs offer them (see `conversations`). Nothing is ticked at first. The two parts are independent: ticking the folder deletes no conversation, and ticking conversations moves nothing. The confirm button says what will happen and the room it frees (*Delete 2 conversations and move 1 item to the Trash · frees 1.6 GB*). On confirm the ticked conversations are deleted first (through omp, as the sidebar's delete does), then every ticked path is checked again as things are then and moved; what was not done is said in a toast, and the row is measured again. Conversations that ran in a moved folder and were not deleted keep their transcripts; the dialog says how many.

The folder may be moved unless something alive works in it: a conversation's omp process that this server runs (open in a page, idle or replying) in the folder or inside it, unless that conversation is ticked for deletion; a Terminal tab or a process of the person's whose working folder is in it; or a sidebar project whose folder is it or inside it. Conversations with no process do not keep it. A folder that holds another row's folder, or a conversation's transcript, is not offered either, and the delete dialogs' other rules apply unchanged: the home and system folders and omp's data are never offered, git work that would be lost is shown as a warning and checked again before the move, and the path must still be the folder the dialog showed. A conversation that is replying or waiting for an answer cannot be ticked.

## Where it is

- Sidebar (or rail) page **Disk space** (`#/disk`). In a bar arranged before it existed it is added at the end of its group.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.diskSort` | JSON `{ "by": "name" \| "folder" \| "conversations" \| "total" \| "lastUsed", "desc": true \| false }` | unset: total, biggest first | Synced preference. How the Disk space page sorts its rows. |

Stored elsewhere:

| Stored in | What | Effect |
|---|---|---|
| `~/.omp-webui/disk-space.json` | the last sizes, by real folder path and by transcript, and when the last scan finished | What the page shows at once; written after each folder. |

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/disk-space` | GET | token | The rows (`shared/disk-space.ts`: `DiskSpaceAnswer`), the scan's state and the disk's free/total space; starts a scan when the last one finished more than 10 minutes ago. |
| `/api/disk-space/scan` | POST | token | Start a scan; `{ started: false }` while one runs. |
| `/api/disk-space/preview` | POST | token | `{ folder, leaving? }`: the row's conversations (with `busy`) and, with `cleanup`, what its folder offers to the Trash, `leaving` being the conversations ticked for deletion. 404 for a folder that is no row. A page that may not move things to the Trash gets `mayTrash: false` and no `cleanup`. |
| `/api/disk-space/clean` | POST | token; moving needs this computer's page or File transfer | `{ folder, files, trash }`: delete `files` (each must be one of the row's conversations, else 400 and nothing is done), then move the `trash` picks the preview gave, each checked again. `trash` from a page that only holds the token is refused (403) unless Settings › Remote access › *File transfer* lets it send files here. Answers `{ deleted, failed, trashed: { moved, notMoved } }`. |

## Limits and caveats

- Sizes are allocated space as `du` counts it, and as of the last scan; a folder on a slow or network disk may stay *too slow to measure*.
- A file shared by hard links, or a folder reached twice through links, may be counted under more than one row.
- Moving to the Trash needs a Trash command on this computer (macOS's `/usr/bin/trash`); without one the dialog only deletes conversations.

## Security notes

- Deleting conversations cannot be undone; folders go to the Trash and can be put back from there.
- Agents should not clean up on the person's behalf unasked: which conversations and folders to remove is the person's decision.
