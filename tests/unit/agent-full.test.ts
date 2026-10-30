import { expect, test } from "bun:test";
import { fieldKeepsKey, isPopOut, neighbour, popOutHref, positionOf } from "../../web/src/lib/agent-full.ts";
import { keyLabel, shortcutLabel } from "../../web/src/lib/platform.ts";
import { chordKeys, DEFAULT_CHORDS, matches } from "../../web/src/lib/shortcuts.ts";

/** The subagent full screen's switcher and its keys. */

const rows = [{ id: "Newer" }, { id: "Older" }, { id: "Older.Nested" }, { id: "Finished" }];

test("the next and previous subagent are the neighbours in the Agents tab's order", () => {
	expect(neighbour(rows, "Older", 1)).toBe("Older.Nested");
	expect(neighbour(rows, "Older", -1)).toBe("Newer");
});

test("there is nothing beyond the first or the last subagent, and none next to one that is not listed", () => {
	expect(neighbour(rows, "Newer", -1)).toBeNull();
	expect(neighbour(rows, "Finished", 1)).toBeNull();
	expect(neighbour(rows, "Gone", 1)).toBeNull();
	expect(neighbour([], "Newer", 1)).toBeNull();
});

test("the position says which of how many the view shows, and nothing for one that is not listed", () => {
	expect(positionOf(rows, "Older")).toEqual({ index: 2, total: 4 });
	expect(positionOf(rows, "Gone")).toBeNull();
});

const key = (init: Partial<KeyboardEventInit> & { key: string; code?: string }) => ({
	metaKey: false,
	ctrlKey: false,
	shiftKey: false,
	altKey: false,
	...init,
});

test("Alt+Up and Alt+Down switch subagents, and only those", () => {
	expect(matches("agentPrev", key({ key: "ArrowUp", altKey: true }))).toBe(true);
	expect(matches("agentNext", key({ key: "ArrowDown", altKey: true }))).toBe(true);
	expect(matches("agentPrev", key({ key: "ArrowUp" }))).toBe(false);
	expect(matches("agentNext", key({ key: "ArrowDown" }))).toBe(false);
	expect(matches("agentPrev", key({ key: "ArrowUp", altKey: true, metaKey: true }))).toBe(false);
	expect(matches("agentNext", key({ key: "ArrowDown", altKey: true, shiftKey: true }))).toBe(false);
	expect(matches("agentNext", key({ key: "ArrowUp", altKey: true }))).toBe(false);
});

test("Alt+L opens the list by its physical key, which Option turns into another letter on a Mac", () => {
	expect(matches("agentList", key({ key: "l", code: "KeyL", altKey: true }))).toBe(true);
	expect(matches("agentList", key({ key: "¬", code: "KeyL", altKey: true }))).toBe(true);
	expect(matches("agentList", key({ key: "l", code: "KeyL" }))).toBe(false);
	expect(matches("agentList", key({ key: "l", code: "KeyL", altKey: true, ctrlKey: true }))).toBe(false);
});

test("Alt is written as ⌥ on Apple platforms and spelled out elsewhere", () => {
	expect(keyLabel("Alt", true)).toBe("⌥");
	expect(keyLabel("Alt", false)).toBe("Alt");
	expect(shortcutLabel(chordKeys(DEFAULT_CHORDS.agentNext), false)).toBe("Alt+↓");
	expect(shortcutLabel(chordKeys(DEFAULT_CHORDS.agentNext), true)).toBe("⌥↓");
});

test("a window opened for a subagent says so in its address, wherever the other parameters are", () => {
	expect(isPopOut("?popout")).toBe(true);
	expect(isPopOut("?token=abc&popout")).toBe(true);
	expect(isPopOut("?popout=1")).toBe(true);
	expect(isPopOut("")).toBe(false);
	expect(isPopOut("?token=popout")).toBe(false);
	expect(isPopOut("?popouts")).toBe(false);
});

test("the pop-out address is the app's own address with the flag in front of the route", () => {
	expect(popOutHref("http://127.0.0.1:7878", "#/s/%2Ftmp%2Fa.jsonl/agent/Scout")).toBe(
		"http://127.0.0.1:7878/?popout#/s/%2Ftmp%2Fa.jsonl/agent/Scout",
	);
});

test("in a text field the arrows and printable keys are the field's, whatever Option made of them", () => {
	for (const key of ["ArrowUp", "ArrowDown", "l", "¬", "ł", "@"]) expect(fieldKeepsKey(key)).toBe(true);
	for (const key of ["Escape", "F2", "Tab", "Enter"]) expect(fieldKeepsKey(key)).toBe(false);
});
