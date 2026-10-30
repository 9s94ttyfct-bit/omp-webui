import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExitInfo,
	encodeFrame,
	FROM_RELAY,
	FrameDecoder,
	type Hello,
	Outbox,
	RELAY_FLAG,
	TO_RELAY,
} from "./relay-protocol.ts";
import type { OmpProcess } from "./rpc-client.ts";
import { PS_MS, run } from "./run.ts";

/**
 * The server's side of an omp relay (relay.ts): an `OmpProcess` whose pipes run through the relay's unix
 * socket. `RelayProc.spawn` starts a relay, which starts omp; `RelayProc.attach` connects to one that is already
 * running — the way a server finds the paused conversations a former one left behind.
 */

/** Longest a unix socket path may be, with margin (macOS allows 104 bytes, Linux 108). */
const MAX_SOCKET_PATH = 100;
/** How long a freshly started relay gets to listen. */
const START_MS = 15_000;
/** How long a relay that is said to be running gets to answer: it either does at once or is not there. */
const ADOPT_MS = 3_000;

/** The longest socket name a relay gets (see `relaySocket`): a liveId and its extension. */
const SOCKET_NAME = "L123456-abcdefgh.sock";

/** Where short socket directories go, and who must own them. */
export interface Where {
	/** The directory the short ones are made in (/tmp). */
	tmp: string;
	/** The user whose they must be; undefined where the system has no such thing. */
	uid: number | undefined;
}

const HERE: Where = { tmp: "/tmp", uid: process.getuid?.() };

/** Data dirs whose usual relay directory could not be used, and the directory of their own they got instead. */
const elsewhere = new Map<string, string>();

/**
 * Where the relay directory of `dataDir` normally is: `<dataDir>/relay`, private to the user. A data dir too deep for a
 * socket path (a test's temp dir, a long home directory) gets a short directory in a per-user one in /tmp instead, named
 * by the data dir it is for. `root` is that per-user directory.
 */
function usualDir(dataDir: string, where: Where): { dir: string; root: string | null } {
	const preferred = join(dataDir, "relay");
	if (join(preferred, SOCKET_NAME).length <= MAX_SOCKET_PATH) return { dir: preferred, root: null };
	const root = join(where.tmp, `ompw-${where.uid ?? "user"}`);
	return { dir: join(root, createHash("sha1").update(dataDir).digest("hex").slice(0, 10)), root };
}

/** The relay directory of `dataDir`, without making it. */
export function relayDirPath(dataDir: string, where: Where = HERE): string {
	return elsewhere.get(dataDir) ?? usualDir(dataDir, where).dir;
}

/**
 * Make `dir` if it is not there, and say whether sockets may be put in it: it is a directory (not a link someone
 * planted) that belongs to `uid`, and is made private to that user. Anything else is left as it is. In /tmp, which
 * anyone may write to, only the owner of a directory can remove or replace it, so what was checked stays true.
 */
export function privateDir(dir: string, uid: number | undefined): boolean {
	try {
		mkdirSync(dir, { mode: 0o700 });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
	}
	try {
		const found = lstatSync(dir);
		if (!found.isDirectory() || (uid !== undefined && found.uid !== uid)) return false;
		if ((found.mode & 0o077) !== 0) chmodSync(dir, 0o700);
		return true;
	} catch {
		return false;
	}
}

/**
 * The directory relay sockets of `dataDir` live in, made. When the usual one is not the user's to use (a foreign or
 * planted directory is there already) a directory is made that is exclusively theirs, and used instead: such a
 * directory must never keep a conversation from starting.
 */
export function relayDir(dataDir: string, where: Where = HERE): string {
	const moved = elsewhere.get(dataDir);
	if (moved) return moved;
	const { dir, root } = usualDir(dataDir, where);
	if (root === null) mkdirSync(dataDir, { recursive: true });
	if ((root === null || privateDir(root, where.uid)) && privateDir(dir, where.uid)) return dir;
	const own = mkdtempSync(join(where.tmp, "ompw-"));
	elsewhere.set(dataDir, own);
	return own;
}

