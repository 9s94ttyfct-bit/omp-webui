import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OmpSnapshot } from "../../shared/omp-install.ts";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { type FakeRegistry, makeWorld, realOmp, startFakeRegistry, type World } from "../support/fake-install.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * omp as the real server runs it: missing, installed from the API, updated when nothing is working. The server
 * runs with a PATH of its own (fake `brew` and `curl`, a launcher in place of omp that hands everything but
 * `--version` and `update` to the machine's omp), an isolated HOME and a fake registry, over real HTTP and
 * WebSocket; no model call, no real installer, and the omp of this machine is never changed.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-lifecycle-contract-"));
const servers: TestServer[] = [];
const registries: FakeRegistry[] = [];
afterAll(async () => {
	for (const s of servers) await s.stop();
	for (const r of registries) await r.stop();
	rmSync(root, { recursive: true, force: true });
});

const skip = realOmp() === null;
let n = 0;
function world(options: { version: string; installers?: boolean; installed?: boolean; brewSeconds?: number }): World {
	return makeWorld(join(root, `world${++n}`), options);
}

function headers(s: TestServer, extra: Record<string, string> = {}) {
	return { "x-omp-webui-token": s.accessToken, ...extra };
}
async function get<T>(s: TestServer, path: string): Promise<T> {
	return (await fetch(`${s.url}${path}`, { headers: headers(s) })).json();
}
async function post(s: TestServer, path: string, body: unknown = {}, csrf = true): Promise<Response> {
	return fetch(`${s.url}${path}`, {
		method: "POST",
		headers: headers(s, { "content-type": "application/json", ...(csrf ? { "x-omp-webui": "1" } : {}) }),
		body: JSON.stringify(body),
	});
}
const omp = (s: TestServer) => get<OmpSnapshot>(s, "/api/omp");

// ------------------------------------------------------------------ no omp

let missing: TestServer;
let missingWorld: World;
beforeAll(async () => {
	if (skip) return;
	missingWorld = world({ version: "18.12.1", installers: true });
	missing = await startTestServer(0, { PATH: missingWorld.path, OMP_BIN: "omp" });
	servers.push(missing);
}, 60_000);

test.skipIf(skip)(
	"without omp the server runs, says so, and offers install methods; nothing needing omp works",
	async () => {
		const { state } = await omp(missing);
		expect(state.status).toBe("missing");
		expect(state.bin).toBeNull();
		expect(state.options.map((o) => [o.id, o.available])).toEqual([
			["homebrew", true],
			["installer", true],
			["bun", true],
		]);
		expect(state.options.find((o) => o.recommended)?.id).toBe("homebrew");
		expect((await get<{ ompVersion: string }>(missing, "/api/meta")).ompVersion).toBe("unknown");
		// What needs omp fails; what does not (the conversations on disk) still answers.
		expect((await fetch(`${missing.url}/api/cli`, { headers: headers(missing) })).status).toBe(500);
		expect((await fetch(`${missing.url}/api/sessions`, { headers: headers(missing) })).status).toBe(200);
	},
);

test.skipIf(skip)(
	"the install API needs the token and the CSRF header, and takes only methods from its table",
	async () => {
		expect((await fetch(`${missing.url}/api/omp`)).status).toBe(401);
		expect((await post(missing, "/api/omp/install", { method: "homebrew" }, false)).status).toBe(403);
		const unknown = await post(missing, "/api/omp/install", { method: "rm -rf /" });
		expect(unknown.status).toBe(400);
		expect(await unknown.json()).toMatchObject({ error: "Unknown install method: rm -rf /", code: "unavailable" });
		// Nothing ran.
		expect((await omp(missing)).state.job).toBeNull();
	},
);

test.skipIf(skip)("installing runs the command, streams its output, then the server uses the omp it left", async () => {
	const ws = await connect(missing);
	const seen: { t: string; job?: string; text?: string; state?: { status: string; job: { state: string } | null } }[] =
		[];
	ws.addEventListener("message", (ev) => seen.push(JSON.parse(String(ev.data))));

	const started = await post(missing, "/api/omp/install", { method: "homebrew" });
	expect(started.status).toBe(200);
	const first = ((await started.json()) as OmpSnapshot).state;
	expect(first.job).toMatchObject({ kind: "install", method: "homebrew", command: "brew install can1357/tap/omp" });
	// A second install while one runs is refused.
	const again = await post(missing, "/api/omp/install", { method: "homebrew" });
	expect(again.status).toBe(409);

	await pollUntil(async () => (await omp(missing)).state.job?.state === "done", "the install to end");
	const done = await omp(missing);
	expect(done.state).toMatchObject({ status: "ready", version: "18.12.1", onboarding: true, options: [] });
	expect(done.state.install).toMatchObject({ method: "homebrew", updatable: true });
	expect(done.log).toContain("==> Installing omp");

	// The page heard of it as it happened: the output in pieces, and the state at the end.
	await pollUntil(() => seen.some((m) => m.t === "omp" && m.state?.status === "ready"), "the page to be told");
	expect(
		seen
			.filter((m) => m.t === "omp_log" && m.job === done.state.job?.id)
			.map((m) => m.text)
			.join(""),
	).toContain("omp was successfully installed!");
	expect(seen.some((m) => m.t === "omp" && m.state?.job?.state === "running")).toBe(true);

	// Everything that held omp's location now uses the one installed: the version, the CLI listing, a process.
	expect((await get<{ ompVersion: string }>(missing, "/api/meta")).ompVersion).toBe("18.12.1");
	expect((await fetch(`${missing.url}/api/cli`, { headers: headers(missing) })).status).toBe(200);
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: missingWorld.dir } });
	expect(live.pid).toBeGreaterThan(0);
	await request(ws, { t: "close", liveId: live.liveId });
	expect((await post(missing, "/api/omp/install", { method: "homebrew" })).status).toBe(409);
	ws.close();

	// The setup that follows is the server's to remember, and finishing it is one request.
	expect(JSON.parse(readFileSync(join(missing.root, "data", "omp.json"), "utf8")).onboarding).toBe(true);
	const finished = (await (await post(missing, "/api/omp/onboarding", { pending: false })).json()) as OmpSnapshot;
	expect(finished.state).toMatchObject({ onboarding: false, job: null });
	expect((await post(missing, "/api/omp/onboarding", { pending: "no" })).status).toBe(400);
});

