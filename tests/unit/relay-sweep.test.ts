import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relaySocket, sweepRelayDir } from "../../server/omp/relay-client.ts";

/**
 * The pool sweeps the relay directory every minute, which needs the command line of every process on the machine: a
 * listing of a thousand processes takes 30 ms idle and over 100 ms when the machine is busy. That is time every
 * conversation's streaming and every tab wait for if the server stands still for it (#355).
 */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("listing the processes for the sweep does not stop the server: its timers keep running meanwhile", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-sweep-"));
	dirs.push(dir);
	// A `ps` that takes 300 ms to list every process, as one does on a busy machine; a listing of one is as fast as ever.
	writeFileSync(join(dir, "ps"), `#!/bin/sh\ncase "$*" in *-A*) /bin/sleep 0.3;; esac\nexec /bin/ps "$@"\n`);
	chmodSync(join(dir, "ps"), 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${dir}:${path}`;
	try {
		// Something to look for: the sweep lists the processes only when the directory holds a socket's name.
		const data = join(dir, "data");
		mkdirSync(data);
		writeFileSync(relaySocket(data, "L1"), "");
		// Timers fire while the sweep waits for the listing; a server that stands still for it fires none until it is over
		// (counted, not timed: how many ticks, not how long).
		let ticks = 0;
		const timer = setInterval(() => ticks++, 10);
		await sweepRelayDir(data);
		clearInterval(timer);
		expect(ticks).toBeGreaterThan(5);
	} finally {
		process.env.PATH = path;
	}
});
