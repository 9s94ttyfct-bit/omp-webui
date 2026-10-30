import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import pkg from "../../package.json";
import { processTree } from "../../server/omp/process-tree.ts";
import { relayDir } from "../../server/omp/relay-client.ts";
import { isRecord } from "../../shared/guards.ts";
import type { LiveInfo, LiveListing, ServerMessage } from "../../shared/protocol.ts";
import type { AppUpdateState, UpdateSnapshot } from "../../shared/update.ts";
import { type AppServer, startAppServer } from "../support/app-server.ts";
import { writeFakeOmp } from "../support/fake-omp.ts";
import { type FakeReleases, startFakeReleases } from "../support/fake-releases.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import { pollUntil, processExists } from "../support/poll.ts";
import { buildFixtures, disposeFixtures, type Fixtures, NEWER } from "../support/update-fixtures.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The app's updates through the real server (#571): it looks for a release by itself and tells the page, installs one from
 * a fake GitHub with the progress told on the socket, refuses a bad installer and says why, asks before it stops a
 * conversation that is replying, and, when it has handed everything to the helper and the app quits, a paused conversation
 * stays in the background for the next server. The test process is the "app": it is the server's parent, it gets the
 * request to quit (SIGUSR1) and, where the app would, stops the server the way the app's supervisor does (SIGTERM).
 */

const mac = process.platform === "darwin" && Bun.which("hdiutil") !== null && Bun.which("codesign") !== null;
/**
 * The installer a release lists. A look for releases never opens it, so where the signed disk images cannot be made (not a
 * Mac) any file stands in for it, and a server there is no app (it has no signed bundle to be).
 */
const releaseDmg = () => (mac ? fixtures.installers.good?.dmg : join(import.meta.dirname, "../../package.json"));
const root = mkdtempSync(join(tmpdir(), "ompw-update-contract-"));
let env: Record<string, string>;
let fixtures: Fixtures;
let fake: FakeReleases;
const procs: Subprocess[] = [];
const dataDirs: string[] = [];
const strays = new Set<number>();

/** What happens when the server asks the "app" to quit; each call of the handler is one request. */
let onQuitRequest: (() => void) | null = null;
const quitRequests: number[] = [];
process.on("SIGUSR1", () => {
	quitRequests.push(Date.now());
	onQuitRequest?.();
});

beforeAll(async () => {
	env = await isolatedEnv(root);
	mkdirSync(join(root, "work"), { recursive: true });
	fake = await startFakeReleases();
	if (mac) fixtures = await buildFixtures(join(root, "fx"), ["good", "tampered"]);
}, 180_000);

afterEach(() => {
	onQuitRequest = null;
	quitRequests.length = 0;
	fake.throttle(1 << 30, 0);
	fake.publish({ tag: "v0.0.0" });
	fake.requests.length = 0;
	for (const p of procs.splice(0)) p.kill("SIGKILL");
	for (const dir of dataDirs.splice(0)) for (const pid of relayPids(dir)) strays.add(pid);
	for (const pid of strays) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	strays.clear();
});
afterAll(async () => {
	await fake.stop();
	if (mac) disposeFixtures(fixtures);
	rmSync(root, { recursive: true, force: true });
});

function relayPids(dataDir: string): number[] {
	const dir = relayDir(dataDir);
	return Bun.spawnSync(["ps", "-A", "-o", "pid=,command="])
		.stdout.toString()
		.split("\n")
		.filter((line) => line.includes("--ompw-relay") && line.includes(dir))
		.map((line) => Number(line.trim().split(/\s+/)[0]));
}

interface Boot {
	server: AppServer;
	url: string;
	dataDir: string;
	bundle: string;
	ws: WebSocket;
	/** The `app_update` states this socket was sent, in order. */
	states: AppUpdateState[];
	get(path: string): Promise<Response>;
	post(path: string, body?: unknown): Promise<Response>;
	state(): Promise<AppUpdateState>;
}

let counter = 0;

