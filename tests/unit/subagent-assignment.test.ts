import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "../../shared/protocol.ts";
import {
	assignmentOfInit,
	assignmentOfRow,
	contextOfSystemPrompt,
	taskItemsOf,
	taskOfPrompt,
} from "../../web/src/lib/subagent-assignment.ts";
import { type AgentRow, agentRows } from "../../web/src/lib/subagents.ts";
import type { SubagentState } from "../../web/src/store/live.ts";

/**
 * What a subagent was told. omp gives it the task as its first user message (`Complete assignment thoroughly:` and the
 * task) and the shared context in its system prompt (the `§ Context` section of the subagent template). Both are in
 * the `session_init` record at the head of its transcript, as omp wrote them; the task call's own arguments hold the
 * same text before and after the subagent exists.
 */

/** The block omp appends to a subagent's system prompt, rendered from `subagent-system-prompt.md`. */
function subagentBlock(context: string | undefined, plan?: string): string {
	return [
		"§ Role\nWorker agent: delegated tasks.\n\n<directives>\n- MUST finish assigned work only.\n</directives>\n",
		context === undefined ? "" : `§ Context\n${context}\n`,
		plan === undefined
			? ""
			: `§ Plan\nThis session is executing an approved plan. Your assignment above is one part of it.\n\n<plan path="local://PLAN.md">\n${plan}\n</plan>\n`,
		"§ Coop\nYou are operating on a piece of work assigned to you by the main agent.\n",
		"§ Completion\nCall yield when done.\n",
	].join("\n");
}

const init = (extra: Record<string, unknown>, id = "i1", parentId: string | null = null): SessionEntry => ({
	type: "session_init",
	id,
	parentId,
	timestamp: "2026-01-07T01:00:00.000Z",
	tools: ["read"],
	...extra,
});

const message = (id: string, parentId: string | null): SessionEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-01-07T01:00:00.000Z",
	message: { role: "user", content: [{ type: "text", text: "hi" }] },
});

describe("the task in the first prompt", () => {
	test("is what follows omp's lead line", () => {
		expect(taskOfPrompt("Complete assignment thoroughly:\n\n# Target\nsrc/a.ts")).toBe("# Target\nsrc/a.ts");
	});

	test("is the whole prompt when it does not begin with the lead", () => {
		expect(taskOfPrompt("Do the thing")).toBe("Do the thing");
		expect(taskOfPrompt("")).toBe("");
	});
});

describe("the shared context in the system prompt", () => {
	test("is the text of the `§ Context` section, up to the next section", () => {
		const blocks = [
			"RFC 2119 keywords",
			"<project-context></project-context>",
			subagentBlock("# Goal\nFix it.\n\n# Contract\n- a\n- b"),
		];
		expect(contextOfSystemPrompt(blocks)).toBe("# Goal\nFix it.\n\n# Contract\n- a\n- b");
	});

	test("is found in a prompt that omp stored as one string", () => {
		expect(contextOfSystemPrompt(`base prompt\n\n${subagentBlock("Shared goal")}`)).toBe("Shared goal");
	});

	test("ends where the plan begins, when the subagent runs a plan", () => {
		expect(contextOfSystemPrompt([subagentBlock("Shared goal", "1. step\n2. step")])).toBe("Shared goal");
	});

	test("keeps a line of the context that looks like a section of the template", () => {
		const context = "Notes on prompts:\n§ Coop\nsome text about coop\n\n§ Plan\nmore";
		expect(contextOfSystemPrompt([subagentBlock(context)])).toBe(context);
	});

	test("is nothing when the subagent was given none, or the prompt is not omp's", () => {
		expect(contextOfSystemPrompt([subagentBlock(undefined)])).toBeUndefined();
		expect(contextOfSystemPrompt(["just some text"])).toBeUndefined();
		expect(contextOfSystemPrompt(undefined)).toBeUndefined();
		expect(contextOfSystemPrompt([1, null, {}])).toBeUndefined();
	});
});

describe("the assignment in a transcript", () => {
	const record = init({
		task: "Complete assignment thoroughly:\n\n# Target\nsrc/a.ts",
		systemPrompt: ["base", subagentBlock("# Goal\nShared")],
	});

	test("is the task and the context of its first session_init", () => {
		const later = init(
			{ task: "Complete assignment thoroughly:\n\nrevived", systemPrompt: [subagentBlock("other")] },
			"i2",
			"m1",
		);
		const entries = [message("m0", null), record, message("m1", "i1"), later];
		// The first record is the one the subagent was spawned with, a revival writes another after the conversation.
		expect(assignmentOfInit([record, message("m1", "i1"), later])).toEqual({
			task: "# Target\nsrc/a.ts",
			context: "# Goal\nShared",
		});
		// A message before any record means there is none to find, as in a transcript omp never initialised.
		expect(assignmentOfInit(entries)).toBeUndefined();
	});

	test("has no context when its system prompt carries none", () => {
		const bare = init({
			task: "Complete assignment thoroughly:\n\nOnly a task",
			systemPrompt: [subagentBlock(undefined)],
		});
		expect(assignmentOfInit([bare])).toEqual({ task: "Only a task", context: undefined });
	});

	test("is none for a transcript without a task, or without a session_init", () => {
		expect(assignmentOfInit([])).toBeUndefined();
		expect(assignmentOfInit([init({ systemPrompt: [] })])).toBeUndefined();
		expect(assignmentOfInit([message("m0", null)])).toBeUndefined();
	});
});

