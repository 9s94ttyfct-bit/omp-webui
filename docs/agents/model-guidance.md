---
title: Guidance
summary: A conversation's standing rules (how to hand work to subagents and which models to use, its language, how it commits, anything else), put into the main agent's system prompt above recalled memories and earlier instructions; picked from saved templates or written per conversation, and a change is noted in the transcript.
settings: guidance
---

# Guidance

## What it does

Guidance is a conversation's standing rules for the main agent: how to delegate to subagents and which models to give them (for example "at most 1 Sonnet subagent at a time"), and anything else the user wants the whole conversation to keep to (reply in Chinese, commit after each change, …). It is off unless the user picks a template or makes one the default for new chats. (Before the next version it was called "Model guidance"; the docs slug `model-guidance` is unchanged.)

- The conversation's omp is started with a small extension that adds the guidance to the **main agent's** system prompt at each turn, under the heading "# Standing instructions for this conversation" and a sentence saying they replace any earlier instruction, recalled memory or habit of the conversation that disagrees with them. Subagents and title requests do not see it. Because the text is read from a file at each turn, a change reaches the next turn without a restart, and compaction or resuming cannot drop it.
- **A change is noted in the transcript**: when the guidance a branch of the conversation was last given differs from the current text (changed, switched template, turned off), the next turn carries a note to the model ("The standing instructions of this conversation are now: …" or "… were removed") and the page shows it as a row **Guidance changed** / **Guidance turned off** (zh 指引已更改 / 指引已关闭), kept visible when the turn is folded. The note omp delivered is the record of what the branch was told, so a turn that was aborted before its prompt went out tells it again, and a resumed conversation, another branch or a new process compares with what that branch was told. A first turn records the text without a note; a conversation from before this, with turns and no record, gets the note once.
- **Templates**: saved name + text pairs. Two ship with the app: "One of each kind at a time" (at most 1 Sonnet, 3 DeepSeek, 2 of any other model at once) and "Simple to DeepSeek, complex to Sonnet". Users can create, edit, rename, duplicate, delete and reset templates; **Restore defaults** puts the shipped templates back as shipped (deleted ones return, edited ones get the shipped text) and leaves user-made templates alone.
- **Default for new chats**: New chat starts with the guidance the last new chat was started with (a template, text, or None: `ompw.guidanceLast`); with nothing remembered, or that template deleted since, it starts with the template marked as the default (the user can still pick another or None there). Deleting the template clears the default.
- **Per conversation**: New chat › Options › **Guidance** (None, a template, or Custom… text). Later the conversation's **Guidance** tab in the side panel shows and edits it: **Save for this conversation** (text becomes its own), **Save to template** (writes into the template it came from; if other conversations use it, asks first, and they carry the new text from their next turn), **Create new template**, **Turn off**. A conversation using a template follows edits to that template.
- **Conflict check** (on by default): after **Save for this conversation**, or when the conversation switches to another template, a small model compares the new guidance with the context files omp loads for the conversation's folder (`AGENTS.md`, `CLAUDE.md`, `.omp/AGENTS.md` and the like, up to the repository root, plus the user's own such as `~/.omp/agent/AGENTS.md`; providers in omp's `disabledProviders` are skipped) and with omp's memories of that project. Conflicts appear under the Guidance tab's buttons, each with the two quoted statements, why they clash and a proposed change shown as a diff: to the guidance (the default), to a file of the folder the Files tab may write, or forgetting (retiring) a memory. **Nothing outside the guidance is changed until the user presses Apply on that change** (or Apply all); Skip leaves it. **Check for conflicts** in the tab runs it again. A check that cannot be made (no model, timeout, an answer that is not the expected JSON) says "Couldn't check for conflicts"; the guidance is saved either way.
- Template edits (Settings, Save to template) are not checked against any folder; the template editor and the tab say a conversation is checked from its Guidance tab.
- A conversation started with the user's own `--trusted-extension`, or one this server took over from an older server, cannot carry guidance; the tab explains why and a change is kept for its next opening.

## Where it is

