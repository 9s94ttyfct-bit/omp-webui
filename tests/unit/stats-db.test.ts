import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentTypesOf,
	dayStartIn,
	entryKey,
	holdsLatest,
	inPageDays,
	statsDbPath,
	statsForRange,
	statsFromDb,
} from "../../server/omp/stats-db.ts";
import { removeScratch } from "../support/scratch.ts";

/**
 * Usage & cost over any range (#714) is read from omp's statistics database. These are the figures a page shows; the
 * contract test holds the formulas equal to omp's own answer.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-stats-db-"));
afterAll(() => removeScratch(root));

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 25, 10);

interface Row {
	at: number;
	model?: string;
	folder?: string;
	agent?: string;
	stop?: string;
	cost?: number;
	duration?: number | null;
	output?: number;
}

function makeDb(name: string, rows: Row[], columns = true): string {
	const path = join(root, `${name}.db`);
	const db = new Database(path, { create: true });
	db.run(`CREATE TABLE messages (id INTEGER PRIMARY KEY, session_file TEXT, entry_id TEXT, folder TEXT, model TEXT,
		provider TEXT, api TEXT, timestamp INTEGER, duration INTEGER, ttft INTEGER, stop_reason TEXT, error_message TEXT,
		input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_tokens INTEGER,
		premium_requests REAL, cost_input REAL, cost_output REAL, cost_cache_read REAL, cost_cache_write REAL, cost_total REAL,
		cost_no_cache_input REAL, cost_unpriced INTEGER${columns ? ", agent_type TEXT" : ""}, service_tier TEXT)`);
	const insert = db.prepare(
		`INSERT INTO messages (session_file, entry_id, folder, model, provider, api, timestamp, duration, ttft, stop_reason,
			input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests, cost_input,
			cost_output, cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, cost_unpriced${columns ? ", agent_type" : ""})
		VALUES (?, ?, ?, ?, 'anthropic', 'x', ?, ?, 100, ?, 10, ?, 90, 0, ?, 0, 0.1, 0.2, 0.3, 0, ?, 1.6, 0${columns ? ", ?" : ""})`,
	);
	rows.forEach((r, i) => {
		const output = r.output ?? 50;
		const values = [
			"s.jsonl",
			`e${i}`,
			r.folder ?? "-a",
			r.model ?? "opus",
			r.at,
			r.duration === undefined ? 1000 : r.duration,
			r.stop ?? "stop",
			output,
			100 + output,
			r.cost ?? 1,
		];
		insert.run(...(columns ? [...values, r.agent ?? "main"] : values));
	});
	db.close();
	return path;
}

const rows: Row[] = [
	{ at: T0 - 1, cost: 100 }, // before the window
	{ at: T0, model: "opus", cost: 2 },
	{ at: T0 + 1_000, model: "opus", cost: 3, stop: "error", duration: null },
	{ at: T0 + 2 * 3_600_000, model: "sonnet", folder: "-b", cost: 1, agent: "advisor" },
	{ at: T0 + DAY, model: "sonnet", cost: 4 },
	{ at: T0 + 2 * DAY, model: "opus", cost: 5, output: 0 },
	{ at: T0 + 2 * DAY + 1, cost: 100 }, // after the window
];

test("the window's requests and nothing outside it are counted, with omp's derived figures", () => {
	const path = makeDb("main", rows);
	const s = statsFromDb(path, { from: T0, to: T0 + 2 * DAY }, "day");
	expect(s).not.toBeNull();
	if (!s) return;
	expect(s.overall.totalRequests).toBe(5);
	expect(s.overall.failedRequests).toBe(1);
	expect(s.overall.successfulRequests).toBe(4);
	expect(s.overall.errorRate).toBeCloseTo(0.2);
	expect(s.overall.totalCost).toBeCloseTo(15);
	expect(s.overall.firstTimestamp).toBe(T0);
	expect(s.overall.lastTimestamp).toBe(T0 + 2 * DAY);
	// Cache rate is cache reads over all input: 90 / (10 + 90) for every row.
	expect(s.overall.cacheRate).toBeCloseTo(0.9);
	// Saving: 1 − (input + cache read + cache write cost) / what the input would have cost uncached = 1 − 0.4 / 1.6.
	expect(s.overall.cacheSavings).toBeCloseTo(0.75);
	// Speed only over requests that took time and wrote something: three of 50 tokens in a second.
	expect(s.overall.avgTokensPerSecond).toBeCloseTo(50);
	// The failed request recorded no duration: the average is over the four that did.
	expect(s.overall.avgDuration).toBeCloseTo(1000);
});

test("models, folders and agent types are split, the costliest first", () => {
	const s = statsFromDb(makeDb("split", rows), { from: T0, to: T0 + 2 * DAY }, "day");
	if (!s) throw new Error("no stats");
	expect(s.byModel.map((m) => [m.model, m.totalRequests, m.totalCost])).toEqual([
		["opus", 3, 10],
		["sonnet", 2, 5],
	]);
	expect(s.byFolder.map((f) => [f.folder, f.totalRequests])).toEqual([
		["-a", 4],
		["-b", 1],
	]);
	expect(s.byAgentType.map((a) => [a.agentType, a.totalRequests])).toEqual([
		["main", 4],
		["advisor", 1],
	]);
});

test("charts step by day beyond a day (UTC's without a time zone), by UTC hour within it; cost is by day either way", () => {
	const path = makeDb("series", rows);
	const days = statsFromDb(path, { from: T0, to: T0 + 2 * DAY }, "day");
	if (!days) throw new Error("no stats");
	const midnight = Date.UTC(2026, 9, 25);
	expect(days.timeSeries.map((b) => [b.timestamp, b.requests, b.errors])).toEqual([
		[midnight, 3, 1],
		[midnight + DAY, 1, 0],
		[midnight + 2 * DAY, 1, 0],
	]);
	const hours = statsFromDb(path, { from: T0, to: T0 + DAY - 1 }, "hour");
	if (!hours) throw new Error("no stats");
	expect(hours.timeSeries.map((b) => [b.timestamp, b.requests])).toEqual([
		[T0, 2],
		[T0 + 2 * 3_600_000, 1],
	]);
	expect(hours.costSeries.map((c) => [c.timestamp, c.model, c.requests])).toEqual([
		[midnight, "opus", 2],
		[midnight, "sonnet", 1],
	]);
});

/** Late on 14 November in Chicago, the 15th in UTC and Shanghai; and the days the US clocks move in 2026. */
const LATE = Date.UTC(2026, 10, 15, 3);
const SPRING = Date.UTC(2026, 2, 8, 12);
const FALL = Date.UTC(2026, 10, 1, 12);

