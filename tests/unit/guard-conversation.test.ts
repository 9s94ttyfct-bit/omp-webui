import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import { ApprovalStore, sessionKey } from "../../server/omp/approval.ts";
import {
	applyGuardOverridePatch,
	DAMAGED_GUARD,
	FOLLOW_GLOBAL_GUARD,
	type GuardConfig,
	GuardConfigError,
	type GuardOverride,
	type GuardWord,
	type KeptGuard,
	NO_GUARD,
	parseGuardOverride,
	parseGuardOverridePatch,
	parseGuardWord,
	readKeptGuard,
	recordKept,
	resolveGuard,
	stricterKept,
	strictOnly,
} from "../../shared/guard.ts";
import { isRecord } from "../../shared/guards.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { writeFakeHostOmp } from "../support/fake-host-omp.ts";
import { fakeConfig } from "../support/fake-omp.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * "Guard dangerous commands" for one conversation (#626), with no omp but a scripted one: how a conversation's own choices
 * combine with the global settings, what is kept of them with the conversation, and what its process's gate is told. The
 * real omp, a restarted server and the pages that are not this computer's are `tests/contract/guard-conversation.test.ts`.
 */

const GLOBAL: GuardConfig = { mode: "reviewer", reviewer: "g/one", askWhenUnavailable: true, askWhenDenied: true };

// ------------------------------------------------------------------ the rules

describe("what a conversation is under", () => {
	test("one that chose nothing is under the global settings, and says so by having nothing of its own", () => {
		expect(resolveGuard(GLOBAL, null)).toEqual({ config: GLOBAL });
		expect(resolveGuard(GLOBAL, undefined)).toEqual({ config: GLOBAL });
		expect(resolveGuard(GLOBAL, {})).toEqual({ config: GLOBAL });
	});

	test("a field it chose is its own, and every other is the global setting's, also when that changes", () => {
		const own = { mode: "ask" as const };
		expect(resolveGuard(GLOBAL, own)).toEqual({ config: { ...GLOBAL, mode: "ask" }, own });
		const moved: GuardConfig = { mode: "off", reviewer: "g/two", askWhenUnavailable: false, askWhenDenied: false };
		expect(resolveGuard(moved, own)).toEqual({ config: { ...moved, mode: "ask" }, own });
		// The other way round: the reviewer is its own, the mode follows.
		expect(resolveGuard(moved, { reviewer: "c/own" })).toEqual({
			config: { ...moved, reviewer: "c/own" },
			own: { reviewer: "c/own" },
		});
	});

	test("what it chose wins in both directions: Off under a guard that is on, and a guard that is on under Off", () => {
		expect(resolveGuard(GLOBAL, { mode: "off" }).config.mode).toBe("off");
		expect(resolveGuard({ ...GLOBAL, mode: "off" }, { mode: "reviewer" }).config.mode).toBe("reviewer");
		expect(resolveGuard({ ...GLOBAL, mode: "off" }, { mode: "ask" }).config.mode).toBe("ask");
	});

	test("a blank reviewer is a choice (the guard picks a model), not a field that follows the settings", () => {
		expect(resolveGuard(GLOBAL, { reviewer: "" })).toEqual({
			config: { ...GLOBAL, reviewer: "" },
			own: { reviewer: "" },
		});
	});

	test("the settings it is resolved over are not changed", () => {
		const global = { ...GLOBAL };
		resolveGuard(global, { mode: "off", reviewer: "x/y", askWhenUnavailable: false });
		expect(global).toEqual(GLOBAL);
	});
});

describe("what is kept of a conversation's choices", () => {
	test("is read back as it was written, the reviewer trimmed", () => {
		expect(parseGuardOverride({ mode: "off" })).toEqual({ mode: "off" });
		expect(parseGuardOverride({ mode: "ask", reviewer: "  a/b , c/d ", askWhenUnavailable: false })).toEqual({
			mode: "ask",
			reviewer: "a/b , c/d",
			askWhenUnavailable: false,
		});
		expect(parseGuardOverride({ reviewer: "" })).toEqual({ reviewer: "" });
		expect(parseGuardOverride({ askWhenDenied: false })).toEqual({ askWhenDenied: false });
	});

	test.each<[string, unknown]>([
		["nothing", undefined],
		["null", null],
		["text", "off"],
		["a number", 0],
		["a list", [{ mode: "off" }]],
		["an object with no choice", {}],
		["a mode that is not one", { mode: "disabled" }],
		["a mode spelled another way", { mode: "Off" }],
		["a mode of another type", { mode: false }],
		["a choice that is not one of these", { mode: "off", nope: true }],
		["a reviewer that is not text", { reviewer: 4 }],
		["a reviewer with a control character", { reviewer: "a/b\u0007" }],
		["a reviewer far too long", { reviewer: "x".repeat(600) }],
		["a switch that is not a boolean", { askWhenUnavailable: "no" }],
		["a denial switch that is not a boolean", { askWhenDenied: 0 }],
		// One field that cannot be read makes the record none: the part that can be read is not trusted on its own.
		["a good mode beside a damaged field", { mode: "off", reviewer: 9 }],
	])("%s is no choice: the conversation follows the settings, never Off", (_name, raw) => {
		expect(parseGuardOverride(raw)).toBeNull();
		// What the conversation is under, then, is what the settings say, the guard on as they have it.
		expect(resolveGuard(GLOBAL, parseGuardOverride(raw))).toEqual({ config: GLOBAL });
	});
});

