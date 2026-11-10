---
title: Projects, folders and git
summary: The folder a conversation works in (the folder picker, the projects folder and New project folder), the sidebar's Projects (named groups of conversations), the status line's git state, and the Worktrees, Issues and CI tabs.
settings: projects-folder
---

# Projects, folders and git

## What it does

**A conversation's folder.** Every conversation runs omp in one folder (its project). **New chat** makes a new project by default (v0.17.0): *Project name* (empty: named from the time, `chat-YYYY-MM-DD-HHMM`, then `-2`, …) is made in the projects folder (*Made in …*, *Change*) when the first message is sent, never before; everything picked before then goes to the process started there. The folder button before the name (*New project ▾*, or the chosen folder's name, its path in the tooltip) has a menu: **New project**, **Choose an existing folder…** (a folder picker that lists the folders of a path; hidden ones left out; `~` is the home folder) and up to four **Recent** folders. An entry point with a folder (an issue's *New conversation with it*, `#/new?cwd=<folder>`) opens New chat in that folder. From the picker, **New project folder** makes an empty folder in the projects folder under a name the person types (*Folder name*, *Create and use*) and starts the chat there. A name is one folder: at most 100 characters (and 255 bytes), no `/` or `\`, not starting with a dot, not starting or ending with a space or ending with a dot, no control characters or `< > : " | ? *`, and not a folder that already exists.

**The projects folder** is where New project folder makes projects. Default: `~/omp` (made when the first project folder is). New chat makes its new projects there too. The person can choose another folder or go back to the default.

**Projects (the sidebar).** A project is a named group of conversations, as a chat app has them: conversations from different folders may be in one project, and putting one in a project never changes its working folder. The sidebar's **Projects** section is above the list by date (shown even with no project, with a one-line hint; *New project* is its **+**). Each project row folds and unfolds (remembered), shows its name and count, **New chat in it** (the pencil button on hover), a **folder button** when it has a folder, and a ⋯ menu: *New chat in this project*, *Rename…*, *Set folder…* / *Change folder…* / *Remove folder*, *Move up* / *Move down*, *Delete project…* (its conversations go back to the list by date; none is deleted). An open project lists its 5 newest conversations, then *Show all N*. A conversation is put in a project from its ⋯ menu (*Move to project ›* a project, *New project…*, *Remove from project*), by dragging its row onto a project's row (mouse: drag; touch: hold the row, then drag), or for several at once from *Select* › *Move to project*. A conversation in a project is listed under it and not in the list by date; Pinned still shows it (and its project too). A search lists every match, in a project or not, with the project's name as a small label.

**Membership rule.** A project holds conversations by their session id (the id in the transcript's header), so omp's `/move` or a renamed file keeps it there. A conversation is in at most one project. One that was put in a project (or taken out of one: *Remove from project* is remembered as "in no project") is where it was put; any other conversation is in the project of the conversation it was branched, forked or continued from (`parentSession`, up the chain), so a branch of a conversation in a project shows in that project until it is moved or taken out itself.

**New chat in a project** opens New chat in the project's folder (or where New chat starts when it has none), with *In the project <name>* under the greeting. The server puts the conversation in the project when its first message is sent (it knows the process's session id by then), so it lands there even when the page is closed right after sending; a New chat left without a message puts nothing anywhere.

**The folder button** shows the project's folder in the Files panel: when the conversation on screen works in that folder, its own side panel opens on Files; otherwise the project's page opens (`#/project/<id>`: its name, folder, New chat, its conversations, and the Files panel on the right rooted at the folder). The Files panel names the project, not a folder: the server finds the folder in its own list of projects, and the files API's rules for this computer's page and a remote page are the same as for a conversation's.

**From project groups (#636).** The first read of the projects, when `chat-projects.json` does not exist yet, turns each old project group into a project of the same name: its conversations are those whose folder was one of the group's folders, its folder is the group's folder when it had exactly one, its fold is kept. `project-groups.json` is left on disk and not read again.

**Git in a conversation.** When the conversation's folder is in a git repository, the status line under the message box shows the branch (*Branch …* or *Detached HEAD at …*), counts of staged, unstaged and untracked changes (*No changes* when clean), and the branch's pull request (*Pull request #N*) where GitHub has one.

**Worktrees tab** (side panel): the repository's worktrees and how each stands: its branch (or *detached at …*, *bare repository*), *this conversation* / *main*, *Locked*, *Its folder is gone (git can prune it)*, uncommitted changes (*Uncommitted: N staged · N changed · N untracked* or *Nothing uncommitted*; counted for the first 24 worktrees only), and commits not on the main branch. *Refresh worktrees* looks again.

**Issues tab** (side panel): the GitHub issues of the conversation's folder, read with the person's own GitHub CLI (`gh issue list`, `gh issue view`): filter *Show issues* (open / closed / all), *Search issues*, and an issue's detail with comments. An issue can be put into the message box (for the person to add to and send) or start a new conversation in the folder with the issue in its message box. Read-only: nothing is ever written to GitHub. When nothing can be shown it says why: `gh` not installed, not signed in, the folder is not a GitHub repository, the repository is unsafe (below), `gh` too slow, or `gh`'s own error.

**CI tab** (side panel): the GitHub Actions runs of the conversation's folder, read with the person's own GitHub CLI (`gh run list`, `gh run view --json jobs`): *This branch* (the folder's current branch; on a detached HEAD every branch's runs are shown) or *All branches*, the latest 20. Each run shows its state (queued, running, passed, failed, cancelled, skipped), workflow name, commit or pull request title, branch, event, when it started and how long it took, and a link to it on GitHub. Clicking a run unfolds its jobs with their state and duration, the first step that failed, and a *Log* link to the job's page on GitHub. The tab's badge is a dot for the latest commit's runs on the current branch: running (pulsing), failed (red) or passed (green); none when there are no runs, for cancelled or skipped ones, or when nothing can be shown. The bell (*Notify when a run of this branch finishes*, `ompw.ciNotify`, off by default) shows a notification when a run of the branch that was queued or running finishes while the window is not in use; it needs notifications (`ompw.notify`, which turning the bell on asks for). In a browser the page shows it; in the macOS app the app shows it (the page asks the app for this one kind of notification, and the app refuses any other a page asks for; macOS's permission is in System Settings › Notifications › omp-webui), and clicking it opens the CI tab. The app's window onto another Mac has no bell. Read-only. The same reasons as the Issues tab when nothing can be shown, plus GitHub's API rate limit.

**How often the CI tab looks.** The server never polls on its own: a page asks (`/api/github/runs`) and the server runs `gh` only when its last look at that list is older than the look's interval: 10 s while any run shown is queued or running, 60 s when all are finished; after a failure 1 minute doubling to at most 15 (after a rate limit 5 minutes doubling). Every page asking about the same repository and list within the interval gets the same look, and a look under way is waited for, so one repository costs one `gh` per interval however many pages watch it. A page asks only while the side panel is open (the badge) or the tab is shown, and not while it is hidden, unless the bell is on (then the current branch's list goes on being looked at so that a run's end can be told).

**Unsafe repositories.** Before running git in a folder, the server checks the repository's own configuration; one that names a command git would run is not looked at ("Not looked at: the repository's own settings name a command git would run").

## Where it is

- **New chat** › the folder button's menu › *Choose an existing folder…* (the folder picker), with **New project folder** (*Made in <projects folder>*).
- **Settings › Conversations & files › Projects folder** (`#/settings/chats`): the path, *Choose…*, *Save*, *Use default*. On a page that holds only the access token (not this computer's, not signed in through Cloudflare Access) it is read-only ("Change the projects folder on the computer omp-webui runs on, or from a page signed in through Cloudflare Access. From here you can still make a project folder in it.").
- Sidebar: the **Projects** section above the list by date; a conversation's ⋯ menu › *Move to project*; *Select* › *Move to project*; a project's page `#/project/<id>`. The search bar's funnel is the **Folder** filter: a flat list of folders with their counts (it keeps the conversations of one working folder).
- A conversation: the status line (git), side panel tabs **Worktrees**, **Issues** and **CI** (bottom pane by default).

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.cwd` | a folder path (free text) | unset | Synced preference. The folder of the last new conversation (Settings › Model config reads it as the project). It no longer picks New chat's folder. |
| `ompw.ciNotify` | `on`, `off` | unset: off | Synced preference. The CI tab's bell: notify when a run of the folder's branch that was queued or running finishes (a browser page or the macOS app, not its window onto another Mac; needs `ompw.notify` and the browser's or macOS's permission). |

Other stored data (in the data folder, `~/.omp-webui`):

| Stored in | Content | Default | Limits |
|---|---|---|---|
| `projects-folder.json` | the projects folder | absent: `~/omp` | must be an existing folder to make projects in it |
| `chat-projects.json` | the sidebar's projects (name, folder, folded or not, the session ids put in each) and the session ids taken out of one | no projects (made from `project-groups.json` on the first read when that exists) | at most 200 projects, names up to 60 characters (no two that read the same), 20,000 conversations in all; written with mode 0600; a damaged file is kept aside as `.damaged` |

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/dirs?path=<path>` | GET | token | The folders in `path` (default: the home folder; `~` and `~/…` allowed, otherwise absolute), without hidden ones: `{ path, parent, dirs, omitted }`, at most 500 names. 404 not found, 400 not a folder or relative, 403 no permission. |
| `/api/projects` | GET, POST | token; POST from the person's own page (this computer's, or one signed in through Cloudflare Access) | GET the projects folder and whether it is the default. POST `{ folder }` (a path, or `null` for the default) changes it; 403 `projectsNotHere` for a page that holds only the token. |
| `/api/projects/new` | POST | token | `{ name }`: make one empty folder of that name directly in the projects folder and answer its path. Open to remote pages (it can make only a new folder inside the projects folder). Name problems are answered with a `problem` code. |
| `/api/chat-projects` | GET | token | The projects: `{ projects, excluded, problem }`. |
| `/api/chat-projects/create` | POST | token | `{ name, sessions? }`: a new project, with these conversations (session ids) put in it. Every change answers the whole list and the project it made or changed (`project`). |
| `/api/chat-projects/rename` | POST | token | `{ id, name }`. |
| `/api/chat-projects/folder` | POST | token | `{ id, folder }`: an existing folder, or `null` for none (`projectFolderInvalid` otherwise). |
| `/api/chat-projects/collapse` | POST | token | `{ id, collapsed }`: fold or unfold a project in the sidebar. |
| `/api/chat-projects/assign` | POST | token | `{ sessions, project }`: put conversations (session ids) in a project, or with `project` null take them out of every project. |
| `/api/chat-projects/reorder` | POST | token | `{ id, delta }`: move a project up (`delta` < 0) or down. |
| `/api/chat-projects/delete` | POST | token | `{ id }`: delete a project; its conversations stay. |
| `/api/git?cwd=<folder>` | GET | token | The status line's git report: branch, change counts and the repository's name (`git.repo`, which the tab's title shows: from its remote's address, without a remote its top folder's name, null when git did not say; only the name leaves the server, never the configuration it is read from); `pr=1` adds the pull request, `fresh=1` looks again instead of using a recent answer. |
| `/api/git/worktrees?cwd=<folder>` | GET | token | The Worktrees tab: the repository's worktrees and their state; `fresh=1` looks again. |
| `/api/github/issues` | POST | token | `{ cwd, state?, search?, fresh? }` (`state` `open` default, `closed`, `all`): the folder's issues via `gh issue list` (up to 100; search up to 200 characters). Answers `{ ok, value }` or `{ ok: false, problem }`. |
| `/api/github/issue` | POST | token | `{ cwd, number, fresh? }`: one issue with its comments via `gh issue view`. |
| `/api/github/runs` | POST | token | `{ cwd, scope?, fresh? }` (`scope` `branch` default, `all`): the folder's GitHub Actions runs via `gh run list` (latest 20). Answers `{ ok, value: { scope, branch, runs }, nextMs }` or `{ ok: false, problem, message?, nextMs }`; `nextMs` is when the next look is due. Shared by every page for its interval; `fresh` looks now. |
| `/api/github/run` | POST | token | `{ cwd, id, fresh? }`: one run's jobs via `gh run view <id> --json jobs`, with each job's first failed step. Kept 10 s while a job is at work, 10 minutes once all are finished. |

Every page is told of a change to the projects over the WebSocket (`chat_projects`). The socket's `open` of a new chat takes `project` (an id): the conversation is put in that project with its first message. A project's Files panel uses `/api/folder/*` with `file=chat-project:<id>`.

## Limits and caveats

- The folder picker lists at most 500 folders of one folder and never hidden ones (type the path instead).
- Git figures are read with a time limit; a slow repository answers "git did not answer in time".
- The Issues and CI tabs need the GitHub CLI installed on the computer omp-webui runs on and signed in; they read with the person's own `gh` account (its API rate limit is the person's).
- The CI tab's badge and notification are only as fresh as a page that has the side panel open: with no page looking, nothing is asked and nothing is notified.
- Projects are omp-webui's own; they do not move or rename folders or conversations, and omp knows nothing of them. Projects are visible and editable from remote pages, as pins and the archive are; setting a folder uses the same folder picker every page has.

## Security notes

- A page that holds the token can list any folder's subfolders (`/api/dirs`) and start a conversation there, which gives the agent its reach in that folder; that is why the token matters (see `server-and-security`).
- Only the person's own page (this computer's, or one signed in through Cloudflare Access) can change the projects folder; a page that holds only the token can make a new folder only inside it.
- git is not run in a repository whose own configuration names a command (protection against a cloned repository running code when merely looked at).
- The Issues and CI tabs never write to GitHub. Remote pages may use them as they may the Issues tab (the token is the gate); `gh`'s token never leaves the server, and anything that looks like a GitHub token in what `gh` prints is replaced before a page is told.
