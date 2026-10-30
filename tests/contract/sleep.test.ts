import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { startAppServer } from "../support/app-server.ts";
import { writeFakeOmp } from "../support/fake-omp.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import { pollUntil } from "../support/poll.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Keeping the Mac awake while a conversation works, on the real server (#647): the server runs `caffeinate` for as long as
 * something works and lets it go when nothing does, the setting turns it off, and `/api/meta` says whether the machine can
 * be held awake at all.
 *
 * `caffeinate` is a stub this test writes (`OMP_WEBUI_CAFFEINATE`), because the real one would hold a CI machine's sleep
 * off; what is asserted is that the server starts and ends it, from an argument list and never a shell, and when. Only
 * macOS has `caffeinate`, so the test is about a server there (it skips elsewhere). A scripted omp, no model.
 */

const mac = process.platform === "darwin";
const root = mkdtempSync(join(tmpdir(), "ompw-sleep-contract-"));
const work = join(root, "work");
let env: Record<string, string>;
const procs: Subprocess[] = [];
const dataDirs: string[] = [];
/** The stubs started (a failing test may leave one running): killed at the end of each test, and they end by themselves. */
const stubs = new Set<string>();

beforeAll(async () => {
	env = await isolatedEnv(root);
	mkdirSync(work, { recursive: true });
});
afterEach(() => {
	for (const p of procs.splice(0)) p.kill("SIGKILL");
	// A stub the server did not end (a failure before it did): killed by what it is, the stub binary in this test's own
	// folder (its command line is `bun <bin> -i -w <pid>`).
	for (const bin of stubs) {
		const listing = Bun.spawnSync(["ps", "-A", "-o", "pid=,command="]).stdout.toString();
		for (const line of listing.split("\n")) {
			if (!line.includes(bin)) continue;
			const pid = Number(line.trim().split(/\s+/, 1)[0]);
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
	}
	stubs.clear();
});
afterAll(() => {
	for (const d of dataDirs) rmSync(d, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
});

/**
 * A stand-in for `/usr/bin/caffeinate`: it writes its own argv and pid to `log`, and stays until it is ended or the pid it
 * was given with `-w` is gone, as a real one does. Its exit on SIGTERM is appended too, so a test can see that it was let go.
 */
function writeStubCaffeinate(): { bin: string; log: string } {
	const dir = join(root, "caffeinate");
	mkdirSync(dir, { recursive: true });
	const bin = join(dir, "caffeinate-stub");
	const log = join(dir, "log");
	writeFileSync(log, "");
	writeFileSync(
		bin,
		`#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const log = ${JSON.stringify(log)};
appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }) + "\\n");
// A real \`caffeinate -w\` polls the pid it was given and exits when it is gone; so does this one, so a server that was
// SIGKILLed cannot leave it behind. SIGKILL cannot be handled: a test that kills it just sees no \`ended\` line.
process.on("SIGTERM", () => { appendFileSync(log, JSON.stringify({ ended: process.pid }) + "\\n"); process.exit(0); });
const w = process.argv.indexOf("-w");
const watched = w === -1 ? NaN : Number(process.argv[w + 1]);
setInterval(() => {
	if (!Number.isInteger(watched)) return;
	try {
		process.kill(watched, 0);
	} catch {
		process.exit(0);
	}
}, 500);
`,
	);
	chmodSync(bin, 0o755);
	stubs.add(bin);
	return { bin, log };
}

interface Line {
	argv?: string[];
	pid?: number;
	ended?: number;
}

const lines = (log: string): Line[] =>
	readFileSync(log, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Line);
/** The stub processes still running, by pid: one of them holds the Mac's sleep off now. */
const started = (log: string): number[] => lines(log).flatMap((l) => (l.pid === undefined ? [] : [l.pid]));
const ended = (log: string): number[] => lines(log).flatMap((l) => (l.ended === undefined ? [] : [l.ended]));
/** Whether the process is still there (one that exited but is not reaped still is, which is what is asked here). */
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function boot(name: string, extra: Record<string, string> = {}) {
	const dataDir = join(root, name);
	mkdirSync(dataDir, { recursive: true });
	dataDirs.push(dataDir);
	const server = await startAppServer(env, dataDir, 0, extra);
	procs.push(server.proc);
	const url = `http://127.0.0.1:${server.port}`;
	const ws = await connect({ url, accessToken: server.token });
	const lives = async (): Promise<LiveListing[]> =>
		(await fetch(`${url}/api/lives`, { headers: { "x-omp-webui-token": server.token } })).json();
	const setPref = async (keepAwake: "on" | "off") => {
		const res = await fetch(`${url}/api/prefs`, {
			method: "POST",
			headers: { "x-omp-webui-token": server.token, "content-type": "application/json", "x-omp-webui": "1" },
			body: JSON.stringify({ changes: { "ompw.keepAwake": keepAwake } }),
		});
		expect(res.ok).toBe(true);
	};
	return { server, url, ws, lives, setPref };
}

/** A turn of omp's own: `agent_start` until `agent_end`, which is what `working` counts. */
const turnEnds = { type: "agent_end", isTerminal: true };

(mac ? test : test.skip)(
	"a working conversation starts caffeinate for this server, and it is let go when nothing works",
	async () => {
		const stub = writeStubCaffeinate();
		const bin = writeFakeOmp(root, {});
		const b = await boot("data-wake", { OMP_BIN: bin, OMP_WEBUI_CAFFEINATE: stub.bin });
		// Nothing works yet: nothing holds the machine.
		expect(started(stub.log)).toEqual([]);

		const live = await request<LiveInfo>(b.ws, { t: "open", target: { kind: "new", cwd: work } });
		// Still idle after the process came up: a conversation that is not working has no turn to cut.
		await pollUntil(() => b.lives().then((l) => l.length === 1), "the conversation to be listed");
		expect(started(stub.log)).toEqual([]);

		await request(b.ws, {
			t: "rpc",
			liveId: live.liveId,
			command: { type: "emit_frames", frames: [{ type: "agent_start" }] },
		});
		await pollUntil(() => started(stub.log).length === 1, "caffeinate to start with the turn", 15_000);
		const [argv] = lines(stub.log).map((l) => l.argv ?? []);
		// An argument list, never a shell: `-i` (idle sleep only, the display may still sleep) and `-w <this server's pid>`.
		expect(argv).toEqual(["-i", "-w", String(b.server.proc.pid)]);
		const holder = started(stub.log)[0];
		expect(alive(holder)).toBe(true);
		// A turn that runs for a while keeps it: a `caffeinate` that was killed by a timer of the server's own would be gone
		// here, and the Mac would sleep in the middle of a turn (#647 in practice).
		await Bun.sleep(3000);
		expect(alive(holder)).toBe(true);

		await request(b.ws, { t: "rpc", liveId: live.liveId, command: { type: "emit_frames", frames: [turnEnds] } });
		await pollUntil(() => ended(stub.log).includes(holder), "caffeinate to be let go when the turn ended", 15_000);
		await pollUntil(() => !alive(holder), "the caffeinate process to be gone", 15_000);
	},
);

(mac ? test : test.skip)(
	"the setting off stops caffeinate at once and starts none, and on again starts one with what works",
	async () => {
		const stub = writeStubCaffeinate();
		// `streaming: true` is what `get_state` reports: the server reads omp's state after every turn, and a conversation
		// that says it is not streaming is not working, however it announced its turn.
		const bin = writeFakeOmp(root, { streaming: true });
		const b = await boot("data-setting", { OMP_BIN: bin, OMP_WEBUI_CAFFEINATE: stub.bin });
		const live = await request<LiveInfo>(b.ws, { t: "open", target: { kind: "new", cwd: work } });
		await request(b.ws, {
			t: "rpc",
			liveId: live.liveId,
			command: { type: "emit_frames", frames: [{ type: "agent_start" }] },
		});
		await pollUntil(() => started(stub.log).length === 1, "caffeinate to start with the turn", 15_000);
		const first = started(stub.log)[0];

		// The person turns it off in Settings while the turn runs: the child goes, and the turn is not ended by it.
		await b.setPref("off");
		await pollUntil(() => ended(stub.log).includes(first), "caffeinate to be let go when the setting went off", 15_000);
		// The stub logs its exit before it exits: the process itself is what must be gone.
		await pollUntil(() => !alive(first), "the caffeinate process to be gone", 15_000);
		expect((await b.lives())[0].streaming).toBe(true);

		// Still off: nothing starts while the conversation goes on working either.
		await request(b.ws, {
			t: "rpc",
			liveId: live.liveId,
			command: { type: "emit_frames", frames: [turnEnds, { type: "agent_start" }] },
		});
		await Bun.sleep(1500);
		expect(started(stub.log).length).toBe(1);

		// On again with a turn running: it starts with what is working, rather than at the next turn.
		await b.setPref("on");
		await pollUntil(() => started(stub.log).length === 2, "caffeinate to start when the setting came back on", 15_000);
		expect(lines(stub.log).at(-1)?.argv).toEqual(["-i", "-w", String(b.server.proc.pid)]);
	},
);

(mac ? test : test.skip)(
	"a server that stops takes caffeinate with it, and /api/meta says this machine can be held awake",
	async () => {
		const stub = writeStubCaffeinate();
		const bin = writeFakeOmp(root, {});
		const b = await boot("data-exit", { OMP_BIN: bin, OMP_WEBUI_CAFFEINATE: stub.bin });
		const meta = (await (
			await fetch(`${b.url}/api/meta`, { headers: { "x-omp-webui-token": b.server.token } })
		).json()) as {
			keepAwakeAvailable?: boolean;
		};
		expect(meta.keepAwakeAvailable).toBe(true);

		const live = await request<LiveInfo>(b.ws, { t: "open", target: { kind: "new", cwd: work } });
		await request(b.ws, {
			t: "rpc",
			liveId: live.liveId,
			command: { type: "emit_frames", frames: [{ type: "agent_start" }] },
		});
		await pollUntil(() => started(stub.log).length === 1, "caffeinate to start with the turn", 15_000);
		const holder = started(stub.log)[0];
		// Quitting the app stops the server: nothing may be left holding the machine's sleep off, and `-w` is the backstop.
		b.ws.close();
		b.server.proc.kill("SIGTERM");
		expect(await b.server.proc.exited).toBe(0);
		await pollUntil(() => ended(stub.log).includes(holder), "caffeinate to be let go when the server stopped", 15_000);
		await pollUntil(() => !alive(holder), "the caffeinate process to be gone", 15_000);
	},
);

test("a server elsewhere says the setting is not available, and starts nothing", async () => {
	// Not a claim about this machine: the flag the page reads is the server's answer about its own platform, and a server
	// that is not on macOS has no `caffeinate` to run (see `KeepAwake.available`).
	if (mac) {
		// On a Mac the flag is true, and the stub tests above cover what it starts; nothing to assert here.
		expect(existsSync("/usr/bin/caffeinate")).toBe(true);
		return;
	}
	const stub = writeStubCaffeinate();
	const bin = writeFakeOmp(root, {});
	const b = await boot("data-elsewhere", { OMP_BIN: bin, OMP_WEBUI_CAFFEINATE: stub.bin });
	const meta = (await (
		await fetch(`${b.url}/api/meta`, { headers: { "x-omp-webui-token": b.server.token } })
	).json()) as {
		keepAwakeAvailable?: boolean;
	};
	expect(meta.keepAwakeAvailable).toBe(false);
	const live = await request<LiveInfo>(b.ws, { t: "open", target: { kind: "new", cwd: work } });
	await request(b.ws, {
		t: "rpc",
		liveId: live.liveId,
		command: { type: "emit_frames", frames: [{ type: "agent_start" }] },
	});
	await Bun.sleep(1500);
	expect(started(stub.log)).toEqual([]);
});

test("a page that is not on this computer cannot change keep-awake, and the other preferences still go through", async () => {
	const stub = writeStubCaffeinate();
	const bin = writeFakeOmp(root, {});
	const b = await boot("data-remote", { OMP_BIN: bin, OMP_WEBUI_CAFFEINATE: stub.bin });
	// A request that came through the tunnel is not this computer's (`isThisComputer`: no proxy header on a loopback one),
	// and the token it holds changes nothing about that.
	const remote = (changes: Record<string, string>) =>
		fetch(`${b.url}/api/prefs`, {
			method: "POST",
			headers: {
				"x-omp-webui-token": b.server.token,
				"x-omp-webui": "1",
				"content-type": "application/json",
				"x-forwarded-for": "203.0.113.9",
			},
			body: JSON.stringify({ changes }),
		});
	const meta = (await (
		await fetch(`${b.url}/api/meta`, {
			headers: { "x-omp-webui-token": b.server.token, "x-forwarded-for": "203.0.113.9" },
		})
	).json()) as { remote?: boolean; local?: boolean };
	expect(meta.remote, "the fixture's proxy header must make this a remote page").toBe(true);

	// Turned off from such a page: refused, and nothing changed.
	const refused = await remote({ "ompw.keepAwake": "off" });
	expect(refused.status).toBe(403);
	expect(((await refused.json()) as { error?: string }).error).toContain("changed on the computer");
	const prefs = (await (
		await fetch(`${b.url}/api/prefs`, { headers: { "x-omp-webui-token": b.server.token } })
	).json()) as { values: Record<string, string | null> };
	expect(prefs.values["ompw.keepAwake"] ?? "on").toBe("on");

	// Another preference from the same page is still taken: this one key is the person's at this computer.
	expect((await remote({ "ompw.lang": "zh-CN" })).status).toBe(200);
});

(mac ? test : test.skip)(
	"a conversation waiting out a usage limit does not hold the Mac awake, and a short backoff does",
	async () => {
		const stub = writeStubCaffeinate();
		const bin = writeFakeOmp(root, { streaming: true });
		const b = await boot("data-wait", { OMP_BIN: bin, OMP_WEBUI_CAFFEINATE: stub.bin });
		const live = await request<LiveInfo>(b.ws, { t: "open", target: { kind: "new", cwd: work } });
		const frames = (frames: Record<string, unknown>[]) =>
			request(b.ws, { t: "rpc", liveId: live.liveId, command: { type: "emit_frames", frames } });

		// omp waits hours: the wait is counted as working by the menu bar (its turn is open), and must not hold the Mac.
		await frames([
			{ type: "agent_start" },
			{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 3_600_000, errorId: 0x80000 },
		]);
		await pollUntil(() => b.lives().then((l) => l[0]?.retry?.usageLimit === true), "the usage-limit wait");
		expect((await b.lives())[0].holding).toBe("working");
		await Bun.sleep(1500);
		expect(started(stub.log)).toEqual([]);

		// A short backoff (a 5xx) is the turn coming back in seconds: the Mac is held for it.
		await frames([{ type: "auto_retry_end", success: false, attempt: 1 }, { type: "agent_start" }]);
		await frames([{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorId: 0 }]);
		await pollUntil(() => started(stub.log).length === 1, "caffeinate to start with a short backoff", 15_000);
	},
);
