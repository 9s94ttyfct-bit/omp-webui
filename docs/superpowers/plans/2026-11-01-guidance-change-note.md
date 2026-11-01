# Guidance that holds after it changes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A guidance change is followed from the next turn (a note in the conversation), and the guidance outranks recalled memories and earlier instructions (a priority sentence).

**Architecture:** All model-facing behaviour lives in the guidance extension omp loads (`server/omp/guidance/extension.ts`): it keeps what the branch was given as a session custom entry and returns a custom message when that changes. The page draws that message as a typed note; the names of the feature change from "Model guidance" to "Guidance".

**Tech Stack:** Bun, TypeScript, omp extension API (`before_agent_start` → `{ systemPrompt, message }`, `ctx.sessionManager.getBranch()`, `appendCustomEntry`), React.

**Spec:** `docs/superpowers/specs/2026-11-01-guidance-change-note-design.md`

## Global Constraints

- The extension imports nothing of the app (it is copied into the data dir); constants it shares are exported from it.
- Main agent only: subagents and title requests get nothing (unchanged).
- Custom type and entry type: `ompw-guidance`. Message `display: true`, `details: { text }`; entry data `{ text }`.
- Reads stay capped at `GUIDANCE_READ_MAX`.

## Review Focus

- A conversation from before this change (guidance, history, no entry): exactly one note at its first turn, worded neutrally — contract test "first turn after an upgrade".
- Same text rewritten (template saved without a change, server restart re-writing the file): no note — contract test "unchanged".
- Branch switched to a point before a change: compares with that branch's own entries (by `getBranch`) — covered by construction; not tested (no branch API in the stub path).
- Guidance turned off: removal note once, no block in the system prompt — contract test "off".
- A subagent's report turn (omp skips `before_agent_start`): carries the last system prompt; no note is expected there — existing tests keep passing.

---

### Task 1: The extension: priority block, recorded state, note on change

**Files:**
- Modify: `server/omp/guidance/extension.ts`
- Test: `tests/contract/model-guidance.test.ts`

**Interfaces:**
- Produces: `export const GUIDANCE_NOTE_TYPE = "ompw-guidance"`; `export const GUIDANCE_HEADING = "# Standing instructions for this conversation"`.

- [ ] **Step 1: Failing tests** in `model-guidance.test.ts` (scripted stub, prompts via the existing `prompt()`/`mainRequestFor`):
  - `"the guidance block says it outranks earlier instructions and recalled memories"`: first request contains `GUIDANCE_HEADING` and `"replace any earlier instruction"`, and `MARK`.
  - `"a change between turns puts one note with the new text in the next request, and none after"`: open with `{ text: MARK }`, turn 1 (no `"standing instructions of this conversation are now"` in it); POST `/api/model-guidance/live` `{ liveId, guidance: { text: MARK2 } }`; turn 2 request contains the note phrase and `MARK2`; turn 3 request contains the note exactly once (count occurrences).
  - `"turning the guidance off leaves one removal note"`: after off, next request contains `"were removed"` and not `MARK`.
- [ ] **Step 2:** `bun test tests/contract/model-guidance.test.ts` → the three new tests fail.
- [ ] **Step 3: Implement.** In the handler (main agent only): read text; `branch = ctx.sessionManager?.getBranch?.() ?? []`; `before` = `data.text` of the last `type === "custom" && customType === GUIDANCE_NOTE_TYPE` entry, else `""`; `hadTurns` = any `type === "message"` with `message.role === "user"`. System block when text: `${GUIDANCE_HEADING}\n${PRIORITY}\n\n${text}`. When `text !== before`: `appendCustomEntry(GUIDANCE_NOTE_TYPE, { text })`; if `hadTurns`, return `message` with the copy below. Wrap the session calls in try/catch (a conversation never fails for its guidance).
  - PRIORITY: "These are the person's current standing instructions for this whole conversation. They replace any earlier instruction in this conversation, any recalled memory and any earlier habit of this conversation that disagrees with them."
  - Note: "The standing instructions of this conversation are now:\n\n<text>\n\nThey replace any earlier instruction in this conversation, and any recalled memory, that disagrees with them."
  - Removal: "The standing instructions of this conversation were removed. Rules that were given only as standing instructions no longer apply."
  - Update the file's header comment (scope, the note, why: the measured cases of the spec).
- [ ] **Step 4:** the contract file passes whole.
- [ ] **Step 5: Commit** `Guidance: a change is noted in the conversation; the guidance outranks earlier instructions and memories`.

### Task 2: The page: the note, and the feature's names

**Files:**
- Modify: `web/src/lib/notices.ts` (`CustomNote` gains `{ kind: "guidance"; text: string }`; `classifyCustom` maps `ompw-guidance`: text from `details.text`, `""` = removed)
- Modify: `web/src/components/NoticeRows.tsx` (`TypedNote` case `guidance`: `NoteRow` with a scroll icon, title `chat.noteGuidanceChanged` / `chat.noteGuidanceRemoved`, the text folded under a disclosure)
- Modify: `web/src/i18n/chat.ts`, `web/src/i18n/zh-CN/chat.ts` (EN "Guidance changed" / "Guidance turned off"; zh "指引已更改" / "指引已关闭")
- Modify: `web/src/i18n/guidance.ts`, `zh-CN/guidance.ts`, `panel*.ts`: "Model guidance"/"模型使用指引"/"模型指引" → "Guidance"/"指引"; `intro`, `changeIntro`, `empty`, `textPlaceholder` say it is the conversation's standing rules that the main agent follows over memories and earlier instructions; subagents do not see it.
- Test: `tests/unit/render-notices.test.ts`

- [ ] **Step 1: Failing test** `"a guidance note shows the new text, and a removal says so"`: `classifyCustom("ompw-guidance", { text: "X" }, "…")` → `{ kind: "guidance", text: "X" }`; with `{ text: "" }` → `text: ""`; rendered row text contains "Guidance changed" and "X" / "Guidance turned off".
- [ ] **Step 2:** `bun test tests/unit/render-notices.test.ts` fails.
- [ ] **Step 3:** implement as listed.
- [ ] **Step 4:** unit test passes; `npm run typecheck`, `biome check`, `bun test tests/unit` pass; i18n key parity check (`bun test tests/unit` includes it).
- [ ] **Step 5: Commit** `Guidance: the note in the transcript; the feature is called Guidance`.

### Task 3: Docs and the real-model check

**Files:** `docs/TECHNICAL.md`, `docs/TECHNICAL.zh-CN.md` (the model-guidance section: scope, priority, the note, why — the measured table in one line each).

- [ ] **Step 1:** update both docs.
- [ ] **Step 2:** rerun `guidance-repro/run3.ts` with `SHIPPED` = the repo's extension and `ONLY=chatRule-shipped,memory-shipped,memory+switch-shipped` → 8/8 each.
- [ ] **Step 3:** e2e that show guidance (`bunx playwright test -g guidance --workers=1`) pass after `npm run build`.
- [ ] **Step 4: Commit** `Docs: guidance as standing rules, and the note when it changes`.
