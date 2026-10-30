import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { commandOf } from "../../server/instance.ts";
import { type AppServer, startAppServer } from "../support/app-server.ts";
import { isolatedEnv } from "../support/omp-env.ts";

/**
 * The macOS app's server start (OMP_WEBUI_AUTO_PORT=1): never fails on a taken port,
 * stops only a leftover server it can positively identify and whose app is gone, never anything else.
 * Runs the real server against the installed omp (no model calls).
 */

const root = mkdtempSync(join(tmpdir(), "ompw-instance-"));
let env: Record<string, string>;
const procs: Subprocess[] = [];

beforeAll(async () => {
	env = await isolatedEnv(root);
});
afterEach(() => {
	for (const p of procs.splice(0)) p.kill("SIGKILL");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/**
 * An unrelated process holds a port until this file cleans it up. The port is chosen below every OS's ephemeral range
 * (macOS 49152+, Linux 32768+): servers and decoys of the other tests, run in parallel, are all given ephemeral ports by
 * the OS, so none of them takes or frees a port in the window the server under test falls back through (the taken port,
 * then the twenty above it). A port from the OS would sit inside that range, and a neighbour freeing between two starts
 * changed which one the server took (#623).
 */
async function decoy(): Promise<{ proc: Subprocess; port: number }> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const port = 20_000 + Math.floor(Math.random() * 10_000);
		const p = Bun.spawn(
			[
				"bun",
				"-e",
				`Bun.serve({port:${port},hostname:"127.0.0.1",fetch:()=>new Response("decoy")}); console.log("listening");`,
			],
			{ stdout: "pipe", stderr: "ignore" },
		);
		procs.push(p);
		const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
		const first = await reader.read();
		reader.releaseLock();
		if (new TextDecoder().decode(first.value).trim() === "listening") return { proc: p, port };
		// The port was taken by something else: try another.
		await p.exited;
	}
	throw new Error("no free port below the ephemeral range for the decoy");
}

/** Start the server in app mode; resolves with its process and chosen port once ready. */
async function startServer(dataDir: string, port = 0, extra: Record<string, string> = {}): Promise<AppServer> {
	const server = await startAppServer(env, dataDir, port, extra);
	procs.push(server.proc);
	return server;
}

function dataDir(name: string): string {
	const d = join(root, name);
	mkdirSync(d, { recursive: true });
	return d;
}

test("a taken port is left to its owner; the server takes the next free one, the same on every start", async () => {
	const d = await decoy();
	const dir = dataDir("busy");
	const s = await startServer(dir, d.port);
	// Another port, and not the taken one: the server left it to its owner and took a free one of the twenty above it
	// (the decoy's port is below the ephemeral range, so no other test's server sits in that window).
	expect(s.port).toBeGreaterThan(d.port);
	expect(s.port).toBeLessThanOrEqual(d.port + 20);
	expect(alive(d.proc.pid)).toBe(true);
	expect(await (await fetch(`http://127.0.0.1:${d.port}/`)).text()).toBe("decoy");

	// Same occupant, next launch: same port, so the app's origin and stored preferences persist.
	s.proc.kill("SIGTERM");
	await s.proc.exited;
	expect((await startServer(dir, d.port)).port).toBe(s.port);
}, 60_000);

test("a pid file naming another program is ignored, never acted on", async () => {
	const d = await decoy();
	const dir = dataDir("forged");
	// The decoy's pid with a command line that is not the decoy's.
	writeFileSync(
		join(dir, "server.pid"),
		JSON.stringify({ pid: d.proc.pid, command: "/Applications/omp-webui.app/server", port: d.port }),
	);
	const s = await startServer(dir, d.port);
	expect(alive(d.proc.pid)).toBe(true);
	expect(s.port).not.toBe(d.port);
}, 60_000);

test("a leftover server recorded for this data dir is stopped and its port reused", async () => {
	const dir = dataDir("stale");
	const old = await startServer(dir);
	expect(JSON.parse(readFileSync(join(dir, "server.pid"), "utf8"))).toMatchObject({
		pid: old.proc.pid,
		command: commandOf(old.proc.pid),
	});

	const next = await startServer(dir, old.port);
	expect(await old.proc.exited).toBeDefined();
	expect(alive(old.proc.pid)).toBe(false);
	expect(next.port).toBe(old.port);
	expect(JSON.parse(readFileSync(join(dir, "server.pid"), "utf8")).pid).toBe(next.proc.pid);
}, 60_000);

test("stopping the server removes its record", async () => {
	const dir = dataDir("clean");
	const s = await startServer(dir);
	s.proc.kill("SIGTERM");
	await s.proc.exited;
	expect(() => readFileSync(join(dir, "server.pid"))).toThrow();
}, 60_000);

/** The pid file of a data dir, as the server wrote it. */
const record = (dir: string) => JSON.parse(readFileSync(join(dir, "server.pid"), "utf8"));

test("a recorded server whose app is still running is left alone", async () => {
	// A process that stays up stands in for the app.
	const app = Bun.spawn(["sleep", "600"]);
	procs.push(app);
	const dir = dataDir("owned");
	const first = await startServer(dir, 0, { OMP_WEBUI_PARENT_PID: String(app.pid) });
	expect(record(dir).parent).toEqual({ pid: app.pid, command: commandOf(app.pid) });

	// Another start — a second copy of the app — must not take the running one's server away.
	const second = await startServer(dir, first.port);
	expect(alive(first.proc.pid)).toBe(true);
	expect((await fetch(`http://127.0.0.1:${first.port}/`)).status).toBeLessThan(500);
	expect(second.port).not.toBe(first.port);
}, 60_000);

test("a recorded server whose app has gone is stopped, also when the app's pid now belongs to another program", async () => {
	const dir = dataDir("orphaned");
	const appCommand = "/Applications/omp-webui.app/Contents/MacOS/omp-webui";
	const old = await startServer(dir);

	// Recorded as started by an app that is gone: a process that has ended.
	const ended = Bun.spawn(["true"]);
	await ended.exited;
	writeFileSync(
		join(dir, "server.pid"),
		JSON.stringify({ ...record(dir), parent: { pid: ended.pid, command: appCommand } }),
	);
	const next = await startServer(dir, old.port);
	expect(await old.proc.exited).toBeDefined();
	expect(alive(old.proc.pid)).toBe(false);
	expect(next.port).toBe(old.port);

	// The app's pid was reused by another program: that is not the app either.
	const bystander = Bun.spawn(["sleep", "600"]);
	procs.push(bystander);
	writeFileSync(
		join(dir, "server.pid"),
		JSON.stringify({ ...record(dir), parent: { pid: bystander.pid, command: appCommand } }),
	);
	const last = await startServer(dir, next.port);
	expect(await next.proc.exited).toBeDefined();
	expect(alive(bystander.pid)).toBe(true);
	expect(last.port).toBe(next.port);
}, 90_000);

test("the access token is never printed when the app starts the server", async () => {
	const server = await startServer(dataDir("quiet"));
	expect(server.output()).toContain("omp-webui listening on");
	expect(server.output()).not.toContain(server.token);
});
