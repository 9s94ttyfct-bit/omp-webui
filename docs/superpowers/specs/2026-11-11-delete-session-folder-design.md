# Deleting a conversation with its folder or its dependencies — design

Date: 2026-11-11. Size: a project.

## Why

A conversation often ran in a folder made for it (a scratch folder, a clone, a worktree) and filled it with dependencies
(`node_modules`, a `.venv`). Deleting the conversation today leaves all of that on disk: omp's `/session delete` removes
the transcript and its artifacts only. The person wants the delete to offer cleaning that up too, as a choice, on this Mac
and on the remote Macs whose conversations they delete.

## What the person decided

- The folder offered is the conversation's working folder (`SessionSummary.cwd`), wherever it ran: a project, a scratch
  folder, a git worktree.
- "Dependencies" means dependency folders inside that folder (`node_modules`, `.venv`, `Pods`, …); the project's own files
  stay. Packages installed outside the folder (`npm -g`, `pip`, `brew`) are not in scope.
- Removal moves to the Trash (recoverable), never deletes for good.
- Three checks guard a folder: it is not offered while another conversation or a project uses it or a folder in it; a
  git repository with uncommitted or unpushed work is warned about first; the home folder, a folder above it and system
  folders are never offered.
- Both delete dialogs get the choice: the single one (row menu › Delete…) and the bulk one (selection › Delete).
- It applies to this Mac and to remote Macs. A remote Mac's conversations are deleted by its own omp-webui server (its
  page), so the work is all server side and each Mac acts only on its own disk; a remote Mac gets the choice once it runs
  this version.
- Dependency folders are each a line of their own with the exact path and size, unticked; only what is ticked is moved.
  How a folder is recognised as a dependency folder decides only what is listed, never what is moved.

## Goals

- Delete a conversation and, by choice, move its working folder or some of its dependency folders to the Trash, in one
  confirmation.
- Nothing outside what the person ticked is touched; nothing is touched when the conversation itself was not deleted.
- The checks hold on the server: no page (a stale one, a script with the token) can move a folder the checks refuse.

Non-goals: packages installed outside the folder; deleting for good; emptying the Trash; folders of conversations that
are not deleted; other platforms' recycle bins (see Constraints).

Anti-goals (a failure even if it works): moving a folder another conversation or project still uses; moving a folder
with the person's data because it looked like a dependency folder and was pre-ticked; a page saying "moved" when
the move failed.

## Constraints

- macOS ships `/usr/bin/trash` (seen on this Mac, macOS 27.2, and on Server1, 26.6.2). It moves items to the Trash of
  their volume with Put Back, and needs no Automation permission (Finder scripting would). The choice is offered only
  where the server's platform is macOS and `/usr/bin/trash` exists; elsewhere the dialogs are as today.
- omp refuses to delete a busy conversation, and the server refuses one open in another omp (`SessionBusyError`,
  `SessionOpenElsewhereError` → 409). Those refusals stand and come first.
- The server knows every conversation's folder (`store` sessions' `cwd`, live processes' `info.cwd` for chats that have
  no file yet) and every sidebar project's `folder` (`chat-projects`).
- Public repo: no real paths in code, tests, docs or commits.

## Approaches

1. **The server previews, then deletes and moves** (chosen). Opening a delete dialog asks the server what it would offer
   for each conversation: the folder with its size, the dependency folders found with theirs, the git warning, and why
   a folder is not offered. Confirming sends what was ticked; the server deletes each conversation through omp and only
   after that succeeds re-checks and moves the ticked paths to the Trash. All checks live in the server, so a remote Mac
   enforces them too.
2. **The page uses the existing file routes.** Smaller, but the checks would live in the page, and the server could not
   refuse a move they forbid. Rejected.
3. **Ask the agent to clean up.** Unpredictable; rejected.

## Design

### Preview: `POST /api/session/delete-preview`

Body `{ files: string[] }` (one for the single dialog, every selected one for bulk). The conversations in the body do not
count as using each other's folders: they are being deleted together. Answer, per conversation:

```ts
interface DeletePreview {
  file: string;
  /** Null where nothing can be offered (platform without the Trash command, folder missing). */
  folder: null | {
    path: string;
    bytes: number | null;          // null: not measured in time
    offer: boolean;                 // false: shown, not tickable
    refused?: "home" | "system" | "inUse" | "containsOther" | "notFolder";
    usedBy?: string[];              // titles of the conversations/projects that use it (for "inUse"/"containsOther")
    git?: { uncommitted: number; unpushed: number | null };  // present only for a repository with work at risk
  };
  deps: { path: string; bytes: number | null; kind: string }[];  // kind: "node_modules", ".venv", …
}
```

Sizes are measured with a time budget (a large tree answers `null`, shown as "size unknown") so the dialog opens fast.

### Delete: the existing routes take what was ticked

`/api/session/delete` takes `{ file, trash?: string[] }`; `/api/sessions/delete` takes `{ files, trash?: Record<file, string[]> }`.
All conversations of the request are deleted through omp first, as today; only then are the ticked paths moved. A
conversation omp refused keeps everything of its own, and still counts as using its folder for the others' paths. Then,
for each ticked path,
the server checks it again at that moment, nothing taken from the preview on trust:

- it must still be that conversation's folder or a dependency folder the listing rules find in it now;
- its real path must be the one the preview showed (the page sends back the preview's real path; a symlink swapped
  since, or a folder replaced, is refused);
- every check must pass now, against the conversations, live processes and projects as they are now (the
  conversations this request deleted no longer count as using it);
