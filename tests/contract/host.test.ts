import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GPU_MARKER } from "../../server/host-gpu-guard.ts";
import type { HostHistory, HostPoint, HostProc, HostSeries } from "../../shared/host.ts";
import { type AccessKey, type Jwks, makeKey, startJwks } from "../support/access-jwt.ts";
import { pollUntil } from "../support/poll.ts";
import { remoteClient, remoteSettings } from "../support/remote-client.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect } from "../support/ws.ts";

/**
 * The host's load (#613) against the real server. The paces are made short by the settings only tests use
 * (`OMP_WEBUI_HOST_*_MS`); what is read is the computer's own, so figures are checked for what they must be (a share is
 * 0–100, a series has one entry per column), not for what they are. The page at this computer and a page that came in
 * through the tunnel are both served: the load is the computer's, not its files or its commands.
 */

/**
 * What is under test is the pace of a real process on the platform's clock (how often it looks, and that it stops looking), so
 * a few checks have to let real time pass: `elapse` is the only place that does, and says for what. Everything that has an
 * event to wait for (a look arriving, the processes being listed or not) waits on that with `pollUntil`.
 */
const elapse = (ms: number) => Bun.sleep(ms);

const LIVE_MS = 250;
const BACKGROUND_MS = 1000;
const root = mkdtempSync(join(tmpdir(), "ompw-host-contract-"));
const settingsFile = join(root, "remote.json");
const dist = join(root, "dist");
let s: TestServer;
let key: AccessKey;
let jwks: Jwks;
let remote: ReturnType<typeof remoteClient>;

beforeAll(async () => {
	key = await makeKey("kid-1");
	jwks = await startJwks([key]);
	mkdirSync(join(dist, "assets"), { recursive: true });
	writeFileSync(
		join(dist, "index.html"),
		'<!doctype html>\n<html><head></head><body><div id="root"></div></body></html>\n',
	);
	writeFileSync(settingsFile, JSON.stringify(remoteSettings()));
	s = await startTestServer(
		0,
		{
			OMP_WEBUI_REMOTE_CONFIG: settingsFile,
			OMP_WEBUI_ACCESS_CERTS_URL: jwks.url,
			OMP_WEBUI_DIST: dist,
			OMP_WEBUI_HOST_LIVE_MS: String(LIVE_MS),
			OMP_WEBUI_HOST_BACKGROUND_MS: String(BACKGROUND_MS),
		},
		{ login: false },
	);
	remote = remoteClient(s, key);
}, 60_000);

afterAll(async () => {
	await s?.stop();
	jwks?.stop();
	rmSync(root, { recursive: true, force: true });
});

const local = (path: string) => fetch(`${s.url}${path}`, { headers: { "x-omp-webui-token": s.accessToken } });
const history = async (): Promise<HostHistory> => (await local("/api/host")).json();

interface Sample {
	t: "host_sample";
	point: HostPoint;
	minute?: HostPoint;
	procs?: HostProc[];
}

/** The `host_sample` messages a socket is told, as they come. */
function samplesOf(ws: WebSocket): Sample[] {
	const got: Sample[] = [];
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(String(ev.data));
		if (m.t === "host_sample") got.push(m);
	});
	return got;
}

/** What a page says it watches: `detail` (the graphs), `procs` (the process table) or neither (the line of figures). */
interface Says {
	detail?: unknown;
	procs?: unknown;
}

const watch = (ws: WebSocket, on: boolean, says: Says = {}) =>
	ws.send(JSON.stringify({ t: "host_watch", on, ...says }));

/** How many looks the server keeps per second over `ms`, read from what it holds. */
async function rate(ms: number): Promise<number> {
	const before = (await history()).fine.t.length;
	const began = Date.now();
	await elapse(ms);
	const after = (await history()).fine.t.length;
	return ((after - before) / (Date.now() - began)) * 1000;
}

function expectSeries(series: HostSeries): void {
	const n = series.t.length;
	for (const column of [series.cpu, series.gpu, series.mem, series.pressure]) expect(column).toHaveLength(n);
	for (let i = 0; i < n; i++) {
		if (i > 0) expect(series.t[i] as number).toBeGreaterThan(series.t[i - 1] as number);
		expect(series.cpu[i] as number).toBeGreaterThanOrEqual(0);
		expect(series.cpu[i] as number).toBeLessThanOrEqual(100);
		for (const column of [series.gpu, series.mem]) {
			const v = column[i];
			if (v !== null) {
				expect(v as number).toBeGreaterThanOrEqual(0);
				expect(v as number).toBeLessThanOrEqual(100);
			}
		}
		expect([null, 0, 1, 2]).toContain(series.pressure[i] as number | null);
	}
}

