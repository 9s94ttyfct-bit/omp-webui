import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addGuardUsage, GuardUsageIndex, transcriptKind } from "../../server/guard-usage.ts";

/**
 * What the guard's reviewer spent, as an agent type of its own on Usage & cost (#689): `omp stats` counts each of its
 * `model_usage` entries under the agent type of the transcript it is in, so it is moved out of that one, inside the same
 * window, and the totals stay omp's.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-guard-usage-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const T = Date.UTC(2026, 9, 27, 12);
const guard = (id: string, at: number, cost: number) =>
	`${JSON.stringify({
		type: "model_usage",
		id,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		purpose: "guard",
		role: "reviewer",
		provider: "openai-codex",
		model: "gpt-6-luna",
		usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, totalTokens: 160, cost: { total: cost } },
	})}\n`;
const judge = (at: number) =>
	`${JSON.stringify({ type: "model_usage", id: "j", parentId: null, timestamp: new Date(at).toISOString(), purpose: "unexpected-stop", usage: { input: 1, cost: { total: 9 } } })}\n`;
const bucket = (agentType: string, requests: number, cost: number) => ({
	agentType,
	totalRequests: requests,
	successfulRequests: requests,
	failedRequests: 0,
	totalInputTokens: 1000,
	totalOutputTokens: 1000,
	totalCacheReadTokens: 1000,
	totalCacheWriteTokens: 0,
	totalCost: cost,
});

const bucketDir = join(root, "sessions", "-tmp-p");
const conversation = join(bucketDir, "2026-10-27T10-00-00-000Z_01a.jsonl");
const subagent = join(bucketDir, "2026-10-27T10-00-00-000Z_01a", "Scout.jsonl");
mkdirSync(join(bucketDir, "2026-10-27T10-00-00-000Z_01a"), { recursive: true });
writeFileSync(conversation, guard("g1", T, 0.5) + guard("g0", T - 3 * 86_400_000, 7) + judge(T));
writeFileSync(subagent, guard("g2", T + 1000, 0.25));
writeFileSync(join(bucketDir, "2026-10-27T10-00-00-000Z_01a", "__advisor.jsonl"), "");

const stats = (byAgentType: unknown[]) =>
	JSON.stringify({
		overall: { totalRequests: 10, totalCost: 3, firstTimestamp: T - 86_400_000, lastTimestamp: T + 60_000 },
		byModel: [],
		byFolder: [],
		byAgentType,
	});

test("a transcript's agent type is omp's: an advisor by name, a subagent by its artifacts folder, else the conversation", () => {
	expect(transcriptKind(conversation)).toBe("main");
	expect(transcriptKind(subagent)).toBe("subagent");
	expect(transcriptKind(join(bucketDir, "2026-10-27T10-00-00-000Z_01a", "__advisor.jsonl"))).toBe("advisor");
});

test("the guard's requests in the window are a bucket of their own, taken out of the type omp counted them under", async () => {
	const out = JSON.parse(
		await addGuardUsage(stats([bucket("main", 6, 2), bucket("subagent", 4, 1)]), join(root, "sessions")),
	);
	const by = Object.fromEntries(out.byAgentType.map((b: { agentType: string }) => [b.agentType, b]));
	// The one from three days ago is outside the window; the judge's request is not the guard's.
	expect(by.guard).toMatchObject({ totalRequests: 2, totalInputTokens: 200, totalCacheReadTokens: 100 });
	expect(by.guard.totalCost).toBeCloseTo(0.75, 9);
	expect(by.main).toMatchObject({ totalRequests: 5, totalInputTokens: 900 });
	expect(by.main.totalCost).toBeCloseTo(1.5, 9);
	expect(by.subagent).toMatchObject({ totalRequests: 3 });
	expect(by.subagent.totalCost).toBeCloseTo(0.75, 9);
	// The cache rate of what changed is omp's figure of what is left: cache reads of what was read.
	expect(by.guard.cacheRate).toBeCloseTo(100 / 300, 9);
	expect(by.main.cacheRate).toBeCloseTo(950 / (900 + 950), 9);
	// Counted once: the buckets add up to what they did, and omp's totals are untouched.
	const total = (list: { totalCost: number }[]) => list.reduce((s, b) => s + b.totalCost, 0);
	expect(total(out.byAgentType)).toBeCloseTo(3, 9);
	expect(out.overall.totalCost).toBe(3);
});

test("a range the page asked for bounds the guard's requests, not the answer's own first and last request (#714)", async () => {
	const body = stats([bucket("main", 6, 10), bucket("subagent", 4, 1)]);
	const sessions = join(root, "sessions");
	const guardOf = async (window: { from: number; to: number }) =>
		JSON.parse(await addGuardUsage(body, sessions, window)).byAgentType.find(
			(b: { agentType: string }) => b.agentType === "guard",
		);
	// Three days back is inside a month: counted, though omp's own answer starts a day back. The subagent's request, a
	// second after the range ends, is not, though the answer's last request is a minute later.
	const month = await guardOf({ from: T - 3 * 86_400_000, to: T + 999 });
	expect(month).toMatchObject({ totalRequests: 2 });
	expect(month.totalCost).toBeCloseTo(7.5, 9);
	// One millisecond later the request three days back is outside.
	expect((await guardOf({ from: T - 3 * 86_400_000 + 1, to: T + 1000 })).totalCost).toBeCloseTo(0.75, 9);
});

test("a transcript that grows is read on from where it stopped; nothing in the window leaves omp's figures as they were", async () => {
	const index = new GuardUsageIndex(join(root, "sessions"));
	expect((await index.since(T - 86_400_000)).length).toBe(2);
	appendFileSync(subagent, guard("g3", T + 2000, 0.125));
	expect((await index.since(T - 86_400_000)).map((r) => r.at)).toContain(T + 2000);
	const empty = stats([bucket("main", 1, 1)]).replace(String(T - 86_400_000), String(T + 30_000));
	expect(await addGuardUsage(empty, join(root, "nowhere"))).toBe(empty);
});

/** The rows of omp's statistics database that matter here: one per entry omp counted, with its time and agent type. */
function ompDb(name: string, counted: { id: string; at: number; agent: string }[]): string {
	const path = join(root, `${name}.db`);
	const db = new Database(path, { create: true });
	db.run(`CREATE TABLE messages (id INTEGER PRIMARY KEY, session_file TEXT, entry_id TEXT, folder TEXT, model TEXT,
		provider TEXT, api TEXT, timestamp INTEGER, duration INTEGER, ttft INTEGER, stop_reason TEXT, error_message TEXT,
		input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_tokens INTEGER,
		premium_requests REAL, cost_input REAL, cost_output REAL, cost_cache_read REAL, cost_cache_write REAL, cost_total REAL,
		cost_no_cache_input REAL, cost_unpriced INTEGER, agent_type TEXT, service_tier TEXT)`);
	const insert = db.prepare(
		`INSERT INTO messages (session_file, entry_id, folder, model, provider, api, timestamp, stop_reason, input_tokens,
			output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
			cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, cost_unpriced, agent_type)
		VALUES ('/not/where/the/page/looks.jsonl', ?, '-tmp-q', 'm', 'p', 'x', ?, 'stop', 100, 10, 50, 0, 160, 0, 0, 0, 0, 0, 0, 0, 0, ?)`,
	);
	for (const c of counted) insert.run(c.id, c.at, c.agent);
	db.close();
	return path;
}

