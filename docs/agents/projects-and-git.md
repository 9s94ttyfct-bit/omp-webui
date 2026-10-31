---
title: Projects, folders and git
summary: The folder a conversation works in (the folder picker, the projects folder and New project folder), the sidebar's project groups, the status line's git state, and the Worktrees, Issues and CI tabs.
settings: projects-folder
---

# Projects, folders and git

## What it does

**A conversation's folder.** Every conversation runs omp in one folder (its project). **New chat** asks for it with a folder picker that lists the folders of a path (hidden ones left out; `~` is the home folder) and remembers the last one used. From the picker, **New project folder** makes an empty folder in the projects folder under a name the person types (*Folder name*, *Create and use*) and starts the chat there. A name is one folder: at most 100 characters (and 255 bytes), no `/` or `\`, not starting with a dot, not starting or ending with a space or ending with a dot, no control characters or `< > : " | ? *`, and not a folder that already exists.

**The projects folder** is where New project folder makes projects. Default: `~/omp` (made when the first project folder is). The person can choose another folder or go back to the default.

**Project groups.** The sidebar's project list (the funnel: *All projects* / *Projects*) shows each project (folder) with its conversation count; a project appears with its first conversation. Projects can be put into named groups (*New group…*, *Rename…*, *Delete group…*, *Move up* / *Move down*, *Move out of the group*, move a project into a group), and a group can be folded. Groups change only the sidebar: no folder is touched. Deleting a group keeps its projects (they go back to the top level).

