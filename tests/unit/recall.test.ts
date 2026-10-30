import { expect, test } from "bun:test";
import type { SessionEntry } from "../../shared/protocol.ts";
import { promptsOf, recallDown, recallUp } from "../../web/src/lib/recall.ts";

/** Up and Down in the composer walk through what was sent in the conversation, like the terminal's prompt history. */

let n = 0;
const msg = (message: Record<string, unknown>): SessionEntry => ({
	type: "message",
	id: `e${++n}`,
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	message,
});
const user = (text: string, attribution = "user") =>
	msg({ role: "user", content: [{ type: "text", text }], attribution });
const reply = (text: string) => msg({ role: "assistant", content: [{ type: "text", text }] });
const bash = (command: string) => msg({ role: "bashExecution", command, output: "" });

test("the prompts of a conversation, and the !commands run in it, in the order they were sent", () => {
	const path = [
		user("first prompt"),
		reply("answer"),
		bash("ls -la"),
		user("second prompt\nwith two lines"),
		{ type: "model_change", id: "m1", parentId: null, timestamp: "", model: "x" },
	];
	expect(promptsOf(path)).toEqual(["first prompt", "!ls -la", "second prompt\nwith two lines"]);
});

test("messages omp injected on its own and blank prompts are not the user's to recall", () => {
	const path = [user("hello"), user("a reminder from the agent", "agent"), user("   "), reply("hi")];
	expect(promptsOf(path)).toEqual(["hello"]);
});

test("the same prompt sent twice in a row is one entry", () => {
	expect(promptsOf([user("again"), reply("a"), user("again"), reply("b"), user("other"), user("again")])).toEqual([
		"again",
		"other",
		"again",
	]);
});

const history = ["one", "two", "three"];

test("Up starts at the newest prompt, remembers the draft and stops at the oldest", () => {
	const a = recallUp(history, "half typed", null);
	expect(a).toEqual({ text: "three", state: { back: 1, draft: "half typed" } });
	const b = recallUp(history, "three", a?.state ?? null);
	expect(b).toEqual({ text: "two", state: { back: 2, draft: "half typed" } });
	const c = recallUp(history, "two", b?.state ?? null);
	expect(c?.text).toBe("one");
	// Nothing older: the key is still taken, and the oldest prompt stays.
	const d = recallUp(history, "one", c?.state ?? null);
	expect(d).toEqual(c);
});

test("Down walks forward and, past the newest prompt, gives the draft back", () => {
	const a = recallDown(history, { back: 3, draft: "half typed" });
	expect(a).toEqual({ text: "two", state: { back: 2, draft: "half typed" } });
	const b = recallDown(history, a?.state ?? null);
	expect(b?.text).toBe("three");
	const c = recallDown(history, b?.state ?? null);
	expect(c).toEqual({ text: "half typed", state: null });
});

test("without a history, or when not browsing, the keys keep their ordinary job", () => {
	expect(recallUp([], "x", null)).toBeNull();
	expect(recallDown(history, null)).toBeNull();
});