export function relaySocket(dataDir: string, liveId: string, where: Where = HERE): string {
	return join(relayDir(dataDir, where), `${liveId}.sock`);
}

/** Remove the relay directory when no relay is left in it (a server that ends leaves nothing behind). */
export function pruneRelayDir(dataDir: string, where: Where = HERE): void {
	try {
		rmdirSync(relayDirPath(dataDir, where));
	} catch {
		// not there, or a paused conversation's relay is still listening in it
	}
}

/** The command line of every process on this machine, from one listing; null when the system cannot give one. */
export async function processCommands(): Promise<string[] | null> {
	try {
		const ran = await run(["ps", "-A", "-ww", "-o", "command="], { timeoutMs: PS_MS });
		return ran.code === 0 ? ran.stdout.split("\n") : null;
	} catch {
		return null;
	}
}

/**
 * The sockets in the relay directory, each with whether a relay listens on it. A socket is a relay's while a process has
 * it on its command line (`--ompw-relay <socket>`: a paused conversation's relay, another server's) — read from the
 * processes, not by connecting, which would take a live relay's conversation over from the server that holds it. The
 * directory is listed before the processes, so that a relay started meanwhile is never taken for dead. Null when the
 * processes cannot be listed.
 */
async function scanRelayDir(
	dataDir: string,
	where: Where,
	commands: () => Promise<string[] | null>,
): Promise<{ socket: string; listening: boolean }[] | null> {
	const dir = relayDirPath(dataDir, where);
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".sock"));
	} catch {
		return [];
	}
	if (names.length === 0) return [];
	const running = await commands();
	if (!running) return null;
	return names.map((name) => {
		const socket = join(dir, name);
		return { socket, listening: running.some((line) => line.includes(socket)) };
	});
}

/**
 * Remove the sockets in the relay directory that no relay listens on. A relay removes its socket when it ends, but not
 * when it is killed (SIGKILL, an out-of-memory kill): without this one such death leaves a file for good, and the
 * directory is never removed. Nothing is removed when the processes cannot be listed. Returns the names removed.
 */
export async function sweepRelayDir(
	dataDir: string,
	where: Where = HERE,
	commands: () => Promise<string[] | null> = processCommands,
): Promise<string[]> {
	const removed: string[] = [];
	for (const { socket, listening } of (await scanRelayDir(dataDir, where, commands)) ?? []) {
		if (listening) continue;
		try {
			// Only a socket: anything else in here is not ours to remove.
			if (!lstatSync(socket).isSocket()) continue;
			rmSync(socket, { force: true });
			removed.push(basename(socket));
		} catch {
			// gone already, or not removable: the next sweep looks again
		}
	}
	return removed;
}

/** The sockets in the relay directory that a relay listens on now; none when the processes cannot be listed. */
export async function runningRelays(
	dataDir: string,
	where: Where = HERE,
	commands: () => Promise<string[] | null> = processCommands,
): Promise<string[]> {
	return ((await scanRelayDir(dataDir, where, commands)) ?? []).filter((s) => s.listening).map((s) => s.socket);
}

/** The command that runs a relay: the compiled server runs itself, from source the relay is a script of its own. */
export function relayCommand(): string[] {
	const compiled = import.meta.path.startsWith("/$bunfs/");
	return compiled ? [process.execPath] : [process.execPath, fileURLToPath(new URL("./relay-main.ts", import.meta.url))];
}

/** A queue read as an async iterable (omp's pipes, as the relay forwards them). */
class Channel<T> implements AsyncIterable<T> {
	private items: T[] = [];
	private waiting: ((r: IteratorResult<T>) => void)[] = [];
	private closed = false;

	push(item: T): void {
		const next = this.waiting.shift();
		if (next) next({ value: item, done: false });
		else this.items.push(item);
	}

