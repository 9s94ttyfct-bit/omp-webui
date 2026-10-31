---
title: Model guidance
summary: Standing instructions appended to a conversation's main-agent system prompt about how to hand work to subagents and which models to use, picked from saved templates or written per conversation.
settings: guidance
---

# Model guidance

## What it does

Model guidance tells the main agent how to delegate to subagents and which models to give them (for example "at most 1 Sonnet subagent at a time"). It is off unless the user picks a template or makes one the default for new chats.

- The conversation's omp is started with a small extension that appends the guidance text to the **main agent's** system prompt at each turn. Subagents and title requests do not see it. Because the text is read from a file at each turn, a change reaches the next turn without a restart, and compaction or resuming cannot drop it. It does not appear in the transcript.
- **Templates**: saved name + text pairs. Two ship with the app: "One of each kind at a time" (at most 1 Sonnet, 3 DeepSeek, 2 of any other model at once) and "Simple to DeepSeek, complex to Sonnet". Users can create, edit, rename, duplicate, delete and reset templates; **Restore defaults** puts the shipped templates back as shipped (deleted ones return, edited ones get the shipped text) and leaves user-made templates alone.
- **Default for new chats**: one template can be marked as the default; New chat then starts with it (the user can still pick another or None there). Deleting the template clears the default.
- **Per conversation**: New chat › Options › **Guidance** (None, a template, or Custom… text). Later the conversation's **Guidance** tab in the side panel shows and edits it: **Save for this conversation** (text becomes its own), **Save to template** (writes into the template it came from; if other conversations use it, asks first, and they carry the new text from their next turn), **Create new template**, **Turn off**. A conversation using a template follows edits to that template.
- A conversation started with the user's own `--trusted-extension`, or one this server took over from an older server, cannot carry guidance; the tab explains why and a change is kept for its next opening.

## Where it is

- **Settings › Models & accounts › Model guidance** (`#/settings/models`): template list, **New template**, **Edit**, **Duplicate**, **Delete**, **Reset** (shipped ones), **Restore defaults**, **Default for new chats**. Read-only on a page that is not on this computer ("Model guidance is changed on the computer omp-webui runs on").
- **New chat › Options › Guidance**.
- Conversation side panel › **Guidance** tab; a chip "Guidance: <name>" / "Guidance: off".

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.guidanceDefault` | A template id (1–80 non-whitespace characters) | unset (no guidance) | Synced UI preference: the template a conversation started from New chat is given unless the user picks another there. A deleted template stops being the default. |

Other stored data:

| Stored in | Field | Values | Default | Effect |
|---|---|---|---|---|
| `~/.omp-webui/model-guidance.json` | templates | list of `{ id, name, text, builtin? }`; name up to 60 chars, text up to 4,000 chars; at most 50 templates | the two shipped templates | The template set. An unreadable file is kept aside as `model-guidance.json.damaged` and the shipped templates stand in. Moves with Move to another computer. |
| beside the conversation's settings overlay | `<…>.guidance.md` | text up to 4,000 chars | none | What one conversation carries; read by the extension at each turn. |
| `~/.omp-webui/model-guidance-sessions.json` | per conversation | template id and/or text | none | What each conversation was given, so it is carried again when the conversation is reopened. |

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/model-guidance` | GET, POST | token (POST: this computer only) | GET: `{ templates, rev }`. POST `{ template }` saves (creates or replaces) a template, `{ template, update: true }` saves into an existing one (422 `gone` if it was deleted), `{ remove: <id> }` deletes one. Problems answer 422 with `problem` (`nameEmpty`, `nameTooLong`, `nameRepeated`, `textEmpty`, `textTooLong`, `tooMany`, `gone`, `unknown`). Running conversations using a template pick up the change from their next turn. |
| `/api/model-guidance/restore` | POST | token (this computer only) | Restore the shipped templates. |
| `/api/model-guidance/session` | GET | token | Query `live` (process id) or `file` (session file): what the conversation carries (`guidance`: template, templateName, text, live, skipped), the templates, and how many other conversations use each template (`others`). |
| `/api/model-guidance/live` | POST | token (this computer only) | Body `{ liveId \| file, guidance }`: change one conversation's guidance (`guidance` `{ template?, text? }`, or null for none). A running process gets it from its next turn; a conversation with no process keeps it for its next opening. |

## Limits and caveats

- Text: at most 4,000 characters per conversation or template (the system prompt is paid for on every turn); template names at most 60 characters; at most 50 templates.
- Only the main agent is told; subagents never see the guidance. It is advice to the model, not an enforced limit.
- Guidance is not available in a conversation started with `--trusted-extension`.

## Security notes

- Every change (templates, restore, a conversation's guidance) is refused (403) to a page not on this computer, because the text goes into the system prompt of every conversation that uses it. A remote page can read the templates and name a template for a new chat, but cannot send custom guidance text ("The model guidance is written on the computer omp-webui runs on").
- Agents must not create or edit templates, or change the default, on the user's behalf unless asked.