test("a day of the charts is the page's day, from its own midnight, on the days the clocks move too", () => {
	const path = makeDb("page-days", [{ at: SPRING }, { at: FALL }, { at: LATE }]);
	const days = (timeZone: string) => {
		const s = statsFromDb(path, { from: 0, to: LATE + DAY }, "day", timeZone);
		if (!s) throw new Error("no stats");
		expect(s.timeSeries.map((b) => b.timestamp)).toEqual(s.costSeries.map((c) => c.timestamp));
		return s.costSeries.map((c) => c.timestamp);
	};
	// Chicago: midnight of 8 March is still on winter time (UTC−6), of 1 November still on summer time (UTC−5).
	expect(days("America/Chicago")).toEqual([
		Date.UTC(2026, 2, 8, 6),
		Date.UTC(2026, 10, 1, 5),
		Date.UTC(2026, 10, 14, 6),
	]);
	expect(days("Asia/Shanghai")).toEqual([
		Date.UTC(2026, 2, 7, 16),
		Date.UTC(2026, 9, 31, 16),
		Date.UTC(2026, 10, 14, 16),
	]);
	expect(days("UTC")).toEqual([Date.UTC(2026, 2, 8), Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 15)]);
	// UTC+14: 17:00 on the 15th.
	expect(dayStartIn(LATE, "Pacific/Kiritimati")).toBe(Date.UTC(2026, 10, 14, 10));
	// Kolkata (UTC+5:30): 08:30 on the 15th.
	expect(dayStartIn(LATE, "Asia/Kolkata")).toBe(Date.UTC(2026, 10, 14, 18, 30));
});

