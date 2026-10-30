import "./browser-globals.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { SessionEntry } from "../../shared/protocol.ts";
import { AgentTurnBlock } from "../../web/src/components/AgentTurn.tsx";
import type { MessageActions } from "../../web/src/components/Message.tsx";
import { assistant, result, user } from "../support/session-entries.ts";
import { conversationOf, draw, lastTurn } from "../support/turn-render.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * A finished turn folds its steps behind a summary and keeps the answer. A turn that did not end well (the model
 * failed after the tools ran, or the reader stopped it) has no answer to keep: what it ends with is the failure, and
 * the failure and its Retry must not go with the steps.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const ERROR = "429 rate_limit_error: This request would exceed your rate limit.";

/** A prompt, `steps` tool steps (the last of them with the text "Third step."), then whatever `tail` says. */
function turn(tail: SessionEntry[] | ((parent: string) => SessionEntry[]) = []) {
	const entries: SessionEntry[] = [user("u1", null, 1, "Do the work")];
	const parent = () => entries.at(-1)?.id ?? null;
	entries.push(assistant("a1", parent(), 2, { calls: { t1: "bash" } }));
	entries.push(result("r1", parent(), 3, "t1", "ok 1"));
	entries.push(assistant("a2", parent(), 4, { text: "Second step.", calls: { t2: "edit" } }));
	entries.push(result("r2", parent(), 5, "t2", "ok 2"));
	entries.push(assistant("a3", parent(), 6, { text: "Third step." }));
	entries.push(...(typeof tail === "function" ? tail(parent() ?? "") : tail));
	return entries;
}

function html(entries: SessionEntry[], actions: MessageActions = {}): string {
	const { fam, segments } = conversationOf(entries);
	return draw(
		createElement(AgentTurnBlock, {
			turn: lastTurn(segments),
			toolResults: fam.toolResults,
			tools: {},
			actions,
			live: false,
		}),
	);
}

describe("a finished turn that folds", () => {
	test("keeps only its answer, and says how many tool calls it made", () => {
		const out = html(turn());
		expect(out).toContain("Third step.");
		expect(out).not.toContain("Second step.");
		expect(out).toContain('data-testid="work-summary"');
		expect(out).toContain("2 tool calls");
		expect(out).not.toContain('data-testid="assistant-error"');
	});

	test("keeps the failure the model ended it with, and its Retry, and the summary says it failed", () => {
		const out = html(
			turn((parent) => [assistant("a4", parent, 7, { stopReason: "error", errorMessage: ERROR })]),
			{ retry: { entryId: "a4", run: () => {} } },
		);
		expect(out).toContain('data-testid="assistant-error"');
		expect(out).toContain("429 rate_limit_error");
		expect(out).toContain('data-testid="retry-button"');
		// The steps are still folded, and the summary counts what is behind it: the tool calls before the failure.
		expect(out).toContain('data-testid="work-summary"');
		expect(out).toContain("2 tool calls");
		expect(out).not.toContain("Second step.");
		expect(out).toContain('data-testid="work-ended"');
		expect(out).toContain("ended in an error");
	});

	test("keeps the 'Interrupted' row of a turn the reader stopped before its last step wrote anything", () => {
		const out = html(turn((parent) => [assistant("a4", parent, 7, { stopReason: "aborted" })]));
		expect(out).toContain('data-testid="assistant-error"');
		expect(out).toContain("Interrupted");
		expect(out).not.toContain('data-testid="retry-button"');
		expect(out).toContain('data-testid="work-ended"');
		expect(out).not.toContain("Second step.");
	});

	test("counts the steps between the answer and the failure as work, not the answer's own calls", () => {
		const out = html(
			turn((parent) => {
				const a4 = assistant("a4", parent, 7, { calls: { t4: "bash" } });
				const r4 = result("r4", "a4", 8, "t4", "ok 4");
				return [a4, r4, assistant("a5", "r4", 9, { stopReason: "error", errorMessage: ERROR })];
			}),
		);
		expect(out).toContain("3 tool calls");
		expect(out).toContain('data-testid="assistant-error"');
		expect(out).not.toContain("run t4");
	});

	test("a failure a retry got past, or that a later reply made moot, is not kept: it is not what the turn ended with", () => {
		for (const status of ["recovered", "superseded"]) {
			const out = html(
				turn((parent) => [
					assistant("a4", parent, 7, {
						stopReason: "error",
						errorMessage: ERROR,
						extra: { retryRecovery: { status } },
					}),
				]),
			);
			expect({ status, error: out.includes('data-testid="assistant-error"') }).toEqual({ status, error: false });
			expect({ status, ended: out.includes('data-testid="work-ended"') }).toEqual({ status, ended: false });
		}
	});

	test("a turn that ends in an answer with text, even a failed one, keeps that message and nothing else", () => {
		const out = html(
			turn((parent) => [
				assistant("a4", parent, 7, { text: "Half an answer", stopReason: "error", errorMessage: ERROR }),
			]),
		);
		expect(out).toContain("Half an answer");
		expect(out).toContain('data-testid="assistant-error"');
		expect(out).not.toContain("Third step.");
		expect(out).not.toContain('data-testid="work-ended"');
	});

	test("a last step with text whose tool call nobody answered is the answer: it keeps its card and its Continue", () => {
		const out = html(
			turn((parent) => [assistant("a4", parent, 7, { text: "Starting the build.", calls: { t4: "bash" } })]),
			{ resume: { entryId: "a4", run: () => {} } },
		);
		expect(out).toContain("Starting the build.");
		expect(out).toContain('data-testid="tool-interrupted"');
		expect(out).toContain('data-testid="resume-button"');
		expect(out).toContain("2 tool calls");
		expect(out).not.toContain("Third step.");
	});

	test("a tool-only last step that nobody answered is kept even though an earlier step has the text", () => {
		const out = html(turn((parent) => [assistant("a4", parent, 7, { calls: { t4: "bash" } })]));
		expect(out).toContain('data-testid="tool-interrupted"');
		expect(out).toContain("Third step.");
		expect(out).not.toContain("Second step.");
		expect(out).toContain('data-testid="work-ended"');
	});
});
