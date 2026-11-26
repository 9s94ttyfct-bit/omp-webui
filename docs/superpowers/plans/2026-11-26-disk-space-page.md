# Disk space page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Disk space" page that lists every project folder with its folder size, its conversations' size and their sum, sortable, with a per-row "Clean up…" dialog that deletes chosen conversations and/or moves the folder or its dependency folders to the Trash.

**Architecture:** The server builds rows from the projects folder and the store's conversations (pure `rows.ts`), measures them in one background scan at a time (`scan.ts`, cached in `<data dir>/disk-space.json`), and answers four routes. Cleanup reuses `DeleteCleanup` with a second in-use rule ("alive") for this page, and the bulk delete loop extracted from `/api/sessions/delete`. The page is a lazy chunk with its own strings, reached from a new nav item.

**Tech Stack:** Bun, TypeScript, React, zustand, bun:test, Playwright.

**Spec:** docs/superpowers/specs/2026-11-26-disk-space-page-design.md

## Global Constraints

- Folder size: `du -sk` (allocated). One folder may take 30 s (`FOLDER_MS = 30_000`), a whole scan 5 min (`SCAN_MS = 300_000`); a scan starts on page open when the last is older than 10 min (`STALE_MS = 600_000`). One scan at a time per server.
- The two cleanups are independent: ticking the folder never deletes a conversation; ticking conversations never moves a path.
- Conversations are deleted through omp (existing delete path); paths go to the Trash only through `/usr/bin/trash` (`platform.trash`), only for `mayTrash` pages.
- Protected folders (`protectedReason`), the projects folder and every folder containing it: own conversations only, nothing rolls up, no folder part.
- Folder move refused while: a live omp process works in it or inside it (unless its conversation is being deleted in the same request), a Terminal tab or a process of the user works there (`lsof`), a sidebar project's folder is it or inside it, another row's folder is inside it, or a conversation file is inside it (`holdsConversations`).
- English and Chinese strings for everything shown. Public repo: no real paths or project names in code, tests, docs or commits.

## Review Focus

- A conversation whose `cwd` is a symlink to a project folder belongs to that project's row, not a row of its own (rows compare real paths) — test in Task 1.
- A folder that times out in `du` shows "unknown" and the scan goes on to the next folder; the scan stops at 5 min and keeps old sizes for what it did not reach — tests in Task 2.
- The projects folder changed in Settings between scans: rows follow the current setting, cached sizes are kept by real path — test in Task 2.
- Something starts working in the folder after the dialog opened (a conversation opened, a dev server): the move is refused at confirm time with who — test in Task 3 (rule) and Task 4 (route).
- The folder was renamed or replaced after the preview: nothing moves, the result says why — test in Task 4.

---

### Task 1: Rows (which projects, and which conversations are theirs)

**Files:**
- Create: `shared/disk-space.ts`, `server/disk-space/rows.ts`
- Test: `tests/unit/disk-space-rows.test.ts`

**Interfaces:**
- Produces (`shared/disk-space.ts`):
  - `type DiskRowKind = "project" | "other" | "protected"`
  - `type DiskFolderState = "measured" | "unknown" | "pending" | "notMeasured" | "gone"`
  - `interface DiskConversation { file: string; title: string; modifiedAt: number; bytes: number }`
  - `interface DiskRow { folder: string; real: string | null; name: string; kind: DiskRowKind; folderBytes: number | null; folderState: DiskFolderState; measuredAt: number | null; conversations: number; conversationBytes: number; lastUsed: number | null }`
  - `interface DiskScanState { running: boolean; startedAt: number | null; finishedAt: number | null; done: number; total: number }`
  - `interface DiskSpaceAnswer { rows: DiskRow[]; scan: DiskScanState; disk: { free: number; total: number } | null }`
  - `type DiskSortKey = "name" | "folder" | "conversations" | "total" | "lastUsed"`; `interface DiskSort { by: DiskSortKey; desc: boolean }`; `DEFAULT_DISK_SORT: DiskSort = { by: "total", desc: true }`; `isDiskSort(v: unknown): v is DiskSort`