test("requests minutes apart across a half-hour zone's midnight, in one UTC hour, are counted in their own days", () => {
	// 18:20Z and 18:40Z on 14 November: 23:50 and 00:10 in Kolkata (UTC+5:30); 00:05 and 00:25 in Kathmandu (UTC+5:45),
	// where 18:10Z is 23:55 the day before.
	const path = makeDb("half-hour-midnight", [
		{ at: Date.UTC(2026, 10, 14, 18, 10), cost: 1 },
		{ at: Date.UTC(2026, 10, 14, 18, 20), cost: 2 },
		{ at: Date.UTC(2026, 10, 14, 18, 40), cost: 4 },
	]);
	const days = (timeZone: string) =>
		(statsFromDb(path, { from: 0, to: LATE + DAY }, "day", timeZone)?.costSeries ?? []).map((c) => [
			c.timestamp,
			c.requests,
			c.cost,
		]);
	expect(days("Asia/Kolkata")).toEqual([
		[Date.UTC(2026, 10, 13, 18, 30), 2, 3],
		[Date.UTC(2026, 10, 14, 18, 30), 1, 4],
	]);
	expect(days("Asia/Kathmandu")).toEqual([
		[Date.UTC(2026, 10, 13, 18, 15), 1, 1],
		[Date.UTC(2026, 10, 14, 18, 15), 2, 6],
	]);
});

test("omp's own answer (the database unread) has its days moved to the page's, whichever omp counted them", () => {
	const body = (timestamp: number) => JSON.stringify({ overall: {}, costSeries: [{ timestamp, model: "m", cost: 1 }] });
	const day = (answer: string) =>
		(JSON.parse(answer) as { costSeries: { timestamp: number }[] }).costSeries[0].timestamp;
	// Before omp 18.20.1 a day is UTC's (00:00Z), wherever the server is.
	const utc = Date.UTC(2026, 9, 19);
	expect(day(inPageDays(body(utc), "America/Chicago", "Asia/Shanghai"))).toBe(Date.UTC(2026, 9, 19, 5));
	expect(day(inPageDays(body(utc), "Asia/Shanghai", "America/Chicago"))).toBe(Date.UTC(2026, 9, 18, 16));
	// Since, it is the server's: midnight of 19 October in Shanghai is the 19th in Chicago too.
	const shanghai = Date.UTC(2026, 9, 18, 16);
	expect(day(inPageDays(body(shanghai), "America/Chicago", "Asia/Shanghai"))).toBe(Date.UTC(2026, 9, 19, 5));
	expect(day(inPageDays(body(shanghai), "Asia/Shanghai", "Asia/Shanghai"))).toBe(shanghai);
	// A server whose midnight is 00:00Z (London in winter) counts the same day either way.
	expect(day(inPageDays(body(Date.UTC(2026, 0, 10)), "America/Chicago", "Europe/London"))).toBe(
		Date.UTC(2026, 0, 10, 6),
	);
	expect(inPageDays("not json", "UTC")).toBe("not json");
	expect(inPageDays('{"overall":{}}', "UTC")).toBe('{"overall":{}}');
	// The answer of a range whose database is not the one omp read is omp's, in the page's days.
	const path = makeDb("fallback-days", rows);
	const fallback = statsForRange(
		JSON.stringify({ overall: { lastTimestamp: T0 + 9 * DAY }, costSeries: [{ timestamp: utc, model: "m" }] }),
		"7d",
		path,
		T0 + 10 * DAY,
		"America/Chicago",
	);
	expect(fallback.window).toBeNull();
	expect(day(fallback.body)).toBe(Date.UTC(2026, 9, 19, 5));
});