	close(): void {
		this.closed = true;
		for (const next of this.waiting.splice(0)) next({ value: undefined, done: true });
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				const item = this.items.shift();
				if (item !== undefined) return Promise.resolve({ value: item, done: false });
				if (this.closed) return Promise.resolve({ value: undefined, done: true });
				const { promise, resolve } = Promise.withResolvers<IteratorResult<T>>();
				this.waiting.push(resolve);
				return promise;
			},
		};
	}
}

export class RelayProc implements OmpProcess {
	/** omp's process id, known once the relay says hello; null until then, and when omp could not be started. */
	pid: number | null = null;
	/** The relay's, known at once for one this server started. */
	relayPid: number | null = null;
	readonly stdout = new Channel<Uint8Array>();
	readonly stderr = new Channel<Uint8Array>();
	readonly exited: Promise<number | null>;
	/** Resolves with the relay's greeting; rejects when no relay could be reached. */
	readonly started: Promise<Hello>;
	readonly stdin = {
		write: (data: string): number => this.send(TO_RELAY.stdin, data),
		flush: (): void => {},
		end: (): void => void this.send(TO_RELAY.stdinEnd),
	};

	private out: Outbox | null = null;
	private socket: { end(): void; flush(): void } | null = null;
	/** Frames sent before the connection was open. */
	private early: Buffer[] = [];
	private readonly decoder = new FrameDecoder();
	private ended = false;
	private code: number | null = null;
	private signal: NodeJS.Signals | null = null;
	private detached = false;
	private readonly resolveExit: (code: number | null) => void;
	private readonly resolveStarted: (h: Hello) => void;
	private readonly rejectStarted: (e: Error) => void;
	private heard = false;
	/** Runs out when a relay that accepted the connection has not greeted in time (see `connect`). */
	private greeting: NodeJS.Timeout | undefined;

	private constructor(
		readonly socketPath: string,
		/** How long to keep trying to connect, and how long a relay that accepted the connection gets to greet. */
		private readonly connectMs: number,
	) {
		const exit = Promise.withResolvers<number | null>();
		this.exited = exit.promise;
		this.resolveExit = exit.resolve;
		const started = Promise.withResolvers<Hello>();
		this.started = started.promise;
		this.resolveStarted = started.resolve;
		this.rejectStarted = started.reject;
		// Nobody may await `started` (a client that never reaches its relay): keep the rejection observed.
		this.started.catch(() => {});
	}

	/** Start a relay for `command` (omp and its arguments) in `cwd` with `env`, and connect to it. */
	static spawn(opts: {
		socket: string;
		command: string[];
		cwd: string;
		env: Record<string, string | undefined>;
	}): RelayProc {
		const proc = new RelayProc(opts.socket, START_MS);
		const relay = Bun.spawn([...relayCommand(), RELAY_FLAG, opts.socket, ...opts.command], {
			cwd: opts.cwd,
			env: opts.env,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			// Its own session: the server — the app — going away must not signal it.
			detached: true,
		});
		// The server may end while the relay lives on.
		relay.unref();
		proc.relayPid = relay.pid;
		void relay.exited.then((code) => {
			if (!proc.heard) proc.lost(`could not start omp: its relay ended before it could be reached (code ${code})`);
		});
		void proc.connect();
		return proc;
	}

	/** Connect to the relay on `socket`, which is already running. */
	static attach(socket: string): RelayProc {
		const proc = new RelayProc(socket, ADOPT_MS);
		void proc.connect();
		return proc;
	}

