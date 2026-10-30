import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addGuardUsage } from "../../server/guard-usage.ts";
import { statsDbPath } from "../../server/omp/stats-db.ts";

/**
 * Usage & cost › By agent type moves the guard's requests out of the bucket omp counted them in (#689). It may only move
 * the ones omp counted (#706): a `model_usage` entry omp never ingested is in no bucket of its answer, and moving it took
 * a request from `main` that was never there. This holds, against the real omp (18.13.3 ingests a `model_usage` entry
 * that names its `api`, `provider` and `model`; one without them is no request to it) and its database in a home of its
 * own, that the guard's bucket is the requests omp counted, under the type omp counted them under.
 */

const omp = process.env.OMP_BIN ?? Bun.which("omp");
const root = mkdtempSync(join(tmpdir(), "ompw-guard-usage-contract-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test.skipIf(!omp)(
	"the guard's bucket holds the requests omp counted, and one omp never ingested leaves omp's buckets as they were",
	async () => {
		const home = join(root, "home");
		const agentDir = join(home, ".omp", "agent");
		const folder = join(agentDir, "sessions", "-tmp-guard-usage");
		const stem = "2026-10-29T00-00-00-000Z_guard-usage";
		mkdirSync(join(folder, stem), { recursive: true });
		const now = Date.now();
		const iso = (ago: number) => new Date(now - ago).toISOString();
		const min = 60_000;
		const usage = (cost: number) => ({
			input: 100,
			output: 10,
			cacheRead: 50,
			cacheWrite: 0,
			totalTokens: 160,
			cost: { total: cost },
		});
		const assistant = (id: string, parent: string | null, ago: number, cost: number) => ({
			type: "message",
			id,
			parentId: parent,
			timestamp: iso(ago),
			message: {
				role: "assistant",
				content: [{ type: "text", text: id }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-5-5",
				usage: usage(cost),
				stopReason: "stop",
				timestamp: now - ago,
			},
		});
		/** What the guard writes (`appendModelUsage`); `named: false` leaves out what omp needs to count it. */
		const guard = (id: string, parent: string, ago: number, cost: number, named = true) => ({
			type: "model_usage",
			id,
			parentId: parent,
			timestamp: iso(ago),
			purpose: "guard",
			role: "reviewer",
			...(named ? { api: "openai-responses", provider: "openai-codex", model: "gpt-6-luna" } : {}),
			usage: usage(cost),
			stopReason: "stop",
		});
		const head = { type: "session", version: 3, id: "guard-usage", timestamp: iso(60 * min), cwd: "/tmp/guard-usage" };
		const lines = (entries: unknown[]) => `${[head, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`;
		writeFileSync(
			join(folder, `${stem}.jsonl`),
			lines([
				assistant("m0", null, 50 * min, 0.5),
				guard("g1", "m0", 40 * min, 0.25),
				guard("g2", "g1", 35 * min, 8, false),
				assistant("m1", "g2", 30 * min, 0.5),
			]),
		);
		writeFileSync(
			join(folder, stem, "Scout.jsonl"),
			lines([assistant("s0", null, 20 * min, 0.1), guard("sg1", "s0", 10 * min, 0.0625)]),
		);

		const proc = Bun.spawn([omp as string, "stats", "--json"], {
			env: { PATH: process.env.PATH ?? "", HOME: home },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) throw new Error(`omp stats exited ${code}: ${err}`);
		const ompBy = Object.fromEntries(
			(JSON.parse(out).byAgentType as { agentType: string; totalRequests: number }[]).map((b) => [b.agentType, b]),
		);
		// omp counted g1 with the main agent's two messages, and sg1 with the subagent's one; g2 is in none.
		expect(ompBy.main?.totalRequests).toBe(3);
		expect(ompBy.subagent?.totalRequests).toBe(2);

		const dbPath = statsDbPath(agentDir, { HOME: home }, home);
		const moved = JSON.parse(await addGuardUsage(out, join(agentDir, "sessions"), undefined, dbPath));
		const by = Object.fromEntries(
			(moved.byAgentType as { agentType: string; totalRequests: number; totalCost: number }[]).map((b) => [
				b.agentType,
				b,
			]),
		);
		// The guard's requests are the two omp counted; g2's cost (8) is in no bucket.
		expect(by.guard?.totalRequests).toBe(2);
		expect(by.guard?.totalCost).toBeCloseTo(0.3125, 9);
		expect(by.main?.totalRequests).toBe(2);
		expect(by.main?.totalCost).toBeCloseTo(1, 9);
		expect(by.subagent?.totalRequests).toBe(1);
		expect(by.subagent?.totalCost).toBeCloseTo(0.1, 9);
	},
	120_000,
);