describe("a change a page asks for", () => {
	test("names the fields it sets, and a field set to null follows the settings again", () => {
		expect(applyGuardOverridePatch(null, parseGuardOverridePatch({ mode: "off" }))).toEqual({ mode: "off" });
		expect(
			applyGuardOverridePatch(
				{ mode: "off", reviewer: "a/b" },
				parseGuardOverridePatch({ mode: null, askWhenUnavailable: false }),
			),
		).toEqual({ reviewer: "a/b", askWhenUnavailable: false });
		// Nothing left of its own is none, not an empty record.
		expect(applyGuardOverridePatch({ mode: "off" }, parseGuardOverridePatch({ mode: null }))).toBeNull();
		expect(
			applyGuardOverridePatch({ mode: "off", reviewer: "a/b", askWhenDenied: false }, FOLLOW_GLOBAL_GUARD),
		).toBeNull();
		// A change that names nothing changes nothing.
		expect(applyGuardOverridePatch({ mode: "ask" }, parseGuardOverridePatch({}))).toEqual({ mode: "ask" });
	});

	test("is checked as the global settings' changes are, and the one that is refused changes nothing", () => {
		const own = { mode: "ask" as const };
		for (const bad of [
			null,
			"off",
			[],
			{ mode: "disabled" },
			{ mode: 1 },
			{ reviewer: 3 },
			{ reviewer: "a\u0000b" },
			{ reviewer: "x".repeat(600) },
			{ askWhenUnavailable: "yes" },
			{ askWhenDenied: "no" },
			{ nope: true },
			{ nope: null },
		])
			expect(() => parseGuardOverridePatch(bad), JSON.stringify(bad)).toThrow(GuardConfigError);
		expect(own).toEqual({ mode: "ask" });
	});

	test("does not change the record it is applied to", () => {
		const own = { mode: "ask" as const, reviewer: "a/b" };
		applyGuardOverridePatch(own, { mode: null, reviewer: "c/d" });
		expect(own).toEqual({ mode: "ask", reviewer: "a/b" });
	});
});

// ------------------------------------------------------------------ what is kept with the conversation

const dirs: string[] = [];
const pools: LivePool[] = [];
afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
// The server sweeps the temp dir for the overlay directories of servers that are gone: these tests use a temp dir of their own.
const sharedTmp = process.env.TMPDIR;
let ownTmp = "";
beforeAll(() => {
	ownTmp = mkdtempSync(join(tmpdir(), "ompw-guard-conv-tmp-"));
	process.env.TMPDIR = ownTmp;
});
afterAll(() => {
	if (sharedTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = sharedTmp;
	rmSync(ownTmp, { recursive: true, force: true });
});
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-guard-conv-"));
	dirs.push(dir);
	return dir;
};

const ownOf = (store: ApprovalStore, file: string) => store.sessionGuard(file).own;

