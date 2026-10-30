import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * Usage & cost asks `/api/stats` for a range (#714). omp's own `omp stats --json` answers only its last 24 hours, so a
 * request three days old is in the week and in everything, and not in the day: the server reads it from the database
 * the real omp keeps, in the test server's own home.
 */

let s: TestServer;
const MODEL = "contract-range-model";

beforeAll(async () => {
	s = await startTestServer();
	const dir = join(s.agentDir, "sessions", "-tmp-stats-range");
	mkdirSync(dir, { recursive: true });
	const now = Date.now();
	const message = (id: string, at: number) => ({
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: id }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: MODEL,
			usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { total: 0.01 } },
			stopReason: "stop",
			timestamp: at,
		},
	});
	const lines = [
		{
			type: "session",
			version: 3,
			id: "stats-range",
			timestamp: new Date(now - 4 * 86_400_000).toISOString(),
			cwd: "/tmp",
		},
		message("old", now - 3 * 86_400_000),
		message("new", now - 10 * 60_000),
	];
	writeFileSync(
		join(dir, "2026-10-25T00-00-00-000Z_stats-range.jsonl"),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);
});
afterAll(async () => {
	await s?.stop();
});

async function requestsOf(
	range: string,
): Promise<{ requests: number | undefined; range: string | null; fallback: string | null }> {
	const res = await fetch(`${s.url}/api/stats?range=${range}&wait=1`, {
		headers: { "x-omp-webui-token": s.accessToken },
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as { byModel: { model: string; totalRequests: number }[] };
	return {
		requests: body.byModel.find((m) => m.model === MODEL)?.totalRequests,
		range: res.headers.get("x-stats-range"),
		fallback: res.headers.get("x-stats-fallback"),
	};
}

test("a day holds the request of ten minutes ago; a week and everything hold the one of three days ago too", async () => {
	expect(await requestsOf("24h")).toEqual({ requests: 1, range: "24h", fallback: null });
	expect(await requestsOf("7d")).toEqual({ requests: 2, range: "7d", fallback: null });
	expect(await requestsOf("all")).toEqual({ requests: 2, range: "all", fallback: null });
}, 120_000);

test("no range asked is a month; a range the server does not know is a month too", async () => {
	const res = await fetch(`${s.url}/api/stats?range=decade`, { headers: { "x-omp-webui-token": s.accessToken } });
	expect(res.headers.get("x-stats-range")).toBe("30d");
	const plain = await fetch(`${s.url}/api/stats`, { headers: { "x-omp-webui-token": s.accessToken } });
	expect(plain.headers.get("x-stats-range")).toBe("30d");
}, 120_000);