- Produces (`server/disk-space/rows.ts`):
  - `interface RowConversation { file: string; cwd: string; title: string; modifiedAt: number }`
  - `interface RowPlan { folder: string; real: string | null; kind: DiskRowKind; files: string[] }`
  - `function buildRows(input: { projectsFolder: string | null; subfolders: string[]; conversations: RowConversation[]; realOf: (p: string) => string | null; isProtected: (real: string) => boolean }): RowPlan[]`
  - `function projectSubfolders(projectsFolder: string): string[]` (non-hidden directories, real paths; empty when the folder is missing)

- [ ] **Step 1: Write the failing tests** in `tests/unit/disk-space-rows.test.ts` (inject `realOf` from a map, `isProtected` from a set):
  - `each subfolder of the projects folder is a row, with or without conversations` → two subfolders, no conversations → two `project` rows with `files: []`.
  - `a conversation in a project subfolder or deeper belongs to that row` → cwd `<pf>/a/src` → row `<pf>/a` has its file.
  - `a conversation whose folder is a link to a project folder belongs to that project` → `realOf(link) = <pf>/a`.
  - `other folders are rows; one inside another rolls up into the outermost` → cwds `/x/p`, `/x/p/q` → one `other` row `/x/p` with both files.
  - `protected folders and the projects folder (and above it) keep only their own conversations` → cwd `<home>`, cwd `<pf>`, cwd `dirname(<pf>)`, cwd `<home>/code/r` → `protected` rows for the first three each with their one file; `/…/code/r` is its own `other` row (not rolled into home).
  - `a folder that is gone stays a row while it has conversations` → `realOf` null → `other` row with `real: null`.
  - `each conversation is in exactly one row` → total files across rows equals input length for a mixed input.
- [ ] **Step 2: Run** `bun test tests/unit/disk-space-rows.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `shared/disk-space.ts` and `buildRows`/`projectSubfolders`. `isWithin` from `server/sessions/cleanup-rules.ts`. A cwd is protected-like when `isProtected(real)` or `isWithin(projectsFolderReal, real)`. Rows sorted by folder (the page sorts for display).
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Commit** "Disk space: which projects are rows, and whose conversations they hold".

### Task 2: The scan and its cache

**Files:**
- Create: `server/disk-space/scan.ts`
- Test: `tests/unit/disk-space-scan.test.ts`

**Interfaces:**
- Consumes: Task 1's `RowPlan`, `DiskRow`, `DiskSpaceAnswer`.
- Produces:
  - `const FOLDER_MS = 30_000; const SCAN_MS = 300_000; const STALE_MS = 600_000`
  - `interface DiskSpaceDeps { plan(): Promise<{ rows: RowPlan[]; conversations: Map<string, { title: string; modifiedAt: number; size: number }> }>; du(path: string, budgetMs: number): Promise<number | null>; fileBytes(file: string): number; now(): number; free(): { free: number; total: number } | null }`
  - `class DiskSpace { constructor(cacheFile: string, deps: DiskSpaceDeps); answer(): Promise<DiskSpaceAnswer>; scan(): boolean /* false: one runs */; scanIfStale(): void; conversationsOf(folder: string): Promise<DiskConversation[]>; forget(paths: string[]): void /* after a clean: re-measure */; done(): Promise<void> /* tests */ }`

- [ ] **Step 1: Write the failing tests** (temp cache file, stub `du` resolving from a map with optional delays, fake clock):
  - `an answer before any scan shows every row pending with its transcripts' sizes` → `folderState: "pending"`, `conversationBytes` = sum of `size`.
  - `a scan measures folders one at a time and conversations as transcript plus artifacts folder` → `du` calls never overlap (counter); a conversation's bytes = `fileBytes(file) + du(<file without .jsonl>)`.
  - `transcripts kept inside a project folder count once, under conversations` → folder bytes = `du(folder) - those conversations' bytes`.
  - `a folder over its budget is unknown and the scan goes on` → `du` null for one → `"unknown"`, the next measured.
  - `a scan stops after SCAN_MS and keeps the last sizes of what it did not reach` → clock advanced past 5 min mid-scan; unreached rows keep cached bytes and `measuredAt`; next scan starts with them.
  - `protected rows are notMeasured, gone rows are gone` → no `du` call for them.
  - `the cache survives a restart and sizes follow real paths when the projects folder changes` → new `DiskSpace` on the same file answers cached sizes; a row whose real path is unchanged keeps them.
  - `scan() while one runs is refused; scanIfStale starts one only when the last finished over STALE_MS ago`.
