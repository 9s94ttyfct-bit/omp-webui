# Remote computers in New chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New chat's settings bar gets a Remote computers control right after the guard's; ticks act on the warm-up process only.

**Architecture:** `SessionRemote.tsx`'s list becomes a body shared by Session controls and a new `RemotePicker` (an icon
button with a popover, like `GuardPicker`), rendered in `NewChatPickers`' rules group. Ticks use the existing
`POST /api/remote-run/live` on the warm-up process (it has a session file path before the first message). The server drops
the entry of a new chat that ended without its session file being written.

**Tech Stack:** React 19, Radix Popover, lucide-react, Bun tests, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-11-new-chat-remote-design.md`

## Global Constraints

- Every new chat starts with none; a pick is not carried to another process (another folder, options, a new project).
- Only the person's own page may change it (the route already refuses others; the list says why).
- Strings in English and Chinese.

## Review Focus

- No computer saved: no control, and the bar's layout is as before.
- A page that is not the person's own: the list is disabled and says why (existing `controlsRemoteNotOwner`).
- A computer not signed in: still tickable, and says so (existing behaviour of the list).
- A narrow bar: icon only, with an accessible name.
- A new warm-up process after the folder or options changed: control reads "Remote: off".

---

### Task 1: Drop the entry of an abandoned new chat

**Files:** Modify `server/remote-run/service.ts`, `server/live.ts` (`RemoteRunHooks`, `onExit`); Test `tests/unit/remote-run-service.test.ts`

**Interfaces:** Produces `RemoteRunHooks.abandoned(sessionFile: string): void`, implemented by `RemoteRun.abandoned`.

- [ ] Test `"a new chat that ended without its session file being written loses its entry; others keep theirs"`: choose
  SERVER1 for `/s/a.jsonl` and BUILD for `/s/b.jsonl`, `service.abandoned("/s/a.jsonl")`, expect
  `stored().conversations` to equal `{ "/s/b.jsonl": [BUILD.id] }`; `abandoned` of an unknown file writes nothing new.
- [ ] Run `bun test tests/unit/remote-run-service.test.ts` — FAIL (no `abandoned`).
- [ ] Implement `abandoned`; call it in `Live`'s `onExit` inside the existing `untouched && sessionFile && !existsSync` branch.
- [ ] Run the test — PASS.

### Task 2: `RemotePicker` beside the guard

**Files:** Modify `web/src/components/SessionRemote.tsx`, `web/src/components/NewChatPickers.tsx`,
`web/src/i18n/panel-later.ts`, `web/src/i18n/zh-CN/panel.ts`; Test `tests/e2e/new-chat-remote.spec.ts`, `tests/e2e/timings.json`;
Docs `docs/agents/composer.md`, `docs/agents/remote-access.md`

**Interfaces:** Produces `export function RemotePicker({ liveId }: { liveId: string })` in `SessionRemote.tsx`;
test ids `remote-picker` (button, `data-on`), `remote-picker-panel`; list ids unchanged (`session-remote-computer`).

- [ ] e2e `"New chat's Remote computers sit beside the guard, act on the warm-up process only, and are not there without a saved computer"`:
  no saved computer → `remote-picker` count 0; save one through `POST /api/macs` and reload → in `[data-group="rules"]`
  the button right after `guard-picker` is `remote-picker`, text `Remote: off`; tick it in `remote-picker-panel` → the
  warm-up process's `remoteComputers` equals `[id]`, button `Remote: E2E Mac`, `data-on="true"`; change Options → a second
  `open`, button `Remote: off`, the new process has no `remoteComputers`; finally delete the computer.
- [ ] Run it (after `bun run build`) — FAIL (no `remote-picker`).
- [ ] Implement: list body shared (`RemoteList`), `RemotePicker` (icon `Server`, label keys `remotePickerOff` /
  `remotePickerOne` `{name}` / `remotePickerMany` `{n}`, title `remotePickerTitle`, on-style as `AdvisorToggle`, narrow:
  icon only), placed after `GuardPicker`.
- [ ] Run it — PASS; time it into `tests/e2e/timings.json` (`OMPW_E2E_JSON=… playwright test …`, `bun scripts/e2e-timings.ts`).
- [ ] Docs lines; `bun run typecheck`, `bun run lint`; commit.

## Rulings during execution

- Task 1 dropped: the cleanup sat behind `untouched`, which `serveHostTools` clears, so it never ran for a warm-up given a
  computer (final review). Leftover keys of files never written are harmless; removing the cleanup was simpler than a new
  "new chat, never written" flag whose restart-before-first-reply cases were unclear.
- A new project's process is given the warm-up process's computers (the person's call after the review found the pick
  shown but dropped in New chat's default mode): `web/src/lib/new-chat-remote.ts`, loaded on send, since New chat is in the
  first paint (budget 228 KiB, 16 bytes left).
- `RemotePicker` is its own chunk (it carries the later strings), with a placeholder of its width in the pickers'
  skeleton and while it loads; widths in `web/src/index.css`.