describe("the assignment of a row", () => {
	const row = (live: Partial<SubagentState> | undefined): AgentRow =>
		agentRows(undefined, live ? { Scout: { id: "Scout", status: "running", updatedAt: 1, ...live } } : undefined)[0] ??
		({ id: "Scout", name: "Scout", depth: 0, status: "completed", running: false } satisfies AgentRow);

	test("comes from the transcript when it has been read, with its context", () => {
		const r = row({ assignment: "from frames" });
		expect(assignmentOfRow(r, { task: "from transcript", context: "ctx" })).toEqual({
			task: "from transcript",
			context: "ctx",
		});
	});

	test("comes from the progress frames until then, without context", () => {
		expect(
			assignmentOfRow(row({ progress: { id: "Scout", assignment: "from progress" }, assignment: "x" }), undefined),
		).toEqual({
			task: "from progress",
		});
		expect(assignmentOfRow(row({ assignment: "from lifecycle" }), undefined)).toEqual({ task: "from lifecycle" });
	});

	test("takes the task out of the rendered prompt when the frames carry only that", () => {
		expect(assignmentOfRow(row({ task: "Complete assignment thoroughly:\n\nThe work" }), undefined)).toEqual({
			task: "The work",
		});
	});

	test("is none when nothing says what the subagent was told", () => {
		expect(assignmentOfRow(row(undefined), undefined)).toBeUndefined();
		expect(assignmentOfRow(row({ assignment: "  " }), undefined)).toBeUndefined();
	});
});

describe("the subagents a task call starts", () => {
	test("are the items of its `tasks`, each with its own task and the call's shared context", () => {
		const items = taskItemsOf({
			context: "  # Goal\nShared  ",
			tasks: [
				{ name: "Alpha", agent: "explore", task: "  Look at a  " },
				{ name: "Beta", task: "Look at b" },
			],
		});
		expect(items).toEqual([
			{ name: "Alpha", agent: "explore", assignment: { task: "Look at a", context: "# Goal\nShared" } },
			{ name: "Beta", agent: undefined, assignment: { task: "Look at b", context: "# Goal\nShared" } },
		]);
	});

	test("are one subagent for a call that carries its task itself", () => {
		expect(taskItemsOf({ name: "Solo", agent: "task", task: "Do it", context: "Why" })).toEqual([
			{ name: "Solo", agent: "task", assignment: { task: "Do it", context: "Why" } },
		]);
		expect(taskItemsOf({ task: "Do it" })).toEqual([
			{ name: undefined, agent: undefined, assignment: { task: "Do it", context: undefined } },
		]);
	});

	test("read `id` and `assignment` where the item has no `name` or `task`", () => {
		expect(taskItemsOf({ context: "c", tasks: [{ id: "Old", assignment: "Old task" }] })).toEqual([
			{ name: "Old", agent: undefined, assignment: { task: "Old task", context: "c" } },
		]);
	});

	test("are named by the call's result, which has the ids omp gave them, numbered when a name was taken", () => {
		const items = taskItemsOf(
			{ context: "c", tasks: [{ task: "one" }, { name: "Given", task: "two" }, { name: "Kept", task: "three" }] },
			{ progress: [{ id: "FuzzyOtter" }, { id: "Given-2" }] },
		);
		expect(items.map((i) => i.name)).toEqual(["FuzzyOtter", "Given-2", "Kept"]);
	});

	test("show what has arrived of a call that is still being written", () => {
		expect(
			taskItemsOf({ context: "c", tasks: [{ name: "Alpha" }, { name: "Beta", task: "half a sen" }, null, 5] }),
		).toEqual([
			{ name: "Alpha", agent: undefined, assignment: { task: "", context: "c" } },
			{ name: "Beta", agent: undefined, assignment: { task: "half a sen", context: "c" } },
		]);
	});

	test("are none for arguments that name no task", () => {
		for (const args of [undefined, null, "x", 5, {}, { tasks: [] }, { tasks: "nope" }, { context: "only context" }]) {
			expect(taskItemsOf(args)).toEqual([]);
		}
	});
});
