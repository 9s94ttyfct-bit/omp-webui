---
title: Message box (composer)
summary: Sending, steering and queueing messages; slash commands, @file mentions, dropped/pasted files, quick prompts (incl. Soft stop), goal mode, side questions (Ask tab) and the ⋯ overflow.
settings: quick-prompts, drop
---

# Message box (composer)

## What it does

### Sending

- **Enter** sends. While omp is working, Enter queues the message as a follow-up (sent when the turn ends); a queued message can be edited or removed until omp takes it. **⌘Enter / Ctrl+Enter** steers: the message reaches the agent now. **Shift+Enter** is a new line. **Esc** stops omp (press twice: the first Esc asks). All rebindable except Shift+Enter and Esc (see the shortcuts topic).
- A message starting with `/` runs as an omp slash command (autocomplete lists omp's commands); one starting with `!` runs as a shell command (`!bash`).
- `@` opens file-mention completion of paths under the conversation's folder; omp reads a mentioned file into the prompt itself.
- Word prediction: ghost text from omp's `predict_word`; Tab accepts with a space, → without. If omp's prompt history database lacks its `history` table, Settings shows that prediction is unavailable.
- A paused conversation's box says *Paused. Press Enter to resume and send, or use Resume*; the *Pause conversation* button freezes the conversation (see session-controls).
- While the page has lost the server you can type, but Send is disabled until reconnected.

### Files: drop, paste, Attach

Any file can be dropped on, pasted into, or chosen with the Attach button. A small choice offers:

- **Attach**: puts the content in the message. Images as images; UTF-8 text files as text (up to 256 KiB per file, 512 KiB of text per message); PDF and Word `.docx` as the text read from them (documents up to 25 MiB; text of the first 50 PDF pages; up to 10 text-less (scanned) pages sent as images).
- **Insert path**: writes the file's absolute path. In the macOS app that is the real path on the Mac (folders too). In a browser (local or through the tunnel) the file is first uploaded into the conversation's folder at `.omp-webui/uploads/<YYYY-MM-DD>/<name>` and that path is inserted (with progress and Cancel). Upload limits: 50 MiB per file, 500 MiB and 20 000 entries for the uploads folder, 20 files per drop; names are never overwritten (`name (1).ext`); `.omp-webui/.gitignore` keeps uploads out of git.
- Other Office files (`.doc`, `.ppt`, `.pptx`, `.xls`, `.xlsx`, `.rtf`, `.epub`), other binaries and folders can only be inserted as a path. A pasted screenshot is attached at once.
- A checkbox (*Remember for …*) remembers the choice per kind (text files, images, PDF and Word documents, other files, folders). The macOS app and browser pages keep separate choices.
- Warning: omp expands `@` mentions anywhere in the message, including inside attached text; such files are flagged before sending.

### Quick prompts

The ⚡ button beside the box lists saved messages; one click sends one. Each has a mode for when the agent is working: **Steer** (reaches the agent now) or **Follow-up** (waits for the turn to end); when idle, either is an ordinary message. A prompt may also *Stop the session when that turn ends* (the conversation's omp process is ended; the conversation is kept and the next message carries on). The ⚡ button hides while the box has text; quick prompts also appear in the ⌘K command menu while a conversation is on screen, and each can get its own keyboard shortcut. They are not offered while omp is asking for an approval.

Built-in defaults: **Soft stop** (Steer, stops after: asks the agent to stop starting new work, finish or pause safely, and write a handoff as its final message, not to a file), *Review my changes*, *Write tests for this*, *Summarize & next steps*, *Commit the work*, *Simplify what you wrote* (all Follow-up). Built-in texts are English whatever the UI language. A built-in added by a later version joins a saved list once; one the user removed stays removed. A Soft stop request lives with the process (a server restart forgets it); a turn still working 10 minutes later is reminded once.

### Goal mode

Start a chat as a goal (New chat's Goal toggle) or set one on any conversation (header *Goal* button, the command menu, or ⌘⇧G / Ctrl+Shift+G). By default omp interviews the user first, then proposes an objective, acceptance criteria and a token budget; nothing starts until confirmed. The interview can be skipped by typing the objective (a goal started at once cannot carry images). Budgets accept `200000`, `200k`, `1.5M`, `1,500,000`. While a goal is held the control reads *Current goal* and opens the goal bar: objective, status, budget and time used, with Pause, Resume and Drop. omp cannot edit a set goal's objective or budget: drop it and set a new one.

### Side questions (Ask tab)

The side panel's *Ask* tab (omp's `/btw`) answers a question about the conversation without adding to it: it uses the conversation's context, no tools, and allows follow-ups. A model selector above the box chooses the answering model for the whole app: *omp default* (the conversation's own model, answered by omp) or one `provider/id`. With another model, the server copies the saved session file into a private folder of its data dir (`btw-fork/`), starts a separate omp on that copy with the chosen model, asks, streams the answer and deletes the copy; the conversation, its model and its file are untouched. Such answers do not see a turn still streaming, a conversation with no file yet is answered without context, one question per conversation runs at a time (at most two waiting, three such processes in total), and answers are kept by the server only (30 per conversation, 30 conversations). Every answer says which model gave it.

### The ⋯ overflow

When the controls do not fit in one row, the model, permission mode, Attach and the unattended switch stay in the row and the thinking level, guard, guidance, Full/Light, goal and quick prompts move behind **⋯**, each labelled (e.g. *Thinking: Low*, *Mode: Full*). Choosing a quick prompt closes the panel.

## Where it is

- The message box at the bottom of a conversation and in New chat.
- Settings › Conversations & files › Quick prompts: add, edit (Name, Message, While the agent works, Stop the session when that turn ends), reorder, remove, *Restore the defaults*. Also *Edit quick prompts…* in the ⚡ menu.
- Settings › Conversations & files › Dropped files: per kind, Ask each time / Attach / Insert path.
- Side panel › Ask tab: side questions and their model.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.quickPrompts` | JSON list of `{ id, name, text, mode: "steer"\|"followUp", stopAfter }`; at most 20, name ≤ 60 and text ≤ 2000 characters, 16 KiB in all | unset: the six built-ins | Synced preference. The quick prompts. Invalid entries are dropped. |
| `ompw.quickPromptsSeen` | JSON list of built-in ids | unset (= only `soft-stop` known) | Synced preference. Built-ins the saved list was made with, so a new built-in joins once and a removed one stays removed. |
| `ompw.dropChoices.app` | JSON object, kind (`text`, `image`, `document`, `other`, `folder`) → `attach` or `path` (`attach` only for text, image, document) | unset: ask each time | Synced preference. Remembered drop choices in the macOS app. |
| `ompw.dropChoices.page` | same as above | unset: ask each time | Synced preference. Remembered drop choices in browser pages (local or remote). |
| `ompw.btwModel` | one model `provider/id` (no spaces, commas, `*`, `?`; not `pi/…`) | unset: *omp default* | Synced preference. The model that answers side questions, for every conversation. |

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/files` | GET | token | `@file` completion: `?cwd=<folder>&q=<text>`; paths under that folder (bounded walk: skips hidden, dependency and build folders). |
| `/api/upload` | POST | token (refused to a page not on this computer unless Settings › Remote access › File transfer is full) | `?live=&file=&name=`, body = file bytes: saves into `<conversation folder>/.omp-webui/uploads/<date>/<name>` and returns the path. Only creates new files. |

## Limits and caveats

- Image limits: 8 MiB each, 20 MiB per message. Text is attached only if the whole file is valid UTF-8 (a GBK file is path-only).
- A browser cannot know a file's path or upload a folder; only the macOS app inserts real paths for dropped items.
- Uploads are refused into a folder whose `.omp-webui` is an omp-webui data folder (e.g. a conversation in the home folder of the web version).
- A side question with a non-default model sends the whole saved conversation to that model's provider.
- Quick prompts and the side-question model are app-wide preferences: any connected page, including a remote one, can change them.

## Security notes

- `/api/upload` follows the remote file-transfer setting: a tunnel or network page cannot upload unless file transfer is set to full on this computer. Uploads stay inside the conversation's folder; links are not followed.
- `@` mentions in attached text make omp read the named files with no tool approval; check flagged files before sending.
- Agents must not change quick prompts, drop choices or the side-question model unless the user asks.
