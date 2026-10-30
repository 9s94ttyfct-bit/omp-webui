import "./browser-globals.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { AgentTurnBlock } from "../../web/src/components/AgentTurn.tsx";
import { ToolCard } from "../../web/src/components/ToolCard.tsx";
import type { ToolExec } from "../../web/src/store/live.ts";
import { assistant, result, user } from "../support/session-entries.ts";
import { conversationOf, draw, lastTurn } from "../support/turn-render.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * What a tool card shows: the assignments of a `task` call once, not again as the JSON they came in; a call that
 * nobody will answer (its conversation is over) as one that has no result, not as one still running.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const TASKS = {
	context: "Shared contract: keep the signature.",
	tasks: [
		{ name: "Outdated", agent: "explore", task: "List the outdated dependencies." },
		{ name: "Unused", task: "Find the unused exports." },
	],
};

/** A call whose tool runs, so that its card is open. */
const RUNNING: ToolExec = { toolCallId: "call", toolName: "task", args: TASKS, done: false, startedAt: 1 };

describe("a task card", () => {
	test("shows each assignment once: the raw arguments are behind the toggle, the output is not", () => {
		const html = draw(
			createElement(ToolCard, {
				id: "call",
				name: "task",
				args: TASKS,
				exec: { ...RUNNING, partial: { content: [{ type: "text", text: "2 agents running" }] } },
			}),
		);
		expect(html).toContain('data-testid="task-assignments"');
		expect(html).toContain("Outdated");
		// The same ids and texts again, as JSON, are what this was about.
		expect(html).not.toContain("&quot;tasks&quot;");
		expect(html).not.toContain("&quot;assignment&quot;");
		expect(html).toContain('data-testid="tool-raw-toggle"');
		expect(html).toContain("Show raw arguments");
		expect(html).toContain("2 agents running");
	});

	test("without assignments to show (nothing arrived yet) the arguments are all there is, and they show", () => {
		const html = draw(
			createElement(ToolCard, {
				id: "call-empty",
				name: "task",
				args: { tasks: [] },
				exec: { ...RUNNING, toolCallId: "call-empty", args: { tasks: [] } },
			}),
		);
		expect(html).not.toContain('data-testid="task-assignments"');
		expect(html).toContain("Arguments");
		expect(html).toContain("&quot;tasks&quot;");
		expect(html).not.toContain('data-testid="tool-raw-toggle"');
	});

	test("another tool's card still shows its arguments plainly", () => {
		const html = draw(
			createElement(ToolCard, {
				id: "bash-1",
				name: "bash",
				args: { command: "make all" },
				exec: { ...RUNNING, toolCallId: "bash-1", toolName: "bash", args: { command: "make all" } },
			}),
		);
		expect(html).toContain("Arguments");
		expect(html).not.toContain('data-testid="tool-raw-toggle"');
	});
});

/** The spinner of a running call (`Spinner` in `ui.tsx`). */
const SPINNING = "animate-spin";
const INTERRUPTED = 'data-testid="tool-interrupted"';

describe("a tool call nobody answered", () => {
	const card = (props: { idle?: boolean; withResult?: boolean; exec?: ToolExec }) =>
		draw(
			createElement(ToolCard, {
				id: "bash-1",
				name: "bash",
				args: { command: "make all" },
				idle: props.idle,
				exec: props.exec,
				result: props.withResult
					? { role: "toolResult", toolCallId: "bash-1", content: [{ type: "text", text: "done" }] }
					: undefined,
			}),
		);

	test("is about to start while something may still run: the running spinner", () => {
		const html = card({});
		expect(html).toContain(SPINNING);
		expect(html).not.toContain(INTERRUPTED);
	});

	test("reads as having no result once nothing is running: no spinner, a marker that says so", () => {
		const html = card({ idle: true });
		expect(html).not.toContain(SPINNING);
		expect(html).toContain(INTERRUPTED);
		expect(html).toContain("No result");
		expect(html).toContain("interrupted");
	});

	test("is not interrupted when it has a result, or a live record of its own", () => {
		const done = card({ idle: true, withResult: true });
		expect(done).not.toContain(INTERRUPTED);
		expect(done).not.toContain(SPINNING);
		const running = card({
			idle: true,
			exec: { toolCallId: "bash-1", toolName: "bash", args: {}, done: false, startedAt: 1 },
		});
		expect(running).toContain(SPINNING);
		expect(running).not.toContain(INTERRUPTED);
	});

	/** A prompt, a step that calls `t1` (nothing ever answered it), then what follows. */
	function conversation(follows: "nothing" | "next step") {
		const entries = [
			user("u1", null, 1, "Run it"),
			assistant("a1", "u1", 2, { text: "Running.", calls: { t1: "bash" } }),
		];
		if (follows === "next step") {
			entries.push(assistant("a2", "a1", 3, { text: "On to the next.", calls: { t2: "bash" } }));
			entries.push(result("r2", "a2", 4, "t2", "ok 2"));
		}
		return conversationOf(entries);
	}
	const turn = (follows: "nothing" | "next step", live: boolean) => {
		const { fam, segments } = conversation(follows);
		return draw(
			createElement(AgentTurnBlock, {
				turn: lastTurn(segments),
				toolResults: fam.toolResults,
				tools: {},
				actions: {},
				live,
			}),
		);
	};

	test("in a saved conversation that nothing runs: the conversation's end is interrupted, not spinning", () => {
		const html = turn("nothing", false);
		expect(html).toContain(INTERRUPTED);
		expect(html).not.toContain(SPINNING);
	});

	test("in a conversation that is streaming, the step it is on is waiting for its tool", () => {
		const html = turn("nothing", true);
		expect(html).toContain(SPINNING);
		expect(html).not.toContain(INTERRUPTED);
	});

	test("a step that a later step followed was abandoned even while the conversation streams", () => {
		const html = turn("next step", true);
		// a1's call has no result and a2 came after it; a2's call has one.
		expect(html.split(INTERRUPTED)).toHaveLength(2);
		expect(html).not.toContain(SPINNING);
	});
});

describe("a call in a paused conversation (#602)", () => {
	const args = { command: "make -j8 all" };

	test("one the page never saw start shows its arguments and that it is paused, not a bare spinner", () => {
		const frozen = draw(createElement(ToolCard, { id: "p1", name: "bash", args, paused: true }));
		expect(frozen).toContain('data-testid="tool-paused"');
		expect(frozen).toContain("make -j8 all");
		expect(frozen).toContain("Arguments");
		expect(frozen).not.toContain('data-testid="tool-interrupted"');
		// Not paused, it is a call about to start: folded, with a spinner.
		const waiting = draw(createElement(ToolCard, { id: "p2", name: "bash", args }));
		expect(waiting).not.toContain('data-testid="tool-paused"');
		expect(waiting).not.toContain("Arguments");
	});

	test("one the page saw running shows what it printed so far, frozen", () => {
		const exec: ToolExec = {
			toolCallId: "p3",
			toolName: "bash",
			args,
			done: false,
			startedAt: 1,
			partial: { content: [{ type: "text", text: "compiling 41 of 90" }] },
		};
		const html = draw(createElement(ToolCard, { id: "p3", name: "bash", args, exec, paused: true }));
		expect(html).toContain('data-testid="tool-paused"');
		expect(html).toContain("compiling 41 of 90");
	});

	test("a call with a result, or one nothing will answer, is as it was", () => {
		const html = draw(createElement(ToolCard, { id: "p4", name: "bash", args, paused: true, idle: true }));
		expect(html).not.toContain('data-testid="tool-paused"');
		expect(html).toContain('data-testid="tool-interrupted"');
	});
});
