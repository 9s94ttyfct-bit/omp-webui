import "./browser-globals.ts";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	activeMsOf,
	addUsage,
	copyUsageFold,
	emptyUsage,
	foldEntry,
	foldUsageLine,
	isSoundUsage,
	newAcc,
	newUsageFold,
	parseSessionText,
	summarize,
	transcriptUsage,
} from "../../server/sessions/parse.ts";
import { SessionStore } from "../../server/sessions/store.ts";
import { SubagentIndex } from "../../server/sessions/subagents.ts";
import { finite } from "../../shared/guards.ts";
import type { SessionEntry } from "../../shared/protocol.ts";
import { appended } from "../../web/src/lib/lineage.ts";
import type { AgentMessage } from "../../web/src/lib/messages.ts";
import { rowSpend } from "../../web/src/lib/subagents.ts";
import { conversationTotals, sumEntries, usageByModel } from "../../web/src/lib/totals.ts";
import { stepStats, TurnTally } from "../../web/src/lib/turn-stats.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * A usage field that is not a number (a hand edit, another tool, another version of omp) was added with `+`: totals read
 * `0a`, `0[object Object]`, `NaN` and `Infinity`. Every total counts what is not a finite number as 0, in the page and in
 * the server, and a total an older version already kept malformed is summed again.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const STAMP = "2026-01-19T10:00:00.000Z";
const GOOD = { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, totalTokens: 26, cost: { total: 0.002 } };

/** Usage as a session file can hold it, with what it should count as. */
const SHAPES: [
	string,
	unknown,
	{ input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number },
][] = [
	["good", GOOD, { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, total: 26, cost: 0.002 }],
	[
		"strings",
		{ input: "a", output: "5", cacheRead: "7", cacheWrite: "", totalTokens: "26", cost: { total: "0.002" } },
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
	],
	[
		"nulls",
		{ input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null, cost: null },
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
	],
	[
		"objects and lists",
		{ input: {}, output: [], cacheRead: [1], cacheWrite: { n: 1 }, totalTokens: [], cost: { total: {} } },
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
	],
	[
		"booleans",
		{ input: true, output: false, cacheRead: true, cacheWrite: true, totalTokens: true, cost: true },
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
	],
	[
		"cost that is not an object",
		{ ...GOOD, cost: 5 },
		{ input: 3, output: 5, cacheRead: 7, cacheWrite: 11, total: 26, cost: 0 },
	],
	[
		"cost total that is not a number",
		{ ...GOOD, cost: { total: "x" } },
		{ input: 3, output: 5, cacheRead: 7, cacheWrite: 11, total: 26, cost: 0 },
	],
	[
		"some good, some bad",
		{ input: 10, output: "5", cacheRead: 3, cacheWrite: null, totalTokens: 18, cost: { total: 0.5 } },
		{ input: 10, output: 0, cacheRead: 3, cacheWrite: 0, total: 18, cost: 0.5 },
	],
	[
		"a total that is no number is made of the parts",
		{ input: 4, output: 6, cacheRead: 1, cacheWrite: 2, totalTokens: "many", cost: { total: 0.1 } },
		{ input: 4, output: 6, cacheRead: 1, cacheWrite: 2, total: 13, cost: 0.1 },
	],
	[
		"no total",
		{ input: 4, output: 6, cacheRead: 1, cacheWrite: 2 },
		{ input: 4, output: 6, cacheRead: 1, cacheWrite: 2, total: 13, cost: 0 },
	],
];

/** The shapes only a program (a live frame, a test) can make: JSON has no `NaN`, and `1e999` is read as `Infinity`. */
const NON_FINITE: [string, unknown][] = [
	[
		"NaN",
		{
			input: Number.NaN,
			output: Number.NaN,
			cacheRead: Number.NaN,
			cacheWrite: Number.NaN,
			totalTokens: Number.NaN,
			cost: { total: Number.NaN },
		},
	],
	[
		"Infinity",
		{
			input: Number.POSITIVE_INFINITY,
			output: Number.NEGATIVE_INFINITY,
			cacheRead: Number.POSITIVE_INFINITY,
			cacheWrite: Number.POSITIVE_INFINITY,
			totalTokens: Number.POSITIVE_INFINITY,
			cost: { total: Number.POSITIVE_INFINITY },
		},
	],
];