describe("the store", () => {
	test("keeps a conversation's choices by its file, for the next server, and forgets them when it follows the settings again", () => {
		const dir = scratch();
		const store = new ApprovalStore("omp", dir, 0);
		expect(store.sessionGuard("/s/a.jsonl")).toEqual(NO_GUARD);
		store.rememberGuard("/s/a.jsonl", { mode: "off" });
		store.rememberGuard("/s/b.jsonl", { mode: "ask", reviewer: "x/y" });
		expect(ownOf(new ApprovalStore("omp", dir, 0), "/s/a.jsonl")).toEqual({ mode: "off" });
		expect(ownOf(new ApprovalStore("omp", dir, 0), "/s/b.jsonl")).toEqual({ mode: "ask", reviewer: "x/y" });
		store.rememberGuard("/s/a.jsonl", null);
		expect(new ApprovalStore("omp", dir, 0).sessionGuard("/s/a.jsonl")).toEqual(NO_GUARD);
		expect(ownOf(new ApprovalStore("omp", dir, 0), "/s/b.jsonl")).toEqual({ mode: "ask", reviewer: "x/y" });
		// What else the store holds is not touched by it.
		store.rememberSession("/s/a.jsonl", "yolo");
		store.rememberGuard("/s/c.jsonl", { mode: "off" });
		expect(store.sessionMode("/s/a.jsonl")).toBe("yolo");
		expect(ownOf(new ApprovalStore("omp", dir, 0), "/s/b.jsonl")).toEqual({ mode: "ask", reviewer: "x/y" });
	});

	test("reads a record that is damaged as damage, not as none and not as the part that could be read, and the rest of the file as it is", () => {
		const dir = scratch();
		writeFileSync(
			join(dir, "approval.json"),
			JSON.stringify({
				default: null,
				sessions: { "/s/a.jsonl": "yolo" },
				guard: {
					"/s/good.jsonl": { mode: "ask" },
					"/s/word.jsonl": "off",
					"/s/wrong-case.jsonl": { mode: "OFF" },
					"/s/mixed.jsonl": { mode: "off", extra: 1 },
					"/s/list.jsonl": [{ mode: "off" }],
					"/s/null.jsonl": null,
					"/s/empty.jsonl": {},
				},
			}),
		);
		const store = new ApprovalStore("omp", dir, 0);
		expect(ownOf(store, "/s/good.jsonl")).toEqual({ mode: "ask" });
		for (const name of ["word", "wrong-case", "mixed", "list", "null"])
			expect(store.sessionGuard(`/s/${name}.jsonl`), name).toEqual(DAMAGED_GUARD);
		for (const name of ["empty", "unknown"]) expect(store.sessionGuard(`/s/${name}.jsonl`), name).toEqual(NO_GUARD);
		expect(store.sessionMode("/s/a.jsonl")).toBe("yolo");
	});

	test.each([
		["not json", "{ not json"],
		["a list", "[]"],
		["guard that is no object", '{"guard":"off"}'],
		["guard that is a list", '{"guard":[{"mode":"off"}]}'],
	])("a file that is %s holds no choice at all", (_name, text) => {
		const dir = scratch();
		writeFileSync(join(dir, "approval.json"), text);
		expect(new ApprovalStore("omp", dir, 0).sessionGuard("/s/a.jsonl")).toEqual(NO_GUARD);
	});

	test("is the server's memory: an Off planted in the file is not read, and is written over at the next look", () => {
		const dir = scratch();
		const file = join(dir, "approval.json");
		const store = new ApprovalStore("omp", dir, 0);
		store.rememberGuard("/s/a.jsonl", { mode: "ask" });
		expect(store.verify()).toBe(false);
		const guardOfFile = (): unknown => JSON.parse(readFileSync(file, "utf8")).guard;
		// An agent plants an Off for its own conversation, one for another, and one over what the person chose.
		writeFileSync(
			file,
			JSON.stringify({ guard: { "/s/a.jsonl": { mode: "off" }, "/s/b.jsonl": { mode: "off" }, "/s/c.jsonl": "off" } }),
		);
		expect(ownOf(store, "/s/a.jsonl")).toEqual({ mode: "ask" });
		expect(store.sessionGuard("/s/b.jsonl")).toEqual(NO_GUARD);
		expect(store.sessionGuard("/s/c.jsonl")).toEqual(NO_GUARD);
		expect(store.verify()).toBe(true);
		expect(guardOfFile()).toEqual({ "/s/a.jsonl": { mode: "ask" } });
		expect(store.verify()).toBe(false);
		// The file taken away is put back.
		rmSync(file);
		expect(store.verify()).toBe(true);
		expect(guardOfFile()).toEqual({ "/s/a.jsonl": { mode: "ask" } });
		// What is damaged when the server starts is damage from then on, and is not mistaken for a change.
		writeFileSync(file, JSON.stringify({ guard: { "/s/d.jsonl": { mode: "OFF" } } }));
		const started = new ApprovalStore("omp", dir, 0);
		expect(started.sessionGuard("/s/d.jsonl")).toEqual(DAMAGED_GUARD);
		expect(started.verify()).toBe(false);
	});

	test("takes what an import left in the file when it is told to (`reload`), and `verify` leaves that alone", () => {
		const dir = scratch();
		const file = join(dir, "approval.json");
		const store = new ApprovalStore("omp", dir, 0);
		store.rememberGuard("/s/a.jsonl", { mode: "ask" });
		// Move to another computer replaced the file with the one that came from the other Mac.
		writeFileSync(
			file,
			JSON.stringify({ default: "write", guard: { "/s/imported.jsonl": { mode: "ask", reviewer: "x/y" } } }),
		);
		store.reload();
		expect(ownOf(store, "/s/imported.jsonl")).toEqual({ mode: "ask", reviewer: "x/y" });
		expect(store.sessionGuard("/s/a.jsonl")).toEqual(NO_GUARD);
		expect(store.verify()).toBe(false);
		expect(store.verify()).toBe(false);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			default: "write",
			guard: { "/s/imported.jsonl": { mode: "ask", reviewer: "x/y" } },
		});
		// What is on disk is the new server's too: the next server reads the same.
		expect(ownOf(new ApprovalStore("omp", dir, 0), "/s/imported.jsonl")).toEqual({ mode: "ask", reviewer: "x/y" });
	});

	test("looks at the file's stamp before it reads it: a plant of the same size, with the time put back, is still found", () => {
		const dir = scratch();
		const file = join(dir, "approval.json");
		const store = new ApprovalStore("omp", dir, 0);
		store.rememberGuard("/s/a.jsonl", { mode: "ask" });
		const before = statSync(file);
		const written = readFileSync(file, "utf8");
		const planted = written.replace('"ask"', '"off"');
		expect(planted).toHaveLength(written.length);
		writeFileSync(file, planted);
		utimesSync(file, before.atime, before.mtime);
		expect(statSync(file).size).toBe(before.size);
		expect(store.verify()).toBe(true);
		expect(JSON.parse(readFileSync(file, "utf8")).guard).toEqual({ "/s/a.jsonl": { mode: "ask" } });
		expect(store.verify()).toBe(false);
	});

	test("writes through a temp file of its own, so that another process's temp file is no hindrance and none is left", () => {
		const dir = scratch();
		const store = new ApprovalStore("omp", dir, 0);
		// What an older server's fixed name would have been: a folder there cannot be written to or renamed over.
		mkdirSync(join(dir, "approval.json.tmp"));
		store.rememberGuard("/s/a.jsonl", { mode: "ask" });
		store.rememberSession("/s/a.jsonl", "write");
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual(["approval.json.tmp"]);
		expect(ownOf(new ApprovalStore("omp", dir, 0), "/s/a.jsonl")).toEqual({ mode: "ask" });
	});

	test("never throws when it cannot write: it says so once, goes on, and puts the file right when it can", () => {
		const dir = scratch();
		const file = join(dir, "approval.json");
		const store = new ApprovalStore("omp", dir, 0);
		store.rememberGuard("/s/a.jsonl", { mode: "ask" });
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			// An Off planted in the file, and the folder that holds it takes no new file: the write cannot be made.
			writeFileSync(file, JSON.stringify({ guard: { "/s/a.jsonl": { mode: "off" } } }));
			chmodSync(dir, 0o500);
			try {
				expect(store.verify()).toBe(false);
				expect(store.verify()).toBe(false);
				expect(warn).toHaveBeenCalledTimes(1);
				expect(ownOf(store, "/s/a.jsonl")).toEqual({ mode: "ask" });
			} finally {
				chmodSync(dir, 0o700);
			}
			// The folder can be written again: the next look writes the server's own copy over what was planted, and says nothing.
			expect(store.verify()).toBe(true);
			expect(JSON.parse(readFileSync(file, "utf8")).guard).toEqual({ "/s/a.jsonl": { mode: "ask" } });
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("damage and the records of a conversation", () => {
	test("a record that was damaged is read as the default at least: the settings can only make it stricter, never Off", () => {
		const off: GuardConfig = { mode: "off", reviewer: "g/one", askWhenUnavailable: false, askWhenDenied: false };
		// Whether a denial is put to the person stays the settings': the default (it is) is no stricter than a final denial.
		expect(resolveGuard(off, null, true)).toEqual({
			config: { mode: "reviewer", reviewer: "g/one", askWhenUnavailable: true, askWhenDenied: false },
			damaged: true,
		});
		expect(resolveGuard({ ...off, mode: "ask" }, null, true).config.mode).toBe("ask");
		expect(resolveGuard(GLOBAL, null, true)).toEqual({ config: GLOBAL, damaged: true });
		// What a conversation chose after the damage is what it chose.
		expect(resolveGuard(GLOBAL, { mode: "off" }, true).config.mode).toBe("off");
	});

	test("of a paused conversation and of the store, the stricter is taken when the next server adopts it", () => {
		const own = (o: GuardOverride): KeptGuard => ({ own: o, damaged: false });
		const off = own({ mode: "off" });
		const ask = own({ mode: "ask" });
		const reviewer = own({ mode: "reviewer" });
		// An Off planted in one of the two never beats what the other says.
		expect(stricterKept(off, ask)).toBe(ask);
		expect(stricterKept(ask, off)).toBe(ask);
		expect(stricterKept(off, NO_GUARD)).toBe(NO_GUARD);
		expect(stricterKept(NO_GUARD, off)).toBe(NO_GUARD);
		expect(stricterKept(off, DAMAGED_GUARD)).toBe(DAMAGED_GUARD);
		expect(stricterKept(reviewer, ask)).toBe(ask);
		expect(stricterKept(NO_GUARD, reviewer)).toBe(reviewer);
		// Alike in mode: the one that asks when no reviewer can be reached.
		const refusing = own({ mode: "reviewer", askWhenUnavailable: false });
		const asking = own({ mode: "reviewer", askWhenUnavailable: true });
		expect(stricterKept(refusing, asking)).toBe(asking);
		expect(stricterKept(asking, refusing)).toBe(asking);
		// Alike in that too: the one whose reviewer's denial is final, not put to the person.
		const final = own({ mode: "reviewer", askWhenDenied: false });
		const overruled = own({ mode: "reviewer", askWhenDenied: true });
		expect(stricterKept(overruled, final)).toBe(final);
		expect(stricterKept(final, overruled)).toBe(final);
		// The record of a paused conversation, as it was written.
		expect(recordKept(undefined)).toEqual(NO_GUARD);
		expect(recordKept({ guard: { mode: "ask" } })).toEqual(ask);
		expect(recordKept({ guardDamaged: true })).toEqual(DAMAGED_GUARD);
		expect(readKeptGuard({ mode: "ask" })).toEqual(ask);
		expect(readKeptGuard("off")).toEqual(DAMAGED_GUARD);
		expect(readKeptGuard({})).toEqual(NO_GUARD);
	});
});

// ------------------------------------------------------------------ what a process's gate is told

interface Setup {
	dir: string;
	/** The settings in force now: assign to change them. */
	global: { config: GuardConfig };
	approval: ApprovalStore;
	pool: LivePool;
	/** The processes' own settings overlays, in the order they were started: the gate's word is beside each. */
	overlays(): string[];
	/** A pool of another server over the same data folder. */
	next(): { pool: LivePool; overlays(): string[] };
	/** A session file of this test. */
	file(name: string): string;
	open(name: string): Promise<Live>;
	/** The word a process's gate reads, as it reads it: the one beside the n-th overlay. */
	word(n: number): GuardWord | null;
	/** What the page is told of every conversation as the pool announces it. */
	told: LiveInfo[];
	/** The types of the commands that reached omp, in order. */
	sent(): string[];
}

function setup(): Setup {
	const dir = scratch();
	const log = join(dir, "log");
	writeFileSync(log, "");
	const bin = writeFakeHostOmp(dir, log, { configured: "yolo" });
	const global = { config: { ...GLOBAL } };
	const gate = (pool: LivePool): void => {
		pool.gate = {
			extension: join(dir, "gate", "extension.ts"),
			protect: [dir],
			confirm: () => false,
			ensure: () => true,
			guard: { config: () => global.config, log: join(dir, "guard", "decisions.jsonl"), own: [dir] },
		};
	};
	const make = () => {
		const approval = new ApprovalStore(bin, dir, 0);
		approval.handlerMs = 120_000;
		const pool = new LivePool(fakeConfig(dir, bin), null, null, approval);
		pools.push(pool);
		gate(pool);
		return { approval, pool };
	};
	const { approval, pool } = make();
	const told: LiveInfo[] = [];
	pool.onAnnounce((info) => told.push(structuredClone(info)));
	const overlays = (): string[] =>
		readFileSync(log, "utf8")
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => {
				const entry: unknown = JSON.parse(line);
				if (!isRecord(entry) || !Array.isArray(entry.argv)) return [];
				return [String(entry.argv.at(-1))];
			});
	const file = (name: string): string => {
		const path = join(dir, `${name}.jsonl`);
		writeFileSync(path, "");
		return path;
	};
	return {
		dir,
		global,
		approval,
		pool,
		overlays,
		next: () => {
			const second = make();
			return { pool: second.pool, overlays };
		},
		file,
		open: (name) => pool.open({ kind: "resume", sessionFile: file(name) }, async () => tmpdir()),
		word: (n) => parseGuardWord(JSON.parse(readFileSync(`${overlays()[n]}.risk`, "utf8")).guard),
		told,
		sent: () =>
			readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.flatMap((line) => {
					const entry: unknown = JSON.parse(line);
					return isRecord(entry) && isRecord(entry.in) && typeof entry.in.type === "string" ? [entry.in.type] : [];
				}),
	};
}

describe("a conversation's gate", () => {
	test("is told what the conversation chose over the global settings, and every other conversation's is told those", async () => {
		const t = setup();
		const a = await t.open("a");
		const b = await t.open("b");
		expect(t.word(0)).toMatchObject({ mode: "reviewer", reviewers: ["g/one"], askWhenUnavailable: true });

		const now = a.changeGuard({ mode: "ask", reviewer: "x/y" });
		expect(now).toEqual({
			config: { mode: "ask", reviewer: "x/y", askWhenUnavailable: true, askWhenDenied: true },
			own: { mode: "ask", reviewer: "x/y" },
		});
		expect(t.word(0)).toMatchObject({ mode: "ask", reviewers: ["x/y"], askWhenUnavailable: true });
		expect(t.word(1)).toMatchObject({ mode: "reviewer", reviewers: ["g/one"] });
		expect(a.info.guard).toEqual(now);
		expect(b.info.guard).toEqual({ config: GLOBAL });
	});

	test("follows the global settings for what it did not choose, live, and the pages are told as it moves", async () => {
		const t = setup();
		const a = await t.open("a");
		const b = await t.open("b");
		a.changeGuard({ mode: "off" });
		t.told.length = 0;

		t.global.config = { mode: "ask", reviewer: "g/two", askWhenUnavailable: false, askWhenDenied: true };
		t.pool.syncRisk();
		// The one that chose Off stays off, and takes the rest from the settings; the other follows all of them.
		expect(t.word(0)).toMatchObject({ mode: "off", reviewers: ["g/two"], askWhenUnavailable: false });
		expect(t.word(1)).toMatchObject({ mode: "ask", reviewers: ["g/two"], askWhenUnavailable: false });
		expect(b.info.guard).toEqual({ config: t.global.config });
		expect(a.info.guard).toEqual({ config: { ...t.global.config, mode: "off" }, own: { mode: "off" } });
		// Both are announced: the settings moved what each shows. A change nobody sees is not announced.
		const ids = new Set(t.told.filter((i) => i.guard !== undefined).map((i) => i.liveId));
		expect(ids).toEqual(new Set([a.info.liveId, b.info.liveId]));
		t.told.length = 0;
		t.pool.syncRisk();
		expect(t.told).toEqual([]);

		// Off in the settings changes nothing for the conversation that chose a guard.
		a.changeGuard({ mode: "ask" });
		t.global.config = { ...t.global.config, mode: "off" };
		t.pool.syncRisk();
		expect(t.word(0)?.mode).toBe("ask");
		expect(t.word(1)?.mode).toBe("off");
	});

	test("goes back to the settings, field by field, when the conversation gives its choice up", async () => {
		const t = setup();
		const a = await t.open("a");
		a.changeGuard({ mode: "off", reviewer: "x/y", askWhenUnavailable: false });
		expect(t.word(0)).toMatchObject({ mode: "off", reviewers: ["x/y"], askWhenUnavailable: false });
		a.changeGuard({ reviewer: null });
		expect(t.word(0)).toMatchObject({ mode: "off", reviewers: ["g/one"], askWhenUnavailable: false });
		a.changeGuard({ mode: null, askWhenUnavailable: null });
		expect(t.word(0)).toMatchObject({ mode: "reviewer", reviewers: ["g/one"], askWhenUnavailable: true });
		expect(a.info.guard).toEqual({ config: GLOBAL });
		expect(a.guardChoice).toBeNull();
	});

	test("is not told a choice it could not be told: nothing changes when the word cannot be written", async () => {
		const t = setup();
		const a = await t.open("a");
		a.changeGuard({ mode: "ask" });
		const folder = dirname(t.overlays()[0]);
		// Its folder takes no new file: the word cannot be written.
		chmodSync(folder, 0o500);
		try {
			expect(() => a.changeGuard({ mode: "off" })).toThrow(/could not be told/);
		} finally {
			chmodSync(folder, 0o700);
		}
		expect(a.guardChoice).toEqual({ mode: "ask" });
		expect(a.info.guard?.config.mode).toBe("ask");
		expect(ownOf(t.approval, sessionKey(a.info.sessionFile ?? ""))).toEqual({ mode: "ask" });
		expect(t.word(0)?.mode).toBe("ask");
	});

	test("is that of the conversation a process is opened on, by this server again or by the next", async () => {
		const t = setup();
		const a = await t.open("a");
		a.changeGuard({ mode: "ask", askWhenUnavailable: false });
		const path = a.info.sessionFile ?? "";
		await a.end();
		await pollUntil(() => a.info.exited, "the first process to end");

		// The same server opens the file again: a new process, under what the conversation chose.
		const again = await t.pool.open({ kind: "resume", sessionFile: path }, async () => tmpdir());
		expect(again).not.toBe(a);
		expect(again.info.guard).toEqual({
			config: { ...GLOBAL, mode: "ask", askWhenUnavailable: false },
			own: { mode: "ask", askWhenUnavailable: false },
		});
		expect(t.word(1)).toMatchObject({ mode: "ask", reviewers: ["g/one"], askWhenUnavailable: false });

		// A server that starts over the same data folder reads it from the file.
		const next = t.next();
		const third = await next.pool.open({ kind: "resume", sessionFile: path }, async () => tmpdir());
		expect(third.info.guard?.own).toEqual({ mode: "ask", askWhenUnavailable: false });
		expect(parseGuardWord(JSON.parse(readFileSync(`${next.overlays()[2]}.risk`, "utf8")).guard)?.mode).toBe("ask");
		// A conversation that chose nothing is as the settings say, whatever else was opened.
		const other = await next.pool.open({ kind: "resume", sessionFile: t.file("other") }, async () => tmpdir());
		expect(other.info.guard).toEqual({ config: GLOBAL });
	});

	test.each<[string, unknown]>([
		["text", "off"],
		["a mode spelled another way", { mode: "OFF" }],
		["a mode beside a field that is not one", { mode: "off", extra: 1 }],
		["a list", [{ mode: "off" }]],
	])(
		"is under the stricter of the settings and the default when what was kept for it is %s: never Off",
		async (_name, damaged) => {
			const t = setup();
			const path = t.file("a");
			// What the file says when a server starts is what that server holds.
			writeFileSync(join(t.dir, "approval.json"), JSON.stringify({ guard: { [sessionKey(path)]: damaged } }));
			const next = t.next();
			const live = await next.pool.open({ kind: "resume", sessionFile: path }, async () => tmpdir());
			expect(live.info.guard).toEqual({ config: GLOBAL, damaged: true });
			expect(t.word(0)).toMatchObject({ mode: "reviewer", askWhenUnavailable: true });
			// With the settings off it is still not off, and with them on Ask me it is that.
			t.global.config = { mode: "off", reviewer: "", askWhenUnavailable: false, askWhenDenied: true };
			next.pool.syncRisk();
			expect(live.info.guard?.config).toMatchObject({ mode: "reviewer", askWhenUnavailable: true });
			expect(t.word(0)?.mode).toBe("reviewer");
			t.global.config = { ...t.global.config, mode: "ask" };
			next.pool.syncRisk();
			expect(t.word(0)?.mode).toBe("ask");
			// A choice made for it replaces the damage.
			// A choice made for it replaces the damage; the switch it was under stays what it was (the settings say not to ask).
			live.changeGuard({ mode: "off" });
			expect(live.info.guard).toEqual({
				config: { ...t.global.config, mode: "off", askWhenUnavailable: true },
				own: { mode: "off", askWhenUnavailable: true },
			});
		},
	);

	test("goes along when the conversation moves to another file by a fork, and the file that has choices of its own keeps them", async () => {
		const t = setup();
		const a = await t.open("a");
		const first = a.info.sessionFile ?? "";
		a.changeGuard({ mode: "ask" });
		// A fork is the same conversation in another file.
		await a.rpc({ type: "fork" });
		await pollUntil(() => a.info.sessionFile !== first, "the process to be bound to the forked file");
		const forked = a.info.sessionFile ?? "";
		expect(ownOf(t.approval, sessionKey(forked))).toEqual({ mode: "ask" });
		expect(ownOf(t.approval, sessionKey(first))).toEqual({ mode: "ask" });

		// The next move is to a file a conversation already made choices for: they are what the process is under.
		const b = await t.open("b");
		const target = `${(b.info.sessionFile ?? "").replace(/\.jsonl$/, "")}-1.jsonl`;
		t.approval.rememberGuard(sessionKey(target), { mode: "off" });
		await b.rpc({ type: "fork" });
		await pollUntil(() => b.info.sessionFile === target, "the process to be bound to the file with its own choices");
		expect(b.info.guard?.own).toEqual({ mode: "off" });
		expect(t.word(1)?.mode).toBe("off");
	});

	test("is not carried onto another conversation: a process that moves to an existing one by anything but a fork leaves it under the settings", async () => {
		const t = setup();
		const a = await t.open("a");
		const first = a.info.sessionFile ?? "";
		a.changeGuard({ mode: "off" });
		expect(t.word(0)?.mode).toBe("off");
		// omp moved the process to another file (a switch, a slash command): no command of a fork's kind was sent through the server.
		await a.client.request({ type: "fork" });
		await a.refreshState();
		const moved = a.info.sessionFile ?? "";
		expect(moved).not.toBe(first);
		expect(a.info.guard).toEqual({ config: GLOBAL });
		expect(a.guardChoice).toBeNull();
		expect(t.word(0)?.mode).toBe("reviewer");
		expect(t.approval.sessionGuard(sessionKey(moved))).toEqual(NO_GUARD);
		// What it chose for the conversation it left is still that conversation's.
		expect(ownOf(t.approval, sessionKey(first))).toEqual({ mode: "off" });
	});

	test("is not carried onto a conversation whose record is damaged either: that is damage, never the process's Off", async () => {
		const t = setup();
		const path = t.file("a");
		const target = `${sessionKey(path).replace(/\.jsonl$/, "")}-1.jsonl`;
		writeFileSync(join(t.dir, "approval.json"), JSON.stringify({ guard: { [target]: "off" } }));
		const next = t.next();
		const a = await next.pool.open({ kind: "resume", sessionFile: path }, async () => tmpdir());
		a.changeGuard({ mode: "off" });
		await a.client.request({ type: "fork" });
		await a.refreshState();
		expect(a.info.sessionFile).toBe(target);
		expect(a.info.guard).toEqual({ config: GLOBAL, damaged: true });
		expect(t.word(0)?.mode).toBe("reviewer");
	});

	test("is kept by a move omp made itself that was not proven to be a fork: Ask goes along, Off does not", async () => {
		const t = setup();
		const a = await t.open("a");
		const ask = t.file("ask");
		a.changeGuard({ mode: "ask" });
		// A prompt that moves the process (omp's own `/move`, `/wt`, a compaction's hand-off): the server saw no move command.
		await a.rpc({ type: "prompt", message: `/move ${ask}` });
		await pollUntil(
			() => a.info.sessionFile === sessionKey(ask),
			"the process to be bound to the file it was moved to",
		);
		await pollUntil(
			() => ownOf(t.approval, sessionKey(ask))?.mode === "ask",
			"the choice to be kept for the file it moved to",
		);
		expect(a.info.guard).toEqual({ config: { ...GLOBAL, mode: "ask" }, own: { mode: "ask" } });
		expect(t.word(0)?.mode).toBe("ask");

		// Off is not what the conversation it moved to chose, and is not carried there.
		const off = t.file("off");
		a.changeGuard({ mode: "off" });
		await a.rpc({ type: "prompt", message: `/move ${off}` });
		await pollUntil(() => a.info.sessionFile === sessionKey(off), "the process to be bound to the second file");
		await pollUntil(() => a.info.guard?.own === undefined, "the process to be under the settings again");
		expect(a.info.guard).toEqual({ config: GLOBAL });
		expect(t.word(0)?.mode).toBe("reviewer");
		expect(t.approval.sessionGuard(sessionKey(off))).toEqual(NO_GUARD);
	});

	test("moves are sent one at a time, each settled before the next: a fork sent behind a switch is a fork of the conversation switched to", async () => {
		const t = setup();
		const a = await t.open("a");
		const c = t.file("c");
		a.changeGuard({ mode: "off" });
		t.approval.rememberGuard(sessionKey(c), { mode: "ask" });
		// Both are sent without waiting for the answer to the first.
		const [switched, forked] = await Promise.all([
			a.rpc({ type: "switch_session", sessionPath: c }),
			a.rpc({ type: "fork" }),
		]);
		expect(switched.success && forked.success).toBe(true);
		const fork = `${sessionKey(c).replace(/\.jsonl$/, "")}-1.jsonl`;
		expect(a.info.sessionFile).toBe(fork);
		// The fork of C is under C's choice, not under the Off the process had before it was switched to C.
		expect(a.info.guard?.own).toEqual({ mode: "ask" });
		expect(ownOf(t.approval, sessionKey(fork))).toEqual({ mode: "ask" });
		expect(t.word(0)?.mode).toBe("ask");
		// What A chose is A's: it did not follow the process.
		expect(ownOf(t.approval, sessionKey(c))).toEqual({ mode: "ask" });
		// The fork was not sent until the state after the switch had been read.
		const order = t.sent().filter((type) => ["switch_session", "fork", "get_state"].includes(type));
		expect(order.slice(order.indexOf("switch_session"))).toEqual(["switch_session", "get_state", "fork", "get_state"]);
	});

	test("a cancelled fork changes nothing, and the next move is judged on its own", async () => {
		const t = setup();
		const a = await t.open("a");
		const first = a.info.sessionFile ?? "";
		a.changeGuard({ mode: "off" });
		const cancelled = await a.rpc({ type: "fork", cancel: true });
		expect(cancelled.success).toBe(true);
		expect(a.info.sessionFile).toBe(first);
		expect(a.info.guard?.own).toEqual({ mode: "off" });
		expect(t.word(0)?.mode).toBe("off");
		// The fork that was cancelled is not what a later move omp makes itself is taken for: Off does not follow it.
		const other = t.file("other");
		await a.rpc({ type: "prompt", message: `/move ${other}` });
		await pollUntil(
			() => a.info.sessionFile === sessionKey(other),
			"the process to be bound to the file it was moved to",
		);
		await pollUntil(() => a.info.guard?.own === undefined, "the process to be under the settings again");
		expect(a.info.guard).toEqual({ config: GLOBAL });
		// A fork after it goes along as any fork does.
		a.changeGuard({ mode: "ask" });
		await a.rpc({ type: "fork" });
		expect(a.info.guard?.own).toEqual({ mode: "ask" });
	});

	test("an edit of a conversation whose record was damaged keeps the mode it is under: it is not left following Settings, which may say Off", async () => {
		const t = setup();
		const path = t.file("a");
		writeFileSync(join(t.dir, "approval.json"), JSON.stringify({ guard: { [sessionKey(path)]: "off" } }));
		const next = t.next();
		const live = await next.pool.open({ kind: "resume", sessionFile: path }, async () => tmpdir());
		t.global.config = { mode: "off", reviewer: "g/one", askWhenUnavailable: false, askWhenDenied: true };
		next.pool.syncRisk();
		expect(live.info.guard).toEqual({
			config: { mode: "reviewer", reviewer: "g/one", askWhenUnavailable: true, askWhenDenied: true },
			damaged: true,
		});
		// Only the reviewer is edited: what the panel showed for the mode and the switch is what they stay.
		live.changeGuard({ reviewer: "x/y" });
		expect(live.info.guard).toEqual({
			config: { mode: "reviewer", reviewer: "x/y", askWhenUnavailable: true, askWhenDenied: true },
			own: { mode: "reviewer", reviewer: "x/y", askWhenUnavailable: true },
		});
		expect(t.word(0)).toMatchObject({ mode: "reviewer", reviewers: ["x/y"], askWhenUnavailable: true });
		// And the settings moving to Ask me does not move it: it chose.
		t.global.config = { ...t.global.config, mode: "ask" };
		next.pool.syncRisk();
		expect(t.word(0)?.mode).toBe("reviewer");
	});

	test("a move omp made itself takes along only a field that is stricter than what the conversation it moved to gets by following Settings", async () => {
		const t = setup();
		const a = await t.open("a");
		// Settings say Ask me, and this conversation chose the weaker Reviewer model: it must not make the other one weaker.
		t.global.config = { mode: "ask", reviewer: "g/one", askWhenUnavailable: true, askWhenDenied: true };
		t.pool.syncRisk();
		a.changeGuard({ mode: "reviewer", reviewer: "mine/one" });
		const b = t.file("b");
		await a.rpc({ type: "prompt", message: `/move ${b}` });
		await pollUntil(() => a.info.sessionFile === sessionKey(b), "the process to be bound to the file it was moved to");
		await pollUntil(() => a.info.guard?.own === undefined, "the process to follow the settings again");
		expect(a.info.guard).toEqual({ config: t.global.config });
		expect(t.word(0)).toMatchObject({ mode: "ask", reviewers: ["g/one"] });
		expect(t.approval.sessionGuard(sessionKey(b))).toEqual(NO_GUARD);

		// The switch is the same: one that asks goes along where the settings do not ask, and one that refuses does not where they ask.
		t.global.config = { mode: "reviewer", reviewer: "g/one", askWhenUnavailable: false, askWhenDenied: true };
		t.pool.syncRisk();
		a.changeGuard({ askWhenUnavailable: true, reviewer: "mine/two" });
		const c = t.file("c");
		await a.rpc({ type: "prompt", message: `/move ${c}` });
		await pollUntil(() => a.info.sessionFile === sessionKey(c), "the process to be bound to the second file");
		await pollUntil(() => ownOf(t.approval, sessionKey(c)) !== null, "the switch to be kept for the file it moved to");
		expect(a.info.guard).toEqual({
			config: { ...t.global.config, askWhenUnavailable: true },
			own: { askWhenUnavailable: true },
		});
		t.global.config = { mode: "reviewer", reviewer: "g/one", askWhenUnavailable: true, askWhenDenied: true };
		t.pool.syncRisk();
		a.changeGuard({ askWhenUnavailable: false });
		const d = t.file("d");
		await a.rpc({ type: "prompt", message: `/move ${d}` });
		await pollUntil(() => a.info.sessionFile === sessionKey(d), "the process to be bound to the third file");
		await pollUntil(() => a.info.guard?.own === undefined, "the process to follow the settings again");
		expect(a.info.guard).toEqual({ config: t.global.config });
	});

	test("what a move leaves behind is `strictOnly` of the settings and what the process had", () => {
		const own = (o: GuardOverride): KeptGuard => ({ own: o, damaged: false });
		const ask: GuardConfig = { mode: "ask", reviewer: "g/one", askWhenUnavailable: false, askWhenDenied: true };
		const rev: GuardConfig = { mode: "reviewer", reviewer: "g/one", askWhenUnavailable: false, askWhenDenied: true };
		const off: GuardConfig = { mode: "off", reviewer: "g/one", askWhenUnavailable: false, askWhenDenied: true };
		expect(strictOnly(rev, own({ mode: "ask" }))).toEqual(own({ mode: "ask" }));
		expect(strictOnly(off, own({ mode: "reviewer" }))).toEqual(own({ mode: "reviewer" }));
		// No stricter than following: nothing goes.
		expect(strictOnly(ask, own({ mode: "reviewer" }))).toEqual(NO_GUARD);
		expect(strictOnly(ask, own({ mode: "ask" }))).toEqual(NO_GUARD);
		expect(strictOnly(rev, own({ mode: "off" }))).toEqual(NO_GUARD);
		expect(strictOnly(rev, own({ reviewer: "x/y" }))).toEqual(NO_GUARD);
		expect(strictOnly(rev, NO_GUARD)).toEqual(NO_GUARD);
		expect(strictOnly(rev, own({ askWhenUnavailable: true }))).toEqual(own({ askWhenUnavailable: true }));
		expect(strictOnly({ ...rev, askWhenUnavailable: true }, own({ askWhenUnavailable: false }))).toEqual(NO_GUARD);
		// A reviewer's denial that is final goes along where the settings put denials to the person, not the other way.
		expect(strictOnly(rev, own({ askWhenDenied: false }))).toEqual(own({ askWhenDenied: false }));
		expect(strictOnly({ ...rev, askWhenDenied: false }, own({ askWhenDenied: true }))).toEqual(NO_GUARD);
		// Damage is the default at least: what is stricter than the settings in it goes, as fields, and never as damage.
		expect(strictOnly(off, DAMAGED_GUARD)).toEqual(own({ mode: "reviewer", askWhenUnavailable: true }));
		expect(strictOnly(ask, DAMAGED_GUARD)).toEqual(own({ askWhenUnavailable: true }));
	});

	test("a fork of a conversation whose record was damaged is damaged too, and is read so when its file is opened again", async () => {
		const t = setup();
		const path = t.file("a");
		writeFileSync(join(t.dir, "approval.json"), JSON.stringify({ guard: { [sessionKey(path)]: "off" } }));
		const next = t.next();
		const live = await next.pool.open({ kind: "resume", sessionFile: path }, async () => tmpdir());
		expect(live.info.guard?.damaged).toBe(true);
		await live.rpc({ type: "fork" });
		const fork = live.info.sessionFile ?? "";
		expect(fork).not.toBe(sessionKey(path));
		expect(live.info.guard?.damaged).toBe(true);
		expect(next.pool.keptGuard(fork)).toEqual(DAMAGED_GUARD);
		const written: { guard?: Record<string, unknown> } = JSON.parse(readFileSync(join(t.dir, "approval.json"), "utf8"));
		expect(written.guard?.[fork]).toBe("damaged");
		// Global Off, a server later, the fork opened again: not Off.
		t.global.config = { mode: "off", reviewer: "", askWhenUnavailable: false, askWhenDenied: true };
		// The scripted omp wrote no file for its fork; a conversation is opened again from its file.
		writeFileSync(fork, "");
		const later = t.next();
		const again = await later.pool.open({ kind: "resume", sessionFile: fork }, async () => tmpdir());
		expect(again.info.guard).toEqual({
			config: { mode: "reviewer", reviewer: "", askWhenUnavailable: true, askWhenDenied: true },
			damaged: true,
		});
	});
});