test("a database without a column the queries read, or no database, gives no figures", () => {
	expect(statsFromDb(makeDb("old", rows, false), { from: 0, to: T0 * 2 }, "day")).toBeNull();
	expect(statsFromDb(join(root, "absent.db"), { from: 0, to: T0 * 2 }, "day")).toBeNull();
});

test("only a database that holds omp's last counted request is taken for omp's", () => {
	const path = makeDb("latest", rows);
	expect(holdsLatest(path, T0 + DAY)).toBe(true);
	expect(holdsLatest(path, T0 + DAY + 7)).toBe(false);
});

test("the agent type omp counted an entry under is read by the entry's id and time, and an entry omp never counted has none (#706)", () => {
	const path = makeDb("entries", [
		{ at: T0, agent: "main" },
		{ at: T0 + 1_000, agent: "subagent" },
	]);
	// makeDb names the entries e0, e1, … and puts them all in `s.jsonl`.
	const got = agentTypesOf(path, [
		{ id: "e0", at: T0 },
		{ id: "e1", at: T0 + 1_000 },
		// Not in the database: the id is, the time is not (another entry of that id), and an id it never had.
		{ id: "e1", at: T0 + 2_000 },
		{ id: "gone", at: T0 },
	]);
	expect(got).not.toBeNull();
	expect([...(got ?? new Map())]).toEqual([
		[entryKey("e0", T0), "main"],
		[entryKey("e1", T0 + 1_000), "subagent"],
	]);
	// No entries asked about: nothing read.
	expect(agentTypesOf(path, [])?.size).toBe(0);
	// A database it cannot use says nothing, which is not "none were counted".
	expect(agentTypesOf(makeDb("noagent", rows, false), [{ id: "e0", at: T0 }])).toBeNull();
	expect(agentTypesOf(join(root, "absent.db"), [{ id: "e0", at: T0 }])).toBeNull();
});

test("the database is the one omp keeps for the agent folder", () => {
	const home = join(root, "home");
	expect(statsDbPath(join(home, ".omp", "agent"), {}, home)).toBe(join(home, ".omp", "stats.db"));
	// An agent folder of its own does not move the database: omp keeps it under the config root.
	expect(statsDbPath("/elsewhere/agent", {}, home)).toBe(join(home, ".omp", "stats.db"));
	const xdg = join(root, "xdg");
	mkdirSync(join(xdg, "omp"), { recursive: true });
	expect(statsDbPath(join(home, ".omp", "agent"), { XDG_DATA_HOME: xdg }, home)).toBe(join(xdg, "omp", "stats.db"));
	// An XDG data folder omp has not made is not used.
	expect(statsDbPath(join(home, ".omp", "agent"), { XDG_DATA_HOME: join(root, "none") }, home)).toBe(
		join(home, ".omp", "stats.db"),
	);
});

test("PI_CONFIG_DIR is a folder of the home, as omp joins it, even when absolute (audit A-031)", () => {
	const home = join(root, "home");
	expect(statsDbPath(join(home, ".omp-alt", "agent"), { PI_CONFIG_DIR: ".omp-alt" }, home)).toBe(
		join(home, ".omp-alt", "stats.db"),
	);
	expect(statsDbPath("/cfg/agent", { PI_CONFIG_DIR: "/cfg" }, home)).toBe(join(home, "cfg", "stats.db"));
	// The XDG data folder takes over only for the default agent folder of that config root.
	const xdg = join(root, "xdg-alt");
	mkdirSync(join(xdg, "omp"), { recursive: true });
	expect(statsDbPath(join(home, ".omp-alt", "agent"), { PI_CONFIG_DIR: ".omp-alt", XDG_DATA_HOME: xdg }, home)).toBe(
		join(xdg, "omp", "stats.db"),
	);
});
