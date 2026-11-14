# Isolated project environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A folder marked `.ompw-env/ompw-env.json` makes every process omp-webui starts in it (omp, side question, Terminal tab) install and cache npm, bun, pip, uv, cargo, go, Playwright and Hugging Face downloads inside `.ompw-env/`, switched in New chat, removed by the existing delete-to-Trash.

**Architecture:** A pure resolver in `shared/isolated-env.ts` turns a root folder and a few facts into environment variables; `server/isolated-env.ts` finds the root from a working folder (walking up, adopting a linked worktree of an isolated project), writes the marker and the cargo links, and applies the rules for which folders may be switched. Every spawn site adds the variables on top of what it gives today.

**Tech Stack:** Bun, TypeScript, React, `bun test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-14-isolated-project-env-design.md`

## Global Constraints

- Marker: `<root>/.ompw-env/ompw-env.json` = `{ "version": 1 }`; `<root>/.ompw-env/.gitignore` = `*\n`.
- Variables exactly as the spec's table; `HF_HOME` and `RUSTUP_HOME` never set; `OMPW_ISOLATED_ENV=<root>/.ompw-env`.
- npm's prefix only when nvm is not installed (`NVM_DIR` unset and no `~/.nvm/nvm.sh`).
- Not offered on Windows (`platform.id === "win32"`).
- Changing isolation: owner page only (`isOwnerPage`).
- No edits to the person's shell files; no `HOME` change.

## Review Focus

1. A folder switched off while another conversation runs there: that conversation keeps its env and shows *Restart to apply* — Task 3 test.
2. `~/.cargo/config.toml` absent, or `E/cargo/config.toml` a regular file the person made: no link, file untouched — Task 2 test.
3. A spare process started before the switch must not be handed out after it — Task 3 test.
4. The Terminal tab's `PATH` after `zsh -l` (path_helper) still starts with `E/…/bin` — Task 4 test.
5. Switching on the projects folder, home, or a folder holding another conversation's folder is refused with a reason — Task 2 test.

---

### Task 1: Pure resolver

**Files:** Create `shared/isolated-env.ts`; Test `tests/unit/isolated-env.test.ts`.

**Interfaces — Produces:**
- `ISOLATED_DIR = ".ompw-env"`, `ISOLATED_MARKER = "ompw-env.json"`
- `type IsolatedTool = "npm" | "npm-global" | "bun" | "pip" | "uv" | "cargo" | "go" | "playwright" | "huggingface"`
- `interface IsolationFacts { nvm: boolean }`
- `isolatedEnv(root: string, facts: IsolationFacts, basePath: string): { env: Record<string, string>; covered: IsolatedTool[] }` (`env.PATH` = the six bin folders then `basePath`)
- `isolatedNote(covered: IsolatedTool[]): string` — the agent's note: covered installs go in the project; `npm -g` named as not covered when `npm-global` is missing; `brew`/`sudo` ask first.

- [ ] Tests: `isolatedEnv("/p", {nvm:false}, "/usr/bin")` has `npm_config_prefix="/p/.ompw-env/npm"`, `CARGO_HOME="/p/.ompw-env/cargo"`, `HF_HUB_CACHE="/p/.ompw-env/huggingface/hub"`, no `HF_HOME`, `PATH` starting `/p/.ompw-env/npm/bin:` and ending `:/usr/bin`; with `{nvm:true}` no `npm_config_prefix`, `npm_config_cache` still set, `covered` lacks `npm-global`, and `isolatedNote` mentions `npm -g` as installing outside. Run, fail, implement, pass, commit.

### Task 2: Server side: find, ensure, rules

**Files:** Create `server/isolated-env.ts`; Modify `server/sessions/cleanup-rules.ts` (`.ompw-env` kind); Test `tests/unit/isolated-env-server.test.ts`, `tests/unit/cleanup-rules.test.ts`.