// ------------------------------------------------------------------ updates

let updating: TestServer;
let updatingWorld: World;
let registry: FakeRegistry;
beforeAll(async () => {
	if (skip) return;
	updatingWorld = world({ version: "18.12.0", installed: true });
	updatingWorld.state.setUpdateTo("19.0.0");
	registry = await startFakeRegistry("19.0.0");
	registries.push(registry);
	updating = await startTestServer(0, {
		PATH: updatingWorld.path,
		OMP_BIN: "omp",
		npm_config_registry: registry.url,
		// No look-up of its own: the test asks for each one.
		OMP_WEBUI_UPDATE_CHECK: "off",
	});
	servers.push(updating);
}, 60_000);

test.skipIf(skip)(
	"a release is looked up on request; one outside the supported range needs an acknowledgement",
	async () => {
		expect((await omp(updating)).state.release).toBeNull();
		const checked = (await (await post(updating, "/api/omp/check")).json()) as OmpSnapshot;
		expect(checked.state.release).toMatchObject({ latest: "19.0.0", newer: true, compat: "newer", source: "npm" });
		expect(registry.hits).toEqual(["/@oh-my-pi%2fpi-coding-agent/latest"]);
		expect(checked.state.compat).toEqual({ range: ">=18.11.0 <19.0.0", verdict: "supported" });

		const refused = await post(updating, "/api/omp/update", {});
		expect(refused.status).toBe(409);
		expect(await refused.json()).toMatchObject({ code: "outside_compat" });
		expect(updatingWorld.state.updateCalls()).toEqual([]);
	},
);