/** Whatever `usage` is, as the usage of a saved reply. */
const reply = (id: string, usage: unknown, model = "claude-haiku-5-5"): SessionEntry =>
	({
		type: "message",
		id,
		parentId: null,
		timestamp: STAMP,
		message: {
			role: "assistant",
			content: [{ type: "text", text: id }],
			provider: "anthropic",
			model,
			usage,
			timestamp: 1,
		},
	}) as unknown as SessionEntry;

const finiteAll = (o: object) => Object.values(o).every((v) => typeof v === "number" && Number.isFinite(v));

describe("finite", () => {
	test("a finite number is itself; everything else is 0", () => {
		for (const v of [0, 1, -2.5, 1e300]) expect(finite(v)).toBe(v);
		for (const v of [
			"a",
			"5",
			"",
			null,
			undefined,
			{},
			[],
			[1],
			true,
			false,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			expect(finite(v)).toBe(0);
		}
		expect(finite(JSON.parse("1e999"))).toBe(0);
	});
});

describe("the page's totals", () => {
	for (const [name, usage, want] of SHAPES) {
		test(`${name}: sumEntries, usageByModel and a step read it as numbers`, () => {
			const entries = [reply("a", usage), reply("b", usage, "claude-opus-5")];
			const sum = sumEntries(entries);
			expect(sum).toEqual({
				input: want.input * 2,
				output: want.output * 2,
				cacheRead: want.cacheRead * 2,
				cacheWrite: want.cacheWrite * 2,
				cost: want.cost * 2,
			});
			expect(usageByModel(entries)).toEqual([
				[
					"anthropic/claude-haiku-5-5",
					{ tokens: finite((usage as { totalTokens?: unknown }).totalTokens), cost: want.cost, n: 1 },
				],
				[
					"anthropic/claude-opus-5",
					{ tokens: finite((usage as { totalTokens?: unknown }).totalTokens), cost: want.cost, n: 1 },
				],
			]);
			const step = stepStats((entries[0] as unknown as { message: AgentMessage }).message, STAMP);
			expect(
				step && {
					input: step.input,
					output: step.output,
					cacheRead: step.cacheRead,
					cacheWrite: step.cacheWrite,
					cost: step.cost,
				},
			).toEqual({
				input: want.input,
				output: want.output,
				cacheRead: want.cacheRead,
				cacheWrite: want.cacheWrite,
				cost: want.cost,
			});
		});
	}

	test("what is not usage at all adds nothing, and what is not finite counts as 0", () => {
		for (const usage of ["x", 5, [1], true, null, undefined]) {
			const sum = sumEntries([reply("a", usage), reply("b", GOOD)]);
			expect(sum).toEqual({ input: 3, output: 5, cacheRead: 7, cacheWrite: 11, cost: 0.002 });
			expect(finiteAll(sum)).toBe(true);
		}
		for (const [, usage] of NON_FINITE) {
			const entries = [reply("a", usage), reply("b", GOOD)];
			expect(sumEntries(entries)).toEqual({ input: 3, output: 5, cacheRead: 7, cacheWrite: 11, cost: 0.002 });
			for (const [, v] of usageByModel(entries)) expect(finiteAll(v)).toBe(true);
		}
	});

	test("a turn's figures and a conversation's totals stay numbers", () => {
		const tally = new TurnTally();
		for (const [, usage] of [...SHAPES, ...NON_FINITE]) {
			const step = stepStats({ role: "assistant", usage, timestamp: 5 } as unknown as AgentMessage, STAMP);
			if (step) tally.add(step);
		}
		const figures = tally.figures();
		expect(figures).not.toBeNull();
		if (!figures) return;
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const)
			expect(Number.isFinite(figures[key])).toBe(true);
		const rows = [
			{
				stat: { usage: { input: "a", output: null, cacheRead: {}, cacheWrite: Number.NaN, cost: "x" } },
				live: { progress: { cost: Number.POSITIVE_INFINITY, tokens: "9" } },
			},
		];
		const spend = rowSpend(rows[0] as never);
		expect(spend).toEqual({ parts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, pending: 0 });
		const totals = conversationTotals(sumEntries([reply("a", SHAPES[1][1]), reply("b", GOOD)]), rows as never);
		const { split, ...header } = totals.usage;
		for (const v of [totals.total, totals.main, header, totals.mainUsage, totals.subagentUsage]) {
			expect(finiteAll(v)).toBe(true);
		}
		expect(split && [split.main, split.subagents].every(finiteAll)).toBe(true);
	});

	test("going on from where it was is starting from the start", () => {
		const entries = SHAPES.map(([name, usage]) => reply(name, usage));
		// Entries only ever arrive by `appended`, which is how a fold knows to go on from where it was.
		let grown: SessionEntry[] = [];
		for (const e of entries) {
			grown = appended(grown, [e]);
			expect(sumEntries(grown)).toEqual(sumEntries([...grown]));
			expect(usageByModel(grown)).toEqual(usageByModel([...grown]));
		}
		expect(finiteAll(sumEntries(grown))).toBe(true);
	});
});