- [ ] **Step 2: Run** `bun test tests/unit/disk-space-scan.test.ts` → FAIL.
- [ ] **Step 3: Implement** `DiskSpace`. Cache JSON `{ version: 1, folders: Record<real, { bytes: number | null; at: number }>, conversations: Record<file, { mtime: number; bytes: number }> }`, written atomically (write temp, rename) after each folder. `du` in production is `sizeOf` from `cleanup-scan.ts` run under `nice -n 10` (extend `sizeOf` with an optional `nice` flag rather than a second `du` wrapper). Conversation bytes measured in the scan with a 10 s budget each; between scans a changed file (mtime differs) shows `fileBytes`. `lastUsed` = newest conversation `modifiedAt`, else the folder's `mtimeMs`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** "Disk space: one background scan at a time, kept across restarts".

### Task 3: The cleanup rule of this page

**Files:**
- Modify: `shared/delete-cleanup.ts` (add `"holdsConversations"` to `FolderRefusal`), `server/sessions/cleanup-rules.ts`, `server/sessions/cleanup.ts`, `web/src/components/DeleteDialog.tsx` (`refusalText` case), `web/src/i18n/delete-dialog.ts`, `web/src/i18n/zh-CN/delete-dialog.ts` (`cleanupRefusedHoldsConversations`)
- Test: `tests/unit/cleanup-rules.test.ts` (new `describe("folderUseAlive")`), `tests/unit/cleanup-processes.test.ts` if it covers `DeleteCleanup` with a stub world (extend it there; else a new `tests/unit/cleanup-folder.test.ts`)