function expectPoint(p: HostPoint): void {
	expectSeries({ t: [p.t], cpu: [p.cpu], gpu: [p.gpu], mem: [p.mem], pressure: [p.pressure] });
}

describe("GET /api/host at this computer", () => {
	test("tells what the computer is and how the series are taken, and holds history that nobody watched for", async () => {
		// The server looks every BACKGROUND_MS while no page watches: the history is there without anyone asking for it.
		await pollUntil(async () => (await history()).fine.t.length >= 2, "two looks of the background pace");
		const h = await history();
		expect(h.info.platform).toBe(process.platform);
		expect(h.info.cores).toBeGreaterThan(0);
		expect(h.info.memTotal).toBeGreaterThan(0);
		expect(h.info.liveMs).toBe(LIVE_MS);
		expect(h.info.backgroundMs).toBe(BACKGROUND_MS);
		expect(h.info.fineSpanMs).toBe(3_600_000);
		expect(h.info.coarseMs).toBe(60_000);
		expect(h.info.coarseSpanMs).toBe(86_400_000);
		expect(typeof h.info.pressure).toBe("boolean");
		// The clock is the server's own, and what it holds is not from the future.
		expect(Math.abs(h.now - Date.now())).toBeLessThan(5000);
		expectSeries(h.fine);
		expectSeries(h.coarse);
		expect(h.fine.t.at(-1) as number).toBeLessThanOrEqual(h.now);
		// Nothing asks for the processes: none are listed (a listing is a process to start, at every look).
		expect(h.procs).toBeNull();
	});

	test("a Mac says its GPU and memory pressure (this runs on whatever computer it is run on)", async () => {
		await pollUntil(async () => (await history()).fine.t.length >= 1, "a look");
		const h = await history();
		if (process.platform === "darwin") {
			expect(h.info.pressure).toBe(true);
			expect(h.fine.pressure.every((p) => p !== null)).toBe(true);
			expect(h.info.gpu).not.toBeNull();
			expect(h.fine.gpu.every((g) => g !== null)).toBe(true);
		}
		if (process.platform === "linux") expect(h.info.gpu).toBeNull();
	});

	test("is refused to a page of another origin, and to one with no token", async () => {
		const stranger = await fetch(`${s.url}/api/host`, {
			headers: { "x-omp-webui-token": s.accessToken, origin: "https://evil.example" },
		});
		expect(stranger.status).toBe(403);
		const anonymous = await fetch(`${s.url}/api/host`);
		expect(anonymous.status).toBe(401);
	});
});

