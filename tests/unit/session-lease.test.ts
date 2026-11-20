// needs: leaseHolders
import { afterAll, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abstractLockName } from "../../server/platform/linux.ts";
import {
	type LeaseSystem,
	leaseHeldElsewhere,
	leaseHolders,
	leaseLockPath,
	SESSION_LEASE_SINCE,
	sessionOwnersDir,
} from "../../server/sessions/lease.ts";

/**
 * Who holds a session's write lease. omp 18.14.1 says whether it is held (`omp session lease --json`), played here by a
 * fake omp; older omp, and the attribution to a process, read it from the system as omp takes it on Linux: before omp
 * 19.0.1 no file, an abstract Unix socket named from the lock's path, bound by the process that holds it; from 19.0.1 a
 * lock on the lock file itself, which the kernel lists in the holder's `fdinfo`. Read here from a `/proc` laid out as
 * Linux's is, so that it is checked on any system; tests/contract/open-elsewhere.test.ts is the real omp.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-lease-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ID = "01937f2a-5c1d-7e00-8000-000000000061";
const HOME = "/home/jdoe";
const LOCK = `${HOME}/.omp/run/session-owners/${ID}.lock`;

test("the socket's name is omp's: the lock path's two xxHash64s under omp's seeds", () => {
	// Computed with the reference xxHash (Python's `xxhash`), not with the code under test.
	expect(abstractLockName(LOCK)).toBe("omp-file-lock-aacaff4d4a5669bdb194c8d6751e091e");
});

/** A `/proc` with these bound sockets (inode → address) and these processes (pid → what their descriptors lead to). */
function fakeProc(name: string, sockets: Record<string, string>, processes: Record<string, string[] | null>): string {
	const proc = join(root, name);
	mkdirSync(join(proc, "net"), { recursive: true });
	const rows = Object.entries(sockets).map(
		([inode, address]) => `0000000000000000: 00000002 00000000 00000000 0002 01 ${inode} ${address}`,
	);
	// An unbound socket has no path column.
	rows.push("0000000000000000: 00000003 00000000 00000000 0001 03 777");
	writeFileSync(
		join(proc, "net", "unix"),
		["Num       RefCount Protocol Flags    Type St Inode Path", ...rows, ""].join("\n"),
	);
	mkdirSync(join(proc, "self"));
	for (const [pid, targets] of Object.entries(processes)) {
		mkdirSync(join(proc, pid), { recursive: true });
		// No `fd` folder: a process this user cannot look into.
		if (targets === null) continue;
		mkdirSync(join(proc, pid, "fd"));
		for (const [fd, target] of targets.entries()) symlinkSync(target, join(proc, pid, "fd", String(fd)));
	}
	return proc;
}

const linux = (proc: string, env: Record<string, string> = {}): LeaseSystem => ({
	env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
	home: HOME,
	platform: "linux",
	proc,
});

/** Process 100 holds the lease of `ID` (under `~/.omp`). */
const heldBy100 = fakeProc("held-by-100", { "4242": `@${abstractLockName(LOCK)}` }, { "100": ["socket:[4242]"] });

test("on Linux the holder is the process that has the socket bound, and only that one", async () => {
	const name = abstractLockName(LOCK);
	const proc = fakeProc(
		"held",
		{ "4242": `@${name}`, "5151": "@omp-file-lock-00000000000000000000000000000000", "6161": "/run/a.sock" },
		{
			"100": ["/dev/null", "pipe:[9]", "socket:[4242]"],
			"200": ["socket:[5151]", "socket:[6161]"],
			"300": null,
			"400": ["socket:[42420]"],
		},
	);
	expect(await leaseHolders(ID, linux(proc))).toEqual([100]);
	// Another session's lease, or the same session under another home, is not this one.
	expect(await leaseHolders("01937f2a-5c1d-7e00-8000-000000000062", linux(proc))).toEqual([]);
	expect(await leaseHolders(ID, { ...linux(proc), home: "/home/someone" })).toEqual([]);
});

