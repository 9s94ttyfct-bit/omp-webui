import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdsLatest, statsDbPath, statsFromDb } from "../../server/omp/stats-db.ts";

/**
 * Usage & cost reads omp's statistics database for ranges `omp stats --json` does not answer (#714). This holds the
 * reading to omp's own: transcripts of known requests are counted by the real `omp stats --json` in a home of their own,
 * and the server's figures for the same window, from the database omp wrote, must equal omp's answer. It fails when omp
 * moves the database, renames a column the queries read, or changes a formula.
 */

const omp = process.env.OMP_BIN ?? Bun.which("omp");
const root = mkdtempSync(join(tmpdir(), "ompw-stats-contract-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Call {
	model: string;
	cost: number;
	stop?: "stop" | "error" | "toolUse";
	ago: number;
}

/** A transcript of `calls`, each `ago` milliseconds before now: inside omp's own 24 hours. */
function writeSession(agentDir: string, calls: Call[]): void {
	const dir = join(agentDir, "sessions", "-tmp-stats-contract");
	mkdirSync(dir, { recursive: true });
	const now = Date.now();
	const start = new Date(now - 3_600_000).toISOString();
	const lines: unknown[] = [
		{ type: "session", version: 3, id: "stats-contract", timestamp: start, cwd: "/tmp/stats-contract" },
	];
	calls.forEach((c, i) => {
		const at = now - c.ago;
		const n = 100 * (i + 1);
		lines.push({
			type: "message",
			id: `m${i}`,
			parentId: i ? `m${i - 1}` : null,
			timestamp: new Date(at).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: `answer ${i}` }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: c.model,
				usage: { input: n, output: n, cacheRead: 3 * n, cacheWrite: n, totalTokens: 6 * n, cost: { total: c.cost } },
				stopReason: c.stop ?? "stop",
				...(c.stop === "error" ? { errorMessage: "overloaded" } : {}),
				timestamp: at,
			},
		});
	});
	writeFileSync(
		join(dir, "2026-10-28T00-00-00-000Z_stats-contract.jsonl"),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);
}

const CALLS: Call[] = [
	{ model: "claude-opus-5-5", cost: 0.5, ago: 50 * 60_000 },
	{ model: "claude-opus-5-5", cost: 0.25, ago: 40 * 60_000, stop: "toolUse" },
	{ model: "claude-sonnet-5-5", cost: 0.125, ago: 30 * 60_000 },
	{ model: "claude-sonnet-5-5", cost: 0, ago: 20 * 60_000, stop: "error" },
	{ model: "claude-opus-5-5", cost: 1, ago: 10 * 60_000 },
];

/** What omp answers, run in a home of its own with `env` (no user settings, no other history). */
async function ompStats(env: Record<string, string>): Promise<Record<string, unknown>> {
	const proc = Bun.spawn([omp as string, "stats", "--json"], {
		env: { PATH: process.env.PATH ?? "", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`omp stats exited ${code}: ${err}`);
	return JSON.parse(out);
}

type Bucket = Record<string, number | string | null>;

const FIELDS = [
	"totalRequests",
	"successfulRequests",
	"failedRequests",
	"errorRate",
	"totalInputTokens",
	"totalOutputTokens",
	"totalCacheReadTokens",
	"totalCacheWriteTokens",
	"cacheRate",
	"cacheSavings",
	"totalCost",
	"unpricedRequests",
	"totalPremiumRequests",
	"avgDuration",
	"avgTtft",
	"avgTokensPerSecond",
	"firstTimestamp",
	"lastTimestamp",
];

function expectSameBucket(ours: Bucket, theirs: Bucket, what: string): void {
	for (const field of FIELDS) {
		const a = ours[field] ?? null;
		const b = theirs[field] ?? null;
		if (typeof a === "number" && typeof b === "number")
			expect([what, field, a]).toEqual([what, field, expect.closeTo(b, 9)]);
		else expect([what, field, a]).toEqual([what, field, b]);
	}
}

async function compare(home: string, agentDir: string, env: Record<string, string>): Promise<void> {
	writeSession(agentDir, CALLS);
	const answer = await ompStats(env);
	const overall = answer.overall as Bucket;
	expect(overall.totalRequests).toBe(CALLS.length);
	const path = statsDbPath(agentDir, env, home);
	expect(holdsLatest(path, overall.lastTimestamp as number)).toBe(true);
	const ours = statsFromDb(
		path,
		{ from: overall.firstTimestamp as number, to: overall.lastTimestamp as number },
		"hour",
	);
	if (!ours) throw new Error(`no figures from ${path}`);
	expectSameBucket(ours.overall as unknown as Bucket, overall, "overall");
	const byModel = (answer.byModel as Bucket[]).slice().sort((x, y) => String(x.model).localeCompare(String(y.model)));
	const ourModels = ours.byModel.slice().sort((x, y) => x.model.localeCompare(y.model));
	expect(ourModels.map((m) => m.model)).toEqual(byModel.map((m) => String(m.model)));
	for (const [i, m] of ourModels.entries())
		expectSameBucket(m as unknown as Bucket, byModel[i] as Bucket, `model ${m.model}`);
	const types = new Map((answer.byAgentType as Bucket[]).map((t) => [String(t.agentType), t]));
	expect(ours.byAgentType.map((t) => t.agentType).sort()).toEqual([...types.keys()].sort());
	for (const t of ours.byAgentType) {
		expect(t.totalRequests).toBe(types.get(t.agentType)?.totalRequests as number);
		expect(t.totalCost).toBeCloseTo(types.get(t.agentType)?.totalCost as number, 9);
	}
	expect(ours.timeSeries).toEqual(answer.timeSeries as typeof ours.timeSeries);
	const theirCost = (answer.costSeries as Bucket[]).map((c) => `${c.timestamp} ${c.model} ${c.requests}`).sort();
	expect(ours.costSeries.map((c) => `${c.timestamp} ${c.model} ${c.requests}`).sort()).toEqual(theirCost);
}

test.skipIf(!omp)(
	"the default agent folder: the figures are omp's own for its window",
	async () => {
		const home = join(root, "default");
		const agentDir = join(home, ".omp", "agent");
		await compare(home, agentDir, { HOME: home });
	},
	120_000,
);

test.skipIf(!omp)(
	"an agent folder of its own (PI_CODING_AGENT_DIR) keeps the config root's database, and it is that one read",
	async () => {
		const home = join(root, "own");
		const agentDir = join(root, "own-agent");
		await compare(home, agentDir, { HOME: home, PI_CODING_AGENT_DIR: agentDir });
	},
	120_000,
);