describe("the server's totals", () => {
	for (const [name, usage, want] of SHAPES) {
		test(`${name}: addUsage counts what is a number`, () => {
			const totals = emptyUsage();
			addUsage(totals, usage as never);
			addUsage(totals, usage as never);
			expect(totals).toEqual({
				input: want.input * 2,
				output: want.output * 2,
				cacheRead: want.cacheRead * 2,
				cacheWrite: want.cacheWrite * 2,
				totalTokens: want.total * 2,
				cost: want.cost * 2,
				requests: 2,
			});
			expect(isSoundUsage(totals)).toBe(true);
		});
	}

	test("what is not usage adds nothing; a number that is not finite counts as 0", () => {
		for (const usage of ["x", 5, [1], true, null, undefined]) {
			const totals = emptyUsage();
			addUsage(totals, usage as never);
			expect(totals).toEqual(emptyUsage());
		}
		for (const [, usage] of NON_FINITE) {
			const totals = emptyUsage();
			addUsage(totals, usage as never);
			expect(isSoundUsage(totals)).toBe(true);
			expect(totals.requests).toBe(1);
		}
	});

	test("a transcript read as text: `1e999` is Infinity, and counts as 0 like the rest", () => {
		const lines = [
			{ type: "session", version: 3, id: "01a00000-0000-7000-8000-00000000f0f0", timestamp: STAMP, cwd: "/x" },
			reply("a", GOOD),
			reply("b", { input: "a", output: null, cacheRead: {}, cost: 5 }),
			{ type: "model_usage", id: "m1", parentId: null, timestamp: STAMP, usage: { input: "9", output: [2] } },
		].map((l) => JSON.stringify(l));
		lines.push(
			'{"type":"message","id":"c","parentId":null,"timestamp":"x","message":{"role":"assistant","usage":{"input":1e999,"output":2,"cost":{"total":1e999}}}}',
		);
		const text = lines.join("\n");
		const { usage } = transcriptUsage(text);
		expect(usage).toEqual({
			input: 3,
			output: 7,
			cacheRead: 7,
			cacheWrite: 11,
			totalTokens: 28,
			cost: 0.002,
			requests: 4,
		});
		expect(isSoundUsage(usage)).toBe(true);
		const parsed = parseSessionText(text);
		const summary = summarize("/x/f.jsonl", parsed, { mtimeMs: 1, size: text.length }, 0);
		expect(summary?.usage).toEqual(usage);
		const acc = newAcc();
		for (const e of parsed.entries) foldEntry(acc, e);
		expect(acc.usage).toEqual(usage);
	});

	test("a subagent transcript's working time: each prompt's turn to its last entry, the same read whole or as it grows (#692)", () => {
		const at = (hms: string) => `2026-10-27T${hms}.000Z`;
		const entry = (id: string, time: string, message: Record<string, unknown>) => ({
			type: "message",
			id,
			parentId: null,
			timestamp: at(time),
			message,
		});
		const lines = [
			{ type: "session", version: 3, id: "01a00000-0000-7000-8000-00000000c0c0", timestamp: at("10:00:00"), cwd: "/x" },
			entry("p1", "10:00:01", { role: "user", attribution: "agent", content: "Do it" }),
			entry("a1", "10:00:30", { role: "assistant", usage: GOOD }),
			// A tool's output that quotes a prompt does not begin a turn.
			entry("t1", "10:01:00", { role: "toolResult", content: [{ type: "text", text: '{"role":"user"}' }] }),
			entry("a2", "10:01:10", { role: "assistant", usage: GOOD }),
			// Told something an hour later: the hour in between is not work.
			entry("p2", "11:00:00", { role: "user", attribution: "agent", content: "Again" }),
			entry("a3", "11:00:20", { role: "assistant", usage: GOOD }),
		].map((l) => JSON.stringify(l));
		expect(transcriptUsage(lines.join("\n")).activeMs).toBe(69_000 + 20_000);
		const fold = newUsageFold();
		for (const line of lines.slice(0, 4)) foldUsageLine(fold, line);
		const grown = copyUsageFold(fold);
		for (const line of lines.slice(4)) foldUsageLine(grown, line);
		expect(activeMsOf(fold)).toBe(59_000);
		expect(activeMsOf(grown)).toBe(89_000);
	});

	test("isSoundUsage: seven figures that are all numbers", () => {
		expect(isSoundUsage(emptyUsage())).toBe(true);
		expect(isSoundUsage({ ...emptyUsage(), input: "0a" })).toBe(false);
		expect(isSoundUsage({ ...emptyUsage(), cost: null })).toBe(false);
		expect(isSoundUsage({ ...emptyUsage(), cacheRead: Number.NaN })).toBe(false);
		expect(isSoundUsage({ ...emptyUsage(), requests: Number.POSITIVE_INFINITY })).toBe(false);
		const { requests: _, ...missing } = emptyUsage();
		expect(isSoundUsage(missing)).toBe(false);
		expect(isSoundUsage(null)).toBe(false);
		expect(isSoundUsage("x")).toBe(false);
	});
});