describe("the socket: host_watch and host_sample", () => {
	test("a page that shows the graphs is told each look, in shape, at the live pace; one that is told to stop is told nothing more", async () => {
		const ws = await connect(s);
		try {
			const got = samplesOf(ws);
			watch(ws, true, { detail: true });
			await pollUntil(() => got.length >= 4, "four looks of the live pace");
			for (const m of got) {
				expectPoint(m.point);
				// No `procs` unless this page asked for them.
				expect(m.procs).toBeUndefined();
			}
			for (let i = 1; i < got.length; i++)
				expect((got[i] as Sample).point.t).toBeGreaterThan((got[i - 1] as Sample).point.t);
			// A finished minute comes with the look that ends it: its point is the minute's start.
			for (const m of got) if (m.minute) expect(m.minute.t % 60_000).toBe(0);

			watch(ws, false);
			// One look may be on its way; then nothing, for much longer than a look takes.
			await elapse(BACKGROUND_MS);
			const quiet = got.length;
			await elapse(BACKGROUND_MS * 3);
			expect(got.length).toBe(quiet);
		} finally {
			ws.close();
		}
	}, 30_000);

	test("the server looks at the live pace only while a page shows the graphs (the background pace is far slower)", async () => {
		const idle = await rate(2500);
		const ws = await connect(s);
		try {
			watch(ws, true, { detail: true });
			// The first look after a page starts watching is pulled forward (not waited for at the background pace).
			await pollUntil(async () => (await rate(300)) > 0, "looks at the live pace");
			const busy = await rate(2000);
			expect(busy).toBeGreaterThan(idle * 2);
			expect(idle).toBeLessThan((1000 / BACKGROUND_MS) * 1.6);
		} finally {
			ws.close();
		}
		// A page that goes away without a word (its connection closes) is no longer watched: the pace falls back.
		await elapse(BACKGROUND_MS * 2);
		const after = await rate(2500);
		expect(after).toBeLessThan((1000 / BACKGROUND_MS) * 1.6);
	}, 40_000);

	test("a page that shows only the line of figures is told each look too, but the server keeps the background pace for it", async () => {
		const ws = await connect(s);
		try {
			const got = samplesOf(ws);
			// `on` without `detail`: the sidebar's indicator, which draws one line and no graph.
			watch(ws, true);
			await pollUntil(() => got.length >= 3, "three looks of the background pace");
			for (const m of got) expectPoint(m.point);
			// What it is told is spaced as the background pace spaces looks, not the live one.
			const span = (got.at(-1) as Sample).point.t - (got[0] as Sample).point.t;
			expect(span).toBeGreaterThanOrEqual(BACKGROUND_MS * 2 - 100);
			const busy = await rate(2000);
			expect(busy).toBeLessThan((1000 / LIVE_MS) * 0.5);
		} finally {
			ws.close();
		}
	}, 40_000);

	test("a page that opens the graphs takes the live pace up; when it closes, the line that is left gives the background pace back", async () => {
		const ws = await connect(s);
		try {
			watch(ws, true);
			// The line alone: the background pace, however long the page stays.
			await elapse(BACKGROUND_MS + LIVE_MS);
			const slow = await rate(2000);
			expect(slow).toBeLessThan((1000 / LIVE_MS) * 0.5);
			// The popover opens: the same page says so, and the looks come at the live pace.
			watch(ws, true, { detail: true });
			await pollUntil(async () => (await rate(300)) > 0, "looks at the live pace");
			const fast = await rate(2000);
			expect(fast).toBeGreaterThan(slow * 2);
			// The popover closes: the line is all that is left, and the pace falls back without the page coming or going.
			watch(ws, true);
			await elapse(LIVE_MS * 3);
			const again = await rate(2500);
			expect(again).toBeLessThan((1000 / LIVE_MS) * 0.5);
		} finally {
			ws.close();
		}
	}, 60_000);

	test("the processes come only to a page that asks for them, and are listed only while one does", async () => {
		const plain = await connect(s);
		const asking = await connect(s);
		try {
			const quiet = samplesOf(plain);
			const loud = samplesOf(asking);
			watch(plain, true);
			watch(asking, true, { procs: true });
			await pollUntil(() => loud.length >= 3 && quiet.length >= 3, "looks on both pages");
			for (const m of quiet) expect(m.procs).toBeUndefined();
			const procs = loud.at(-1)?.procs;
			expect(procs).toBeDefined();
			const server = procs?.find((p) => p.id === "server");
			expect(server?.count).toBe(1);
			expect(server?.rss).toBeGreaterThan(0);
			// A share of one core from the second listing on; never negative.
			expect(typeof server?.cpu === "number" && server.cpu >= 0).toBe(true);
			for (const p of procs ?? []) {
				// What a page may be told of a process is these four figures: no command line, path, user or pid. A field added
				// to the row would reach every page, tunnel pages included, and has to be a decision made here.
				expect(Object.keys(p).sort()).toEqual(["count", "cpu", "id", "rss"]);
				expect(["server", "omp", "relay"]).toContain(p.id);
				expect(p.count).toBeGreaterThanOrEqual(1);
				expect(p.rss).toBeGreaterThanOrEqual(0);
			}
			// What `GET /api/host` says of them while a page asks.
			expect((await history()).procs?.some((p) => p.id === "server")).toBe(true);

			// The page that asked stops asking (it still watches the load): nothing is listed any more.
			watch(asking, true);
			await pollUntil(async () => (await history()).procs === null, "the processes no longer listed");
			const seen = loud.length;
			await pollUntil(() => loud.length >= seen + 2, "two more looks");
			for (const m of loud.slice(seen)) expect(m.procs).toBeUndefined();
		} finally {
			plain.close();
			asking.close();
		}
	}, 30_000);

	test("what is not `true` for `procs` is not asking for them; a watch that is not `on` watches nothing", async () => {
		const ws = await connect(s);
		try {
			const got = samplesOf(ws);
			// At the live pace, so that the looks the elapses below wait for are quick: `procs` is what is under test.
			watch(ws, true, { detail: true, procs: "yes" });
			await pollUntil(() => got.length >= 2, "two looks");
			for (const m of got) expect(m.procs).toBeUndefined();
			ws.send(JSON.stringify({ t: "host_watch", on: "true", detail: true }));
			await elapse(BACKGROUND_MS);
			const quiet = got.length;
			await elapse(BACKGROUND_MS * 3);
			expect(got.length).toBe(quiet);
		} finally {
			ws.close();
		}
	}, 30_000);

	test("a page that closes while watching processes stops the listing", async () => {
		const ws = await connect(s);
		watch(ws, true, { procs: true });
		await pollUntil(async () => (await history()).procs !== null, "the processes listed");
		ws.close();
		await pollUntil(async () => (await history()).procs === null, "the listing stopped after the page closed");
	}, 30_000);
});

