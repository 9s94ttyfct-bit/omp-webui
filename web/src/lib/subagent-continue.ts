import { type AgentRow, parentId } from "./subagents.ts";

/**
 * The `agent://` address of a subagent, its id percent-encoded. omp's id is the name the model gave the subagent, raw:
 * `fix src/main.ts` is an ordinary one, and a `/` in an address is a JSON-path suffix that omp's `write` refuses
 * ("agent:// message target cannot have a JSON-path suffix"). Encoded, no character of a name can be read as part of
 * the address or of the sentence it stands in.
 */
export function agentUri(id: string): string {
	return `agent://${encodeURIComponent(id)}`;
}

/**
 * What the main agent is told when a subagent that waits to retry is stopped so that it retries now. omp has no command
 * that ends one subagent's wait and retries it (`abort_retry` and `/retry` are the main session's; a message steered at
 * the subagent is read when its wait ends): what it does have is that a stopped subagent is parked, not gone, and the
 * agent that started it brings it back with `write agent://<id>`, which runs it again from its transcript. A host cannot
 * make that write itself, so the agent is asked to (tests/contract/subagent-revive.test.ts runs this very text).
 *
 * This is a message the main agent reads as the user's own, and a subagent's name is chosen by a model (and can come from
 * a file it read): the name is therefore never put in the text as a word. Only its percent-encoded address is, to be
 * copied as it stands.
 */
export function continuePrompt(id: string): string {
	return `A subagent was waiting to retry a request that a usage limit refused. I stopped it from the web UI so that it retries now. Continue it where it stopped: call the write tool with the path ${agentUri(id)} and a short message such as "Carry on where you stopped." Copy the path exactly as written: it is percent-encoded on purpose, so do not decode or change it. Do not start a new subagent for it.`;
}

/**
 * Whether the conversation's own agent started this subagent, not another subagent: only that agent can be asked to bring
 * it back. omp ids are the names models give, and a name can hold a dot (`api.v2 audit`), so a dot does not say a
 * subagent is nested: it is when the part before its last dot is another subagent of the conversation (`Features` for
 * `Features.QuotaPill`).
 */
export function startedByMainAgent(rows: AgentRow[], row: AgentRow): boolean {
	const parent = parentId(row.id);
	return parent === null || !rows.some((r) => r.id === parent);
}
