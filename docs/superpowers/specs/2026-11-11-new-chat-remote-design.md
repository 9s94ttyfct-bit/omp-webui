# Remote computers in New chat — design

## Intent

A conversation can run commands on, and copy files to and from, the person's other computers (`remote_run`,
`remote_copy`), but only after it has started: Session controls › Remote computers. The person wants to choose, before a
new conversation starts, whether it may use them, with a control of its own beside the guard's in New chat's settings bar.

## Goals

- New chat's settings bar has a Remote computers control right after the guard's (`GuardPicker`), in the rules group.
- It shows at a glance whether the conversation will have remote computers, and which.
- What is picked is what the conversation the person sends from has: the warm-up process in an existing folder, the new
  project's process in New chat's default mode.

## Non-goals

- The bar under a running conversation's composer: it has no guard control either; Session controls keeps the list there.
- Carrying a pick to a warm-up process New chat starts later (another folder, other options): it starts with none (the
  person's call).
- A remembered default: every new chat starts with none.
- Anything about which commands may run there (the guard and the permission mode stay as they are).

## Anti-goals

- A new chat that can run commands on another computer without the person having picked it there.
- A page that is not the person's own (a remote page) giving a conversation remote computers.

## Approaches

- **A — icon with a list (picked by the person).** An icon button like the guard's; it opens a popover with the saved
  computers, one tick each, the same list as Session controls › Remote computers. Lit while any is ticked.
- B — one switch: on gives every saved computer. Fastest, but no way to give one of several.

## Design

- **Control** (`RemotePicker`, in `SessionRemote.tsx`, its own chunk with the later strings): icon `Server`, label
  "Remote: off" / "Remote: <name>" / "Remote: <n> computers"; a narrow bar shows the icon only. Accent tint and ring while
  any is ticked. Not shown while no computer is saved. The popover holds the existing list (`SessionRemote`'s body, made
  reusable), with its sign-in state per computer and its reasons for being disabled. A placeholder of its width holds its
  place while its chunk loads (and in `PickersSkeleton`), widths in CSS.
- **On the warm-up process:** a tick goes to `POST /api/remote-run/live` at once, as in Session controls. A fresh omp
  reports its session file path before the first message (checked with omp 18.18.6: `get_state` gives the path, not yet on
  disk), so `RemoteRunService.choose` keys it there.
- **A new project** (New chat's default): the message goes to a process `startProject` starts in the new folder; it is
  given the warm-up process's computers through the same route (`lib/new-chat-remote.ts`, loaded then; New chat is in the
  first paint and its budget), and a warning toast says when it could not be (the person's call).
- **Warm-up processes started later** (the folder or options changed) start with none; the control reads "Remote: off".
- Entries of warm-up processes never sent from stay in `remote-run.json` (keys of files never written): harmless, and
  removing them on exit was dropped (a process given tools is no longer "untouched", so the cleanup never ran).
- **Strings** English and Chinese; docs: `docs/agents/remote-access.md`.

## Verification

- e2e (existing folder): with a saved computer, the icon is right after the guard's; a tick lights it and the warm-up
  process's `remoteComputers` has the id; a new warm-up process (other options) starts with none; no computer saved, no icon.
- e2e (new project): a tick on the warm-up process, a `!command` sent: the project's process has the id.