- **Settings › Models & accounts › Guidance** (`#/settings/models`): template list, **New template**, **Edit**, **Duplicate**, **Delete**, **Reset** (shipped ones), **Restore defaults**, **Default for new chats**, and **Check guidance for conflicts** (the conflict check's switch). Changed from a page on this computer or signed in through Cloudflare Access; read-only on any other page ("Guidance is changed on the computer omp-webui runs on, or from a page signed in through Cloudflare Access").
- **New chat › Options › Guidance**: a pick is applied to New chat's warm-up process at once. On a page that may not change guidance the chip is shown dimmed and a tap says why; a change the server refuses is said in a toast and the chip keeps what the conversation carries.
- Conversation side panel › **Guidance** tab; a chip "Guidance: <name>" / "Guidance: off". Its **Check for conflicts** button (and the check after a save) works on a page on this computer only; on a page signed in through Access the button says why.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.guidanceDefault` | A template id (1–80 non-whitespace characters) | unset (no guidance) | Synced UI preference: the template a conversation started from New chat is given unless the user picks another there. A deleted template stops being the default. |
| `ompw.guidanceLast` | JSON, exactly one of `{ "template": "<id>" }`, `{ "text": "<guidance>" }` (up to the editor's limit), `{ "none": true }` | unset | Synced UI preference, written when a conversation is started from New chat: the guidance that new chat had. New chat starts with it; unset, or a template deleted since, falls back to `ompw.guidanceDefault`. |
| `ompw.guidanceCheck` | `on`, `off` | unset (on) | Synced UI preference: whether saving a conversation's guidance (or switching its template) runs the conflict check. Each check is one request to the Guard reviewer's model (the reviewer set in Guard settings, else omp's `reviewer`, `smol`, `slow` or `default` role), with at most about 40,000 characters of files and memories plus the guidance; the same text against the same files is answered from a cache and not asked again. |

Other stored data:

| Stored in | Field | Values | Default | Effect |
|---|---|---|---|---|
| `~/.omp-webui/model-guidance.json` | templates | list of `{ id, name, text, builtin? }`; name up to 60 chars, text up to 4,000 chars; at most 50 templates | the two shipped templates | The template set. An unreadable file is kept aside as `model-guidance.json.damaged` and the shipped templates stand in. Moves with Move to another computer. |
| beside the conversation's settings overlay | `<…>.guidance.md` | text up to 4,000 chars | none | What one conversation carries; read by the extension at each turn. |
| `~/.omp-webui/model-guidance-sessions.json` | per conversation | template id and/or text | none | Which guidance each conversation is set to, so it is carried again when the conversation is reopened. |
| the conversation's session file (omp's) | entries of custom type `ompw-guidance` | `custom` entry `{ text }` (a first turn) or the delivered note, a `custom_message` with `details: { text }` | none | What each branch of the conversation was last told, compared at each turn to decide whether a note is due. Written by the extension through omp; never edited by the server. |

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/model-guidance` | GET, POST | token (POST: this computer or a verified Access sign-in) | GET: `{ templates, rev }`. POST `{ template }` saves (creates or replaces) a template, `{ template, update: true }` saves into an existing one (422 `gone` if it was deleted), `{ remove: <id> }` deletes one. Problems answer 422 with `problem` (`nameEmpty`, `nameTooLong`, `nameRepeated`, `textEmpty`, `textTooLong`, `tooMany`, `gone`, `unknown`). Running conversations using a template pick up the change from their next turn. |
| `/api/model-guidance/restore` | POST | token (this computer or a verified Access sign-in) | Restore the shipped templates. |
| `/api/model-guidance/session` | GET | token | Query `live` (process id) or `file` (session file): what the conversation carries (`guidance`: template, templateName, text, live, skipped), the templates, and how many other conversations use each template (`others`). |
| `/api/model-guidance/live` | POST | token (this computer or a verified Access sign-in) | Body `{ liveId \| file, guidance }`: change one conversation's guidance (`guidance` `{ template?, text? }`, or null for none). A running process gets it from its next turn; a conversation with no process keeps it for its next opening. |
| `/api/model-guidance/conflicts` | POST | token (this computer only) | Body `{ liveId \| file, text }`: check `text` against the conversation folder's context files and the project's memories. Answers `{ state }`: `off`, `empty`, `nothing` (no file or memory to compare), `clear`, `found` (with `conflicts`: `{ guidance, source, other, why, change }`, `change` `{ target: "guidance" \| "file" \| "memory", … diff }` or null), or `failed` (`reason`: `noModel`, `timeout`, `model`, `malformed`, `folder`), plus `sources`, `model` and `cached`. Writes nothing; changes are applied by the page through `/api/model-guidance/live`, `/api/folder/file` and `/api/memory/retire`. |

## Limits and caveats

- Text: at most 4,000 characters per conversation or template (the system prompt is paid for on every turn); template names at most 60 characters; at most 50 templates.
- Only the main agent is told; subagents never see the guidance. It is advice to the model, not an enforced limit.
- Conflict check limits: 12,000 characters per file and 30,000 for all files, 40 memories (600 characters each, 8,000 in all), at most 8 conflicts per answer, 60 seconds per check. Longer files are read in part and a change to them is never proposed. A proposal is offered only if the text it replaces occurs exactly once in what it changes; otherwise the conflict is shown with no change to apply.
- Guidance is not available in a conversation started with `--trusted-extension`.

## Security notes

- Every change (templates, restore, a conversation's guidance, custom text sent with a new chat) is for a page on this computer or a page signed in through Cloudflare Access with the person's account (an Access sign-in counts as the person), because the text goes into the system prompt of every conversation that uses it. A page that holds only the access token (one on the network, or any page with authentication off) is refused (403): it can read the templates and name a template for a new chat, but cannot send custom guidance text ("Guidance is changed on the computer omp-webui runs on, or from a page signed in through Cloudflare Access").
- The conflict check is for this computer only, also for a page signed in through Access: it reads the folder's instruction files and omp's memories, which are this computer's alone (`/api/memory*` is local-only), and its proposals are applied through them. It writes nothing by itself: each proposed change is applied only when the user presses Apply, through the same routes and rules as any other change (a file through the Files tab's save with its etag, a memory through the Memory page's retire). The model sees the files and memories as data in a request of its own, with no tools.
- Agents must not create or edit templates, or change the default, on the user's behalf unless asked.