**Interfaces — Consumes:** Task 1. **Produces:**
- `findIsolatedRoot(cwd: string): string | null` — nearest folder up to `/` holding the marker; then, if none and `cwd` is in a linked git worktree whose main worktree has a root, the worktree's top level (marker written by `ensureIsolated`).
- `ensureIsolated(root: string, home?: string): void` — idempotent: marker, `.gitignore`, `cargo/config.toml` and `cargo/credentials.toml` links per the spec's rules.
- `isolationRefusal(folder: string, ctx: { home: string; projectsFolder: string; users: FolderUser[] }): string | null` — reasons `protected`, `projectsFolder`, `containsOther`, `insideIsolated`.
- `setIsolated(folder: string, on: boolean, ctx): { root: string | null }` — on: refusal or ensure; off: remove the nearest root's marker file only.
- `envFor(cwd: string, basePath: string): { root: string; env: Record<string, string>; note: string } | null` — find, ensure, resolve (facts read here: nvm).
- cleanup: `dependencyCandidate(".ompw-env", …)` → `{ kind: ".ompw-env", needsIgnored: false }` when it holds `ompw-env.json`.

- [ ] Tests in temp folders: nested lookup; marker-less `.ompw-env` ignored; ensure twice keeps links; broken link replaced; regular file kept; missing original no link; worktree of an isolated repo (`git worktree add`) gets its own marker; each refusal reason; cleanup kind. Run, fail, implement, pass, commit.

### Task 3: Processes and protocol

**Files:** Modify `shared/protocol.ts` (`OpenTarget` new: `isolated?: boolean`; `LiveInfo`: `isolated?: string | null`, `isolationStale?: boolean`), `server/live.ts` (spawn env, `spare` match, `open` applies `setIsolated` before spawn, stale marking after a switch and on `/move`), `server/main.ts` (`open`: owner check `ISOLATED_NOT_HERE`; `GET /api/isolation?folder=` → `{ root: string | null; refused: string | null; supported: boolean }`), `server/omp/btw-fork.ts` (env), `server/omp/guidance/extension.ts` (append `OMPW_ISOLATED_NOTE` to every agent's system prompt when set; the docs-tool extension must not touch `process`). Test `tests/contract/isolated-env.test.ts`.

- [ ] Contract test: New chat with `isolated: true` in a fresh folder → marker exists, `info.isolated` is the root, a `!echo $CARGO_HOME` (or the scripted agent's bash) prints `<root>/.ompw-env/cargo`, the system prompt contains the note; a second conversation running there, then the folder switched off through a new open → the first has `isolationStale: true`; a spare from before the switch is not reused; a non-owner page's `isolated` is refused. Run, fail, implement, pass, commit.

### Task 4: Terminal tab

**Files:** Modify `server/pty.ts`; Test in `tests/contract/isolated-env.test.ts`.

- [ ] Test: a Terminal tab in an isolated folder, `echo $PATH` prints a `PATH` starting with `<root>/.ompw-env/npm/bin` (after the login shell's startup files) and `echo $GOPATH` the isolated one; in a plain folder neither. Implement with the variables in `env` and, for zsh, a `ZDOTDIR` wrapper whose files source the person's own and then put the prefix back (bash: the same through `--rcfile`/`BASH_ENV` as fits), made under the server's data folder. Pass, commit.

### Task 5: The page

**Files:** Modify `web/src/components/NewChat.tsx`, `NewChatPickers.tsx` (switch), the conversation header (mark), `web/src/i18n/*` (en, zh-CN); Test `tests/e2e/isolated-env.spec.ts`; `tests/e2e/timings.json`.

- [ ] E2E: New chat with a new project folder: switch off by default, on → the started process's `info.isolated` set and the header mark shows; an existing folder the server refuses → switch disabled with the reason; a frame with `isolationStale` → *Restart to apply*; the delete dialog lists `.ompw-env`. Run, fail, implement, pass, commit.

### Task 6: Real installs, docs, release

**Files:** Create `scripts/check-isolated-env.ts`; Modify `docs/TECHNICAL.md`, `docs/TECHNICAL.zh-CN.md`, `release-notes/vX.Y.Z.md`, `package.json`.

- [ ] Script: in a temp isolated folder, with `envFor`'s variables, run `npm i -g cowsay`, `bun add -g cowsay`, `pip install --user six`, `uv tool install ruff`, `cargo install --locked tokei`(or a smaller crate), `go install golang.org/x/example/hello@latest`, `npx playwright install chromium-headless-shell`, and a Hugging Face download of `hf-internal-testing/tiny-random-bert`; before and after, list the tools' usual folders outside (mtime-newer entries); print per tool `inside: yes/no, outside: none/<paths>`. Run it; drop any tool that leaks from `covered` and the docs.
- [ ] Full checks: `bun run lint`, `bun run typecheck`, `bun run test:all`, the touched E2E specs; push, CI green, release-local.
