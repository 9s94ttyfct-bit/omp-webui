import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore, ProcessOverlay, removeOverlayFiles } from "../../server/omp/approval.ts";
import {
	identitiesOf,
	identityOf,
	type ParkedRecord,
	ParkedStore,
	type ProcessRef,
	type ProcessSource,
	referenceTo,
	runsAs,
} from "../../server/omp/parked.ts";
import { encodeFrame, FrameDecoder, Outbox } from "../../server/omp/relay-protocol.ts";

/**
 * What lets a paused conversation outlive the server: the records of them, the identity that keeps a reused pid
 * from being taken for the recorded process, the overlay files omp reads when it runs again, and the relay's wire.
 */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Every server sweeps the temp dir for the overlay directories of servers that are gone, and these tests make such
 * directories: in the shared temp dir another test file's sweep could take them mid-test, so they use one of their own.
 */
const sharedTmp = process.env.TMPDIR;
let ownTmp = "";
beforeAll(() => {
	ownTmp = mkdtempSync(join(tmpdir(), "ompw-parked-tmp-"));
	process.env.TMPDIR = ownTmp;
});
afterAll(() => {
	if (sharedTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = sharedTmp;
	rmSync(ownTmp, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "ompw-parked-"));
	dirs.push(dir);
	return dir;
}

const record = (liveId: string, pausedAt = 1): ParkedRecord => ({
	version: 2,
	liveId,
	omp: { pid: 1, identity: "a" },
	relay: { pid: 2, identity: "b" },
	socket: "/tmp/x.sock",
	owner: null,
	cwd: "/",
	args: [],
	env: {},
	mode: "full",
	startedAt: 0,
	pausedAt,
	sessionFile: null,
	sessionId: null,
	streaming: false,
	overlay: null,
	interviewing: false,
	pendingUI: [],
	descendants: [],
});

test("records come back oldest pause first; files that are not records are removed, those of another version are kept", () => {
	const data = scratch();
	const store = new ParkedStore(data);
	store.save(record("L2", 20));
	store.save(record("L1", 10));
	store.save({ ...record("L1", 10), streaming: true });
	const dir = join(data, "parked");
	writeFileSync(join(dir, "junk.json"), "{ not json");
	writeFileSync(join(dir, "partial.json"), JSON.stringify({ version: 1, liveId: "L3" }));
	writeFileSync(join(dir, "future.json"), JSON.stringify({ version: 3, liveId: "L4" }));

	expect(store.list().map((r) => [r.liveId, r.streaming])).toEqual([
		["L1", true],
		["L2", false],
	]);
	expect(readdirSync(dir).sort()).toEqual(["L1.json", "L2.json", "future.json"]);
	store.remove("L1");
	expect(store.list().map((r) => r.liveId)).toEqual(["L2"]);
});

test("a record of version 1 names its mode online or offline: it comes back as Full, or Light on a local server", () => {
	const data = scratch();
	const store = new ParkedStore(data);
	store.save(record("L0", 5));
	const dir = join(data, "parked");
	for (const [liveId, mode, pausedAt] of [
		["L1", "online", 10],
		["L2", "offline", 20],
	] as const)
		writeFileSync(join(dir, `${liveId}.json`), JSON.stringify({ ...record(liveId, pausedAt), version: 1, mode }));
	const read = Object.fromEntries(store.list().map((r) => [r.liveId, { mode: r.mode, lightModels: r.lightModels }]));
	expect(read.L0).toEqual({ mode: "full", lightModels: undefined });
	expect(read.L1).toEqual({ mode: "full", lightModels: undefined });
	expect(read.L2).toEqual({ mode: "light", lightModels: "local" });
	// A record is the same record whichever version wrote it: a Light one of version 2 says what its models are itself.
	store.save({ ...record("L3", 30), mode: "light", lightModels: "yours" });
	expect(store.list().find((r) => r.liveId === "L3")).toMatchObject({ mode: "light", lightModels: "yours" });
});

test("omp's backoff is recorded with the conversation and read back; a record without one, or with a damaged one, still comes back, without a wait", () => {
	const data = scratch();
	const store = new ParkedStore(data);
	const wait = { attempt: 2, maxAttempts: 5, delayMs: 5_400_000, startedAt: 1_000, usageLimit: true, resumed: false };
	store.save({ ...record("L1", 10), retry: wait });
	store.save(record("L2", 20));
	// A hand-edited or half-written wait is dropped from the record, not the conversation with it.
	for (const [i, [name, retry]] of Object.entries({
		L3: { ...wait, delayMs: "soon" },
		L4: { ...wait, resumed: undefined },
		L5: { ...wait, attempt: -1 },
		L6: "waiting",
	}).entries())
		writeFileSync(join(data, "parked", `${name}.json`), JSON.stringify({ ...record(name, 30 + i), retry }));

	const listed = store.list();
	expect(listed.map((r) => r.liveId)).toEqual(["L1", "L2", "L3", "L4", "L5", "L6"]);
	expect(listed[0].retry).toEqual(wait);
	for (const r of listed.slice(1)) expect(r.retry).toBeUndefined();
});

test("a conversation's gate having been seen to start is recorded and read back; a record without it, or with a damaged one, says nothing of it", () => {
	const data = scratch();
	const store = new ParkedStore(data);
	store.save({ ...record("L1", 10), gated: true });
	store.save(record("L2", 20));
	writeFileSync(join(data, "parked", "L3.json"), JSON.stringify({ ...record("L3", 30), gated: "yes" }));
	const [gated, plain, damaged] = store.list();
	expect(gated.gated).toBe(true);
	expect(plain.gated).toBeUndefined();
	expect(damaged.gated).toBeUndefined();
});

test("what a conversation chose of the guard is recorded and read back; a record without it, or with a damaged one, says nothing of it (never Off)", () => {
	const data = scratch();
	const store = new ParkedStore(data);
	store.save({ ...record("L1", 10), guard: { mode: "ask", reviewer: "a/b", askWhenUnavailable: false } });
	store.save(record("L2", 20));
	for (const [i, damaged] of ["off", { mode: "OFF" }, { mode: "off", nope: 1 }, [], {}, null].entries()) {
		writeFileSync(
			join(data, "parked", `L${i + 3}.json`),
			JSON.stringify({ ...record(`L${i + 3}`, 30 + i), guard: damaged }),
		);
	}
	const [kept, plain, ...damaged] = store.list();
	expect(kept.guard).toEqual({ mode: "ask", reviewer: "a/b", askWhenUnavailable: false });
	expect(plain.guard).toBeUndefined();
	expect(damaged).toHaveLength(6);
	for (const d of damaged) expect(d.guard, d.liveId).toBeUndefined();
	// Damage is told as damage (the next server reads it as the default at least); a record with no field at all is none.
	expect(damaged.map((d) => d.guardDamaged)).toEqual([true, true, true, true, undefined, true]);
	expect(plain.guardDamaged).toBeUndefined();
	expect(kept.guardDamaged).toBeUndefined();
});

test("a paused conversation's preset is recorded with its overlay and written back when the next server takes it over", () => {
	const data = scratch();
	const store = new ParkedStore(data);
	const models = { preset: "deep", roles: { default: "a/b:high", task: "a/c" }, defaultThinkingLevel: "low" as const };
	const file = join(scratch(), "L1.yml");
	store.save({ ...record("L1", 10), overlay: { file, mode: "yolo", wait: null, models, absent: ["smol"] } });

	const [read] = store.list();
	expect(read.overlay?.models).toEqual(models);
	expect(read.overlay?.absent).toEqual(["smol"]);
	// A record an older server wrote has neither.
	store.save({ ...record("L2", 20), overlay: { file, mode: "yolo" } });
	expect(store.list()[1].overlay?.models).toBeUndefined();

	// What the next server writes where omp was told to look is what the conversation was running on.
	new ApprovalStore("omp", scratch(), 0).restore(file, "yolo", null, read.overlay?.models, read.overlay?.absent);
	expect(Bun.YAML.parse(readFileSync(file, "utf8"))).toMatchObject({
		modelRoles: { default: "a/b:high", task: "a/c", smol: null },
		defaultThinkingLevel: "low",
	});
});

test("a paused conversation's subagent models are recorded with its overlay, with the agents they clear, and written back", () => {
	const data = scratch();
	const store = new ParkedStore(data);
	const models = {
		preset: "review",
		roles: { default: "a/b:high" },
		agentModelOverrides: { reviewer: "a/c:low", "odd-agent": "a/b,c/d" },
	};
	const file = join(scratch(), "L1.yml");
	store.save({
		...record("L1", 10),
		overlay: { file, mode: "yolo", models, absent: [], absentAgents: ["scout", "sonic"] },
	});
	// A record an older server wrote has no list of them; a damaged one is no record.
	store.save({ ...record("L2", 20), overlay: { file, mode: "yolo", models, absent: [] } });
	writeFileSync(
		join(data, "parked", "L3.json"),
		JSON.stringify({ ...record("L3", 30), overlay: { file, mode: "yolo", models, absentAgents: "scout" } }),
	);

	const listed = store.list();
	expect(listed.map((r) => r.liveId)).toEqual(["L1", "L2"]);
	expect(listed[0].overlay?.models).toEqual(models);
	expect(listed[0].overlay?.absentAgents).toEqual(["scout", "sonic"]);
	expect(listed[1].overlay?.absentAgents).toBeUndefined();

	new ApprovalStore("omp", scratch(), 0).restore(
		file,
		"yolo",
		null,
		listed[0].overlay?.models,
		listed[0].overlay?.absent,
		{},
		listed[0].overlay?.absentAgents,
	);
	expect(Bun.YAML.parse(readFileSync(file, "utf8"))).toMatchObject({
		modelRoles: { default: "a/b:high" },
		task: { agentModelOverrides: { reviewer: "a/c:low", "odd-agent": "a/b,c/d", scout: null, sonic: null } },
	});
});

test("a process is recognised by its start and command line, not its pid alone", async () => {
	const sleeper = Bun.spawn(["sleep", "30"]);
	try {
		const ref = await referenceTo(sleeper.pid);
		expect(ref?.identity).toContain("sleep 30");
		expect(await runsAs(ref as NonNullable<typeof ref>)).toBe(true);
		// The same pid with another start or command is another process.
		expect(await runsAs({ pid: sleeper.pid, identity: "Thu Jan  1 00:00:00 1970 sleep 30" })).toBe(false);
		expect(await runsAs({ pid: sleeper.pid, identity: `${(ref?.identity ?? "").slice(0, 24)} sleep 31` })).toBe(false);
	} finally {
		sleeper.kill();
	}
	await sleeper.exited;
	expect(await identityOf(sleeper.pid)).toBeNull();
});

test("a Linux process caught inside execve (its new name, no command line yet) is recorded once it has its command line", async () => {
	const stat = "4242 (sleep) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 98765 0 0";
	let reads = 0;
	const source: ProcessSource = {
		platform: "linux",
		proc: (path) => {
			if (path === "/proc/4242/stat") return stat;
			if (path === "/proc/sys/kernel/random/boot_id") return "boot-1";
			// The first two reads come before the command line is in place.
			if (path === "/proc/4242/cmdline") return ++reads > 2 ? "sleep\u000030\u0000" : "";
			return null;
		},
		ps: async () => null,
	};
	expect(await referenceTo(4242, source)).toEqual({ pid: 4242, identity: "linux:boot-1:98765 sleep 30" });
	// One that never gets a command line (a kernel thread) is named by its own name, after a few reads.
	const thread: ProcessSource = { ...source, proc: (path) => (path === "/proc/4242/cmdline" ? "" : source.proc(path)) };
	expect(await referenceTo(4242, thread)).toEqual({ pid: 4242, identity: "linux:boot-1:98765 [sleep]" });
});

/** A system as `identityOf` reads it: `/proc` files by path, `ps` by what it is asked for. */
function system(
	platform: NodeJS.Platform,
	files: Record<string, string>,
	ps: (args: string[]) => string | null = () => null,
): ProcessSource {
	return { platform, proc: (path) => files[path] ?? null, ps: async (args) => ps(args) };
}

/** `/proc/<pid>/stat` as Linux writes it: the command in parentheses, then 49 fields of which the 22nd is the start. */
function stat(pid: number, comm: string, start: number): string {
	const after = ["S", 1, pid, pid, 0, -1, 4194560, 100, 0, 0, 0, 5, 3, 0, 0, 20, 0, 1, 0, start, 4096, 1024];
	return `${pid} (${comm}) ${after.join(" ")} 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0\n`;
}

const BOOT = "/proc/sys/kernel/random/boot_id";

test("on Linux a process is recognised by its start in the kernel's own ticks and the boot, never by ps's lstart", async () => {
	const files = {
		[BOOT]: "boot-A\n",
		"/proc/42/stat": stat(42, "omp", 123456),
		"/proc/42/cmdline": "/usr/bin/omp\0--mode\0rpc-ui\0",
	};
	// `ps` is not even asked: its lstart is derived from the boot time, which a suspend or a clock step moves.
	const linux = system("linux", files, () => {
		throw new Error("ps must not be consulted on Linux");
	});
	const identity = await identityOf(42, linux);
	expect(identity).toBe("linux:boot-A:123456 /usr/bin/omp --mode rpc-ui");
	expect(await runsAs({ pid: 42, identity: identity as string }, linux)).toBe(true);

	// The same process after the clock stepped: nothing it is known by changed.
	expect(await identityOf(42, system("linux", { ...files }))).toBe(identity);
	// Another start (the pid was reused), another boot (the same ticks counted again), another command.
	expect(await identityOf(42, system("linux", { ...files, "/proc/42/stat": stat(42, "omp", 123457) }))).not.toBe(
		identity,
	);
	expect(await identityOf(42, system("linux", { ...files, [BOOT]: "boot-B\n" }))).not.toBe(identity);
	expect(
		await identityOf(42, system("linux", { ...files, "/proc/42/cmdline": "/usr/bin/omp\0--mode\0rpc\0" })),
	).not.toBe(identity);
	// No such process.
	expect(await identityOf(43, linux)).toBeNull();
	expect(await runsAs({ pid: 43, identity: "linux:boot-A:1 x" }, linux)).toBe(false);
});

test("a Linux process whose name holds spaces and parentheses is still read right, and one without a command line is named by its own", async () => {
	const odd = system("linux", {
		[BOOT]: "b\n",
		"/proc/7/stat": stat(7, "my (odd) proc", 999),
		"/proc/7/cmdline": "my (odd) proc\0-x\0",
		"/proc/8/stat": stat(8, "kworker/0:1", 5),
		"/proc/8/cmdline": "",
	});
	expect(await identityOf(7, odd)).toBe("linux:b:999 my (odd) proc -x");
	expect(await identityOf(8, odd)).toBe("linux:b:5 [kworker/0:1]");
});

test("elsewhere the process listing's start and command are the identity, as before", async () => {
	const listing = (args: string[]) =>
		args.join(" ") === "-o lstart=,command= -p 42" ? "Thu Jan  1 00:00:00 1970     sleep 30\n" : null;
	const mac = system("darwin", { "/proc/42/stat": "never read" }, listing);
	expect(await identityOf(42, mac)).toBe("Thu Jan  1 00:00:00 1970     sleep 30");
	expect(await identityOf(43, mac)).toBeNull();
});

test("the identities of several processes come from one listing and are the ones each would have alone", async () => {
	const sleepers = [Bun.spawn(["sleep", "30"]), Bun.spawn(["sleep", "31"])];
	const gone = Bun.spawn(["true"]);
	await gone.exited;
	try {
		const pids = [...sleepers.map((s) => s.pid), gone.pid];
		const together = await identitiesOf(pids);
		expect([...together.keys()].sort((a, b) => a - b)).toEqual(sleepers.map((s) => s.pid).sort((a, b) => a - b));
		for (const s of sleepers) expect(together.get(s.pid)).toBe((await identityOf(s.pid)) ?? undefined);
	} finally {
		for (const s of sleepers) s.kill();
	}
	expect((await identitiesOf([])).size).toBe(0);
});

/** A record of a paused conversation whose omp and relay run (this test process stands for both) and whose overlay is `file`. */
async function runningRecord(liveId: string, file: string): Promise<ParkedRecord> {
	const running = (await referenceTo(process.pid)) as ProcessRef;
	return { ...record(liveId), omp: running, relay: running, overlay: { file, mode: "yolo" } };
}

test("an overlay of a paused conversation that is on record and running is neither swept nor removed with its server's directory", async () => {
	const dead = Bun.spawn(["true"]);
	await dead.exited;
	const keep = join(tmpdir(), `ompw-live-${dead.pid}-kept`);
	const drop = join(tmpdir(), `ompw-live-${dead.pid}-dropped`);
	dirs.push(keep, drop);
	mkdirSync(keep, { recursive: true });
	mkdirSync(drop, { recursive: true });
	const parked = new ProcessOverlay(join(keep, "L1.yml"), "yolo");
	parked.park();
	writeFileSync(join(drop, "L2.yml"), "tools: {}\n");

	// Creating an overlay is when a server sweeps the directories of dead ones.
	const data = scratch();
	new ParkedStore(data).save(await runningRecord("L1", parked.file));
	const store = new ApprovalStore("omp", data);
	const own = await store.create("L9", null);
	expect(existsSync(parked.file)).toBe(true);
	expect(existsSync(`${parked.file}.parked`)).toBe(true);
	expect(existsSync(drop)).toBe(false);
	own.remove();

	// Removing the last overlay of a directory removes the directory.
	parked.remove();
	expect(existsSync(keep)).toBe(false);
});

test("a paused overlay whose conversation is no longer on record is swept with the directory of its dead server (#424)", async () => {
	const { dir } = await deadServersDir("unrecorded");
	// The server was killed between parking the overlay and recording the conversation, or the record was deleted.
	new ProcessOverlay(join(dir, "L1.yml"), "yolo", 0).park();
	const other = await deadServersDir("recorded-elsewhere");
	const recorded = new ProcessOverlay(join(other.dir, "L2.yml"), "yolo", 0);
	recorded.park();
	const data = scratch();
	// Another conversation's record does not keep this one's overlay.
	new ParkedStore(data).save(await runningRecord("L2", recorded.file));

	(await new ApprovalStore("omp", data, 0).create("L9", null)).remove();
	expect(existsSync(dir)).toBe(false);
	expect(existsSync(other.dir)).toBe(true);
});

test("a paused overlay whose recorded omp is gone is swept: nothing will run on it again (#424)", async () => {
	const { dir } = await deadServersDir("dead-omp");
	const overlay = new ProcessOverlay(join(dir, "L1.yml"), "yolo", 0);
	overlay.park();
	const data = scratch();
	// The record's processes are not running as recorded (the machine restarted, omp was killed).
	new ParkedStore(data).save({ ...record("L1"), overlay: { file: overlay.file, mode: "yolo" } });

	(await new ApprovalStore("omp", data, 0).create("L9", null)).remove();
	expect(existsSync(dir)).toBe(false);
});

test("an overlay a server leaves paused as it ends is kept in its directory", () => {
	// The server's own directory is judged by its own markers when it ends: what it keeps paused is recorded by then,
	// and what it did not keep has been unparked or removed.
	const script = join(scratch(), "own.ts");
	const approval = join(import.meta.dir, "../../server/omp/approval.ts");
	const out = join(scratch(), "kept-file");
	writeFileSync(
		script,
		`import { writeFileSync } from "node:fs";
import { ApprovalStore } from ${JSON.stringify(approval)};
const store = new ApprovalStore("omp", ${JSON.stringify(scratch())}, 0);
const kept = await store.create("Lk", null);
kept.park();
(await store.create("Lg", null)).remove();
writeFileSync(${JSON.stringify(out)}, kept.file);
`,
	);
	const ran = Bun.spawnSync(["bun", script], { stdout: "pipe", stderr: "pipe" });
	expect(ran.exitCode, ran.stderr.toString()).toBe(0);
	const file = readFileSync(out, "utf8");
	dirs.push(join(file, ".."));
	expect(existsSync(file)).toBe(true);
	expect(existsSync(`${file}.parked`)).toBe(true);
});

test("a restored overlay is written again where omp was told to find it, with the conversation's mode", () => {
	const gone = join(scratch(), "swept", "L1.yml");
	const store = new ApprovalStore("omp", scratch());
	const overlay = store.restore(gone, "always-ask");

	expect(readdirSync(join(gone, "..")).sort()).toEqual(["L1.yml", "L1.yml.adopted", "L1.yml.parked"]);
	expect(overlay.mode).toBe("always-ask");
	removeOverlayFiles(gone);
	expect(existsSync(join(gone, ".."))).toBe(false);
});

/** A directory in the temp dir named as a server's overlay directory, for a server that is already gone. */
async function deadServersDir(name: string): Promise<{ dir: string; pid: number }> {
	const dead = Bun.spawn(["true"]);
	await dead.exited;
	const dir = join(tmpdir(), `ompw-live-${dead.pid}-${name}`);
	dirs.push(dir);
	mkdirSync(dir, { recursive: true });
	return { dir, pid: dead.pid };
}

test("an overlay a server adopted is not swept by another server once the conversation is resumed, and its mode can still be changed", async () => {
	const { dir } = await deadServersDir("adopted");
	const file = join(dir, "L1.yml");
	// The server that paused the conversation wrote its overlay and left.
	new ProcessOverlay(file, "always-ask", 0).park();

	const overlay = new ApprovalStore("omp", scratch(), 0).restore(file, "always-ask");
	// Resume: the pause is over, and the overlay is no longer the paused kind.
	overlay.unpark();
	expect(existsSync(`${file}.parked`)).toBe(false);

	// Another server starts: its first overlay sweeps the directories of servers that are gone.
	(await new ApprovalStore("omp", scratch(), 0).create("L9", null)).remove();
	expect(existsSync(file)).toBe(true);
	await overlay.set("yolo");
	expect(readFileSync(file, "utf8")).toContain("approvalMode: yolo");

	// Ended, it takes its directory with it.
	overlay.remove();
	expect(existsSync(dir)).toBe(false);
});

test("an adopted overlay is swept once the server that adopted it is gone too", async () => {
	const { dir } = await deadServersDir("abandoned");
	const adopter = await deadServersDir("adopter");
	const file = join(dir, "L1.yml");
	new ProcessOverlay(file, null, 0);
	writeFileSync(`${file}.adopted`, String(adopter.pid));

	(await new ApprovalStore("omp", scratch(), 0).create("L9", null)).remove();
	expect(existsSync(dir)).toBe(false);
});

test("an overlay whose directory has gone is written again where omp looks, and keeps what protects it", async () => {
	const { dir } = await deadServersDir("vanished");
	const file = join(dir, "L1.yml");
	const overlay = new ApprovalStore("omp", scratch(), 0).restore(file, "write");
	rmSync(dir, { recursive: true, force: true });

	await overlay.set("yolo");
	expect(readFileSync(file, "utf8")).toContain("approvalMode: yolo");
	expect(readdirSync(dir).sort()).toEqual(["L1.yml", "L1.yml.adopted", "L1.yml.parked"]);
});

test("frames reassemble from any chunking of the stream", () => {
	const payloads = [Buffer.from("héllo"), Buffer.alloc(0), Buffer.alloc(70_000, 7)];
	const wire = Buffer.concat(payloads.map((p, i) => encodeFrame(i + 1, p)));
	for (const size of [1, 3, 5, 4096, wire.length]) {
		const decoder = new FrameDecoder();
		const seen = [];
		for (let at = 0; at < wire.length; at += size) seen.push(...decoder.push(wire.subarray(at, at + size)));
		expect(seen.map((f) => f.type)).toEqual([1, 2, 3]);
		expect(seen.map((f) => f.payload.length)).toEqual([payloads[0].length, 0, 70_000]);
		expect(seen[0].payload.toString()).toBe("héllo");
	}
});

test("a socket that takes only part of a write gets the rest, in order, when it drains", async () => {
	const written: number[] = [];
	/** How many bytes the socket takes before it is full again. */
	let room = 3;
	const outbox = new Outbox({
		write(data) {
			const n = Math.min(room, data.length);
			room -= n;
			written.push(...data.subarray(0, n));
			return n;
		},
	});
	outbox.send(Uint8Array.of(1, 2, 3, 4, 5));
	outbox.send(Uint8Array.of(6, 7));
	expect(outbox.backlog).toBe(4);
	const flushed = outbox.flushed();
	room = 2;
	outbox.drain();
	expect(outbox.backlog).toBe(2);
	room = 10;
	outbox.drain();
	await flushed;
	expect(written).toEqual([1, 2, 3, 4, 5, 6, 7]);
	expect(outbox.backlog).toBe(0);
});