**Git in a conversation.** When the conversation's folder is in a git repository, the status line under the message box shows the branch (*Branch …* or *Detached HEAD at …*), counts of staged, unstaged and untracked changes (*No changes* when clean), and the branch's pull request (*Pull request #N*) where GitHub has one.

**Worktrees tab** (side panel): the repository's worktrees and how each stands: its branch (or *detached at …*, *bare repository*), *this conversation* / *main*, *Locked*, *Its folder is gone (git can prune it)*, uncommitted changes (*Uncommitted: N staged · N changed · N untracked* or *Nothing uncommitted*; counted for the first 24 worktrees only), and commits not on the main branch. *Refresh worktrees* looks again.

**Issues tab** (side panel): the GitHub issues of the conversation's folder, read with the person's own GitHub CLI (`gh issue list`, `gh issue view`): filter *Show issues* (open / closed / all), *Search issues*, and an issue's detail with comments. An issue can be put into the message box (for the person to add to and send) or start a new conversation in the folder with the issue in its message box. Read-only: nothing is ever written to GitHub. When nothing can be shown it says why: `gh` not installed, not signed in, the folder is not a GitHub repository, the repository is unsafe (below), `gh` too slow, or `gh`'s own error.

**CI tab** (side panel): the GitHub Actions runs of the conversation's folder, read with the person's own GitHub CLI (`gh run list`, `gh run view --json jobs`): *This branch* (the folder's current branch; on a detached HEAD every branch's runs are shown) or *All branches*, the latest 20. Each run shows its state (queued, running, passed, failed, cancelled, skipped), workflow name, commit or pull request title, branch, event, when it started and how long it took, and a link to it on GitHub. Clicking a run unfolds its jobs with their state and duration, the first step that failed, and a *Log* link to the job's page on GitHub. The tab's badge is a dot for the latest commit's runs on the current branch: running (pulsing), failed (red) or passed (green); none when there are no runs, for cancelled or skipped ones, or when nothing can be shown. The bell (*Notify when a run of this branch finishes*, `ompw.ciNotify`, off by default) shows a notification when a run of the branch that was queued or running finishes while the window is not in use; it needs page notifications (`ompw.notify`, which turning the bell on asks for) and is a browser feature: the macOS app's window has no page notifications, so the bell is not shown there. Read-only. The same reasons as the Issues tab when nothing can be shown, plus GitHub's API rate limit.

**How often the CI tab looks.** The server never polls on its own: a page asks (`/api/github/runs`) and the server runs `gh` only when its last look at that list is older than the look's interval: 10 s while any run shown is queued or running, 60 s when all are finished; after a failure 1 minute doubling to at most 15 (after a rate limit 5 minutes doubling). Every page asking about the same repository and list within the interval gets the same look, and a look under way is waited for, so one repository costs one `gh` per interval however many pages watch it. A page asks only while the side panel is open (the badge) or the tab is shown, and not while it is hidden, unless the bell is on (then the current branch's list goes on being looked at so that a run's end can be told).

**Unsafe repositories.** Before running git in a folder, the server checks the repository's own configuration; one that names a command git would run is not looked at ("Not looked at: the repository's own settings name a command git would run").

## Where it is

- **New chat** › folder picker, with **New project folder** (*Made in <projects folder>*).
- **Settings › Conversations & files › Projects folder** (`#/settings/chats`): the path, *Choose…*, *Save*, *Use default*. On a page that is not on this computer it is read-only ("Change the projects folder on the computer omp-webui runs on. From here you can still make a project folder in it.").
- Sidebar: the projects funnel and its popover with the groups and their menus.
- A conversation: the status line (git), side panel tabs **Worktrees**, **Issues** and **CI** (bottom pane by default).

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.cwd` | a folder path (free text) | unset | Synced preference. The folder of the last new conversation; the New chat folder picker starts there (unset: the home folder). |
| `ompw.ciNotify` | `on`, `off` | unset: off | Synced preference. The CI tab's bell: notify when a run of the folder's branch that was queued or running finishes (browser pages only; needs `ompw.notify` and the browser's permission). |

Other stored data (in the data folder, `~/.omp-webui`):

| Stored in | Content | Default | Limits |
|---|---|---|---|
| `projects-folder.json` | the projects folder | absent: `~/omp` | must be an existing folder to make projects in it |
| `project-groups.json` | the sidebar's groups: name, folded or not, their projects in order | no groups | at most 200 groups, names up to 60 characters, 500 projects per group, 5,000 in all; written with mode 0600; a damaged file is kept aside as `.damaged` |

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/dirs?path=<path>` | GET | token | The folders in `path` (default: the home folder; `~` and `~/…` allowed, otherwise absolute), without hidden ones: `{ path, parent, dirs, omitted }`, at most 500 names. 404 not found, 400 not a folder or relative, 403 no permission. |
| `/api/projects` | GET, POST | token; POST from this computer only | GET the projects folder and whether it is the default. POST `{ folder }` (a path, or `null` for the default) changes it; 403 `projectsNotHere` for a page not on this computer. |
| `/api/projects/new` | POST | token | `{ name }`: make one empty folder of that name directly in the projects folder and answer its path. Open to remote pages (it can make only a new folder inside the projects folder). Name problems are answered with a `problem` code. |
| `/api/project-groups` | GET, POST | token | GET the groups. A POST to the bare route with `{ id }` deletes that group, as `/delete` does. |
| `/api/project-groups/create` | POST | token | `{ name }`: a new group. |
| `/api/project-groups/rename` | POST | token | `{ id, name }`. |
| `/api/project-groups/collapse` | POST | token | `{ id, collapsed }`: fold or unfold a group in the sidebar. |
| `/api/project-groups/move` | POST | token | `{ cwd, group, at }`: move a project (folder) into a group (`group` null: the top level) at a position. |
| `/api/project-groups/reorder` | POST | token | `{ id, delta }`: move a group up (`delta` < 0) or down. |
| `/api/project-groups/delete` | POST | token | `{ id }`: delete a group; its projects stay. |
| `/api/git?cwd=<folder>` | GET | token | The status line's git report: branch, change counts; `pr=1` adds the pull request, `fresh=1` looks again instead of using a recent answer. |
| `/api/git/worktrees?cwd=<folder>` | GET | token | The Worktrees tab: the repository's worktrees and their state; `fresh=1` looks again. |
| `/api/github/issues` | POST | token | `{ cwd, state?, search?, fresh? }` (`state` `open` default, `closed`, `all`): the folder's issues via `gh issue list` (up to 100; search up to 200 characters). Answers `{ ok, value }` or `{ ok: false, problem }`. |
| `/api/github/issue` | POST | token | `{ cwd, number, fresh? }`: one issue with its comments via `gh issue view`. |
| `/api/github/runs` | POST | token | `{ cwd, scope?, fresh? }` (`scope` `branch` default, `all`): the folder's GitHub Actions runs via `gh run list` (latest 20). Answers `{ ok, value: { scope, branch, runs }, nextMs }` or `{ ok: false, problem, message?, nextMs }`; `nextMs` is when the next look is due. Shared by every page for its interval; `fresh` looks now. |
| `/api/github/run` | POST | token | `{ cwd, id, fresh? }`: one run's jobs via `gh run view <id> --json jobs`, with each job's first failed step. Kept 10 s while a job is at work, 10 minutes once all are finished. |

Every page is told of a change to the groups over the WebSocket.

## Limits and caveats

- The folder picker lists at most 500 folders of one folder and never hidden ones (type the path instead).
- Git figures are read with a time limit; a slow repository answers "git did not answer in time".
- The Issues and CI tabs need the GitHub CLI installed on the computer omp-webui runs on and signed in; they read with the person's own `gh` account (its API rate limit is the person's).
- The CI tab's badge and notification are only as fresh as a page that has the side panel open: with no page looking, nothing is asked and nothing is notified.
- Project groups are omp-webui's own; they do not move or rename folders, and omp knows nothing of them.

## Security notes

- A page that holds the token can list any folder's subfolders (`/api/dirs`) and start a conversation there, which gives the agent its reach in that folder; that is why the token matters (see `server-and-security`).
- Only a page on this computer can change the projects folder; a remote page can make a new folder only inside it.
- git is not run in a repository whose own configuration names a command (protection against a cloned repository running code when merely looked at).
- The Issues and CI tabs never write to GitHub. Remote pages may use them as they may the Issues tab (the token is the gate); `gh`'s token never leaves the server, and anything that looks like a GitHub token in what `gh` prints is replaced before a page is told.
