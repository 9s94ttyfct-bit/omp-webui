import { expect, test } from "bun:test";
import type { SessionSummary } from "../../shared/protocol.ts";
import { type GroupInput, sessionGroups, sessionSortOf } from "../../web/src/lib/session-order.ts";

/**
 * The sidebar's groups (#699, #700, #701): pinned first in the order they were pinned, then the conversations that work
 * now, then the rest in the chosen order under its headings.
 */

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-27T18:00:00.000Z");
const s = (file: string, title: string, modifiedAt: number, createdAt: number): SessionSummary =>
	({ file, title, preview: "", modifiedAt, createdAt: new Date(createdAt).toISOString() }) as SessionSummary;
const dateOf = (ms: number) => (ms >= NOW - DAY / 2 ? "Today" : ms >= NOW - 2 * DAY ? "Yesterday" : "Older");

// The session list's own order: last activity first.
const old = s("old", "Banana", NOW - 10 * DAY, NOW - 10 * DAY);
const sessions = [
	s("a", "Cherry", NOW - 1000, NOW - 5 * DAY),
	s("b", "apple", NOW - DAY - 1000, NOW - 1000),
	s("p", "Pinned one", NOW - 2000, NOW - 2000),
	old,
];
const groups = (over: Partial<GroupInput> = {}) =>
	sessionGroups({
		sessions,
		pins: ["p"],
		sort: "activity",
		working: new Set(),
		dateOf,
		today: "Today",
		pinnedLabel: "Pinned",
		byNameLabel: "By name",
		ranked: false,
		pinnedFolded: false,
		...over,
	}).map(([label, list]) => [label, list.map((x) => x.file)]);

test("by last activity: pinned first, then date headings, as the list always was", () => {
	expect(groups()).toEqual([
		["Pinned", ["p"]],
		["Today", ["a"]],
		["Yesterday", ["b"]],
		["Older", ["old"]],
	]);
});

test("a conversation working now goes to the top of Today, whatever day it was last written to (#699)", () => {
	expect(groups({ working: new Set(["old"]) })).toEqual([
		["Pinned", ["p"]],
		["Today", ["old", "a"]],
		["Yesterday", ["b"]],
	]);
	// A pinned one stays among the pinned.
	expect(groups({ working: new Set(["p"]) })[0]).toEqual(["Pinned", ["p"]]);
});

test("by creation and by name, the working ones first in either (#701)", () => {
	expect(groups({ sort: "created" })).toEqual([
		["Pinned", ["p"]],
		["Today", ["b"]],
		["Older", ["a", "old"]],
	]);
	expect(groups({ sort: "title" })).toEqual([
		["Pinned", ["p"]],
		["By name", ["b", "old", "a"]],
	]);
	expect(groups({ sort: "title", working: new Set(["a"]) })).toEqual([
		["Pinned", ["p"]],
		["By name", ["a", "b", "old"]],
	]);
	expect(groups({ sort: "created", working: new Set(["old"]) })).toEqual([
		["Pinned", ["p"]],
		["Today", ["old", "b"]],
		["Older", ["a"]],
	]);
});

test("a folded Pinned group keeps its heading and no rows, except in a search, which shows every match (#700)", () => {
	expect(groups({ pinnedFolded: true })[0]).toEqual(["Pinned", []]);
	expect(groups({ pinnedFolded: true, ranked: true })[0]).toEqual(["Pinned", ["p"]]);
});

test("a search's ranking stands: no other order, nothing moved up", () => {
	expect(groups({ ranked: true, sort: "title", working: new Set(["old"]) }).flatMap(([, l]) => l)).toEqual([
		"p",
		"a",
		"b",
		"old",
	]);
});

test("a stored order that is no order is the default", () => {
	expect(sessionSortOf(null)).toBe("activity");
	expect(sessionSortOf("created")).toBe("created");
	expect(sessionSortOf("random")).toBe("activity");
});