**Interfaces:**
- Produces (`cleanup-rules.ts`): `function folderUseAlive(real: string, users: { active: readonly FolderUser[]; projects: readonly FolderUser[]; rows: readonly string[]; files: readonly string[] }): { refused: "inUse" | "containsOther" | "holdsConversations" | null; usedBy: UsedBy[] }` — `active` (processes, Terminal tabs, live omp of conversations not being deleted) in it or inside → `inUse`; a project whose folder is it or inside it → `inUse`; another row's real folder inside it → `containsOther`; a conversation file's real path inside it → `holdsConversations`.
- Produces (`DeleteCleanup`):
  - `previewFolder(folder: string, leaving: string[]): Promise<{ trash: boolean; folder: CleanupFolder | null; deps: CleanupDep[] }>`
  - `moveFolder(folder: string, picks: TrashPick[], deleted: CleanupTarget[]): Promise<TrashResult>`
  - `CleanupWorld` gains `rowFolders(): Promise<string[]>` (the other rows' real folders) and `conversationFiles(): Promise<string[]>` (every conversation file, real).
  - Internals: `previewOne`/`moveOne` take a `rule: "delete" | "alive"`; `"delete"` is today's `folderUse`, unchanged.

- [ ] **Step 1: Write the failing tests**:
  - `folderUseAlive`: `a stopped conversation in the folder does not block it` (it is not in `active`); `a live omp, a Terminal tab, a process in it or inside block it as inUse`; `a project whose folder is inside it blocks it`; `another row inside it is containsOther`; `a conversation file inside it is holdsConversations`; `a running process in a folder that holds it does not block it` (only "it or inside").
  - `DeleteCleanup.previewFolder` with a stub world: offered with a stopped conversation there; refused `inUse` with a live process there; the live process of a conversation in `leaving` does not count.
  - `moveFolder`: re-checks at move time (a process appearing after preview → not moved, error names it); a pick whose real path changed → not moved; git work grown → not moved; dependency picks follow `depUse` as today.
- [ ] **Step 2: Run** `bun test tests/unit/cleanup-rules.test.ts <the cleanup unit file>` → FAIL.
- [ ] **Step 3: Implement.** Keep `preview`/`moveAfter` behaviour identical (their existing unit and contract tests are the guard). `users(leaving)` already yields `active` and the projects (kind `project` in `all`); pass `projects` as `all.filter(u => u.who.kind === "project")`.
- [ ] **Step 4: Run** the two files plus `tests/contract/delete-cleanup.test.ts` → PASS.
- [ ] **Step 5: Commit** "Cleanup: a folder rule for the Disk space page, where only what runs blocks a move".

### Task 4: Routes

**Files:**
- Modify: `server/main.ts` (construct `DiskSpace` after `deleteCleanup`; routes; extract the bulk delete loop)
- Test: `tests/contract/disk-space.test.ts` (pattern and stand-in Trash of `tests/contract/delete-cleanup.test.ts`, `// needs: posixShell`)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `async function deleteFiles(files: string[]): Promise<{ deleted: string[]; failed: { file: string; error: string }[]; gone: CleanupTarget[] }>` in `server/main.ts`, used by `/api/sessions/delete` and the clean route (same body as today's loop: `actions.delete`, `dismissQuestionsOf`, `closeBrowserOf`, `archived.set`, `store.refresh(true)`).
  - `GET /api/disk-space` → `DiskSpaceAnswer` (calls `scanIfStale()`); `disk` from `statfsSync` of the projects folder (its parent when missing).
  - `POST /api/disk-space/scan` → `{ started: boolean }`.
  - `POST /api/disk-space/preview` `{ folder }` → `{ folder: string; conversations: (DiskConversation & { busy: boolean })[]; mayTrash: boolean; trash: boolean; cleanup: { folder: CleanupFolder | null; deps: CleanupDep[] } | null }` (404 for a folder that is no row; `cleanup` null for protected/gone rows or when `!mayTrash`). `busy` from the pool: a live process of that file whose turn is running.
  - `POST /api/disk-space/clean` `{ folder, files: string[], trash: TrashPick[] }` → `{ deleted: string[]; failed: { file; error }[]; trashed: TrashResult }`. Every file must be one of the row's now (else 400 before anything is done); `trash` non-empty without `mayTrash` → 403. Deletes first, then `moveFolder(folder, trash, gone)`, then `diskSpace.forget([folder])`.
  - Same access as `/api/sessions`: any page with the token reads; the trash part is `mayTrash`'s.

- [ ] **Step 1: Write the failing tests** (a projects folder set through `POST /api/projects` to a temp folder; conversations with `writeSimpleSession(..., cwd)`):
  - `the rows list each project with its conversations, and a scan measures them`.
  - `ticking only the folder moves it and deletes no conversation` (files still on disk, still listed).
  - `ticking only conversations deletes them and moves nothing`.
  - `a file that is not the row's is refused and nothing is done`.
  - `a path the preview did not give, or a folder replaced since, is not moved`.
  - `a page that holds only the token is offered no Trash and cannot move` (as `delete-cleanup.test.ts` does it).
  - `/api/sessions/delete` tests in `delete-cleanup.test.ts` still pass after the extraction.
- [ ] **Step 2: Run** `bun test tests/contract/disk-space.test.ts` → FAIL.
- [ ] **Step 3: Implement** the routes and `deleteFiles`.
- [ ] **Step 4: Run** `bun test tests/contract/disk-space.test.ts tests/contract/delete-cleanup.test.ts tests/contract/delete-busy.test.ts` → PASS; `bun run typecheck` → exit 0.
- [ ] **Step 5: Commit** "Disk space: the routes, and the bulk delete shared with them".

### Task 5: The page, the dialog, the nav item

**Files:**
- Create: `web/src/components/DiskSpacePage.tsx`, `web/src/components/DiskCleanupDialog.tsx`, `web/src/components/CleanupOptions.tsx` (moved out of `DeleteDialog.tsx`: `Options`, `FolderRow`, `DepRow`, `refusalText`, `gitText`, `whoText`, `offered`, exported; `DeleteDialog.tsx` imports them), `web/src/lib/disk-space.ts` (api calls and `sortRows(rows: DiskRow[], sort: DiskSort): DiskRow[]`), `web/src/i18n/disk-space.ts`, `web/src/i18n/zh-CN/disk-space.ts`
- Modify: `web/src/i18n/index.ts` and `zh-CN/index.ts` (namespace `diskSpace`), `web/src/lib/nav-layout.ts` (`"disk"` after `"usage"` in `NAV_ITEM_IDS`, `NAV_ITEMS` with `HardDrive`, defaults), `web/src/components/NavDock.tsx` (`PAGES`), `web/src/store/app.ts` (`View` `{ kind: "disk" }`, hash `#/disk` both ways), `web/src/App.tsx` (lazy page), `web/src/i18n/shell.ts` + `zh-CN/shell.ts` (`sidebarNavDisk`: "Disk space" / "磁盘空间"), `shared/prefs.ts` (`PREF.diskSort = "ompw.diskSort"`, validator `isDiskSort`)
- Test: `tests/unit/disk-space-sort.test.ts`, `tests/unit/nav-layout.test.ts` (new item placed by default for a stored layout without it), `tests/e2e/disk-space.spec.ts`, `tests/e2e/timings.json`

**Interfaces:**
- Consumes: Task 4's routes and types.
- Produces: `sortRows` — `total` is `(folderBytes ?? 0) + conversationBytes`; ties broken by name; `name` sorts with `localeCompare`; null `lastUsed` last in both directions.

- [ ] **Step 1: Write the failing tests**:
  - Unit `sortRows`: each key both ways; ties by name; null `lastUsed` last.
  - Unit nav-layout: a stored v3 layout without `"disk"` gets it at the end of the bottom group (as built: the existing rule for a page added since, which keeps every other item where it was).
  - e2e (fixture projects folder with two subfolders of different sizes and conversations; stand-in Trash via `OMP_WEBUI_TRASH_COMMAND` as the delete-cleanup e2e does): `the page lists the projects biggest first and sorts by each column`; `the dialog deletes only the ticked conversations`; `the dialog moves only the folder when only it is ticked, and the row is measured again`; `the confirm button says what it will do and the room it frees`; `on a phone the table shows name, total and the button`.
- [ ] **Step 2: Run** `bun test tests/unit/disk-space-sort.test.ts tests/unit/nav-layout.test.ts` and `bun run test:e2e -- tests/e2e/disk-space.spec.ts` → FAIL.
- [ ] **Step 3: Implement.** The page polls `GET /api/disk-space` every 2 s while `scan.running`, else not; Refresh calls `/scan`; the header shows free/total of the disk and how long ago the scan finished; a footer sums the totals. Sort is `PREF.diskSort` via `setPref`. A row's name is a label (as built: the Files panel opens a sidebar project's folder by project id, and the sidebar's folder filter is the search bar's own state matching one exact `cwd`, while a row rolls up every folder inside it; neither takes a row, so no action is wired). The dialog: conversations newest first, Select all, busy ones disabled with why; the folder part is `CleanupOptions`' `Options` fed `{ file: folder, folder, deps }`; "N conversations ran here …" line when the folder box is ticked and some are kept; the confirm label from what is ticked (`diskSpace.confirm` with counts and `formatBytes`); results as toasts for what was not done.
- [ ] **Step 4: Run** the unit files and the e2e spec → PASS. Record the new specs' times: `OMPW_E2E_JSON=.tmp/verify/disk.json bun run test:e2e -- tests/e2e/disk-space.spec.ts && bun scripts/e2e-timings.ts .tmp/verify/disk.json`; `bun test tests/unit/timings-coverage.test.ts` → PASS. Existing delete dialog e2e: `bun run test:e2e -- tests/e2e/delete-cleanup.spec.ts tests/e2e/delete-busy.spec.ts` → PASS.
- [ ] **Step 5: Commit** "Disk space page: what each project takes, sorted, and its cleanup".

### Task 6: Docs, checks, release notes

**Files:**
- Create: `docs/agents/disk-space.md` (what the page shows, the cleanup and its rules, in the style of the other `docs/agents` pages); link it from `docs/agents/index.md`
- Modify: `README.md`/`README.zh-CN.md` only if they list the pages

- [ ] **Step 1:** Write the doc page; `bun test` for any docs index test touching `docs/agents` (find with `rg -l "docs/agents" tests`).
- [ ] **Step 2:** `bun run lint`, `bun run typecheck`, `bun run build` → all exit 0.
- [ ] **Step 3:** Open the page in the built-in browser against a dev server on a port in 18000–18999, with a scratch data folder and projects folder; screenshot the table and the dialog; confirm sorting and one cleanup with the stand-in Trash.
- [ ] **Step 4: Commit** "Disk space page: docs".