test("on Linux a lease nobody holds, or a system without `/proc`, has no holder", async () => {
	const proc = fakeProc("free", {}, { "100": ["socket:[4242]"] });
	expect(await leaseHolders(ID, linux(proc))).toEqual([]);
	expect(await leaseHolders(ID, linux(join(root, "no-proc")))).toEqual([]);
});

test("the lease is looked for where omp keeps it: under PI_CONFIG_DIR when it is set", async () => {
	// A terminal's omp run with `PI_CONFIG_DIR=.omp-alt` (as the server and its omp processes are) binds this one.
	const alt = `${HOME}/.omp-alt/run/session-owners/${ID}.lock`;
	const proc = fakeProc("config-dir", { "4343": `@${abstractLockName(alt)}` }, { "100": ["socket:[4343]"] });
	expect(await leaseHolders(ID, linux(proc, { PI_CONFIG_DIR: ".omp-alt" }))).toEqual([100]);
	// Without it the lease is the default config root's, which nobody holds here.
	expect(await leaseHolders(ID, linux(proc))).toEqual([]);
});

test("on Linux from omp 19.0.1 the holder is the process whose descriptor holds a lock on the lock file, and only that one", async () => {
	// A home that exists: the lock is a file now, and a descriptor's link is that file's real path.
	const home = join(root, "home-ofd");
	const system = { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, home, platform: "linux" as const };
	const lock = leaseLockPath(ID, system);
	mkdirSync(join(home, ".omp", "run", "session-owners"), { recursive: true });
	writeFileSync(lock, "");
	// What the kernel's link names: the file's real path (the temporary folder may be behind a symbolic link).
	const file = realpathSync(lock);
	const proc = fakeProc("ofd", {}, { "100": ["/dev/null", file], "200": [file], "300": null, "400": ["/dev/null"] });
	// The kernel's `lock:` line for the holder's descriptor (an OFD lock names no pid); 200 only has the file open, as
	// omp's own `isHeld` probe does.
	mkdirSync(join(proc, "100", "fdinfo"));
	writeFileSync(join(proc, "100", "fdinfo", "0"), "pos:\t0\nflags:\t02100000\n");
	writeFileSync(
		join(proc, "100", "fdinfo", "1"),
		"pos:\t0\nflags:\t02100002\nmnt_id:\t29\nino:\t1234\nlock:\t1: OFDLCK  ADVISORY  WRITE -1 08:01:1234 0 EOF\n",
	);
	mkdirSync(join(proc, "200", "fdinfo"));
	writeFileSync(join(proc, "200", "fdinfo", "0"), "pos:\t0\nflags:\t02100000\nmnt_id:\t29\nino:\t1234\n");
	expect(await leaseHolders(ID, { ...system, proc })).toEqual([100]);
	// Another session's lock file is not this one.
	expect(await leaseHolders("01937f2a-5c1d-7e00-8000-000000000062", { ...system, proc })).toEqual([]);
});

test("the lease directory follows omp's rules: XDG_STATE_HOME once omp has a folder there, on Linux and macOS", () => {
	const xdg = join(root, "state");
	const sys = { env: { XDG_STATE_HOME: xdg }, home: HOME, platform: "linux" as const };
	// No `omp` folder there yet: omp stays in its config root.
	expect(sessionOwnersDir(sys)).toBe(`${HOME}/.omp/run/session-owners`);
	mkdirSync(join(xdg, "omp"), { recursive: true });
	expect(sessionOwnersDir(sys)).toBe(join(xdg, "omp", "run", "session-owners"));
	expect(sessionOwnersDir({ ...sys, platform: "darwin" })).toBe(join(xdg, "omp", "run", "session-owners"));
	expect(sessionOwnersDir({ ...sys, platform: "win32" })).toBe(`${HOME}/.omp/run/session-owners`);
	// PI_CONFIG_DIR is a folder of the home, as omp joins it.
	expect(sessionOwnersDir({ env: { PI_CONFIG_DIR: ".omp-alt" }, home: HOME, platform: "linux" })).toBe(
		`${HOME}/.omp-alt/run/session-owners`,
	);
	// An id that is not a plain token names no path outside the folder: it is named by its hash.
	const odd = leaseLockPath("../../x", { env: {}, home: HOME, platform: "darwin" });
	expect(odd).toMatch(new RegExp(`^${HOME}/\\.omp/run/session-owners/h-[0-9a-f]{16}\\.lock$`));
});

