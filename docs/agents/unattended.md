---
title: Unattended mode and questions
summary: Letting a conversation work while the person is away: the agent goes on with what needs no decision and files what does as a question on the Questions page, which the person answers later.
settings: unattended
---

# Unattended mode and questions

## What it does

With **Unattended** on for a conversation, its main agent is told the person is away: it goes on with everything that needs no decision, and files what does need one as a **question** instead of stopping. The person answers later from the Questions list; the answer goes to the conversation as an ordinary message that begins "Answer to your question".

How it works:

- Every conversation's omp is started with a small extension of the server's. While the mode is on, it appends the standing instruction (*What the agent is told*) to the **main agent's** system prompt at each turn and makes the tool `file_question` available to it; subagents and title requests see neither. Turning the mode on or off reaches the next turn without a restart.
- `file_question` returns at once; the server reads the call from the conversation's events and files the question (title, what the agent found, the options with the one it would pick marked *recommended*, what it does meanwhile).
- omp's own `ask` dialog is answered by the server for the person ("Recorded for the person, who is away. …") and filed the same way, so it never blocks. Only `ask`: tool approvals of the permission mode and what the guard asks are the person's consent and are never answered for them, so an unattended conversation can still stop on those.
- While questions of a conversation still wait, its agent is told which ones at each turn, so it does not ask them again.
- Answering: choose options and/or write an answer or note, pick **While the conversation is working**: *Queue after the turn* (default) or *Steer in now*, then **Answer**. An idle conversation takes it at once; one that is closed is opened for it; a paused one is resumed first. The question is marked answered only once the message is on its way. **Dismiss** sends nothing and moves it to *Done*.

The instruction defaults to the shipped text (*As shipped*); the person can edit it (*Edited*) or **Restore default**. When a conversation's omp cannot be told (started with the person's own `--trusted-extension`, started by a server without the mode, or the extension did not start), the switch says so; its own `ask` questions are still filed.

## Where it is

- **Unattended** switch beside the message box of each conversation (with a *N open* chip that opens that conversation's questions). In **New chat**, new conversations start with it on when Settings says so.
- **Questions** page: sidebar entry *Questions* with a badge of open questions (`#/questions`); tabs *Open* / *Done*, filter *Show questions from*: *All conversations* / *This conversation*.
- A conversation's side panel › **Questions** tab: that conversation's questions.
- **Settings › Approvals & safety › Unattended mode** (`#/settings/safety`): *Turn it on for new conversations*, *What the agent is told* (with a character count, *Save*, *Restore default*). On a page that is not on this computer the text is read-only ("The text is changed on the computer omp-webui runs on").

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.unattended` | `on`, `off` | unset: `off` | Synced preference. Whether a conversation started from New chat is unattended from the start. Each conversation then has its own switch. |

Other stored data (in the data folder, `~/.omp-webui`; both move with Move to another computer):

| Stored in | Content | Limits |
|---|---|---|
| `unattended.json` | The edited instruction (absent: the shipped default) and which conversations are unattended | Instruction up to 4,000 characters, not empty; up to 500 conversations remembered |
| `questions.json` | The questions, open and settled | 200 kept in all (oldest settled dropped first); at most 60 open per conversation; title 200, context 3,000, meanwhile 1,500 characters, up to 10 options, answer up to 6,000 characters |

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/unattended` | GET, POST | token; POST from this computer only | GET returns the instruction settings. POST `{ instruction }` saves it (`null`: restore the default); 403 for a page not on this computer, 422 for an empty or too long text. Reaches unattended conversations at their next turn. |
| `/api/unattended/session?live=<liveId>` | GET | token | Whether one conversation is unattended: `{ on, unattended }` for a running process (`live`), or what was kept for a session file without one (`?file=`). |
| `/api/unattended/live` | POST | token | `{ liveId, on }`: turn one running conversation unattended or back; open to every page (a phone included). 404 when not running. |
| `/api/questions` | GET | token | The list of questions. Pages are told the open counts over the WebSocket on every change. |
| `/api/questions/answer` | POST | token | `{ id, …answer, delivery? }` with `delivery` `followUp` (default) or `steer`: send the answer to its conversation. 404 unknown question, 409 already settled / being answered / could not be sent, 422 no answer, 403 when the conversation refuses a remote page's turn (remote access's confirm-risky rule). |
| `/api/questions/dismiss` | POST | token | `{ id }`: dismiss without sending anything. |

## Limits and caveats

- The agent decides what to file; the mode is an instruction, not a guarantee. A runaway agent is capped at 60 open questions per conversation; a question that cannot be kept is reported under its conversation ("A question was not kept: …").
- Tool approvals and guard questions still wait for the person; choose a permission mode and guard setting that fit working unattended.
- The instruction costs tokens on every turn of an unattended conversation.

## Security notes

- The instruction is put into the system prompt of every unattended conversation, so it can be changed only from this computer.
- Answering is a turn like any message a page sends, under the same rules (a remote page's turn is subject to remote access's "Confirm risky commands" setting).
- The extension holds no credential and files nothing itself; the server files what it reads from the conversation's own events.