describe("a page that came in through the tunnel", () => {
	test("reads the history, and the answer is the same shape as at this computer", async () => {
		const res = await remote.fetch("/api/host");
		expect(res.status).toBe(200);
		const h = (await res.json()) as HostHistory;
		expect(h.info.platform).toBe(process.platform);
		expect(h.info.memTotal).toBeGreaterThan(0);
		expectSeries(h.fine);
		expectSeries(h.coarse);
	});

	test("is refused without a valid Access token, as every other request is", async () => {
		expect((await remote.fetch("/api/host", { jwt: null })).status).toBe(403);
		expect((await remote.fetch("/api/host", { jwt: "not.a.jwt" })).status).toBe(403);
	});

	test("watches over its socket and is told each look, with the processes when it asks", async () => {
		const ws = await remote.socket();
		expect(ws).not.toBeNull();
		if (!ws) return;
		try {
			const got = samplesOf(ws);
			watch(ws, true, { procs: true });
			await pollUntil(() => got.length >= 3, "looks on the remote page");
			for (const m of got) expectPoint(m.point);
			expect(got.at(-1)?.procs?.some((p) => p.id === "server")).toBe(true);
			// The same figures about the same computer: a remote page does not see a different one.
			const here = await history();
			expect(Math.abs((got.at(-1) as Sample).point.t - here.now)).toBeLessThan(5000);
		} finally {
			ws.close();
		}
	}, 30_000);

	test("closing its socket ends the watch, as for a page at this computer", async () => {
		const ws = await remote.socket();
		if (!ws) throw new Error("the tunnel's socket was refused");
		watch(ws, true, { procs: true });
		await pollUntil(async () => (await history()).procs !== null, "the processes listed for the remote page");
		ws.close();
		await pollUntil(async () => (await history()).procs === null, "the listing stopped");
	}, 30_000);
});

describe("a server that restarts", () => {
	test("starts its history again: it is in memory only", async () => {
		await pollUntil(async () => (await history()).fine.t.length >= 3, "some history");
		const before = Date.now();
		await s.restart();
		await pollUntil(async () => (await history()).fine.t.length >= 1, "the first look of the new server", 20_000);
		const h = await history();
		// Everything it holds was looked at after the restart began.
		for (const t of h.fine.t) expect(t).toBeGreaterThanOrEqual(before);
		for (const t of h.coarse.t) expect(t).toBeGreaterThanOrEqual(before - 60_000);
	}, 60_000);
});

describe("the GPU probe is isolated", () => {
	/** What the mark says; "" while there is none yet. */
	const markerOf = (server: TestServer): string => {
		try {
			return readFileSync(join(server.root, "data", GPU_MARKER), "utf8").trim();
		} catch {
			return "";
		}
	};

	test("a start that crashed in the probe leaves the GPU out (the mark stays), and the CPU and memory are still looked at", async () => {
		if (process.platform !== "darwin") return;
		// The first look cleared the mark: the probe came back.
		await pollUntil(() => markerOf(s) === "ok", "the probe's first read");
		// A start that died in the probe left `probing`: the next start does not open it.
		writeFileSync(join(s.root, "data", GPU_MARKER), "probing\n");
		await s.restart();
		await pollUntil(async () => (await history()).fine.t.length >= 2, "looks of the new server", 20_000);
		const h = await history();
		expect(h.info.gpu).toBeNull();
		expect(h.fine.gpu.every((g) => g === null)).toBe(true);
		expect(h.fine.mem.every((m) => m !== null)).toBe(true);
		expect(markerOf(s)).toBe("probing");
	}, 60_000);

	test("OMP_WEBUI_HOST_GPU=0 leaves it out and never opens it; the pace settings have floors (250 ms and 1 s)", async () => {
		const off = await startTestServer(
			0,
			{ OMP_WEBUI_HOST_GPU: "0", OMP_WEBUI_HOST_LIVE_MS: "1", OMP_WEBUI_HOST_BACKGROUND_MS: "-3" },
			{ login: false },
		);
		try {
			const read = async (): Promise<HostHistory> =>
				(await fetch(`${off.url}/api/host`, { headers: { "x-omp-webui-token": off.accessToken } })).json();
			await pollUntil(async () => (await read()).fine.t.length >= 2, "two looks", 20_000);
			const h = await read();
			expect(h.info.liveMs).toBe(250);
			expect(h.info.backgroundMs).toBe(1000);
			expect(h.info.gpu).toBeNull();
			expect(h.fine.gpu.every((g) => g === null)).toBe(true);
			// Not even a mark: the probe was never going to be opened.
			expect(() => readFileSync(join(off.root, "data", GPU_MARKER))).toThrow();
			// What is not the GPU is looked at as usual.
			expectSeries(h.fine);
		} finally {
			await off.stop();
		}
	}, 60_000);
});