test.skipIf(skip)("'Update omp automatically' is off until set, and what is set is kept in the data dir", async () => {
	expect((await omp(updating)).state.autoUpdate).toBe(false);
	expect((await post(updating, "/api/omp/settings", { autoUpdate: "yes" })).status).toBe(400);
	const on = (await (await post(updating, "/api/omp/settings", { autoUpdate: true })).json()) as OmpSnapshot;
	expect(on.state.autoUpdate).toBe(true);
	expect(JSON.parse(readFileSync(join(updating.root, "data", "omp.json"), "utf8")).autoUpdate).toBe(true);
	// The release is outside the range, so even with the setting on nothing is updated by itself.
	expect((await omp(updating)).state.job).toBeNull();
	await post(updating, "/api/omp/settings", { autoUpdate: false });
});

test.skipIf(skip)("an acknowledged update waits for a working conversation, then runs omp update", async () => {
	const ws = await connect(updating);
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: updatingWorld.dir } });
	// `!command`: omp is working until it ends. It ends when this test says so, not after a number of seconds that a busy
	// machine can overtake between the steps below.
	const go = join(updatingWorld.dir, "go");
	const finished = request(ws, {
		t: "rpc",
		liveId: live.liveId,
		command: { type: "bash", command: `while [ ! -e '${go}' ]; do sleep 0.1; done` },
	});
	await pollUntil(
		async () => (await get<LiveListing[]>(updating, "/api/lives")).find((l) => l.liveId === live.liveId)?.busy === true,
		"the conversation to be working",
	);

	const asked = (await (await post(updating, "/api/omp/update", { acknowledgeCompat: true })).json()) as OmpSnapshot;
	expect(asked.state.job).toMatchObject({
		kind: "update",
		method: "homebrew",
		state: "waiting",
		waiting: { working: 1, asking: 0, paused: 0 },
	});
	expect(updatingWorld.state.updateCalls()).toEqual([]);

	// The command cannot end before this: an update that started earlier than that began while it was working.
	const released = Date.now();
	writeFileSync(go, "");
	await finished;
	await pollUntil(async () => (await omp(updating)).state.job?.state === "done", "the update to run once idle", 30_000);
	const done = (await omp(updating)).state;
	expect(done.job?.startedAt).toBeGreaterThanOrEqual(released);
	expect(done).toMatchObject({ version: "19.0.0", compat: { verdict: "newer" } });
	expect(updatingWorld.state.updateCalls()).toHaveLength(1);
	expect((await get<{ ompVersion: string }>(updating, "/api/meta")).ompVersion).toBe("19.0.0");
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
});

test.skipIf(skip)(
	"a paused conversation holds an update: the job says so, and 'update anyway' runs it without waiting for a resume",
	async () => {
		updatingWorld.state.setUpdateTo("19.1.0");
		registry.setLatest("19.1.0");
		await post(updating, "/api/omp/check");
		const ws = await connect(updating);
		const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: updatingWorld.dir } });
		await request(ws, { t: "pause", liveId: live.liveId });
		const listed = (await get<LiveListing[]>(updating, "/api/lives")).find((l) => l.liveId === live.liveId);
		expect(listed).toMatchObject({ busy: true, holding: "paused" });
		const before = updatingWorld.state.updateCalls().length;

		const asked = (await (await post(updating, "/api/omp/update", { acknowledgeCompat: true })).json()) as OmpSnapshot;
		expect(asked.state.job).toMatchObject({
			kind: "update",
			state: "waiting",
			anyway: false,
			waiting: { working: 0, asking: 0, paused: 1 },
		});
		// Nothing is working, yet it does not start: a paused conversation stays until it is resumed or ended.
		// A separate server process decides on its own one-second timer, which no test clock reaches: look across two ticks.
		await Bun.sleep(2500);
		expect((await omp(updating)).state.job).toMatchObject({ state: "waiting", waiting: { paused: 1 } });
		expect(updatingWorld.state.updateCalls()).toHaveLength(before);

		const anyway = (await (
			await post(updating, "/api/omp/update", { acknowledgeCompat: true, anyway: true })
		).json()) as OmpSnapshot;
		expect(anyway.state.job).toMatchObject({ kind: "update", anyway: true });
		await pollUntil(async () => (await omp(updating)).state.job?.state === "done", "the update to run", 30_000);
		expect(updatingWorld.state.updateCalls()).toHaveLength(before + 1);
		expect((await omp(updating)).state).toMatchObject({ version: "19.1.0" });
		// The paused conversation was left as it was: still there, still frozen.
		expect((await get<LiveListing[]>(updating, "/api/lives")).find((l) => l.liveId === live.liveId)).toMatchObject({
			holding: "paused",
		});
		await request(ws, { t: "resume", liveId: live.liveId });
		await request(ws, { t: "close", liveId: live.liveId });
		ws.close();
	},
	60_000,
);