	private async connect(): Promise<void> {
		const deadline = Date.now() + this.connectMs;
		for (;;) {
			if (this.ended) return;
			try {
				await Bun.connect({
					unix: this.socketPath,
					socket: {
						open: (socket) => {
							this.socket = socket;
							this.out = new Outbox(socket);
							for (const frame of this.early.splice(0)) this.out.send(frame);
						},
						data: (_socket, chunk) => this.receive(chunk),
						drain: () => this.out?.drain(),
						close: () => this.lost("the connection to omp's relay closed"),
						error: (_socket, e) => this.lost(`the connection to omp's relay failed: ${e.message}`),
					},
				});
				// The relay accepted the connection and greets at once; one that does not (stuck, frozen, a stranger listening on
				// its socket) is no more there than one that refuses it, and must not hold up what waits for `started`.
				if (!this.ended && !this.heard)
					this.greeting = setTimeout(
						() => this.lost(`omp's relay did not greet within ${this.connectMs} ms on ${this.socketPath}`),
						this.connectMs,
					);
				return;
			} catch (e) {
				if (Date.now() > deadline)
					return this.lost(
						`could not start omp: its relay did not answer on ${this.socketPath}: ${(e as Error).message}`,
					);
				await Bun.sleep(15);
			}
		}
	}

	private receive(chunk: Uint8Array): void {
		for (const { type, payload } of this.decoder.push(chunk)) {
			if (this.detached) return;
			if (type === FROM_RELAY.hello) {
				const hello = JSON.parse(payload.toString()) as Hello;
				this.heard = true;
				clearTimeout(this.greeting);
				this.pid = hello.pid;
				this.relayPid = hello.relayPid;
				if (hello.stderr) this.stderr.push(Buffer.from(hello.stderr));
				this.resolveStarted(hello);
			} else if (type === FROM_RELAY.stdout) {
				this.stdout.push(Buffer.from(payload));
			} else if (type === FROM_RELAY.stderr) {
				this.stderr.push(Buffer.from(payload));
			} else if (type === FROM_RELAY.exit) {
				const info = JSON.parse(payload.toString()) as ExitInfo;
				this.finish(info.code, info.signal as NodeJS.Signals | null);
			} else if (type === FROM_RELAY.replaced) {
				this.lost("another server took over omp's relay");
			}
		}
	}

	private send(type: number, payload: Uint8Array | string = ""): number {
		const frame = encodeFrame(type, payload);
		if (this.out) this.out.send(frame);
		else if (!this.ended) this.early.push(frame);
		return frame.length - 5;
	}

	private finish(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.ended) return;
		this.ended = true;
		clearTimeout(this.greeting);
		this.code = code;
		this.signal = signal;
		this.out?.abandon();
		this.stdout.close();
		this.stderr.close();
		this.resolveExit(code ?? -1);
		try {
			this.socket?.end();
		} catch {
			// already closed
		}
	}

	/** The relay cannot be reached or went without saying how omp ended. */
	private lost(why: string): void {
		if (this.ended || this.detached) return;
		this.stderr.push(Buffer.from(`error: ${why}\n`));
		this.rejectStarted(new Error(why));
		this.finish(null, null);
	}

	/** Like a process of our own: none when a signal ended omp (`signalCode`); -1 when the relay was lost without saying how. */
	get exitCode(): number | null {
		return this.ended && this.signal === null ? (this.code ?? -1) : null;
	}

	get signalCode(): NodeJS.Signals | null {
		return this.signal;
	}

	/** Keep omp running when this connection ends (`on`), or end it as a closed pipe would. */
	hold(on: boolean): void {
		this.send(TO_RELAY.hold, Buffer.from([on ? 1 : 0]));
	}

	/** Let go of the relay without ending omp: the connection closes and nothing is reported. */
	detach(): void {
		if (this.detached || this.ended) return;
		this.detached = true;
		clearTimeout(this.greeting);
		try {
			this.socket?.flush();
			this.socket?.end();
		} catch {
			// already closed
		}
	}

	/** Signal omp itself; while it is not known (the relay is still starting), ask the relay to end it. */
	kill(signal: NodeJS.Signals | number = "SIGTERM"): void {
		const target = this.pid ?? this.relayPid;
		if (target === null || this.ended) return;
		try {
			process.kill(target, this.pid === null ? "SIGTERM" : signal);
		} catch {
			// gone
		}
	}
}
