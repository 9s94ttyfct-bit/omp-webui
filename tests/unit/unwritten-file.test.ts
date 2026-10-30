import { expect, test } from "bun:test";
import type { SessionSummary } from "../../shared/protocol.ts";
import { familySignature, unwrittenOwnFile } from "../../web/src/lib/family.ts";

/**
 * omp names a new conversation's file as soon as its process starts and writes it with the first assistant message.
 * Until then `/api/family` and `/api/subagents` answer 404 for it, which is a red line in the console of every new chat
 * (#298), so the page does not ask: it waits until the session list holds the file.
 */

const file = (name: string) => `/sessions/${name}.jsonl`;
const listed = (name: string) => ({ file: file(name) }) as SessionSummary;

test("a running process's own file the session list does not hold is not asked for", () => {
	expect(unwrittenOwnFile([], true, file("new"), true)).toBe(true);
	// Other conversations in the list do not make it written.
	expect(unwrittenOwnFile([listed("a"), listed("b")], true, file("new"), true)).toBe(true);
});

test("once the list holds it, it is written", () => {
	expect(unwrittenOwnFile([listed("a"), listed("new")], true, file("new"), true)).toBe(false);
});

test("before the list has loaded nothing is known, so a running process's own file waits for it", () => {
	expect(unwrittenOwnFile([], false, file("new"), true)).toBe(true);
	expect(unwrittenOwnFile([listed("new")], false, file("new"), true)).toBe(true);
});

test("a file no process of this page runs is asked for whatever the list says: a link to a missing one shows its error", () => {
	expect(unwrittenOwnFile([], true, file("gone"), false)).toBe(false);
	expect(unwrittenOwnFile([], false, file("gone"), false)).toBe(false);
	expect(unwrittenOwnFile([listed("a")], true, file("a"), false)).toBe(false);
});

test("the family is asked for again when the list gains the file: its signature changes from unwritten to live", () => {
	const own = file("new");
	expect(familySignature([], own, own)).toContain("unwritten");
	const after = familySignature([listed("new")], own, own);
	expect(after).toContain("live");
	expect(after).not.toBe(familySignature([], own, own));
});