describe("totals an older version kept malformed", () => {
	const root = mkdtempSync(join(tmpdir(), "ompw-usage-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	test("a stored summary with malformed totals is summed again from the file; a sound one is kept", async () => {
		const dir = join(root, "store");
		const bucket = join(dir, "sessions", "-tmp-usage");
		mkdirSync(bucket, { recursive: true });
		const db = join(dir, "index.db");
		const header = (id: string) => ({ type: "session", version: 3, id, timestamp: STAMP, cwd: "/tmp/usage" });
		const files = ["a", "b"].map((k, i) =>
			join(bucket, `2026-01-19T00-00-0${i}-000Z_01a00000-0000-7000-8000-00000000e${k}e${k}.jsonl`),
		);
		const lines = (id: string) =>
			[header(id), reply("r1", GOOD), reply("r2", GOOD)].map((e) => `${JSON.stringify(e)}\n`).join("");
		writeFileSync(files[0], lines("01a00000-0000-7000-8000-00000000eaea"));
		writeFileSync(files[1], lines("01a00000-0000-7000-8000-00000000ebeb"));

		const first = new SessionStore(join(dir, "sessions"), db);
		await first.refresh(true);
		const sound = (await first.list()).map((s) => s.usage);
		expect(sound.every(isSoundUsage)).toBe(true);
		first.close();

		// What a version that added malformed usage with `+` kept: the first file's totals are strings.
		const raw = new Database(db);
		const row = raw.query<{ summary: string }, [string]>("SELECT summary FROM sessions WHERE file = ?").get(files[0]);
		const stored = JSON.parse(row?.summary ?? "{}");
		stored.usage.input = "0a3";
		stored.usage.cost = null;
		raw.run("UPDATE sessions SET summary = ? WHERE file = ?", [JSON.stringify(stored), files[0]]);
		raw.close();

		const next = new SessionStore(join(dir, "sessions"), db);
		await next.refresh(true);
		const listed = await next.list();
		for (const s of listed) expect(isSoundUsage(s.usage) && isSoundUsage(s.subagentUsage)).toBe(true);
		const whole = summarize(files[0], parseSessionText(await Bun.file(files[0]).text()), statSync(files[0]), 0);
		expect(listed.find((s) => s.file === files[0])?.usage).toEqual(whole?.usage ?? emptyUsage());
		expect(listed.find((s) => s.file === files[0])?.usage.input).toBe(6);
		next.close();
	});

	test("a stored subagent total with malformed figures is dropped, a sound one kept", () => {
		const db = new Database(":memory:");
		db.run(
			"CREATE TABLE subagent_usage (file TEXT PRIMARY KEY, owner TEXT NOT NULL, mtime REAL, size INTEGER, started REAL, usage TEXT)",
		);
		const put = (file: string, usage: unknown) =>
			db.run("INSERT INTO subagent_usage VALUES (?, 'o', 1, 1, 1, ?)", [file, JSON.stringify(usage)]);
		put("/sound.jsonl", { ...emptyUsage(), input: 4 });
		put("/junk.jsonl", { ...emptyUsage(), input: "0a" });
		put("/null.jsonl", { ...emptyUsage(), cost: null });
		new SubagentIndex(db);
		expect(db.query("SELECT file FROM subagent_usage").all()).toEqual([{ file: "/sound.jsonl" }]);
		db.close();
	});
});
