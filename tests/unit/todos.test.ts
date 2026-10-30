import { expect, test } from "bun:test";
import { summarizeTodos, withKeys } from "../../web/src/lib/todos.ts";

/** The todo list summed up as the TUI's TODO panel does: done/total, the task in progress, blocked tasks. */

const phases = [
	{
		name: "Research",
		tasks: [
			{ content: "Read the docs", status: "completed" },
			{ content: "Try the API", status: "abandoned" },
		],
	},
	{ name: "Empty", tasks: [] },
	{
		name: "Build",
		tasks: [
			{ content: "Write the parser", status: "pending" },
			{ content: "Wire the strip", status: "in_progress" },
			{ content: "Deploy", status: "blocked", blocker: "waiting for the credentials" },
		],
	},
];

test("completed and abandoned tasks are done; blocked ones are counted; empty phases are dropped", () => {
	const s = summarizeTodos(phases);
	expect(s.total).toBe(5);
	expect(s.done).toBe(2);
	expect(s.blocked).toBe(1);
	expect(s.phases.map((p) => [p.name, p.done, p.tasks.length])).toEqual([
		["Research", 2, 2],
		["Build", 0, 3],
	]);
});

test("the current task is the first one in progress, else the first pending, as in the TUI", () => {
	expect(summarizeTodos(phases).current).toEqual({
		phase: "Build",
		task: { content: "Wire the strip", status: "in_progress" },
	});
	const pendingOnly = summarizeTodos([
		{
			name: "P",
			tasks: [
				{ content: "done", status: "completed" },
				{ content: "next", status: "pending" },
				{ content: "later", status: "pending" },
			],
		},
	]);
	expect(pendingOnly.current?.task.content).toBe("next");
	// An in-progress task wins over an earlier pending one, wherever it is.
	expect(summarizeTodos(phases.slice().reverse()).current?.task.content).toBe("Wire the strip");
});

test("a list with only blocked and finished tasks has no current task, but names the blocked one", () => {
	const s = summarizeTodos([
		{
			name: "P",
			tasks: [
				{ content: "done", status: "completed" },
				{ content: "stuck", status: "blocked", blocker: "needs review" },
			],
		},
	]);
	expect(s.current).toBeNull();
	expect(s.firstBlocked).toEqual({
		phase: "P",
		task: { content: "stuck", status: "blocked", blocker: "needs review" },
	});
});

test("no list, or only empty phases, is nothing", () => {
	for (const input of [undefined, [], [{ name: "x", tasks: [] }]]) {
		const s = summarizeTodos(input);
		expect(s.total).toBe(0);
		expect(s.current).toBeNull();
	}
});

test("rows that repeat get distinct keys, and the same key again on the next render", () => {
	const rows = ["a", "b", "a", "a"];
	const first = withKeys(rows, (r) => r).map((r) => r.key);
	expect(new Set(first).size).toBe(4);
	expect(withKeys(rows, (r) => r).map((r) => r.key)).toEqual(first);
});