/** A fake omp whose `omp session lease` prints `answer` (and exits with `code`); it notes its arguments in `calls`. */
function leaseOmp(name: string, answer: string, code = 0): { bin: string; calls: () => string } {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const bin = join(dir, "omp");
	const calls = join(dir, "calls");
	writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${calls}'\necho '${answer}'\nexit ${code}\n`);
	chmodSync(bin, 0o755);
	return { bin, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : "") };
}

const held = JSON.stringify({ held: [ID], unknown: [] });
const free = JSON.stringify({ held: [], unknown: [] });

test(`omp ${SESSION_LEASE_SINCE} and later is asked (\`omp session lease\`), and its answer is taken over the system's`, async () => {
	const said = leaseOmp("says-held", held);
	expect(await leaseHeldElsewhere(ID, null, { bin: said.bin, version: "18.14.1" }, linux(heldBy100))).toEqual({
		pids: [],
	});
	expect(said.calls()).toBe(`session lease --json -- ${ID}\n`);
	// It says nobody holds it: so it is, whatever the system would have said.
	const saidFree = leaseOmp("says-free", free);
	expect(await leaseHeldElsewhere(ID, null, { bin: saidFree.bin, version: "18.15.0" }, linux(heldBy100))).toBeNull();
	expect(saidFree.calls()).toBe(`session lease --json -- ${ID}\n`);
});

test("held while the server has a process of its own on the conversation: the system tells whose it is", async () => {
	// omp does not say which process holds it, and the server's own process holds it only once it has written to it.
	const said = leaseOmp("says-held-ours", held);
	const omp = { bin: said.bin, version: "18.14.1" };
	expect(await leaseHeldElsewhere(ID, 100, omp, linux(heldBy100))).toBeNull();
	expect(await leaseHeldElsewhere(ID, 555, omp, linux(heldBy100))).toEqual({ pids: [100] });
	// A system that cannot tell leaves it unseen, as before.
	expect(await leaseHeldElsewhere(ID, 555, omp, linux(join(root, "no-proc")))).toBeNull();
});

test("an older omp, one with no version, or an answer omp could not give: the system is read", async () => {
	for (const version of ["18.13.3", "18.12.3", null, "unknown"]) {
		const notAsked = leaseOmp(`old-${version}`, held);
		expect(await leaseHeldElsewhere(ID, null, { bin: notAsked.bin, version }, linux(heldBy100))).toEqual({
			pids: [100],
		});
		expect(await leaseHeldElsewhere(ID, 100, { bin: notAsked.bin, version }, linux(heldBy100))).toBeNull();
		expect(notAsked.calls()).toBe("");
	}
	const answers: [string, string, number][] = [
		["unknown", JSON.stringify({ held: [], unknown: [ID] }), 0],
		["fails", "error: Unknown action: lease", 1],
		["no-json", "held", 0],
		["no-lists", "{}", 0],
	];
	for (const [name, answer, code] of answers) {
		const omp = leaseOmp(name, answer, code);
		expect(await leaseHeldElsewhere(ID, null, { bin: omp.bin, version: "18.14.1" }, linux(heldBy100))).toEqual({
			pids: [100],
		});
		expect(omp.calls()).not.toBe("");
	}
});