- the git counts must be no higher than the preview showed: work added since the dialog opened stops the move.

Then it runs `/usr/bin/trash <path>`. The answer adds, per conversation, `{ moved: string[], notMoved: { path, error }[] }`;
the page shows a toast for anything not moved, and the conversation stays deleted.

### The checks (server, `server/sessions/trash-check.ts`)

- **home/system**: refused when the real path (symlinks resolved) is the home folder or a folder above it, `/`, a volume
  root (`/Volumes/<name>`), one of `/tmp`, `/var`, `/private`, `/private/tmp`, `/private/var`, `/opt`, `/Users`, or is
  inside `/System`, `/Library`, `/Applications`, `/usr`, `/bin`, `/sbin`. A scratch folder inside `/tmp` or the
  per-user temp folder stays offerable. omp-webui's data folder, omp's home (`~/.omp`), the folders above them and the
  folders inside them are refused the same way.
- **inUse / containsOther**: the folders of the other conversations (every one not deleted in this request, with or
  without a file: live processes' `info.cwd` count), of every sidebar project (the deleted conversation's own project
  included: the project stays), of the server's Terminal tabs, and the working folder of every process of this user
  (`lsof -a -d cwd -u <uid> -Fn`, so a dev server or a shell started elsewhere counts) are compared, real path to real
  path. Refused as `inUse` when one of them is this folder or contains it (a project's subfolder is not moved from under
  it), as `containsOther` when one is inside it. Containing counts only for conversations and projects, and only when
  their folder is not the home folder, above it or a system folder (a chat started in `~` would otherwise block
  everything); for Terminal tabs and processes only "this folder or inside it" counts (every app's working folder is
  `/`). `usedBy` names them ("a Terminal tab", "node (pid 4120)"). The omp
  processes of the conversations being deleted are not counted (the delete ends them); anything else they started is.
- **git**: in a repository, uncommitted work is `git status --porcelain -- <path>` (limited to what would move, so a
  subfolder is not warned about changes elsewhere in the repository). Unpushed work is
  `git rev-list --count @{u}..HEAD`, counted only when the folder is the repository's top or a worktree's (null without
  an upstream; then a branch with commits and no upstream counts as unpushed). Run the way the status line runs git
  (`safeGit`/`vetRepository`: no hooks, no fsmonitor, no command from the repository's config). Warning only: the box
  stays tickable, and the dialog states the counts next to it. A git worktree moved to the Trash keeps git's record of
  it (Put Back restores a working worktree); the dialog says git lists it until `git worktree prune`.

### Dependency folders (what is listed)

Searched inside the folder, to a bounded depth (4) and count (50), not entering a listed folder or `.git`:

| Kind | Listed when |
|---|---|
| `node_modules` | always |
| `.venv`, `venv` | it holds `pyvenv.cfg` |
| `target` | it holds `CACHEDIR.TAG` (Cargo writes it) |
| `Pods` | a `Podfile.lock` is beside it |
| `.gradle`, `build` (Gradle) | a `build.gradle(.kts)`/`settings.gradle(.kts)` is beside it and git ignores it |
| `vendor` | a `composer.json` or `go.mod` is beside it and git ignores it |

Listing is not a promise it is disposable: each is unticked, with its path and size.

A dependency folder is offered even when the conversation's folder is not (a chat in its project's folder is the common
case). Its checks (the person's decision): home/system and the data folders as above, and it must be inside the
deleted conversation's folder; of the "in use" sources only what is running counts: a conversation process that is
still alive, a Terminal tab, or a process whose working folder is the conversation's folder or inside it (a dev server
of the project). Old conversations and sidebar projects in the same folder do not block it: dependencies can be
installed again.

### Dialogs

Single dialog, under the description, when the preview has something:

```
☐ Move the folder to the Trash     ~/code/login-refactor (1.2 GB)
    ⚠ 3 uncommitted changes, 2 commits not pushed
  Or only its dependency folders:
☐ ~/code/login-refactor/node_modules   840 MB
☐ ~/code/login-refactor/web/.venv      210 MB
```

Ticking the folder makes the dependency boxes moot (they are disabled and shown ticked-through). A folder that is not
offered shows why ("Used by “Fix CI” and 1 more", "Your home folder"). Bulk dialog: every selected conversation gets the
same block under its title, none left out; the list scrolls inside the dialog instead of stopping at 8 + "and N more".
A conversation with nothing to offer is one line (its title); one with something is collapsed under its title with a
count ("folder · 2 dependency folders") and opens on a click. Conversations sharing one folder: the folder is offered
once, under the first of them (deleting them together frees it). Paths are shown with `~` for the home folder. English
and Chinese strings (`web/src/i18n/shell.ts`, `zh-CN/shell.ts`).

The delete button's label says what it will do: "Delete" / "Delete and move 2 items to the Trash".

### Tests

- Unit: the checks (home, above home, system, inUse/containsOther with symlinks, the data folder), the dependency
  listing rules, the git counts on a scratch repository.
- Contract: preview and delete through the routes with a stand-in `trash` (an injected command), including "omp
  refused → nothing moved" and "path not in the preview → refused".
- One macOS test (`test:mac`) moves a scratch folder with the real `/usr/bin/trash` and finds it in the Trash.
- e2e: the single dialog shows the options and sends the ticked paths; the bulk one per conversation.

## Left to the builder

The time budget for sizes; how the preview is cached between opening and confirming; the exact system folder list
beyond the one above; layout details of the bulk dialog.
