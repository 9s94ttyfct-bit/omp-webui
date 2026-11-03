import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilitiesFor, UNAVAILABLE } from "../../server/platform/capabilities.ts";
import { platformFor } from "../../server/platform/index.ts";
import type { Capability, PlatformId } from "../../shared/platform.ts";

/**
 * The platform adapter (`server/platform/`): what each system may do, and the argument lists macOS and Linux run, which
 * must stay what the server ran before the adapter existed.
 */

const IDS: PlatformId[] = ["darwin", "linux", "win32"];

test("every capability that is off somewhere has a reason to give", () => {
	for (const id of IDS)
		for (const [name, on] of Object.entries(capabilitiesFor(id)))
			if (!on) expect(UNAVAILABLE[name as Capability], `${id} ${name}`).toBeTruthy();
});

test("pause and relays are off on Windows, on elsewhere", () => {
	expect(capabilitiesFor("win32")).toMatchObject({ pauseResume: false, relay: false });
	for (const id of ["darwin", "linux"] as const)
		expect(capabilitiesFor(id)).toMatchObject({ pauseResume: true, relay: true });
});

test("macOS and Linux run the same commands as before the adapter", () => {
	for (const id of ["darwin", "linux"] as const) {
		const p = platformFor(id);
		expect(p.shell.privateArgv(["omp"])).toEqual(["/bin/sh", "-c", 'umask 077; exec "$@"', "omp-webui", "omp"]);
		expect(p.shell.jobArgv("/s", ["x"])?.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
		expect(p.shell.hangup).toBe("SIGHUP");
		expect(p.proc.groupSpawn).toEqual({ detached: true });
	}
	const mac = platformFor("darwin");
	expect(mac.desktop?.openArgv("/a")).toEqual(["/usr/bin/open", "/a"]);
	expect(mac.desktop?.revealArgv("/a")).toEqual(["/usr/bin/open", "-R", "/a"]);
	expect(mac.power?.keepAwakeArgv("/usr/bin/caffeinate", 7)).toEqual(["/usr/bin/caffeinate", "-i", "-w", "7"]);
	expect(platformFor("linux").desktop).toBeNull();
});

test("a process tree is walked from one listing", async () => {
	const linux = platformFor("linux", {
		run: async () => ({ code: 0, stdout: "  10 1\n  11 10\n  12 11\n  13 1\n", stderr: "" }),
	});
	expect(await linux.proc.tree(10)).toEqual([10, 11, 12]);
});

test("Windows refuses the signals it has not, ends trees with taskkill, and finds programs by PATHEXT", () => {
	const ran: string[][] = [];
	const killed: [number, string | number][] = [];
	const win = platformFor("win32", {
		runSync: (argv) => {
			ran.push(argv);
			return { code: 0, stdout: "" };
		},
		kill: (pid, signal) => void killed.push([pid, signal]),
		env: { PATHEXT: ".EXE;.CMD" },
	});
	expect(() => win.proc.signal(5, "SIGSTOP")).toThrow("not available on Windows");
	win.proc.signal(5, "SIGTERM");
	expect(killed).toEqual([[5, "SIGTERM"]]);
	win.proc.signalGroup(6, "SIGKILL");
	expect(ran).toEqual([["taskkill", "/PID", "6", "/T", "/F"]]);
	expect(win.shell.jobArgv("/s", ["x"])).toBeNull();
	expect(win.shell.loginEnvArgv("sh", "M")).toBeNull();
	const dir = mkdtempSync(join(tmpdir(), "ompw-win-"));
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "bin", "omp.cmd"), "");
	expect(win.commands.which("omp", [join(dir, "bin")])).toBe(join(dir, "bin", "omp.cmd"));
});