/** A server like the app's, with the fake GitHub, a copy of the signed running app to replace, and the test as its parent. */
async function boot(dataDir: string, extra: Record<string, string> = {}, bundled = mac): Promise<Boot> {
	mkdirSync(dataDir, { recursive: true });
	if (!dataDirs.includes(dataDir)) dataDirs.push(dataDir);
	const installDir = join(root, `Applications-${++counter}`);
	mkdirSync(installDir, { recursive: true });
	const bundle = join(installDir, "omp-webui.app");
	if (bundled) Bun.spawnSync(["ditto", fixtures.running, bundle]);
	const server = await startAppServer(env, dataDir, 0, {
		OMP_WEBUI_APP_UPDATE_API: fake.url,
		OMP_WEBUI_APP_UPDATE_FIRST_MS: "100",
		OMP_WEBUI_PARENT_PID: String(process.pid),
		...(bundled ? { OMP_WEBUI_APP_BUNDLE: bundle } : {}),
		...extra,
	});
	procs.push(server.proc);
	const url = `http://127.0.0.1:${server.port}`;
	const ws = await connect({ url, accessToken: server.token });
	const states: AppUpdateState[] = [];
	ws.addEventListener("message", (ev) => {
		const m: ServerMessage = JSON.parse(String(ev.data));
		if (m.t === "app_update") states.push(m.state);
	});
	const headers = { "x-omp-webui-token": server.token, "x-omp-webui": "1", "content-type": "application/json" };
	const get = (path: string) => fetch(`${url}${path}`, { headers });
	return {
		server,
		url,
		dataDir,
		bundle,
		ws,
		states,
		get,
		post: (path, body) => fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body ?? {}) }),
		state: async () => ((await (await get("/api/update")).json()) as UpdateSnapshot).state,
	};
}

/** Stop the server as the app's supervisor does when the app quits. */
async function quit(b: Boot): Promise<void> {
	b.ws.close();
	b.server.proc.kill("SIGTERM");
	expect(await b.server.proc.exited).toBe(0);
}

/** The helper an install started, from the handover record; ended so that nothing waits for the "app" that never quits. */
function endHelper(b: Boot): void {
	try {
		const record: unknown = JSON.parse(readFileSync(join(b.dataDir, "update", "handover.json"), "utf8"));
		if (isRecord(record) && typeof record.helperPid === "number") process.kill(record.helperPid, "SIGKILL");
	} catch {
		// no helper
	}
}

function phases(states: AppUpdateState[]): string[] {
	const seen: string[] = [];
	for (const s of states) if (s.job && seen.at(-1) !== s.job.phase) seen.push(s.job.phase);
	return seen;
}

test("the server looks for a release soon after it starts, with no one asking, and a page that connects is told", async () => {
	fake.publish({ tag: `v${NEWER}`, dmg: releaseDmg() });
	const b = await boot(join(root, "data-start"));
	await pollUntil(async () => (await b.state()).newer, "the release to be found by itself");
	const state = await b.state();
	expect(state).toMatchObject({ installed: pkg.version, newer: true, failure: null, latest: { tag: `v${NEWER}` } });
	expect(state.latest?.asset?.name).toBe(`omp-webui-v${NEWER}.dmg`);
	const looks = fake.requests.filter((r) => r.path.endsWith("/releases/latest"));
	expect(looks).toHaveLength(1);
	expect(looks[0]?.headers["user-agent"]).toBe(`omp-webui/${pkg.version}`);
	expect(looks[0]?.headers.authorization).toBeUndefined();
	// It was told to the page that was open as it was found; a page that opens now is told at once.
	await pollUntil(() => b.states.some((s) => s.newer), "the open page to be told");
	const late = await connect({ url: b.url, accessToken: b.server.token });
	const told: AppUpdateState[] = [];
	late.addEventListener("message", (ev) => {
		const m: ServerMessage = JSON.parse(String(ev.data));
		if (m.t === "app_update") told.push(m.state);
	});
	await pollUntil(() => told.length > 0, "a page that opened after the release was found to be told");
	expect(told[0]?.latest?.tag).toBe(`v${NEWER}`);
	late.close();
}, 90_000);

