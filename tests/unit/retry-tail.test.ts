import { expect, test } from "bun:test";
import type { SessionEntry } from "../../shared/protocol.ts";
import { toolResultsById } from "../../web/src/lib/messages.ts";
import { interruptedTail, retryableTail } from "../../web/src/lib/retry.ts";

/** `/retry` redoes the last failed turn, so the Retry button belongs to the failed message that ends the conversation. */

let n = 0;
const msg = (message: Record<string, unknown>): SessionEntry => ({
	type: "message",
	id: `e${++n}`,
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	message,
});
const prompt = () => msg({ role: "user", content: [{ type: "text", text: "go" }], attribution: "user" });
const assistant = (stopReason: string) => msg({ role: "assistant", content: [], stopReason, errorMessage: "boom" });

test("a failed or interrupted assistant message at the very end can be retried", () => {
	const error = assistant("error");
	expect(retryableTail([prompt(), error])).toBe(error.id);
	const aborted = assistant("aborted");
	expect(retryableTail([prompt(), aborted])).toBe(aborted.id);
});

test("a message that went well, or one that something followed, cannot", () => {
	expect(retryableTail([prompt(), assistant("stop")])).toBeNull();
	expect(retryableTail([prompt(), assistant("error"), prompt()])).toBeNull();
	// The user ran a command afterwards: omp then has nothing to retry.
	expect(retryableTail([prompt(), assistant("error"), msg({ role: "bashExecution", command: "ls" })])).toBeNull();
	expect(retryableTail([])).toBeNull();
});

test("entries that are not messages, and the placeholder results omp adds for unrun tools, do not count", () => {
	const error = assistant("error");
	const synthetic = msg({ role: "toolResult", isError: true, details: { __synthetic: true } });
	const note: SessionEntry = { type: "model_change", id: "m", parentId: null, timestamp: "", model: "x" };
	expect(retryableTail([prompt(), error, synthetic, note])).toBe(error.id);
	// A real tool result belongs to a turn that went on.
	const real = msg({ role: "toolResult", isError: false, details: {} });
	expect(retryableTail([prompt(), error, real])).toBeNull();
});

/** An assistant step that calls the tools `ids`, as omp saves it before they run. */
const calling = (...ids: string[]) =>
	msg({
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall", id, name: "bash", arguments: { command: "make" } })),
		stopReason: "toolUse",
	});
const answered = (id: string) =>
	msg({ role: "toolResult", toolCallId: id, toolName: "bash", content: [], isError: false });

/** `/retry` says "Nothing to retry." to a conversation that ends in tool calls nobody answered (omp 18.12): Continue is what is offered there. */
test("a conversation that ends in a tool call nobody answered can be continued", () => {
	const step = calling("t1");
	const path = [prompt(), step];
	expect(interruptedTail(path, toolResultsById(path))).toBe(step.id);
	expect(retryableTail(path)).toBeNull();
	// One call of two answered: the other still has none.
	const two = calling("a", "b");
	const half = [prompt(), two, answered("a")];
	expect(interruptedTail(half, toolResultsById(half))).toBe(two.id);
});

test("not when every call was answered, when something followed, or when the step failed (that has Retry)", () => {
	const step = calling("t1");
	const done = [prompt(), step, answered("t1")];
	expect(interruptedTail(done, toolResultsById(done))).toBeNull();
	const went = [prompt(), step, prompt()];
	expect(interruptedTail(went, toolResultsById(went))).toBeNull();
	const failed = [
		prompt(),
		msg({ role: "assistant", content: [{ type: "toolCall", id: "x", name: "bash" }], stopReason: "aborted" }),
	];
	expect(interruptedTail(failed, toolResultsById(failed))).toBeNull();
	expect(interruptedTail([], toolResultsById([]))).toBeNull();
});

/** A call the attached process runs is not one nobody answered: it is shown as running, with no Continue (#602). */
test("a call the live process executes is not interrupted, however briefly it is not streaming", () => {
	const step = calling("t1", "t2");
	const path = [prompt(), step, answered("t1")];
	const exec = (toolCallId: string, done: boolean) => ({ toolCallId, toolName: "bash", args: {}, done, startedAt: 0 });
	expect(interruptedTail(path, toolResultsById(path))).toBe(step.id);
	expect(interruptedTail(path, toolResultsById(path), { t2: exec("t2", false) })).toBeNull();
	// One finished that the file does not hold yet is just as answered.
	expect(interruptedTail(path, toolResultsById(path), { t2: exec("t2", true) })).toBeNull();
	// An execution of some other call does not cover it.
	expect(interruptedTail(path, toolResultsById(path), { zz: exec("zz", false) })).toBe(step.id);
});
