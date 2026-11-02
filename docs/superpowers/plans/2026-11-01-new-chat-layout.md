# New chat layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New chat's settings move out of the composer into a bar under it, all of them always shown. The folder controls above the composer become one button with a menu.

**Architecture:** `NewChat` stops passing its pickers to `Composer` as `footer`. It renders them in a new settings bar under the composer instead. The bar marks itself `data-composer-narrow` under the same width as the composer, so the pickers' existing `composer-narrow:` icon-only styles apply unchanged. `NewChatPickers` drops `ComposerMore` and reorders its controls. The folder row becomes a Radix dropdown (`@radix-ui/react-dropdown-menu`, as `ModePicker` uses). It holds New project, Choose an existing folder… and up to four recent folders. `NewProjectField` loses its "Use an existing folder" button.

**Tech Stack:** React 19, Tailwind 4 custom variants (`web/src/index.css`), Radix dropdown menu, Playwright e2e (`bun scripts/e2e.ts`).

**Spec:** `docs/superpowers/specs/2026-11-01-new-chat-layout-design.md`

## Global Constraints

- No control is hidden behind a menu on New chat, at any width: no `ComposerMore` / `composer-more` on this page.
- Order in the bar: preset, model, thinking, Full/Light (mode) | divider | guard, guidance, approval, unattended, goal switches.
- Narrow (bar width < `NARROW_COMPOSER_PX` = 440 px): icons only, wrapping onto as many lines as needed.
- The conversation page's composer is unchanged (`ChatView` passes `footerOneRow`; nothing there changes).
- Strings exist in en and zh-CN; zh copy: 新项目 / 选择已有文件夹… / 最近.
- Commits use the 9s94ttyfct-bit noreply identity; no personal paths in committed files.

## Review Focus

- A person on a phone (390 px) sees every control as an icon, and none is cut off past the screen's right edge. Covered in Task 1, test "phone".
- The composer's field does not move when the pickers' chunk lands: the skeleton now sits in the bar and holds the bar's height. Covered in Task 1 by updating `new-chat-pickers-skeleton.spec.ts` to measure `new-chat-settings`.
- The recent-folder list omits the folder already chosen and shows at most 4 entries. Covered in Task 2, test "menu".
- A remote page cannot change the projects root. The menu's New project item must not offer "Change" when `remote`: the root note keeps that rule, and the menu adds no second path to it. Covered in Task 2, test "menu" (asserts no `new-project-root-change` inside the menu).
- Keyboard: the folder button opens with Enter/Space, the arrows move through the items, and Escape gives focus back to the button. Radix provides this; covered in Task 2, test "keyboard".

---

### Task 1: Settings bar under the composer

