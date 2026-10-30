import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, realpathSync } from "node:fs";
import type { FamilyStats, SessionFileData } from "../../shared/protocol.ts";
import { writeBigSession } from "../support/big-session.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * What a long conversation costs to open. These are real-clock measurements, so they assert ratios (how much faster the end
 * of a conversation is than the whole of it) and not times: the answers are compared with one another on one machine in
 * one run. The test:contract/test:all scripts run this phase after their parallel pool, while the other suites are idle.
 */

const BIG_BYTES = 50 * 1024 * 1024;
let s: TestServer;
let big: string;
/** How long the whole lineage took when it was first asked for (milliseconds). */
let coldWhole = Number.POSITIVE_INFINITY;
const authed = () => ({ "x-omp-webui-token": s.accessToken });

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
		90_000,
	);
}, 180_000);
afterAll(async () => {
	await s?.stop();
});

const family = (params: Record<string, string> = {}) =>
	`${s.url}/api/family?${new URLSearchParams({ file: big, ...params })}`;

/** What the answers read here hold: the members of the family, or the figures of the file. */
interface Answered {
	members: SessionFileData[];
	stats: FamilyStats;
}

/** How long a small answer takes to arrive in full, as the page would wait for it. */
async function timed(url: string): Promise<{ ms: number; body: Answered }> {
	const started = performance.now();
	const res = await fetch(url, { headers: { ...authed(), "accept-encoding": "gzip" } });
	expect(res.status).toBe(200);
	const body: Answered = await res.json();
	return { ms: performance.now() - started, body };
}

/** The whole lineage, which is tens of MB: fetched and thrown away by curl, so the test process does not inflate it. */
async function wholeMs(): Promise<{ ms: number; sent: number }> {
	const curl = Bun.spawn(
		[
			"curl",
			"-s",
			"-o",
			"/dev/null",
			"-w",
			"%{http_code} %{size_download} %{time_total}",
			"-H",
			`x-omp-webui-token: ${s.accessToken}`,
			"-H",
			"accept-encoding: gzip",
			family(),
		],
		{ stdout: "pipe" },
	);
	const [status, sent, seconds] = (await new Response(curl.stdout).text()).split(" ");
	expect(status).toBe("200");
	return { ms: Number(seconds) * 1000, sent: Number(sent) };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

test("the end of a 50 MB conversation, asked cold, is answered many times faster than its whole, and earlier pages in a few milliseconds", async () => {
	// Cold: the worker has not started and the file has not been indexed.
	const tail = await timed(family({ view: "tail" }));
	expect(tail.body.members[0].entries.length).toBeGreaterThan(100);
	expect(tail.body.members[0].total).toBeGreaterThan(5000);

	// The whole, cold too: it has never been asked for.
	const whole = await wholeMs();
	expect(whole.sent).toBeGreaterThan(1_000_000);
	coldWhole = whole.ms;
	expect(tail.ms * 3).toBeLessThan(whole.ms);

	// Older pages of a conversation the worker has indexed: no file is read whole, nothing is parsed but what is sent.
	const first: string = tail.body.members[0].entries[0].id;
	const pages: number[] = [];
	let at = first;
	for (let i = 0; i < 7; i++) {
		const page = await timed(family({ view: "before", at, limit: "50" }));
		pages.push(page.ms);
		at = page.body.members[0].entries[0].id;
	}
	expect(median(pages) * 5).toBeLessThan(whole.ms);
	expect(median(pages)).toBeLessThan(tail.ms);

	// The same end again, from the cache of the server: a 304.
	const repeat = await fetch(family({ view: "tail" }), { headers: { ...authed(), "accept-encoding": "gzip" } });
	const etag = repeat.headers.get("etag") as string;
	await repeat.arrayBuffer();
	const started = performance.now();
	const revalidated = await fetch(family({ view: "tail" }), { headers: { ...authed(), "if-none-match": etag } });
	expect(revalidated.status).toBe(304);
	expect(performance.now() - started).toBeLessThan(whole.ms / 5);
}, 180_000);

test("the figures of a 50 MB conversation come without the whole of it, and go on from where they were when it grows", async () => {
	const stats = await timed(family({ view: "stats" }));
	expect(stats.body.stats.through).toMatch(/^b/);
	expect(stats.body.stats.usage.cost).toBeGreaterThan(0);
	// `coldWhole` is how long the first test saw the whole take: it is kept now, and would be answered at once.
	expect(stats.ms * 2).toBeLessThan(coldWhole);

	// A few entries are written: the figures take them on, without reading the conversation again.
	const last = stats.body.stats.through as string;
	const added = ["x1", "x2", "x3"].map((id, k) => ({
		type: "message",
		id,
		parentId: k ? `x${k}` : last,
		timestamp: "2026-01-08T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text: `added ${id}` }], attribution: "user" },
	}));
	appendFileSync(big, `${added.map((e) => JSON.stringify(e)).join("\n")}\n`);
	const grown = await timed(family({ view: "stats" }));
	expect(grown.body.stats.through).toBe("x3");
	expect(grown.ms).toBeLessThan(stats.ms);
	expect(grown.ms * 5).toBeLessThan(coldWhole);
}, 180_000);
