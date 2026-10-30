import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrefsError, UiPrefs } from "../../server/prefs.ts";
import { NO_FILTER, STATUS_FILTERS, TIME_FILTERS } from "../../shared/graph-filter.ts";
import { isValidPref, PREF, type PrefKey } from "../../shared/prefs.ts";
import { graphViewOf, setGraphFilter, setGraphFocus, setGraphGrid } from "../../web/src/lib/graph-view.ts";

/**
 * The agent graph remembers how it is looked at (v0.12.2): Grid, Focus (with its minimap) and the status and time
 * filters, one choice for every conversation's graph, kept with the app's other preferences. A stored value no version
 * writes is that setting's default, and the server refuses to keep one.
 */

const KEYS = [PREF.graphGrid, PREF.graphFocus, PREF.graphStatus, PREF.graphTime] as const;
const from = (values: Partial<Record<PrefKey, string>>) => graphViewOf((k) => values[k] ?? null);

const globals = globalThis as Record<string, unknown>;
let savedStorage: unknown;
let storage: Map<string, string>;
let dir: string;
beforeEach(() => {
	savedStorage = globals.localStorage;
	storage = new Map();
	globals.localStorage = {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => storage.set(k, String(v)),
		removeItem: (k: string) => storage.delete(k),
	};
	dir = mkdtempSync(join(tmpdir(), "ompw-graph-view-"));
});
afterEach(() => {
	if (savedStorage === undefined) delete globals.localStorage;
	else globals.localStorage = savedStorage;
	rmSync(dir, { recursive: true, force: true });
});

test("nothing stored: the graph opens as it always did, switches off and no filter", () => {
	expect(from({})).toEqual({ grid: false, focus: false, filter: NO_FILTER });
});

test("what was stored is the view, each setting on its own", () => {
	expect(
		from({
			[PREF.graphGrid]: "on",
			[PREF.graphFocus]: "on",
			[PREF.graphStatus]: "failed",
			[PREF.graphTime]: "today",
		}),
	).toEqual({ grid: true, focus: true, filter: { status: "failed", time: "today" } });
	expect(from({ [PREF.graphFocus]: "on", [PREF.graphGrid]: "off" })).toEqual({
		grid: false,
		focus: true,
		filter: NO_FILTER,
	});
	for (const status of STATUS_FILTERS) expect(from({ [PREF.graphStatus]: status }).filter.status).toBe(status);
	for (const time of TIME_FILTERS) expect(from({ [PREF.graphTime]: time }).filter.time).toBe(time);
});

test("a stored value no version writes (a filter that no longer exists, junk) is that setting's default, the rest stand", () => {
	const view = from({
		[PREF.graphGrid]: "yes",
		[PREF.graphFocus]: "on",
		[PREF.graphStatus]: "stalled",
		[PREF.graphTime]: "week",
	});
	expect(view).toEqual({ grid: false, focus: true, filter: NO_FILTER });
	for (const junk of ["", "ALL", "Running", " running", '{"status":"running"}', "null", "undefined"]) {
		expect(from({ [PREF.graphStatus]: junk, [PREF.graphTime]: "hour" }).filter, junk).toEqual({
			status: "all",
			time: "hour",
		});
		expect(from({ [PREF.graphTime]: junk, [PREF.graphStatus]: "running" }).filter, junk).toEqual({
			status: "running",
			time: "all",
		});
		expect(from({ [PREF.graphGrid]: junk, [PREF.graphFocus]: junk }), junk).toMatchObject({
			grid: false,
			focus: false,
		});
	}
});

test("a change is written where the app's preferences are, and read back as it was made", () => {
	setGraphGrid(true);
	setGraphFocus(true);
	setGraphFilter({ status: "running", time: "hour" });
	expect(Object.fromEntries(KEYS.map((k) => [k, storage.get(k)]))).toEqual({
		[PREF.graphGrid]: "on",
		[PREF.graphFocus]: "on",
		[PREF.graphStatus]: "running",
		[PREF.graphTime]: "hour",
	});
	expect(graphViewOf((k) => localStorage.getItem(k))).toEqual({
		grid: true,
		focus: true,
		filter: { status: "running", time: "hour" },
	});
	// Turned off and cleared: still stored (as the defaults), so that the server forgets the earlier choice too.
	setGraphGrid(false);
	setGraphFocus(false);
	setGraphFilter(NO_FILTER);
	expect(Object.fromEntries(KEYS.map((k) => [k, storage.get(k)]))).toEqual({
		[PREF.graphGrid]: "off",
		[PREF.graphFocus]: "off",
		[PREF.graphStatus]: "all",
		[PREF.graphTime]: "all",
	});
	expect(graphViewOf((k) => localStorage.getItem(k))).toEqual({ grid: false, focus: false, filter: NO_FILTER });
});

test("every value the page writes is one the server keeps; any other is refused", () => {
	for (const v of ["on", "off"]) {
		expect(isValidPref(PREF.graphGrid, v)).toBe(true);
		expect(isValidPref(PREF.graphFocus, v)).toBe(true);
	}
	for (const v of STATUS_FILTERS) expect(isValidPref(PREF.graphStatus, v)).toBe(true);
	for (const v of TIME_FILTERS) expect(isValidPref(PREF.graphTime, v)).toBe(true);
	const bad: [PrefKey, string][] = [
		[PREF.graphGrid, "yes"],
		[PREF.graphFocus, ""],
		[PREF.graphStatus, "stalled"],
		[PREF.graphStatus, "Running"],
		[PREF.graphTime, "week"],
		[PREF.graphTime, ""],
	];
	for (const [k, v] of bad) expect(isValidPref(k, v), `${k}=${v}`).toBe(false);

	const prefs = new UiPrefs(dir);
	for (const [k, v] of bad) expect(() => prefs.apply({ [k]: v }), `${k}=${v}`).toThrow(PrefsError);
	const kept = prefs.apply({
		[PREF.graphGrid]: "on",
		[PREF.graphFocus]: "off",
		[PREF.graphStatus]: "failed",
		[PREF.graphTime]: "today",
	});
	// Kept by the server, so a restart (a new store on the same data dir) still has them.
	expect(new UiPrefs(dir).snapshot().values).toEqual(kept.values);
	expect(graphViewOf((k) => kept.values[k])).toEqual({
		grid: true,
		focus: false,
		filter: { status: "failed", time: "today" },
	});
});