**Files:**
- Modify: `web/src/components/NewChat.tsx` (footer → bar; `PickersSkeleton` order; warm-up states)
- Modify: `web/src/components/NewChatPickers.tsx` (no `ComposerMore`; new order; divider)
- Modify: `web/src/components/Composer.tsx` (export `NARROW_COMPOSER_PX`)
- Modify: `web/src/index.css` (skeleton rules that key on `[data-composer-narrow]` still match: the bar carries the attribute)
- Test: `tests/e2e/new-chat-layout.spec.ts` (new); update `tests/e2e/new-chat-pickers-skeleton.spec.ts`, plus the New chat cases of `label-in-name`, `phone-layout`, `panel-column`, `select-chevron`, `thinking-font` and `unattended` that look for these controls in `composer-footer` / `composer-more-panel`
- Timings: `tests/e2e/timings.json` (new tests' real durations)

**Interfaces:**
- Produces: `data-testid="new-chat-settings"` on the bar element, with `data-composer-narrow=""` while narrow; `export const NARROW_COMPOSER_PX = 440` from `Composer.tsx`.

- [ ] **Step 1: Write the failing e2e tests** in `tests/e2e/new-chat-layout.spec.ts`. Open New chat via `newChatIn(process.env.OMPW_E2E_WORK)` and wait for `thinking-picker`.
  - `"the settings are a bar under the composer, in order, none of them inside it"` (1400×900, en):
    - `composer-footer` contains none of `preset-picker`, `model-picker`, `thinking-picker`, `mode-picker`, `guard-picker`, `guidance-picker`, `approval-picker`, `unattended-toggle`, `goal-mode`.
    - `new-chat-settings` contains each of them, in that DOM order: compare `boundingBox().x` within a line, or `compareDocumentPosition`.
    - The bar's top is ≥ the composer box's bottom (`composer-footer`'s closest `[data-testid="composer"]`, or the footer's bottom).
    - `composer-more` count is 0.
  - `"phone: every setting is an icon in the bar, none behind ⋯ and none past the screen"` (iPhone 13 device):
    - `new-chat-settings` has the attribute `data-composer-narrow`.
    - `composer-more` count is 0.
    - Each of the 9 controls is visible, with `boundingBox().x + width <= viewport width`.
- [ ] **Step 2: Run** `bun scripts/e2e.ts tests/e2e/new-chat-layout.spec.ts --workers=1`. Expected: both FAIL, because the controls are in `composer-footer` and `composer-more` exists on the phone.
- [ ] **Step 3: Implement.**
  - **`NewChat.tsx`**:
    - Pass no `footer` to `Composer`.
    - After `<Composer …/>`, render `<div ref={setBar} data-testid="new-chat-settings" data-composer-narrow={narrow ? "" : undefined} className="mt-2 flex flex-wrap items-center gap-1 px-1">`. Its content is what `footer` held: the pickers, the skeleton, "pick a folder", the error with Retry, "Starting omp…".
    - Compute `narrow` with `useCrampedRow(bar, "data-composer-narrow", (row) => row.clientWidth < NARROW_COMPOSER_PX)`.
    - Reorder `PickersSkeleton` to the bar's order, with a `data-sk="divider"` 1 px bar. Remove the `composer-narrow:hidden` / `more` square rules from the skeleton: nothing is behind ⋯ now.
  - **`NewChatPickers.tsx`**:
    - Render in this order, with no `ComposerMore`: `PresetPicker`, `ModelPicker`, `ThinkingPicker`, `ModePicker`, `<span aria-hidden className="mx-1 h-5 w-px bg-border" />`, `GuardPicker`, `GuidancePicker` (its Suspense skeleton unchanged), `ApprovalPicker`, `UnattendedToggle`, `{more}` (goal switches).
    - Update the file's header comment to match.
  - **`index.css`**: delete the skeleton rules for `data-sk="more"` if nothing renders them; keep the narrow width rule.
- [ ] **Step 4: Run** the new spec again (PASS). Then run the updated `new-chat-pickers-skeleton.spec.ts`, which now measures `new-chat-settings` instead of `composer-footer` (PASS). Then run every spec in the Files list (PASS). Specs whose cases open a conversation, not New chat, must still pass unchanged.
- [ ] **Step 5:** Run `npm run typecheck && npm run lint && npm test`; each command must exit 0. Add the timings for the new tests. Commit: "New chat: the settings are a bar under the composer, every one always shown".

### Task 2: One folder button with a menu

**Files:**
- Create: `web/src/components/NewChatFolder.tsx`, holding `NewChatFolderMenu`
- Modify: `web/src/components/NewChat.tsx` (folder row), `web/src/components/NewProjectField.tsx` (drop `onUseExisting` and its button)
- Modify: `web/src/i18n/pages.ts`, `web/src/i18n/zh-CN/pages.ts` (new keys)
- Test: extend `tests/e2e/new-chat-layout.spec.ts`; update `new-chat-project.spec.ts`, `projects-folder.spec.ts`, `folder-picker*.spec.ts`, `approval.spec.ts`, `new-chat-picks.spec.ts`, `new-chat-images.spec.ts`, `send-failure.spec.ts`, `issues-tab.spec.ts`, `first-run.spec.ts`, `focus-indicator.spec.ts`, `quota-lazy.spec.ts` (all that use `cwd-picker`, `use-existing-folder` or `back-to-new-project`)
- Docs: `docs/TECHNICAL.md`, `docs/TECHNICAL.zh-CN.md` (New chat section), and `docs/agents/*` lines that name New chat's folder controls (find them with `rg -n "existing folder|new project instead|Options" docs/agents`)

**Interfaces:**
- Consumes: `new-chat-settings` from Task 1 (unchanged).
- Produces: `NewChatFolderMenu({ existing: string | null; recent: string[]; home?: string; onNew: () => void; onChooseExisting: () => void; onPick: (folder: string) => void })`.
  - Test ids:
    - `folder-menu`: the trigger. `data-mode="new"|"existing"`. In `existing` mode its `title` is the full path.
    - `folder-menu-new`, `folder-menu-existing`: the two fixed menu items.
    - `folder-menu-recent`: one per recent folder, each with `title` = full path.
  - i18n keys `pages.newFolderNew` ("New project" / "新项目"), `pages.newFolderExisting` ("Choose an existing folder…" / "选择已有文件夹…"), `pages.newFolderRecent` ("Recent" / "最近").
  - Remove `pages.newBackToProject` and `projects.useExisting` once nothing uses them.

- [ ] **Step 1: Write the failing e2e tests** in `new-chat-layout.spec.ts`.
  - `"the folder row is one line: the folder button, the name field, Options"` (1400, new project):
    - `folder-menu` has `data-mode="new"` and the text "New project".
    - `new-project-name`, `folder-menu` and the Options button share one line (`boundingBox().y` centres within 4 px).
    - `use-existing-folder` and `back-to-new-project` have count 0.
  - `"menu"`:
    - Write a session with cwd A and another with cwd B into the world (the existing `projects-folder` / `new-chat-project` helpers do this).
    - Open New chat in A. `folder-menu` has `data-mode="existing"`, the text = A's last segment, and `title` = A.
    - Click it. `folder-menu-recent` lists B and not A; the count is ≤ 4. `new-project-root-change` has count 0 inside the menu.
    - Choose B: the trigger now reads B's name.
    - Open the menu again and choose `folder-menu-new`: `data-mode="new"`, and `new-project-name` is visible.
    - Open it again and choose `folder-menu-existing`: the folder browser dialog opens.
  - `"keyboard"`:
    - Focus `folder-menu`, then press Enter: the menu is open and focus is on the first item.
    - ArrowDown moves the focus.
    - Escape closes the menu, and `folder-menu` is focused.
- [ ] **Step 2: Run** them. Expected: FAIL, because `folder-menu` does not exist.
- [ ] **Step 3: Implement `NewChatFolderMenu`.**
  - Use the Radix `Menu.Root` / `Trigger` / `Portal` / `Content` / `Item` / `Label` / `Separator`, styled as `ModePicker`'s menu.
  - Trigger: `FolderPlus` + `pages.newFolderNew` when `existing === null`; `FolderOpen` + the folder's last segment otherwise. Add a `ChevronDown`.
  - The recent list is `recent.filter((r) => r !== existing).slice(0, 4)`, as `NewChat` does today.
  - In `NewChat`:
    - Replace `cwd-picker`, `back-to-new-project` and the inline recent buttons with the component.
    - `onNew` does what `back-to-new-project` did; `onChooseExisting` does what `use-existing-folder` / `cwd-picker` did (`setBrowseFor("existing")` / `setBrowse(true)`); `onPick` = `setExisting`.
    - Lay the row out as `[folder-menu][ProjectField name input, flex-1][quota + Options]`, with the root note under it.
  - In `NewProjectField`, remove the `onUseExisting` prop and its button.
- [ ] **Step 4: Run** the new tests (PASS), then every spec in the Files list (PASS).
- [ ] **Step 5: Update the docs** (EN + zh TECHNICAL New chat paragraph; the agent-doc lines found above).
- [ ] **Step 6:** Run `npm run typecheck && npm run lint && npm test` (each exits 0), then the whole New chat e2e group: `bun scripts/e2e.ts tests/e2e/new-chat-*.spec.ts tests/e2e/projects-folder.spec.ts tests/e2e/folder-picker*.spec.ts --workers=1` (all pass).
- [ ] **Step 7: Smoke** at 1400 / 1000 / 390, en and zh-CN, with the real build (`npm run build`, then the throwaway screenshot script): one line on top, the bar under the composer. Add the timings. Commit: "New chat: one folder button with New project, an existing folder and the recent ones in its menu".