test.skipIf(skip)(
	"an automatic update skips a paused conversation but says what it waits for, then runs once it is resumed",
	async () => {
		const w = world({ version: "18.12.0", installed: true });
		w.state.setUpdateTo("18.13.0");
		const registry = await startFakeRegistry("18.13.0");
		registries.push(registry);
		const s = await startTestServer(0, {
			PATH: w.path,
			OMP_BIN: "omp",
			npm_config_registry: registry.url,
			OMP_WEBUI_UPDATE_CHECK: "off",
		});
		servers.push(s);
		const ws = await connect(s);
		const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: w.dir } });
		await request(ws, { t: "pause", liveId: live.liveId });
		await post(s, "/api/omp/check");
		await post(s, "/api/omp/settings", { autoUpdate: true });

		await pollUntil(
			async () => (await omp(s)).state.autoWaitingFor?.paused === 1,
			"the page to be told what it waits for",
		);
		expect((await omp(s)).state).toMatchObject({ job: null, autoWaitingFor: { working: 0, asking: 0, paused: 1 } });
		// A separate server process decides on its own one-second timer, which no test clock reaches: look across two ticks.
		await Bun.sleep(2500);
		expect(w.state.updateCalls()).toEqual([]);

		await request(ws, { t: "resume", liveId: live.liveId });
		await pollUntil(async () => (await omp(s)).state.job?.state === "done", "the automatic update to run", 30_000);
		expect((await omp(s)).state).toMatchObject({ version: "18.13.0", autoWaitingFor: null });
		expect(w.state.updateCalls()).toHaveLength(1);
		await request(ws, { t: "close", liveId: live.liveId });
		ws.close();
	},
	90_000,
);

test.skipIf(skip)(
	"stopping the server in the middle of an install does not stop the install, and the next server settles the job",
	async () => {
		const w = world({ version: "18.12.1", installers: true, brewSeconds: 3 });
		const s = await startTestServer(0, { PATH: w.path, OMP_BIN: "omp" });
		servers.push(s);
		expect((await post(s, "/api/omp/install", { method: "homebrew" })).status).toBe(200);
		await pollUntil(async () => (await omp(s)).log.includes("==> Fetching"), "brew to be under way");
		expect(existsSync(join(w.prefix, "bin", "omp"))).toBe(false);

		// SIGTERM, as quitting the app does, while brew is still at it: its output pipe used to go with the server.
		await s.restart();
		// brew was not cut off: it gets to the end and links omp, whatever the servers did meanwhile.
		await pollUntil(() => existsSync(join(w.prefix, "bin", "omp")), "brew to finish by itself", 30_000);
		expect(readFileSync(w.brewLog, "utf8")).toContain("install can1357/tap/omp");

		// The server that came up afterwards found the job — running, or already over — and finished it as if it had
		// watched it: omp adopted, the first-time setup pending, brew's output kept.
		await pollUntil(async () => (await omp(s)).state.job?.state === "done", "the job to be settled", 30_000);
		const after = await omp(s);
		expect(after.state).toMatchObject({ status: "ready", version: "18.12.1", onboarding: true });
		expect(after.state.job).toMatchObject({ kind: "install", method: "homebrew", exitCode: 0 });
		expect(after.log).toContain("omp was successfully installed!");
		expect((await get<{ ompVersion: string }>(s, "/api/meta")).ompVersion).toBe("18.12.1");
	},
	90_000,
);