test("only the requests omp counted are moved out of its buckets: one it never ingested stays out of the guard's, a copy in a fork is one request (#706)", async () => {
	const sessions = join(root, "ingest", "sessions");
	const folder = join(sessions, "-tmp-q");
	mkdirSync(join(folder, "2026-10-27T10-00-00-000Z_01b"), { recursive: true });
	// g1: counted. gm: in a stretch of the transcript omp never ingested. g2 (a subagent's): counted. The fork holds a copy of
	// g1, as omp's forks do (the same id and time): omp keeps one row for it.
	writeFileSync(join(folder, "2026-10-27T10-00-00-000Z_01b.jsonl"), guard("g1", T, 0.5) + guard("gm", T + 500, 4));
	writeFileSync(join(folder, "2026-10-27T11-00-00-000Z_01c.jsonl"), guard("g1", T, 0.5));
	writeFileSync(join(folder, "2026-10-27T10-00-00-000Z_01b", "Scout.jsonl"), guard("g2", T + 1000, 0.25));
	const db = ompDb("ingest", [
		{ id: "g1", at: T, agent: "main" },
		{ id: "g2", at: T + 1000, agent: "subagent" },
	]);
	const body = stats([bucket("main", 6, 2), bucket("subagent", 4, 1)]);
	const by = (json: string): Record<string, Record<string, number>> =>
		Object.fromEntries(JSON.parse(json).byAgentType.map((b: { agentType: string }) => [b.agentType, b])) as Record<
			string,
			Record<string, number>
		>;

	const moved = by(await addGuardUsage(body, sessions, undefined, db));
	// Two requests are omp's to give: the main agent's and the subagent's. `gm` is in no bucket of omp's, so not in the guard's either.
	expect(moved.guard).toMatchObject({ totalRequests: 2 });
	expect(moved.guard?.totalCost).toBeCloseTo(0.75, 9);
	expect(moved.main).toMatchObject({ totalRequests: 5 });
	expect(moved.main?.totalCost).toBeCloseTo(1.5, 9);
	expect(moved.subagent).toMatchObject({ totalRequests: 3 });
	expect(moved.subagent?.totalCost).toBeCloseTo(0.75, 9);
	// The buckets still add up to what omp counted.
	expect(Object.values(moved).reduce((sum, b) => sum + (b.totalCost ?? 0), 0)).toBeCloseTo(3, 9);

	// The bucket a request leaves is the one omp counted it under, whichever transcript it was read from.
	const odd = ompDb("ingest-odd", [
		{ id: "g1", at: T, agent: "main" },
		{ id: "g2", at: T + 1000, agent: "advisor" },
	]);
	const advised = by(
		await addGuardUsage(
			stats([bucket("main", 6, 2), bucket("subagent", 4, 1), bucket("advisor", 2, 1)]),
			sessions,
			undefined,
			odd,
		),
	);
	expect(advised.advisor).toMatchObject({ totalRequests: 1 });
	expect(advised.subagent).toMatchObject({ totalRequests: 4 });

	// A database that cannot be read says nothing of what omp counted: the requests of the window are moved, as they were.
	const unread = by(await addGuardUsage(body, sessions, undefined, join(root, "absent.db")));
	expect(unread.guard?.totalRequests).toBeGreaterThanOrEqual(3);
});
