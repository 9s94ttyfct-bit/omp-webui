# An isolated environment for a project folder — design

Date: 2026-11-14. Size: a project.

## Why

The person often starts a project only to try something. The agent installs what it needs as it goes, and much of that
lands outside the project's folder: global tools (`npm -g`, `pip install --user`, `cargo install`, `go install`,
`uv tool install`), package caches (`~/.npm`, bun's, pip's and uv's, `~/.cargo/registry`, `~/go/pkg/mod`), Playwright's
browsers and models pulled from Hugging Face. Deleting the conversation with its folder (v0.23.4) moves the folder and the
dependency folders inside it to the Trash, but none of that. The person wants a test project they are done with to leave
nothing behind.

## What the person decided

- The tools covered: npm, bun, pip, uv, cargo, go, Playwright, and Hugging Face models (and datasets).
- Isolation belongs to the **folder**, not to a conversation: every omp started in an isolated folder (or a folder inside
  it) is isolated, whichever conversation it is: a new one, a resumed one, a fork, a subagent, the side question, the
  Terminal tab.
- It is set in **New chat**: a switch for the chosen folder, a new project folder or an existing one. For an existing
  folder it starts as what the folder is, and changing it changes the folder (every conversation in it), not only the new
  conversation. (2026-11-14: the person confirmed folder, not session, and the switch in New chat for new folders too.)
- A git worktree made from an isolated project (`/wt`) gets an isolated environment of its own (option A).
- Removing what was installed is the existing delete: tick the folder (or the isolated environment's line) and it goes to
  the Trash with the rest.

## Goals

- In an isolated folder, what the covered tools install or cache lands in `<folder>/.ompw-env/`, so trashing the folder
  removes it.
- Nothing about the person's own setup changes: their logins (gh, git, ssh, model providers, the Hugging Face token),
  their shell configuration, their global tools and caches stay as they are and keep working.
- A tool the page says is covered is one whose isolation was verified (an install and its cache land inside, nothing new
  outside).

Non-goals: `brew`, `sudo`, system package managers, Docker; containers or VMs; deleting for good; a size limit; Windows in
the first version (its tools' variables and paths differ; the option is not offered there).

Anti-goals (a failure even if it works): a broken login or a broken shell in an isolated folder; something installed
outside while the page says the folder is isolated; files removed outside `.ompw-env/`.

## Constraints

- omp's environment today is the Full/Light launch plan's (`LiveManager.plan` → `modes.plan`), the same for every folder;
  spare (pre-warmed) processes are matched on that environment (`server/live.ts`, `launch.env`).
- The Terminal tab is a login shell (`$SHELL -l`, `server/pty.ts`, `childEnv`): the person's shell startup files run
  after the environment is given and may reorder `PATH`.
- The person uses nvm, which refuses to work while `npm_config_prefix` is set (`nvm use` prints an error). A shell that
  sources nvm must still work.
- Hugging Face keeps the login token under `HF_HOME`: `HF_HOME` must not move.
- Delete-to-Trash is macOS only (`/usr/bin/trash`); on Linux the folder can still be removed by hand.

## Approaches

1. **Redirect the tools' install and cache folders with environment variables, keyed on a marker in the folder**
   (chosen). Every omp and shell started in or under a folder holding `.ompw-env/` gets the variables; nothing is stored
   per conversation, so resume, forks and subagents need nothing of their own.
2. Redirect per conversation (a switch kept with each conversation). Rejected by the person: two conversations of one
   folder could differ, and then the folder is half isolated.
3. A separate `HOME` for the folder. Rejected: it breaks every login and the person's shell configuration.
4. A container or VM. Rejected: no Docker on the Mac, heavy, and the agent's tools (browser, remote_run) run on the host.
5. Snapshot the global caches before and after, and remove the difference. Rejected: caches are shared with other
   projects, so the difference is not this project's alone.

## The design

**The marker.** `<folder>/.ompw-env/` holds `ompw-env.json` (`{ "version": 1 }`) and a `.gitignore` of `*`, so git ignores
the folder without the project's own `.gitignore` being touched. A folder is isolated when it, or any folder above it up
to the filesystem root, has that file (the projects folder may be outside the home folder, `/Volumes/…`); the nearest
one counts, and a `.ompw-env` without the file means nothing.

**Which folders may be switched on** (builder's question; my call): never a folder `protectedReason` refuses (the home
folder or above it, system folders, omp's and omp-webui's data), never the projects folder itself, never a folder that
holds another conversation's or sidebar project's folder (the rule `containsOther` in `server/sessions/cleanup-rules.ts`
already finds those), and never a folder inside an isolated one (it is isolated already; no nesting). A conversation in
a subfolder of an isolated folder switches that folder's marker, and New chat's switch names it.

**The variables** (`shared/isolated-env.ts`; `E` is `<folder>/.ompw-env`). Two separate steps: a **pure resolver**
(`isolatedEnv(root, facts)`: the variables and the list of what is covered, from the root and a few facts read
beforehand: whether nvm is installed, whether `~/.cargo/config.toml` and `credentials.toml` exist) that writes nothing,
and an **ensure step** on the server (`server/isolated-env.ts`), run once before a process starts, that makes the marker
files and the cargo links and is safe to run again (a missing original: no link; a link already right: kept; a broken or
wrong link: replaced; a regular file the person put there: left alone).

| Tool | Variables |
| --- | --- |
| npm | `npm_config_cache=E/cache/npm`; global installs: see *npm and nvm* |
| bun | `BUN_INSTALL=E/bun` (global installs and their `bin`), `BUN_INSTALL_CACHE_DIR=E/cache/bun` |
| pip | `PYTHONUSERBASE=E/python`, `PIP_CACHE_DIR=E/cache/pip`. Inside, the person's own `pip --user` packages are not imported (their programs in `~/.local/bin` still run); the page says so |
| uv | `UV_CACHE_DIR=E/cache/uv`, `UV_TOOL_DIR=E/uv/tools`, `UV_TOOL_BIN_DIR=E/uv/bin`, `UV_PYTHON_INSTALL_DIR=E/uv/python` |
| cargo | `CARGO_HOME=E/cargo`, with the person's `~/.cargo/config.toml` and `credentials.toml` linked into it (symbolic links, made when the variables are worked out and only when the originals exist), so mirrors, build settings and the registry login keep working; `cargo login` there writes through the link to the person's own file. rustup's toolchains stay shared (`RUSTUP_HOME` is not set) |
| go | `GOPATH=E/go` (modules and `go install`), `GOCACHE=E/cache/go-build`; the person's `go env -w` settings are in `GOENV`, which does not move |
| Playwright | `PLAYWRIGHT_BROWSERS_PATH=E/ms-playwright` |
| Hugging Face | `HF_HUB_CACHE=E/huggingface/hub`, `HF_DATASETS_CACHE=E/huggingface/datasets`, `HF_XET_CACHE=E/huggingface/xet`; `HF_HOME` unchanged |

`PATH` gets the folders whose programs these tools install put first: `E/npm/bin`, `E/bun/bin`, `E/python/bin`,
`E/uv/bin`, `E/cargo/bin`, `E/go/bin`. `OMPW_ISOLATED_ENV=E` says the folder is isolated.

**npm and nvm.** `npm_config_prefix` makes nvm refuse to work. When nvm is installed (`NVM_DIR` set, or `~/.nvm/nvm.sh`
there), npm's global installs are left out of isolation (its cache stays isolated) and neither the page nor the agent's
note claims them. This Mac has no nvm today (checked 2026-11-14), so npm's global installs are isolated here.

**Measured 2026-11-14:** a login shell (`zsh -l`, `bash -l`) on this Mac moves a `PATH` prefix behind `/usr/local/bin`
(`path_helper` in `/etc/zprofile` and `/etc/profile`), so the Terminal tab needs the prefix put back after the startup
files (see *The Terminal tab's PATH*), and the builder checks the same for omp's own bash.

**Where they are applied.** Every process omp-webui starts with a working folder looks the marker up from **its own**
working folder when it starts: a conversation's omp (`server/live.ts`, `env` of the `RpcClient`), the side question's
fork (`server/omp/btw-fork.ts`), and the Terminal tab's shell and the `omp` commands it runs (`server/pty.ts`, which today
gives every one of them the server's `childEnv` and so needs the lookup added). The variables are added on top of the
launch plan's environment, not into `launch.env`, and a spare process is used for a folder only when its isolation is
the same (none, or this folder's). Subagents and omp's own bash commands inherit them from omp.

**The Terminal tab's PATH.** The login shell's startup files may put other folders before `E/…/bin`. The builder checks
this with the person's real shell. If they do, the builder picks the least intrusive way to put the prefix back after the
startup files have run, without editing the person's shell files; if there is none, the page says that programs installed
globally in the project are run by their path in the Terminal tab.

**What the agent is told.** In an isolated folder the gate extension adds a short note to the system prompt, made from
the same table the variables come from, so it names only what is covered: which tools' global installs and caches go
into the project (do them as usual), which are not (npm's global installs, if *npm and nvm* leaves them out), and that
`brew`, `sudo` and system package managers would install outside the project, so ask before using them.

**The page.**
- New chat's settings bar: an **Isolated environment** switch for the chosen folder. For a new project folder it starts
  off and, when on, the marker is written with the folder (`server/projects.ts` `create` result, before omp starts). For
  an existing folder it starts as the folder is (asked of the server); where the rules above refuse the folder it is
  disabled with the reason. A flip restarts the warm-up process (as a mode change does), and the server writes or removes
  the marker before starting it (`OpenTarget` `isolated?: boolean`; absent: the folder is left as it is).
- **Processes already running** in the folder when it is switched are not restarted unasked (one may be working): their
  header mark says *Restart to apply*.
- **The header mark** says what the process has, not what the folder says: it shows while the process was started with
  `OMPW_ISOLATED_ENV`. A process whose folder's isolation no longer matches what it started with (switched since, or moved
  with `/move`) shows *Restart to apply*. A process never claims an isolation it was not started with.
- **Worktrees** (option A): when a process starts in a folder with no marker that is a linked git worktree whose main
  worktree is isolated, the ensure step writes a marker at the worktree's top level first.
- The delete dialog lists `.ompw-env` as a line of its own among the dependency folders (path and size, unticked), and
  ticking the folder takes it as before.
- Changing it is for the person's own page only (`isOwnerPage`), like the other folder-touching settings.

**Remote Macs.** A remote Mac's New chat makes the folder on that Mac through its own server, so the same code applies
there once it runs this version.

## Verification

- A contract test starts a conversation in an isolated folder and checks the variables in omp's bash, in a subagent's
  bash and in the Terminal tab, and their absence in a folder that is not isolated.
- For each tool, a script run on this Mac before release installs one global program and one package (Hugging Face: one
  tiny model) in an isolated folder and checks that nothing new appeared in the tool's usual places outside it. A tool
  that fails is left out of the table and of what the page says.
- An E2E test for the New chat checkbox, the *This session* switch and the delete dialog's line.
- In the per-tool script, cargo's check also confirms that a mirror in `config.toml` and the registry token are used.

## Left to the builder

- Exact UI wording and the header mark; placement in New chat's folder form.
- How the marker is looked up (cached per folder or read at each start).
- The Terminal tab's PATH fix, within the constraint above.
- Which tests are E2E and which contract.
