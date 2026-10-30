import { expect, test } from "bun:test";
import {
	enterEntry,
	entryIdOf,
	entryState,
	keepReading,
	newEntryId,
	type Reading,
	readingOf,
	registerReader,
} from "../../web/src/lib/reading.ts";

/** Where a reader was in a conversation is kept for the history entry they leave it on, for Back. */

const at = (segment: string, top = 0): Reading => ({ window: { from: "a", to: null }, anchor: { segment, top } });

test("a history entry's id is in its state, and an entry that has none says so", () => {
	const id = newEntryId();
	expect(entryIdOf(entryState(id))).toBe(id);
	expect(newEntryId()).not.toBe(id);
	for (const state of [null, undefined, "x", 3, {}, { ompwEntry: 4 }]) expect(entryIdOf(state)).toBeNull();
});

test("leaving an entry keeps what the reader sees for it, and Back finds it by the entry's id", () => {
	const stop = registerReader(() => at("m7", -12));
	enterEntry("entry-a");
	keepReading();
	expect(readingOf("entry-a")).toEqual(at("m7", -12));
	expect(readingOf("entry-b")).toBeUndefined();
	expect(readingOf(null)).toBeUndefined();
	stop();
});

test("leaving again keeps the later place; a reader that sees nothing, or an entry with no id, keeps nothing", () => {
	let reading: Reading | null = at("first");
	const stop = registerReader(() => reading);
	enterEntry("entry-c");
	keepReading();
	reading = at("second");
	keepReading();
	expect(readingOf("entry-c")).toEqual(at("second"));

	reading = null;
	enterEntry("entry-d");
	keepReading();
	expect(readingOf("entry-d")).toBeUndefined();

	reading = at("lost");
	enterEntry(null);
	keepReading();
	stop();
});

test("a page that is not on a chat keeps nothing, and a reader that has gone does not read", () => {
	const stop = registerReader(() => at("m1"));
	stop();
	enterEntry("entry-e");
	keepReading();
	expect(readingOf("entry-e")).toBeUndefined();
});

test("a newer reader is not taken away by the older one's cleanup", () => {
	const stopOld = registerReader(() => at("old"));
	const stopNew = registerReader(() => at("new"));
	stopOld();
	enterEntry("entry-f");
	keepReading();
	expect(readingOf("entry-f")).toEqual(at("new"));
	stopNew();
});

test("only the latest hundred readings are kept", () => {
	const stop = registerReader(() => at("m"));
	for (let i = 0; i < 105; i++) {
		enterEntry(`bulk-${i}`);
		keepReading();
	}
	expect(readingOf("bulk-0")).toBeUndefined();
	expect(readingOf("bulk-4")).toBeUndefined();
	expect(readingOf("bulk-5")).toBeDefined();
	expect(readingOf("bulk-104")).toBeDefined();
	stop();
});
