import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statsFromDb, timeZoneOr } from "../../server/omp/stats-db.ts";
import { TOP_CONVERSATIONS } from "../../shared/usage-analysis.ts";
import { removeScratch } from "../support/scratch.ts";

/**
 * The parts of Usage & cost that omp's answer has none for (v0.19.0 part 3): the range's conversations, tools, errors and
 * hours of the day, read from omp's statistics database. Each is bounded by the range the page asked, and a database
 * without what a part reads leaves only that part out.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-stats-analysis-"));
afterAll(() => removeScratch(root));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 25, 10);
const WINDOW = { from: T0, to: T0 + 2 * DAY };

interface Message {
	at: number;
	file: string;
	model?: string;
	agent?: string;
	stop?: string;
	error?: string | null;
	cost?: number;
	tokens?: number;
}

interface Call {
	at: number;
	tool: string;
	error?: 0 | 1 | null;
	result?: number | null;
}

/** A database of omp's schema, less the columns and tables named in `without`. */
function makeDb(name: string, messages: Message[], calls: Call[] = [], without: string[] = []): string {
	const path = join(root, `${name}.db`);
	const db = new Database(path, { create: true });
	const columns = [
		"session_file TEXT",
		"entry_id TEXT",
		"folder TEXT",
		"model TEXT",
		"provider TEXT",
		"timestamp INTEGER",
		"duration INTEGER",
		"ttft INTEGER",
		"stop_reason TEXT",
		"error_message TEXT",
		"input_tokens INTEGER",
		"output_tokens INTEGER",
		"cache_read_tokens INTEGER",
		"cache_write_tokens INTEGER",
		"total_tokens INTEGER",
		"premium_requests REAL",
		"cost_input REAL",
		"cost_output REAL",
		"cost_cache_read REAL",
		"cost_cache_write REAL",
		"cost_total REAL",
		"cost_no_cache_input REAL",
		"cost_unpriced INTEGER",
		"agent_type TEXT",
	].filter((c) => !without.includes(c.split(" ")[0] as string));
	db.run(`CREATE TABLE messages (id INTEGER PRIMARY KEY, ${columns.join(", ")})`);
	const has = (c: string) => !without.includes(c);
	messages.forEach((m, i) => {
		const row: Record<string, string | number | null> = {
			session_file: m.file,
			entry_id: `e${i}`,
			folder: "-work-app",
			model: m.model ?? "opus",
			provider: "anthropic",
			timestamp: m.at,
			duration: 1000,
			ttft: 100,
			stop_reason: m.stop ?? (m.error !== undefined ? "error" : "stop"),
			error_message: m.error ?? null,
			input_tokens: 10,
			output_tokens: 10,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			total_tokens: m.tokens ?? 20,
			premium_requests: 0,
			cost_input: 0,
			cost_output: 0,
			cost_cache_read: 0,
			cost_cache_write: 0,
			cost_total: m.cost ?? 1,
			cost_no_cache_input: 0,
			cost_unpriced: 0,
			agent_type: m.agent ?? "main",
		};
		const keys = Object.keys(row).filter(has);
		db.prepare(`INSERT INTO messages (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(
			...keys.map((k) => row[k] ?? null),
		);
	});
	if (!without.includes("tool_calls")) {
		const callColumns = ["tool_name TEXT", "timestamp INTEGER", "is_error INTEGER", "result_chars INTEGER"].filter(
			(c) => !without.includes(c.split(" ")[0] as string),
		);
		db.run(`CREATE TABLE tool_calls (id INTEGER PRIMARY KEY, ${callColumns.join(", ")})`);
		for (const c of calls) {
			const row: Record<string, string | number | null> = {
				tool_name: c.tool,
				timestamp: c.at,
				is_error: c.error === undefined ? 0 : c.error,
				result_chars: c.result === undefined ? 100 : c.result,
			};
			const keys = Object.keys(row).filter(has);
			db.prepare(`INSERT INTO tool_calls (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(
				...keys.map((k) => row[k] ?? null),
			);
		}
	}
	db.close();
	return path;
}

/** A conversation on disk: its transcript, and a subagent's and that subagent's own beside it, as omp keeps them. */
function conversation(name: string) {
	const dir = join(root, "sessions", "-work-app");
	const main = join(dir, `${name}.jsonl`);
	const scout = join(dir, name, "0-Scout.jsonl");
	const deep = join(dir, name, "0-Scout", "1-Deep.jsonl");
	const advisor = join(dir, name, "__advisor.jsonl");
	mkdirSync(join(dir, name, "0-Scout"), { recursive: true });
	for (const f of [main, scout, deep, advisor]) writeFileSync(f, "");
	return { main, scout, deep, advisor };
}

test("a conversation is its own requests and its subagents' and advisor's, in the range only, the costliest first", () => {
	const a = conversation("a");
	const b = conversation("b");
	const path = makeDb("conversations", [
		{ at: T0 - 1, file: a.main, cost: 100 }, // before the range
		{ at: T0, file: a.main, model: "opus", cost: 2, tokens: 30 },
		{ at: T0 + HOUR, file: a.scout, model: "haiku", agent: "subagent", cost: 0.5 },
		{ at: T0 + 2 * HOUR, file: a.deep, model: "haiku", agent: "subagent", cost: 0.25 },
		{ at: T0 + 3 * HOUR, file: a.advisor, model: "sonnet", agent: "advisor", cost: 1 },
		{ at: T0 + DAY, file: b.main, model: "sonnet", cost: 5 },
		{ at: T0 + 2 * DAY + 1, file: b.main, cost: 100 }, // after the range
	]);
	const s = statsFromDb(path, WINDOW, "day");
	expect(s?.analysis.conversations).toEqual([
		{
			file: realpathSync(b.main),
			folder: "-work-app",
			requests: 1,
			tokens: 20,
			cost: 5,
			subagentCost: 0,
			advisorCost: 0,
			models: ["sonnet"],
			lastTimestamp: T0 + DAY,
		},
		{
			file: realpathSync(a.main),
			folder: "-work-app",
			requests: 4,
			tokens: 90,
			cost: 3.75,
			subagentCost: 0.75,
			advisorCost: 1,
			models: ["opus", "sonnet", "haiku"],
			lastTimestamp: T0 + 3 * HOUR,
		},
	]);
});

test("a conversation moved to another folder is one, at the path it is at now; a subagent of nothing omp holds is its own", () => {
	const now = conversation("moved");
	// Its old transcripts: gone from disk, still in omp's rows.
	const old = join(root, "sessions", "-old-place", "moved.jsonl");
	const oldScout = join(root, "sessions", "-old-place", "moved", "0-Scout.jsonl");
	const strayA = join(root, "sessions", "-x", "gone-a", "__advisor.jsonl");
	const strayB = join(root, "sessions", "-x", "gone-b", "__advisor.jsonl");
	const path = makeDb("moved", [
		{ at: T0, file: old, cost: 3 },
		{ at: T0 + 1, file: oldScout, agent: "subagent", cost: 2 },
		{ at: T0 + 2, file: now.main, cost: 1 },
		{ at: T0 + 3, file: strayA, agent: "advisor", cost: 0.5 },
		{ at: T0 + 4, file: strayB, agent: "advisor", cost: 0.25 },
	]);
	const listed = statsFromDb(path, WINDOW, "day")?.analysis.conversations ?? [];
	// The strays' folders are gone too: their paths are the real path of what is left of them.
	const real = (p: string) => join(realpathSync(root), p.slice(root.length));
	expect(listed.map((c) => [c.file, c.requests, c.cost, c.subagentCost, c.advisorCost])).toEqual([
		[realpathSync(now.main), 3, 6, 2, 0],
		[real(strayA), 1, 0.5, 0, 0.5],
		[real(strayB), 1, 0.25, 0, 0.25],
	]);
});

test("at most the costliest conversations are listed", () => {
	const many = Array.from({ length: TOP_CONVERSATIONS + 5 }, (_, i) => ({
		at: T0 + i,
		file: join(root, "flat", `${i}.jsonl`),
		cost: i,
	}));
	const listed = statsFromDb(makeDb("many", many), WINDOW, "day")?.analysis.conversations ?? [];
	expect(listed).toHaveLength(TOP_CONVERSATIONS);
	expect(listed[0]?.cost).toBe(TOP_CONVERSATIONS + 4);
});

test("tools count their calls and errors in the range; the error share and size are over the calls with a result", () => {
	const path = makeDb(
		"tools",
		[{ at: T0, file: "x.jsonl" }],
		[
			{ at: T0 - 1, tool: "bash", error: 1 }, // before the range
			{ at: T0, tool: "bash", error: 0, result: 100 },
			{ at: T0 + 1, tool: "bash", error: 1, result: 300 },
			// Still waiting for its result: a call, in neither the share nor the size.
			{ at: T0 + 2, tool: "bash", error: null, result: null },
			{ at: T0 + 3, tool: "read", error: 0, result: 50 },
			{ at: T0 + 2 * DAY + 1, tool: "read", error: 1 }, // after the range
		],
	);
	expect(statsFromDb(path, WINDOW, "day")?.analysis.tools).toEqual([
		{ tool: "bash", calls: 3, errors: 1, errorRate: 0.5, avgResultChars: 200 },
		{ tool: "read", calls: 1, errors: 0, errorRate: 0, avgResultChars: 50 },
	]);
});

test("errors are grouped by model and message, the most frequent first, with when each was last seen", () => {
	const path = makeDb("errors", [
		{ at: T0 - 1, file: "x.jsonl", error: "overloaded" }, // before the range
		{ at: T0, file: "x.jsonl", model: "opus", error: "overloaded" },
		{ at: T0 + HOUR, file: "x.jsonl", model: "opus", error: "overloaded" },
		{ at: T0 + 2 * HOUR, file: "x.jsonl", model: "sonnet", error: "overloaded" },
		{ at: T0 + 3 * HOUR, file: "x.jsonl", model: "opus", error: null },
		{ at: T0 + 4 * HOUR, file: "x.jsonl", model: "opus", stop: "stop" },
	]);
	expect(statsFromDb(path, WINDOW, "day")?.analysis.errors).toEqual([
		{ provider: "anthropic", model: "opus", message: "overloaded", count: 2, lastTimestamp: T0 + HOUR },
		{ provider: "anthropic", model: "opus", message: null, count: 1, lastTimestamp: T0 + 3 * HOUR },
		{ provider: "anthropic", model: "sonnet", message: "overloaded", count: 1, lastTimestamp: T0 + 2 * HOUR },
	]);
});

test("the hours of the day are the page's clock: a half-hour zone and summer time put a request in the hour it said", () => {
	const winter = Date.UTC(2026, 0, 15, 14);
	const summer = Date.UTC(2026, 6, 15, 14);
	const path = makeDb("hours", [
		{ at: winter, file: "x.jsonl", cost: 1 },
		{ at: summer, file: "x.jsonl", cost: 2 },
		{ at: summer + 45 * 60_000, file: "x.jsonl", cost: 4 },
	]);
	const at = (timeZone: string) => {
		const hours = statsFromDb(path, { from: 0, to: summer + DAY }, "day", timeZone)?.analysis.hours ?? [];
		expect(hours).toHaveLength(24);
		return hours.filter((h) => h.requests > 0).map((h) => [h.hour, h.requests, h.cost]);
	};
	// New York: 09:00 in winter (UTC−5), 10:00 and 10:45 in summer (UTC−4).
	expect(at("America/New_York")).toEqual([
		[9, 1, 1],
		[10, 2, 6],
	]);
	// Kolkata (UTC+5:30): 19:30, 19:30 and 20:15; a whole UTC hour would have put the last one at 19.
	expect(at("Asia/Kolkata")).toEqual([
		[19, 2, 3],
		[20, 1, 4],
	]);
	expect(statsFromDb(path, { from: 0, to: summer + DAY }, "day")?.analysis.timeZone).toBe("UTC");
});

test("a time zone the server does not know is UTC", () => {
	expect(timeZoneOr("Europe/Berlin")).toBe("Europe/Berlin");
	expect(timeZoneOr("Mars/Olympus")).toBe("UTC");
	expect(timeZoneOr("")).toBe("UTC");
	expect(timeZoneOr(null)).toBe("UTC");
});

test("a database without what a part reads leaves that part out and keeps the rest", () => {
	const messages: Message[] = [{ at: T0, file: "x.jsonl", error: "boom" }];
	const calls: Call[] = [{ at: T0, tool: "bash" }];
	const full = statsFromDb(makeDb("full", messages, calls), WINDOW, "day");
	expect(full?.analysis.conversations).toHaveLength(1);
	expect(full?.analysis.tools).toHaveLength(1);
	expect(full?.analysis.errors).toHaveLength(1);

	const noErrors = statsFromDb(makeDb("no-error-message", messages, calls, ["error_message"]), WINDOW, "day");
	expect(noErrors?.overall.totalRequests).toBe(1);
	expect(noErrors?.analysis.errors).toBeNull();
	expect(noErrors?.analysis.tools).toHaveLength(1);

	const noFiles = statsFromDb(makeDb("no-session-file", messages, calls, ["session_file"]), WINDOW, "day");
	expect(noFiles?.analysis.conversations).toBeNull();
	expect(noFiles?.analysis.errors).toHaveLength(1);

	const noTools = statsFromDb(makeDb("no-tool-calls", messages, calls, ["tool_calls"]), WINDOW, "day");
	expect(noTools?.analysis.tools).toBeNull();
	expect(noTools?.analysis.conversations).toHaveLength(1);
	expect(noTools?.analysis.hours?.reduce((n, h) => n + h.requests, 0)).toBe(1);

	const oldTools = statsFromDb(makeDb("no-result-chars", messages, calls, ["result_chars"]), WINDOW, "day");
	expect(oldTools?.analysis.tools).toBeNull();
	expect(oldTools?.byModel).toHaveLength(1);
});
