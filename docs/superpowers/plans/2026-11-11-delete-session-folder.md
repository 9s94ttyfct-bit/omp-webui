# Deleting a conversation with its folder or dependency folders — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The single and bulk delete dialogs offer, per conversation, to move its working folder or chosen dependency folders to the Trash, after omp deleted the conversation.

**Architecture:** Pure rules (protected folders, who uses a folder, which folders are dependency folders) in `server/sessions/cleanup-rules.ts`; disk and process looks in `server/sessions/cleanup-scan.ts`; `DeleteCleanup` in `server/sessions/cleanup.ts` previews and, after the deletes, re-checks and runs the Trash command. Routes: a new preview route and the two delete routes taking the ticked paths. The page renders the preview in both dialogs (`web/src/components/DeleteCleanup.tsx`).

**Tech Stack:** Bun, TypeScript, React, bun:test, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-11-delete-session-folder-design.md`

## Global Constraints

- Offered only where a Trash command exists: `/usr/bin/trash` on macOS; `OMP_WEBUI_TRASH_COMMAND` (tests) names another. Elsewhere the preview answers `trash: false` and the dialogs are as today.
- Nothing is moved for a conversation omp did not delete; all deletes of a request run before any move.
- Every move is re-checked at the moment of moving; the preview is never trusted.
- Dependency folders: unticked, exact path and size, blocked only by running things.
- Strings in English and Chinese. No real paths in code, tests, docs.

## Review Focus

1. A conversation started in `~`: its folder is refused (home), its dependency folders still listed if any — test in Task 1.
2. Two selected conversations in one folder: offered once, moved once, no "in use" between them — Task 3 contract test.
3. A symlinked folder (`cwd` is a link): checks and the move use the real path; a link swapped after the preview is refused — Task 3.
4. `lsof`/`/proc` unavailable or slow: the folder is refused as `unchecked`, never moved unchecked — Task 2.
5. The Trash command fails: the conversation stays deleted, the path is reported in `notMoved`, the page toasts — Task 3.

---

### Task 1: Types and pure rules

**Files:** Create `shared/delete-cleanup.ts`, `server/sessions/cleanup-rules.ts`; Test `tests/unit/cleanup-rules.test.ts`.

**Produces:**
- `shared/delete-cleanup.ts`: `FolderRefusal = "home" | "system" | "data" | "inUse" | "containsOther" | "unchecked" | "missing"`; `GitRisk { uncommitted: number | null; unpushed: number | null }`; `CleanupFolder { path; real; bytes: number | null; refused: FolderRefusal | null; usedBy: string[]; git: GitRisk | null }`; `CleanupDep { path; real; kind; bytes: number | null; usedBy: string[] }`; `DeletePreview { file; folder: CleanupFolder | null; deps: CleanupDep[] }`; `DeletePreviewAnswer { trash: boolean; previews: DeletePreview[] }`; `TrashPick { path; real; git: GitRisk | null }`; `TrashResult { moved: string[]; notMoved: { path; error }[] }`.
- `cleanup-rules.ts`: `isWithin(child, parent): boolean` (equal counts); `protectedReason(real, { home, data: string[] }): "home" | "system" | "data" | null`; `FolderUser { real; label; kind: "conversation" | "project" | "process" }`; `folderUse(real, users, home): { refused: "inUse" | "containsOther" | null; usedBy: string[] }`; `depUse(dep, conversationFolder, running: FolderUser[]): string[]`; `dependencyKind(name, { has(name): boolean; inDir(name): boolean }, ignored: boolean): string | null`.

- [ ] Tests: home and above refused (`/`, `/Users`, home); `/tmp`, `/private/var` refused, `/tmp/x` allowed; inside `/System`, `/usr/lib` refused; data folders and their parents and children refused; `folderUse` same folder → inUse, project containing it → inUse, conversation in `~` containing it → not, process in a parent → not, process inside → containsOther, conversation inside → containsOther; `depUse` blocks for a running process inside the conversation folder, not for one elsewhere; `dependencyKind` table from the spec (`node_modules` always; `.venv` needs `pyvenv.cfg`; `target` needs `CACHEDIR.TAG`; `Pods` needs `Podfile.lock` beside; `build`/`.gradle` need Gradle file beside + ignored; `vendor` needs `composer.json`/`go.mod` + ignored).
- [ ] Implement; run `bun test tests/unit/cleanup-rules.test.ts`; commit.

### Task 2: Disk, git and process looks

**Files:** Create `server/sessions/cleanup-scan.ts`; Test `tests/unit/cleanup-scan.test.ts`.

**Consumes:** Task 1 rules; `run` (`server/omp/run.ts`), `safeGit`, `vetRepository`, `countChanges`.

**Produces:** `listDependencies(folder, ignored: (paths: string[]) => Promise<Set<string>>): Promise<{ path; kind }[]>` (depth 4, at most 50, not into `.git` or a found one); `sizeOf(path, budgetMs): Promise<number | null>` (`du -sk`, null on timeout); `gitRisk(path, timeoutMs): Promise<GitRisk | null>` (null: not a repository or no risk; `{uncommitted: null, unpushed: null}`: could not look); `gitIgnored(folder, paths): Promise<Set<string>>` (`git check-ignore --stdin`); `processCwds(): Promise<{ pid; name; cwd }[] | null>` (darwin `lsof -a -d cwd -u <uid> -Fpcn`, linux `/proc/*/cwd`; null on failure).

- [ ] Tests (scratch dirs): listing finds `node_modules`, a `.venv` with `pyvenv.cfg`, skips one without, does not descend into `node_modules`; `gitRisk` counts an untracked file limited to the path, unpushed null at a subfolder, `{0,…}` → null when clean; `processCwds` finds this test process's own cwd (`process.cwd()`), skip where neither lsof nor /proc.
- [ ] Implement; run tests; commit.

### Task 3: Preview, delete-then-move, routes

**Files:** Create `server/sessions/cleanup.ts`; Modify `server/main.ts` (`/api/session/delete-preview`, `/api/session/delete`, `/api/sessions/delete`), `server/pty.ts` (`pids(): Set<number>`); Test `tests/contract/delete-cleanup.test.ts`.

**Produces:** `class DeleteCleanup` with `available: boolean`, `preview(files: { file; cwd }[]): Promise<DeletePreviewAnswer>`, `moveAfter(deleted: { file; cwd }[], picks: Map<string, TrashPick[]>): Promise<Record<string, TrashResult>>`. Routes: preview body `{ files }`; single delete `{ file, trash?: TrashPick[] }` → `{ ok, trashed?: TrashResult }`; bulk `{ files, trash?: Record<file, TrashPick[]> }` → `{ deleted, failed, trashed }`.

- [ ] Contract tests (stand-in trash script via `OMP_WEBUI_TRASH_COMMAND` that moves into a test folder): preview of a conversation in a scratch folder offers it with size; delete with the pick moves it; a pick for a path not this conversation's is refused (notMoved); bulk of two conversations in one folder offers it once and moves it; a second conversation (not deleted) in the folder → inUse, nothing moved; a symlink swapped after preview → notMoved; untracked file added after preview → notMoved; trash command failing → conversation deleted, notMoved with its error.
- [ ] Implement; run `bun test tests/contract/delete-cleanup.test.ts tests/contract/delete-busy.test.ts`; commit.

### Task 4: The dialogs

**Files:** Create `web/src/components/DeleteCleanup.tsx`; Modify `web/src/lib/api.ts`, `web/src/components/Sidebar.tsx`, `web/src/i18n/shell.ts`, `web/src/i18n/zh-CN/shell.ts`; Test `tests/e2e/delete-cleanup.spec.ts`, `tests/e2e/timings.json`.

**Consumes:** Task 3 routes and types.

- [ ] `DeleteCleanupOptions({ preview, picks, onChange, collapsed? })`: folder box with size, refusal text or git warning; dependency boxes (disabled while the folder is ticked). Bulk list scrolls and shows every selected conversation; one with nothing to offer is its title only. Button label counts ticked items.
- [ ] e2e (server with stand-in trash): single dialog shows the folder and a `node_modules`, ticking one sends it and the folder is gone from disk; bulk dialog lists every selected conversation's options.
- [ ] Run the spec; add its timing; commit.

### Task 5: The real Trash, docs

**Files:** Test `tests/unit/cleanup-trash-mac.test.ts` (`platform.id === "darwin"`); Modify `docs/TECHNICAL.md`, `docs/TECHNICAL.zh-CN.md`, `README.md`, `README.zh-CN.md` where deletion is described.

- [ ] Test: a scratch folder moved with `/usr/bin/trash` is no longer at its path and is in `~/.Trash`; remove it from the Trash after.
- [ ] Docs; full `bun run lint`, `bun run typecheck`, the unit/contract files above; commit; push.
