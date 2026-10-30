import { afterAll, beforeAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { writeBigSession } from "../support/big-session.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * These are real-clock latency budgets, not ordinary correctness tests: a 20 ms response budget also counts time
 * the OS gives to unrelated processes. The test:contract/test:all scripts run this phase after their parallel pool,
 * while the other suites are idle. Keep the 22 MB workload, 2 ms probes and strict 20 ms assertion intact.
 */

const BIG_BYTES = 22 * 1024 * 1024;
let s: TestServer;
let big: string;
const authed = () => ({ "x-omp-webui-token": s.accessToken });
const lives = () => fetch(`${s.url}/api/lives`, { headers: authed() }).then((r) => r.arrayBuffer());

beforeAll(async () => {
	s = await startTestServer();
	big = realpathSync(writeBigSession(s.agentDir, BIG_BYTES));
	// The server's index scans a new file on the request thread, a job of its own: let it finish before measuring.
	await pollUntil(
		async () => {
			const sessions: { file: string }[] = await (await fetch(`${s.url}/api/sessions`, { headers: authed() })).json();
			return sessions.some((x) => x.file === big);
		},
		"the server to index the big conversation",
		60_000,
	);
}, 120_000);
afterAll(async () => {
	await s?.stop();
});
/**
 * Fetch `url` the way a page does (gzip) while probing the server every 2 ms, and what the probes saw. curl rather than fetch:
 * inflating 22 MB in this process would delay the probes by itself.
 */
async function probedWhileFetching(url: string): Promise<{ status: string; sent: number; latencies: number[] }> {
	const response = Bun.spawn(
		[
			"curl",
			"-s",
			"-o",
			"/dev/null",
			"-w",
			"%{http_code} %{size_download}",
			"-H",
			`x-omp-webui-token: ${s.accessToken}`,
			"-H",
			"accept-encoding: gzip",
			url,
		],
		{ stdout: "pipe" },
	);
	let inFlight = true;
	const latencies: number[] = [];
	const probes: Promise<void>[] = [];
	// A probe every 2 ms, none waiting for the one before: a stalled server shows as every probe in the stall.
	const timer = setInterval(() => {
		const started = performance.now();
		probes.push(
			lives().then(() => {
				if (inFlight) latencies.push(performance.now() - started);
			}),
		);
	}, 2);
	const [status, sent] = (await new Response(response.stdout).text()).split(" ");
	inFlight = false;
	clearInterval(timer);
	await Promise.all(probes);
	return { status, sent: Number(sent), latencies };
}

test("other requests are answered within 20 ms while a 22 MB conversation is built and sent", async () => {
	const { status, sent, latencies } = await probedWhileFetching(`${s.url}/api/family?file=${encodeURIComponent(big)}`);

	expect(status).toBe("200");
	// Compressed: far smaller than the 22 MB it describes.
	expect(sent).toBeGreaterThan(100_000);
	expect(sent).toBeLessThan(BIG_BYTES / 2);
	// The request really was in flight while the probes ran (a cold build takes ~100 ms), and nothing waited on it.
	expect(latencies.length).toBeGreaterThan(10);
	expect(Math.max(...latencies)).toBeLessThan(20);
}, 60_000);

test("other requests are answered within 20 ms while /api/session reads, parses and sends a 22 MB transcript", async () => {
	// It used to be done on the request thread: 300 ms of nothing else answered for this file, 4 s for 300 MB.
	const { status, sent, latencies } = await probedWhileFetching(`${s.url}/api/session?file=${encodeURIComponent(big)}`);

	expect(status).toBe("200");
	expect(sent).toBeGreaterThan(100_000);
	expect(sent).toBeLessThan(BIG_BYTES / 2);
	expect(latencies.length).toBeGreaterThan(10);
	expect(Math.max(...latencies)).toBeLessThan(20);
}, 60_000);
