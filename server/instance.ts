import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "./platform/index.ts";

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

/** The process is running, and still runs the command it was recorded with (its pid was not reused). */
function runsAs(p: ProcessRef): boolean {
	return platform.proc.exists(p.pid) && platform.proc.commandLineSync(p.pid) === p.command;
}

function readRef<T extends ProcessRef>(path: string): T | null {
	try {
		const r = JSON.parse(readFileSync(path, "utf8")) as T;
		return Number.isInteger(r.pid) && typeof r.command === "string" ? r : null;
	} catch {
		return null;
	}
}

const read = (dataDir: string) => readRef<ServerRecord>(file(dataDir));

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
	platform.proc.signal(rec.pid, "SIGTERM");
	for (let i = 0; i < 50 && platform.proc.exists(rec.pid); i++) await Bun.sleep(100);
	if (platform.proc.exists(rec.pid) && platform.proc.commandLineSync(rec.pid) === rec.command)
		platform.proc.signal(rec.pid, "SIGKILL");
	rmSync(file(dataDir), { force: true });
	return rec.pid;
}

/** Record this server, and the app (`parentPid`) that started it, if any. */
export function recordServer(dataDir: string, port: number, parentPid: number | null, localPort?: number): void {
	const command = platform.proc.commandLineSync(process.pid);
	if (!command) return;
	const parentCommand = parentPid === null ? null : platform.proc.commandLineSync(parentPid);
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

/**
 * The server this data dir records (this process too, once it has recorded itself), when it is running as recorded:
 * the loopback port its page on this computer is served on. Null when there is none (or the pid now belongs to
 * something else).
 */
export function runningServer(dataDir: string): { pid: number; port: number } | null {
	const rec = read(dataDir);
	if (!rec || !runsAs(rec)) return null;
	const port = rec.localPort ?? rec.port;
	return Number.isInteger(port) && port > 0 ? { pid: rec.pid, port } : null;
}

/**
 * Hold the start of this data dir's server, so that two launchers started together (a double-click done twice, Start at
 * login's run while the person opens the program) do not both start one: `<dataDir>/start.lock`, holding the process that
 * made it, is made only where there is none (a hard link of a file already written, so it is never seen half-written). A
 * launcher that finds it held by a live process waits until that one lets it go (its server has recorded itself, or it
 * failed), then decides with the record; one left by a process that is gone is removed. Waiting longer than `timeoutMs`
 * is an error. Returns what lets it go, which does nothing once it is not this process's.
 */
export async function holdStart(dataDir: string, timeoutMs = 120_000): Promise<() => void> {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const lock = join(dataDir, "start.lock");
	const mine = `${lock}.${process.pid}.tmp`;
	writeFileSync(mine, JSON.stringify({ pid: process.pid, command: platform.proc.commandLineSync(process.pid) ?? "" }), {
		mode: 0o600,
	});
	const until = Date.now() + timeoutMs;
	try {
		for (;;) {
			try {
				linkSync(mine, lock);
				return () => {
					if (readRef(lock)?.pid === process.pid) rmSync(lock, { force: true });
				};
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			}
			const holder = readRef(lock);
			if (!holder || !runsAs(holder)) {
				rmSync(lock, { force: true });
				continue;
			}
			while (readRef(lock)?.pid === holder.pid && platform.proc.exists(holder.pid)) {
				if (Date.now() > until)
					throw new Error(`another omp-webui (pid ${holder.pid}) is still starting on this data folder`);
				await Bun.sleep(100);
			}
		}
	} finally {
		rmSync(mine, { force: true });
	}
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
		if (rec && rec.pid !== process.pid && Number.isInteger(rec.port) && rec.port > 0 && platform.proc.exists(rec.pid)) {
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
