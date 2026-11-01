# Guidance that holds after it changes — design

Date: 2026-11-01. Size: a small change.

## Why

The person changes a conversation's guidance and the agent keeps working by the old rule; sometimes it follows the
guidance only after being told which one. Reproduced with a real model (Opus 5.5, isolated omp home, 8 replies per case,
`guidance-repro/` outside the repo):

| Case | Shipped | With the note |
|---|---|---|
| The person typed a rule in the chat, then changed the guidance | 2/8 | 8/8 |
| A recalled memory holds the old rule, then the guidance changed | 0/8 | 8/8 |
| A recalled memory holds an old rule, the guidance never changed | 6/8 | 8/8 with the priority sentence |
| The guidance against omp's own rule (user says "parallel", guidance says no subagents) | 8/8 | — |
| The guidance asks for an action (run a command after edits) | 8/8 | — |

Cause: omp's recalled memories reach the model as a hidden message in the conversation each turn (`memoryNotice`), the
same standing as what the person typed. The guidance lives in the system prompt and is swapped there silently; the
conversation never says it changed, so the model follows the newer-looking rule in the conversation.

## Goals

- The guidance becomes the conversation's standing work rules (language, how to commit, how to hand out work, …), not
  only subagent and model choice; it overrides recalled memories and earlier instructions in the conversation.
- A change of the guidance reaches the very next turn and is followed, and the person can see in the transcript that it
  changed.

Non-goals: editing or deleting omp's memories; sending the guidance to subagents (it stays the main agent's: the
person's choice, so delegation rules do not read as orders to a subagent).

## Approaches

1. **A note in the conversation when the guidance changes** (chosen, with 2). The guidance extension, at the start of the
   main agent's turn, compares the text with what the conversation was last given and, when it differs and the
   conversation has earlier turns, adds a message: the new text and that it replaces earlier instructions. 8/8 in every
   case above.
2. **A priority sentence in the system prompt** (chosen, with 1). The block says it is the person's current standing
   instructions for the whole conversation and replaces earlier instructions, recalled memories and earlier habits of the
   conversation. Took the never-changed-but-old-memory case from 6/8 to 8/8.
3. Clean up conflicting memories — dropped: not needed by the results, and it could delete memories the person wants.

## How

- `server/omp/guidance/extension.ts`:
  - The block: `# Standing instructions for this conversation`, the priority sentence, then the text (always; the text's
    own heading, if any, stays inside it).
  - What the conversation was last given is a custom *entry* of its session (`ompw-guidance`, `{ text }`, appended with
    `ctx.sessionManager.appendCustomEntry`; entries are not sent to the model), read from the current branch
    (`getBranch`), so a resumed conversation, a new process and a branch switch all compare with what that branch was given.
  - When the text differs from the last entry: append the entry; if the branch already has a user message, also return a
    `message` (`customType: "ompw-guidance"`, `display: true`, `details: { text }`): "The standing instructions of this
    conversation are now: … They replace any earlier instruction in this conversation, and any recalled memory, that
    disagrees with them." Guidance turned off: "The standing instructions of this conversation were removed; …".
    Wording is neutral, so a conversation from before this change gets one correct note at its first turn.
  - Subagents and title requests: unchanged (nothing).
- Web UI: the transcript shows the note as a typed note (`classifyCustom`): "Guidance changed" with the text folded
  under it, instead of the raw extension row.
- Names: Settings › Model guidance and the composer picker become **Guidance** (指引); their descriptions say it is the
  conversation's standing rules, which the main agent follows over memories and earlier instructions. Shipped templates
  are kept.
- Docs: TECHNICAL.md / zh-CN, the guidance section.

## Tests

- Contract (`tests/contract/model-guidance.test.ts`, fake provider): a change between two turns puts the note with the new
  text in the next request, once; an unchanged turn and the first turn carry none; turning it off carries the removal
  note; the system block has the priority sentence.
- The real-model check is the throwaway script, rerun once against the built extension.

## Left to the builder

Exact wording of the UI strings and the note; where the typed note's text folds.
