import { Chain, type Entry, writeRenderSession } from "./render-fixtures.ts";

/**
 * One conversation that has every text-only button of the transcript on it (no model call): a task card with its
 * "View subagents" link, an edit whose diff is longer than the diff view shows at first ("Show all lines") with the
 * card's raw-arguments toggle, a bash result longer than the card shows at first ("Show all characters"), and an advisor
 * card with more notes than it lists ("+N more"). The target-size spec opens it by its prompt.
 */

export const TARGETS_PROMPT = "Target probe: a task card, a long diff, a long result and advisor notes";

/** Longer than the diff view's cap of 300 rows. */
const DIFF_ROWS = 320;
const DIFF = Array.from({ length: DIFF_ROWS }, (_, i) => `+${i + 1}|\tconst row${i + 1} = ${i + 1};`).join("\n");

/** Writes the conversation into `agentDir`'s fixture project; returns the file. */
export function writeTargetsSession(agentDir: string): string {
	const c = new Chain("tg01");
	c.user(TARGETS_PROMPT);
	c.assistant([
		{
			type: "toolCall",
			id: "toolu_g1",
			name: "task",
			arguments: { tasks: [{ id: "Scout", assignment: "Look around the project" }] },
		},
	]);
	c.toolResult("toolu_g1", "task", [{ type: "text", text: "The scout is done." }]);
	c.assistant([
		{
			type: "toolCall",
			id: "toolu_g2",
			name: "edit",
			arguments: { i: "Adding rows", input: "[src/rows.ts#1234]\nPUT 1:\n+const row1 = 1;" },
		},
	]);
	const at = Date.UTC(2026, 0, 9, 10, 30);
	const diffResult: Entry = {
		id: "tg01e001",
		parentId: c.lastId,
		timestamp: new Date(at).toISOString(),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "toolu_g2",
			toolName: "edit",
			content: [{ type: "text", text: "[src/rows.ts#1234]\n1:\tconst row1 = 1;" }],
			details: { diff: DIFF, firstChangedLine: 1, op: "update", path: "/tmp/ompw-fixture-project/src/rows.ts" },
			isError: false,
			timestamp: at,
		},
	};
	c.entries.push(diffResult);
	c.assistant([{ type: "toolCall", id: "toolu_g3", name: "bash", arguments: { command: "seq 1 2000" } }]);
	c.toolResult("toolu_g3", "bash", [{ type: "text", text: Array.from({ length: 2000 }, (_, i) => i + 1).join("\n") }]);
	c.custom(
		"advisor",
		'<advisory severity="concern" guidance="weigh, don\'t blindly obey">\nTARGET-NOTE-1\n</advisory>',
		{
			notes: Array.from({ length: 5 }, (_, i) => ({
				note: `TARGET-NOTE-${i + 1}`,
				severity: "concern",
				turn: 3,
				turnsAgo: 0,
			})),
		},
	);
	c.assistant([{ type: "text", text: "TARGET-FINAL: done." }]);
	return writeRenderSession(agentDir, "01a00000-0000-7000-8000-00000000a124", c.entries);
}
