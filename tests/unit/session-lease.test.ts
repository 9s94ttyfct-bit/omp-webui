import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abstractLockName, leaseHolders } from "../../server/sessions/lease.ts";

/**
 * Who holds a session's write lease, as omp takes it on Linux: no file, an abstract Unix socket named from the lock's path,
 * bound by the process that holds it. Read here from a `/proc` laid out as Linux's is, so that it is checked on any system;
 * tests/contract/open-elsewhere.test.ts is the real omp on the system the tests run on.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-lease-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ID = "01937f2a-5c1d-7e00-8000-000000000061";
const HOME = "/home/jdoe";

test("the socket's name is omp's: the lock path's two xxHash64s under omp's seeds", () => {
	// Computed with the reference xxHash (Python's `xxhash`), not with the code under test.
	expect(abstractLockName(`${HOME}/.omp/run/session-owners/${ID}.lock`)).toBe(
		"omp-file-lock-aacaff4d4a5669bdb194c8d6751e091e",
	);
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

test("on Linux the holder is the process that has the socket bound, and only that one", async () => {
	const name = abstractLockName(`${HOME}/.omp/run/session-owners/${ID}.lock`);
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
	expect(await leaseHolders(ID, HOME, "linux", proc)).toEqual([100]);
	// Another session's lease, or the same session under another home, is not this one.
	expect(await leaseHolders("01937f2a-5c1d-7e00-8000-000000000062", HOME, "linux", proc)).toEqual([]);
	expect(await leaseHolders(ID, "/home/someone", "linux", proc)).toEqual([]);
});

test("on Linux a lease nobody holds, or a system without `/proc`, has no holder", async () => {
	const proc = fakeProc("free", {}, { "100": ["socket:[4242]"] });
	expect(await leaseHolders(ID, HOME, "linux", proc)).toEqual([]);
	expect(await leaseHolders(ID, HOME, "linux", join(root, "no-proc"))).toEqual([]);
});
