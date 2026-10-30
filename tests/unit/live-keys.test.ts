import "./browser-globals.ts";
import { expect, test } from "bun:test";
import { LiveKeys } from "../../web/src/lib/live-keys.ts";
import type { AgentMessage } from "../../web/src/lib/messages.ts";
import type { OverlayMessage } from "../../web/src/store/live.ts";
import { assistant, user } from "../support/session-entries.ts";

/**
 * The row that streams a message and the row of the entry omp saves for it are one message to the reader: the saved row
 * takes over the streamed row's key (omp keeps the `timestamp` the message streamed with), so its DOM is not rebuilt.
 */

const streamed = (messageId: string, timestamp: number | undefined, ended = false): OverlayMessage => {
	const message: AgentMessage = { role: "assistant", content: [], timestamp };
	return { messageId, message, ended };
};

test("a saved entry takes the key of the streamed message it replaces, and others keep their id", () => {
	const keys = new LiveKeys();
	const saved = assistant("a1", "u1", 5, { text: "answer" });
	// Before it is saved, or when nothing streamed it: its own id.
	expect(keys.entry(saved)).toBe("a1");
	const stamp = Date.UTC(2026, 0, 20, 10, 0, 5);
	keys.note([streamed("m-1", stamp)]);
	expect(keys.entry(saved)).toBe(keys.overlay(streamed("m-1", stamp)));
	expect(keys.entry(saved)).not.toBe("a1");
	// Another message of another time is not matched, nor is a prompt of the same time, nor a streamed message without a timestamp.
	expect(keys.entry(assistant("a2", "a1", 9, { text: "later" }))).toBe("a2");
	expect(keys.entry(user("u2", "a1", 5, "same second"))).toBe("u2");
	keys.note([streamed("m-2", undefined)]);
	expect(keys.entry(assistant("a3", "a2", 11, {}))).toBe("a3");
});

test("the claim outlives the streamed message: the overlay is gone when the saved row is drawn", () => {
	const keys = new LiveKeys();
	const stamp = Date.UTC(2026, 0, 20, 10, 0, 7);
	keys.note([streamed("m-7", stamp, false)]);
	keys.note([streamed("m-7", stamp, true)]);
	keys.note([]);
	expect(keys.entry(assistant("a7", "u1", 7, {}))).toBe("live:m-7");
});

test("a message streamed again under a new id is drawn under the new one", () => {
	const keys = new LiveKeys();
	const stamp = Date.UTC(2026, 0, 20, 10, 0, 3);
	keys.note([streamed("m-old", stamp)]);
	keys.note([streamed("m-new", stamp)]);
	expect(keys.entry(assistant("a3", "u1", 3, {}))).toBe("live:m-new");
});