test("a restarted server knows the release before it asks, and asks with the ETag it was given: a 304 changes nothing", async () => {
	fake.publish({ tag: `v${NEWER}`, dmg: releaseDmg() });
	const dataDir = join(root, "data-etag");
	const a = await boot(dataDir);
	await pollUntil(async () => (await a.state()).newer, "the first look");
	await quit(a);
	fake.requests.length = 0;
	const b = await boot(dataDir);
	await pollUntil(() => fake.requests.some((r) => r.path.endsWith("/releases/latest")), "the second server's look");
	expect(fake.requests[0]?.headers["if-none-match"]).toMatch(/^W\/"fake-/);
	await pollUntil(async () => (await b.state()).checkedAt !== null, "the answer to be taken");
	expect(await b.state()).toMatchObject({ newer: true, failure: null, latest: { tag: `v${NEWER}` } });
});

test("a server that is no app cannot install, and every route is for a page of this origin only", async () => {
	fake.publish({ tag: `v${NEWER}`, dmg: releaseDmg() });
	const b = await boot(join(root, "data-web"), {}, false);
	await pollUntil(async () => (await b.state()).newer, "the release to be found");
	expect((await b.state()).install).toEqual({ allowed: false, reason: "notApp" });
	const refused = await b.post("/api/update/install", { tag: `v${NEWER}`, anyway: true });
	expect(refused.status).toBe(409);
	expect(await refused.json()).toMatchObject({ code: "blocked", params: { reason: "notApp" } });
	expect(quitRequests).toEqual([]);

	const token = { "x-omp-webui-token": b.server.token };
	// A page of another origin (Sec-Fetch-Site) is refused, reading or writing.
	for (const site of ["cross-site", "same-site"]) {
		expect((await fetch(`${b.url}/api/update`, { headers: { ...token, "sec-fetch-site": site } })).status, site).toBe(
			403,
		);
		const post = await fetch(`${b.url}/api/update/check`, {
			method: "POST",
			headers: { ...token, "x-omp-webui": "1", "sec-fetch-site": site },
		});
		expect(post.status, site).toBe(403);
	}
	// A write without the CSRF header is refused, and with the page's own header it goes through.
	expect((await fetch(`${b.url}/api/update/check`, { method: "POST", headers: token })).status).toBe(403);
	expect((await fetch(`${b.url}/api/update`, { headers: { ...token, "sec-fetch-site": "same-origin" } })).status).toBe(
		200,
	);
	// Without the access token, nothing.
	expect((await fetch(`${b.url}/api/update`)).status).toBe(401);
});

test.skipIf(!mac)(
	"an install tells the page its progress, stages the new app next to the old one, records the hand-over and then asks the app to quit",
	async () => {
		fake.publish({ tag: `v${NEWER}`, dmg: fixtures.installers.good?.dmg });
		fake.throttle(3_000, 40);
		const b = await boot(join(root, "data-install"));
		await pollUntil(async () => (await b.state()).newer, "the release to be found");
		const started = await b.post("/api/update/install", { tag: `v${NEWER}` });
		expect(started.status).toBe(200);
		expect(((await started.json()) as UpdateSnapshot).state.job).toMatchObject({
			tag: `v${NEWER}`,
			phase: "downloading",
		});
		await pollUntil(() => b.states.some((s) => s.job?.phase === "handover"), "the hand-over", 60_000);
		try {
			expect(phases(b.states)).toEqual(["downloading", "verifying", "staging", "handover"]);
			// The download was told as it came: a step with some of it, each step further than the one before.
			const steps = b.states.filter((s) => s.job?.phase === "downloading").map((s) => s.job);
			expect(steps.some((job) => job && job.received > 0 && job.received < job.total)).toBe(true);
			const received = steps.map((job) => job?.received ?? 0);
			expect([...received].sort((x, y) => x - y)).toEqual(received);
			expect(new Set(b.states.map((s) => s.boot)).size).toBe(1);
			// The app was asked once, after the record the shell looks for was there.
			await pollUntil(() => quitRequests.length > 0, "the request to quit");
			expect(quitRequests).toHaveLength(1);
			expect(existsSync(join(b.dataDir, "update", "handover.json"))).toBe(true);
			// The new app is beside the old one, checked and ready; nothing of the download is left.
			expect(readdirSync(join(b.bundle, "..")).sort()).toEqual(["omp-webui.app", "omp-webui.app.updating"]);
			const staged = Bun.spawnSync([
				"plutil",
				"-extract",
				"CFBundleShortVersionString",
				"raw",
				"-o",
				"-",
				join(`${b.bundle}.updating`, "Contents", "Info.plist"),
			]);
			expect(staged.stdout.toString().trim()).toBe(NEWER);
			expect(
				readdirSync(join(b.dataDir, "update")).filter((f) => f.endsWith(".dmg") || f.startsWith("mount-")),
			).toEqual([]);
			expect((await b.state()).job?.phase).toBe("handover");
		} finally {
			endHelper(b);
		}
	},
	120_000,
);

test.skipIf(!mac)(
	"an installer that fails a check is refused with the reason, nothing is staged and the app is not asked to quit",
	async () => {
		fake.publish({ tag: fixtures.installers.tampered?.tag as string, dmg: fixtures.installers.tampered?.dmg });
		const b = await boot(join(root, "data-refuse"));
		await pollUntil(async () => (await b.state()).newer, "the release to be found");
		expect((await b.post("/api/update/install", { tag: `v${NEWER}` })).status).toBe(200);
		await pollUntil(() => b.states.some((s) => s.failed !== null), "the refusal to be told", 60_000);
		const failed = b.states.find((s) => s.failed !== null)?.failed;
		expect(failed).toMatchObject({ code: "signature", tag: `v${NEWER}` });
		expect((await b.state()).job).toBeNull();
		expect(readdirSync(join(b.bundle, ".."))).toEqual(["omp-webui.app"]);
		expect(quitRequests).toEqual([]);
		expect(existsSync(join(b.dataDir, "update", "handover.json"))).toBe(false);
		// Dismissing it clears it, for every page.
		const dismissed = (await (await b.post("/api/update/dismiss")).json()) as UpdateSnapshot;
		expect(dismissed.state.failed).toBeNull();
		await pollUntil(() => b.states.at(-1)?.failed === null, "the dismissal to be told");
	},
	120_000,
);

test.skipIf(!mac)(
	"a conversation that is replying is named first, and the install goes on only when it is confirmed",
	async () => {
		fake.publish({ tag: `v${NEWER}`, dmg: fixtures.installers.good?.dmg });
		fake.throttle(2_000, 50);
		const bin = writeFakeOmp(root, { tool: true, streaming: true });
		const b = await boot(join(root, "data-replying"), { OMP_BIN: bin });
		await pollUntil(async () => (await b.state()).newer, "the release to be found");
		await request<LiveInfo>(b.ws, { t: "open", target: { kind: "new", cwd: join(root, "work") } });
		await pollUntil(
			async () => ((await (await b.get("/api/lives")).json()) as LiveListing[]).some((l) => l.busy),
			"the conversation to be working",
		);
		const asked = await b.post("/api/update/install", { tag: `v${NEWER}` });
		expect(asked.status).toBe(409);
		expect(await asked.json()).toMatchObject({
			code: "replying",
			params: { working: 1, asking: 0, paused: 0, waiting: 0 },
		});
		expect((await b.state()).job).toBeNull();
		const confirmed = await b.post("/api/update/install", { tag: `v${NEWER}`, anyway: true });
		expect(confirmed.status).toBe(200);
		expect(((await confirmed.json()) as UpdateSnapshot).state.job?.phase).toBe("downloading");
		// A second install while it runs is refused, and a cancel stops it without a failure.
		expect((await b.post("/api/update/install", { tag: `v${NEWER}`, anyway: true })).status).toBe(409);
		await b.post("/api/update/cancel");
		await pollUntil(async () => (await b.state()).job === null, "the cancel");
		expect((await b.state()).failed).toBeNull();
		expect(quitRequests).toEqual([]);
	},
	120_000,
);

test.skipIf(!mac)(
	"when the app quits for an update, a paused conversation stays in the background: the next server takes it over where it stopped",
	async () => {
		fake.publish({ tag: `v${NEWER}`, dmg: fixtures.installers.good?.dmg });
		const bin = writeFakeOmp(root, { tool: true, streaming: true });
		const dataDir = join(root, "data-keeps");
		const a = await boot(dataDir, { OMP_BIN: bin });
		await pollUntil(async () => (await a.state()).newer, "the release to be found");
		const live = await request<LiveInfo>(a.ws, { t: "open", target: { kind: "new", cwd: join(root, "work") } });
		const omp = live.pid as number;
		strays.add(omp);
		const tool = (await processTree(omp)).find((p) => p !== omp) as number;
		strays.add(tool);
		const paused = await request<LiveInfo>(a.ws, { t: "pause", liveId: live.liveId });
		const frozen = (pid: number) =>
			Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
				.stdout.toString()
				.trim()
				.startsWith("T");
		expect(frozen(omp) && frozen(tool)).toBe(true);

		// The app: asked to quit for the update, it stops the server as its supervisor does, and waits for it.
		const stopped = Promise.withResolvers<number>();
		onQuitRequest = () => {
			a.ws.close();
			a.server.proc.kill("SIGTERM");
			void a.server.proc.exited.then(stopped.resolve);
		};
		// A paused conversation is no reason to ask: it stays.
		const started = await a.post("/api/update/install", { tag: `v${NEWER}` });
		expect(started.status).toBe(200);
		expect(await stopped.promise).toBe(0);
		expect(quitRequests).toHaveLength(1);

		try {
			// The server is gone; the conversation's processes are not, and still frozen, with the update waiting for its app.
			expect(processExists(a.server.proc.pid)).toBe(false);
			expect([omp, tool].every(processExists)).toBe(true);
			expect(frozen(omp) && frozen(tool)).toBe(true);
			expect(existsSync(join(dataDir, "update", "handover.json"))).toBe(true);

			const b = await boot(dataDir, { OMP_BIN: bin });
			const [adopted] = ((await (await b.get("/api/lives")).json()) as LiveListing[]).filter(
				(l) => l.liveId === live.liveId,
			);
			expect(adopted).toMatchObject({ pid: omp, pausedAt: paused.pausedAt, exited: false });
			expect(frozen(omp) && frozen(tool)).toBe(true);
			// It runs again where it stopped, as after any restart.
			await request(b.ws, { t: "resume", liveId: live.liveId });
			await pollUntil(() => !frozen(omp) && !frozen(tool), "omp and its tool to run again");
			await request(b.ws, { t: "close", liveId: live.liveId });
			await pollUntil(() => ![omp, tool].some(processExists), "the conversation to end");
			endHelper(b);
			await quit(b);
		} finally {
			endHelper(a);
		}
	},
	120_000,
);
