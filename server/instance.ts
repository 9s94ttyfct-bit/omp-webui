import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * One running server per data dir, recorded in `<dataDir>/server.pid` as its pid, its exact command line
 * and the app that started it. A later start (the macOS app relaunching after a crash) stops a recorded
 * server only when that pid is alive *and* still runs the recorded command *and* its app is gone — a
 * reused pid, any other program on the port, or a server whose app is still running is never touched.
 */

interface ProcessRef {
	pid: number;
	command: string;
}

interface ServerRecord extends ProcessRef {
	port: number;
	/** The port of the loopback listener of a server bound to a network address, when it is not `port` (see `listenOnLoopback`). */
	localPort?: number;
	/** The app that started the server (`OMP_WEBUI_PARENT_PID`), as it ran then; absent for a server started on its own. */
	parent?: ProcessRef;
}

const file = (dataDir: string) => join(dataDir, "server.pid");

/** The command line of a running process, or null when it is gone. */
export function commandOf(pid: number): string | null {
	const r = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
	if (r.exitCode !== 0) return null;
	const out = r.stdout.toString().trim();
	return out || null;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The process is running, and still runs the command it was recorded with (its pid was not reused). */
function runsAs(p: ProcessRef): boolean {
	return alive(p.pid) && commandOf(p.pid) === p.command;
}

function read(dataDir: string): ServerRecord | null {
	try {
		const r = JSON.parse(readFileSync(file(dataDir), "utf8")) as ServerRecord;
		return Number.isInteger(r.pid) && typeof r.command === "string" ? r : null;
	} catch {
		return null;
	}
}

/**
 * Stop a leftover server this data dir recorded. Returns its pid when one was stopped; null when there was
 * none, it was gone, or its app is still running (it is not left over, it is in use).
 */
export async function stopStaleServer(dataDir: string): Promise<number | null> {
	const rec = read(dataDir);
	if (!rec || rec.pid === process.pid) return null;
	if (!runsAs(rec)) {
		// Gone, or the pid now belongs to something else: forget the record, touch nothing.
		rmSync(file(dataDir), { force: true });
		return null;
	}
	if (rec.parent && runsAs(rec.parent)) return null;
	process.kill(rec.pid, "SIGTERM");
	for (let i = 0; i < 50 && alive(rec.pid); i++) await Bun.sleep(100);
	if (alive(rec.pid) && commandOf(rec.pid) === rec.command) process.kill(rec.pid, "SIGKILL");
	rmSync(file(dataDir), { force: true });
	return rec.pid;
}

/** Record this server, and the app (`parentPid`) that started it, if any. */
export function recordServer(dataDir: string, port: number, parentPid: number | null, localPort?: number): void {
	const command = commandOf(process.pid);
	if (!command) return;
	const parentCommand = parentPid === null ? null : commandOf(parentPid);
	const parent = parentPid !== null && parentCommand ? { pid: parentPid, command: parentCommand } : undefined;
	writeFileSync(
		file(dataDir),
		JSON.stringify({ pid: process.pid, command, port, localPort, parent } satisfies ServerRecord),
		{ mode: 0o600 },
	);
}

/** Remove our record (only if it is still ours). */
export function forgetServer(dataDir: string): void {
	if (existsSync(file(dataDir)) && read(dataDir)?.pid === process.pid) rmSync(file(dataDir), { force: true });
}

/** Where an omp-webui keeps its data unless told otherwise: the web version's, and the macOS app's. */
export function knownDataDirs(home: string = homedir()): string[] {
	return [join(home, ".omp-webui"), join(home, "Library", "Application Support", "omp-webui")];
}

/** The ports of the other servers that `dirs` record and that are running now (not this process: it knows its own). */
export function runningServerPorts(dirs: readonly string[]): number[] {
	const ports: number[] = [];
	for (const dir of dirs) {
		const rec = read(dir);
		if (rec && rec.pid !== process.pid && Number.isInteger(rec.port) && rec.port > 0 && alive(rec.pid)) {
			ports.push(rec.port);
			if (Number.isInteger(rec.localPort) && (rec.localPort as number) > 0) ports.push(rec.localPort as number);
		}
	}
	return ports;
}

/** How many ports above its preferred one a server in app mode tries when that one is taken (see `bind` in `main.ts`). */
export const PORT_WINDOW = 20;
/** How many ports above the dev server's a Vite that finds its own taken may take. */
const DEV_WINDOW = 10;

/**
 * Every loopback port an omp-webui may be serving its API on, as far as this server can tell: its own, the window its
 * preferred port may fall back through (a web version next to the app), the ports of the other servers that known data
 * folders record, and under `bun run dev` the Vite port that proxies `/api` to it. A gate asks about the API on each
 * of them (`RiskContext.ports`); another program's port is its own business.
 */
export function apiPorts(
	bound: number,
	preferred: number,
	devPort: number | null,
	others: readonly number[],
): number[] {
	const ports = new Set<number>();
	const add = (from: number, count: number) => {
		for (let p = from; p <= from + count && p <= 65535; p++) if (p > 0) ports.add(p);
	};
	for (const p of [bound, ...others]) add(p, 0);
	add(preferred, PORT_WINDOW);
	if (devPort !== null) add(devPort, DEV_WINDOW);
	return [...ports].sort((a, b) => a - b);
}
