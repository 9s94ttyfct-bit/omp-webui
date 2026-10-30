import { expect, test } from "bun:test";
import {
	addPhase,
	addTask,
	movePhase,
	moveTask,
	phaseIs,
	removePhase,
	removeTask,
	renamePhase,
	setContent,
	setStatus,
	taskIs,
	todosToMarkdown,
	toggledStatus,
} from "../../web/src/lib/todo-edit.ts";

/**
 * Editing omp's todo list: the edits are copies of the list omp reported, written as the Markdown checklist omp's
 * `/todo import` reads (`# phase` / `- [ ] task`; a blocked task's reason in a trailing comment).
 */

const list = () => [
	{
		name: "Research",
		tasks: [
			{ content: "Read the docs", status: "completed" },
			{ content: "Try the API", status: "abandoned" },
		],
	},
	{
		name: "Build",
		tasks: [
			{ content: "Write the parser", status: "in_progress" },
			{ content: "Wire the strip", status: "pending" },
			{ content: "Deploy", status: "blocked", blocker: "waiting for the credentials" },
		],
	},
];

test("the Markdown has omp's markers for every state, and the reason only on a blocked task", () => {
	expect(todosToMarkdown(list())).toBe(
		[
			"# Research",
			"- [x] Read the docs",
			"- [-] Try the API",
			"",
			"# Build",
			"- [/] Write the parser",
			"- [ ] Wire the strip",
			"- [!] Deploy <!-- blocker: waiting for the credentials -->",
			"",
		].join("\n"),
	);
	// A reason left on a task that is no longer blocked is not written.
	expect(todosToMarkdown([{ name: "A", tasks: [{ content: "x", status: "pending", blocker: "old" }] }])).toBe(
		"# A\n- [ ] x\n",
	);
});

test("no list is no text: omp's own `# Todos` would be a phase", () => {
	expect(todosToMarkdown([])).toBe("");
});

test("text is one line and cannot carry the comment delimiters of a reason", () => {
	const md = todosToMarkdown([
		{ name: "Two\nlines", tasks: [{ content: "a  b\n--> c <!-- d", status: "blocked", blocker: "x\n-->y" }] },
	]);
	expect(md).toBe("# Two lines\n- [!] a b c d <!-- blocker: x y -->\n");
});

test("a state omp does not know is written as pending", () => {
	expect(todosToMarkdown([{ name: "A", tasks: [{ content: "x", status: "someday" }] }])).toBe("# A\n- [ ] x\n");
});

test("edits return a changed copy and leave the list omp reported alone", () => {
	const before = list();
	const after = setStatus(before, 1, 1, "completed");
	expect(after[1].tasks[1].status).toBe("completed");
	expect(before[1].tasks[1].status).toBe("pending");
	expect(after[0]).not.toBe(before[0]);
});

test("a state change keeps a reason only for a blocked task, and trims it", () => {
	expect(setStatus(list(), 1, 1, "blocked", "  waiting \n on it ")[1].tasks[1]).toEqual({
		content: "Wire the strip",
		status: "blocked",
		blocker: "waiting on it",
	});
	expect(setStatus(list(), 1, 2, "pending")[1].tasks[2]).toEqual({ content: "Deploy", status: "pending" });
	// Blocked with no reason is blocked all the same.
	expect(setStatus(list(), 1, 1, "blocked", " ")[1].tasks[1]).toEqual({ content: "Wire the strip", status: "blocked" });
});

test("a click on the state icon finishes a task, or takes a finished or abandoned one up again", () => {
	expect(toggledStatus("pending")).toBe("completed");
	expect(toggledStatus("in_progress")).toBe("completed");
	expect(toggledStatus("blocked")).toBe("completed");
	expect(toggledStatus("completed")).toBe("pending");
	expect(toggledStatus("abandoned")).toBe("pending");
});

test("text and names are trimmed to one line and cannot be empty", () => {
	expect(setContent(list(), 0, 0, "  New\ttext ")[0].tasks[0].content).toBe("New text");
	expect(() => setContent(list(), 0, 0, "  ")).toThrow();
	expect(renamePhase(list(), 1, " Ship it ")[1].name).toBe("Ship it");
	expect(() => renamePhase(list(), 1, "")).toThrow();
	expect(() => addTask(list(), 0, "\n")).toThrow();
	expect(() => addPhase(list(), " ")).toThrow();
});

test("a task is added at the end of its phase, and a first one starts omp's default phase", () => {
	expect(addTask(list(), 0, "Summarise")[0].tasks.map((t) => t.content)).toEqual([
		"Read the docs",
		"Try the API",
		"Summarise",
	]);
	expect(addTask([], 0, "First")).toEqual([{ name: "Todos", tasks: [{ content: "First", status: "pending" }] }]);
	expect(addPhase(list(), "Ship").map((p) => p.name)).toEqual(["Research", "Build", "Ship"]);
	expect(addPhase(list(), "Ship")[2].tasks).toEqual([]);
});

test("removing and moving tasks and phases; the ends stay put", () => {
	expect(removeTask(list(), 1, 0)[1].tasks.map((t) => t.content)).toEqual(["Wire the strip", "Deploy"]);
	expect(removePhase(list(), 0).map((p) => p.name)).toEqual(["Build"]);
	expect(moveTask(list(), 1, 2, -1)[1].tasks.map((t) => t.content)).toEqual([
		"Write the parser",
		"Deploy",
		"Wire the strip",
	]);
	expect(moveTask(list(), 1, 0, -1)).toEqual(list());
	expect(moveTask(list(), 1, 2, 1)).toEqual(list());
	expect(movePhase(list(), 1, -1).map((p) => p.name)).toEqual(["Build", "Research"]);
	expect(movePhase(list(), 0, -1)).toEqual(list());
	expect(() => removeTask(list(), 5, 0)).toThrow();
	expect(() => setStatus(list(), 0, 9, "pending")).toThrow();
});

test("an edit is for the task or phase it was opened on: a list that moved on no longer matches", () => {
	expect(taskIs(list(), 1, 2, "Deploy")).toBe(true);
	expect(taskIs(list(), 1, 2, "Wire the strip")).toBe(false);
	expect(taskIs(list(), 3, 0, "Deploy")).toBe(false);
	expect(phaseIs(list(), 1, "Build")).toBe(true);
	expect(phaseIs(list(), 1, "Research")).toBe(false);
});
