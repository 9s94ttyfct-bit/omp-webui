import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownDataDirs, runningServerPorts, stopStaleServer } from "../../server/instance.ts";

/** The ports of the other omp-webui servers that known data folders record: the gate of risky commands asks about their API (#611). */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const record = (pid: number, port: number, localPort?: number): string => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-instance-ports-"));
	dirs.push(dir);
	writeFileSync(join(dir, "server.pid"), JSON.stringify({ pid, command: "bun server/main.ts", port, localPort }));
	return dir;
};

test("a running server's recorded port is listed; this process's own, a gone process's and a damaged record are not", () => {
	const other = record(process.ppid, 7881);
	const mine = record(process.pid, 7878);
	// 2^22 is above any pid macOS and Linux hand out.
	const gone = record(4_194_304, 7882);
	const damaged = mkdtempSync(join(tmpdir(), "ompw-instance-ports-"));
	dirs.push(damaged);
	writeFileSync(join(damaged, "server.pid"), "{");
	const nothing = mkdtempSync(join(tmpdir(), "ompw-instance-ports-"));
	dirs.push(nothing);
	expect(runningServerPorts([other, mine, gone, damaged, nothing])).toEqual([7881]);
});

test("the loopback port of a server bound to a network address, when it is not the recorded one, is listed with it", () => {
	expect(runningServerPorts([record(process.ppid, 7881, 7885)])).toEqual([7881, 7885]);
	expect(runningServerPorts([record(process.ppid, 7881, 0)])).toEqual([7881]);
});

test("the data folders looked in are the web version's and the app's", () => {
	expect(knownDataDirs("/Users/me")).toEqual([
		"/Users/me/.omp-webui",
		"/Users/me/Library/Application Support/omp-webui",
	]);
});

test("a record with a loopback port is read as any other: a gone server's is forgotten, a reused pid's too and nothing is touched, a damaged port is no port", async () => {
	// The pid of a process that ended, with the extra field: forgotten like a record without it.
	const gone = record(4_194_304, 7882, 7885);
	expect(await stopStaleServer(gone)).toBeNull();
	expect(existsSync(join(gone, "server.pid"))).toBe(false);
	// A pid that is alive but runs another command (it was reused): the record goes, the process is left alone.
	const reused = mkdtempSync(join(tmpdir(), "ompw-instance-ports-"));
	dirs.push(reused);
	writeFileSync(
		join(reused, "server.pid"),
		JSON.stringify({ pid: process.ppid, command: "not what runs there", port: 7881, localPort: 7885 }),
	);
	expect(await stopStaleServer(reused)).toBeNull();
	expect(existsSync(join(reused, "server.pid"))).toBe(false);
	expect(() => process.kill(process.ppid, 0)).not.toThrow();
	// A loopback port that is not a port number is left out, the server's own is not.
	const damaged = mkdtempSync(join(tmpdir(), "ompw-instance-ports-"));
	dirs.push(damaged);
	writeFileSync(
		join(damaged, "server.pid"),
		JSON.stringify({ pid: process.ppid, command: "bun server/main.ts", port: 7881, localPort: "7885" }),
	);
	expect(runningServerPorts([damaged])).toEqual([7881]);
});
