---
title: Projects, folders and git
summary: The folder a conversation works in (the folder picker, the projects folder and New project folder), the sidebar's project groups, the status line's git state, and the Worktrees and Issues tabs.
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

**Unsafe repositories.** Before running git in a folder, the server checks the repository's own configuration; one that names a command git would run is not looked at ("Not looked at: the repository's own settings name a command git would run").

## Where it is

- **New chat** › folder picker, with **New project folder** (*Made in <projects folder>*).
- **Settings › Conversations & files › Projects folder** (`#/settings/chats`): the path, *Choose…*, *Save*, *Use default*. On a page that is not on this computer it is read-only ("Change the projects folder on the computer omp-webui runs on. From here you can still make a project folder in it.").
- Sidebar: the projects funnel and its popover with the groups and their menus.
- A conversation: the status line (git), side panel tabs **Worktrees** and **Issues** (bottom pane by default).

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.cwd` | a folder path (free text) | unset | Synced preference. The folder of the last new conversation; the New chat folder picker starts there (unset: the home folder). |

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

Every page is told of a change to the groups over the WebSocket.

## Limits and caveats

- The folder picker lists at most 500 folders of one folder and never hidden ones (type the path instead).
- Git figures are read with a time limit; a slow repository answers "git did not answer in time".
- The Issues tab needs the GitHub CLI installed on the computer omp-webui runs on and signed in; it reads with the person's own `gh` account.
- Project groups are omp-webui's own; they do not move or rename folders, and omp knows nothing of them.

## Security notes

- A page that holds the token can list any folder's subfolders (`/api/dirs`) and start a conversation there, which gives the agent its reach in that folder; that is why the token matters (see `server-and-security`).
- Only a page on this computer can change the projects folder; a remote page can make a new folder only inside it.
- git is not run in a repository whose own configuration names a command (protection against a cloned repository running code when merely looked at).
- The Issues tab never writes to GitHub.
