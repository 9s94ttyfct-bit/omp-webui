import { rmSync } from "node:fs";
import { exists, processTree, signalAll } from "./process-tree.ts";
import { Backlog } from "./relay-backlog.ts";
import {
	type ExitInfo,
	encodeFrame,
	FROM_RELAY,
	FrameDecoder,
	type Hello,
	Outbox,
	TO_RELAY,
} from "./relay-protocol.ts";

/**
 * The process that owns one omp's pipes: `omp-webui-server --ompw-relay <socket> <omp> <args…>`.
 *
 * It starts omp (in its own session and process group, with the relay's own working directory and environment),
 * and passes what omp reads and writes through a unix socket that the web UI's server connects to. It exists so
 * that a paused conversation, or one waiting out a usage limit (omp's own timer is what resumes it), can outlive the
 * server: the server is the relay's only client, and when it goes — the app quitting, a crash — the relay either keeps
 * omp as it is (`hold`: set while the conversation is paused, omp frozen, or waits for a usage limit to reset, omp
 * running) or ends it the way a closed pipe would. The next server connects to the same socket and finds omp exactly
 * where it stopped. If omp itself ends while held (killed), what it left frozen in its process group has nobody to
 * resume it: the relay ends that too.
 *
 * A closed pipe ends an idle omp, but one that is working ignores it until its turn is over, and a server that is
 * gone (killed, out of memory, crashed) cannot stop it: it would go on in the user's folder with nobody to see it.
 * So an omp that is still running ORPHAN_GRACE_MS after its server's connection ended, with no server back and
 * the conversation not held, is stopped, together with what it started.
 *
 * While no server is connected the relay goes on reading omp's stdout and keeps it, whole lines in frames, for the next
 * server (`Backlog`: in memory, and in a file of the relay's own beyond a few MB, up to a bound): an omp that runs on
 * its own — a turn that its usage-limit timer starts while the app is closed — is not held back by a full pipe, and
 * the next server receives everything in order before anything newer. Beyond the bound omp waits on its full pipe.
 * A server that is connected but does not take what it is sent holds omp back the same way, once more than HIGH_WATER
 * of omp's output (stdout and stderr) is unsent: what the relay holds is that, the line being read, and a copy of each.
 * omp's stderr is not kept for a server that is not there: its tail goes to the next one in the greeting.
 */

const MAX_STDERR = 64 * 1024;
/** How long the relay waits for the server that started it to connect. */
const FIRST_CLIENT_MS = 30_000;
/** Unsent output after which the relay stops reading omp's output until the server has caught up. */
export const HIGH_WATER = 1 << 20;
/** How long the server gets to take the last frames and close once omp has ended. */
const EXIT_LINGER_MS = 2000;
/** How long omp gets to end after SIGTERM before it is killed. */
const TERM_GRACE_MS = 1500;
/** How long omp gets to end by itself, on its closed stdin, once the server's connection has gone, before it is stopped. */
const ORPHAN_GRACE_MS = 1500;
/** What `ServerLink.replay` hands the connection at a time. */
const REPLAY_CHUNK = 256 << 10;

interface Client {
	socket: { write(data: Uint8Array): number; end(): void; flush(): void };
	out: Outbox;
	decoder: FrameDecoder;
	closed: boolean;
}

/**
 * The server connected to the relay (one at a time) and what the relay owes it: omp's output goes to it, and while the
 * conversation is held the relay waits for the next one when there is none.
 */
export class ServerLink {
	client: Client | null = null;
	/** A server has connected at least once. */
	everAttached = false;
	/** The conversation is paused or waits out a usage limit: omp keeps running when the server's connection ends. */
	hold = false;
	private readonly waiters: (() => void)[] = [];

	/** `backlog`: what omp wrote that no server has been given yet. */
	constructor(readonly backlog: Backlog = new Backlog()) {}

	changed(): void {
		for (const wake of this.waiters.splice(0)) wake();
	}

	untilChanged(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.waiters.push(resolve);
		return promise;
	}

	/** A server connects. It takes the relay over from the one connected, which is told so and let go. */
	attach(socket: Client["socket"]): Client {
		const taken = this.client;
		if (taken) {
			taken.out.send(encodeFrame(FROM_RELAY.replaced));
			taken.closed = true;
			this.client = null;
			taken.socket.flush();
			taken.socket.end();
			// Its close will not reach `release` (it is not the current connection any more): whatever waits for it to
			// take frames — `deliver`, with a server that was not reading — must not wait for ever.
			taken.out.abandon();
		}
		const next: Client = { socket, out: new Outbox(socket), decoder: new FrameDecoder(), closed: false };
		this.client = next;
		this.everAttached = true;
		return next;
	}

	/** The connection `gone` ended. False when it was not the current one: it had been replaced. */
	release(gone: Client): boolean {
		if (this.client !== gone) return false;
		this.client = null;
		gone.out.abandon();
		this.changed();
		return true;
	}

	/**
	 * Hand `payload` to the connected server, if it has been given all that came before; otherwise keep it, in order,
	 * for the server that will be (`replay`). Output that nobody will ever read is dropped, and when what is kept is
	 * at its bound this waits for room.
	 */
	async deliver(type: number, payload: Uint8Array | readonly Uint8Array[]): Promise<void> {
		for (;;) {
			if (this.client && this.backlog.size === 0) return this.tell(type, payload);
			// Nobody will ever read it.
			if (!this.client && this.everAttached && !this.hold) return;
			if (this.backlog.push(encodeFrame(type, payload))) return;
			await this.untilChanged();
		}
	}

	/**
	 * Give `to`, the server that has just connected, what was kept for it, oldest first, as fast as it takes it (a
	 * server that does not read holds this back, and omp with it once the bound is reached). What `deliver` gets
	 * meanwhile is kept behind it. Ends when all has been given, or when `to` is not the connected server any more.
	 */
	async replay(to: Client): Promise<void> {
		while (this.client === to && this.backlog.size > 0) {
			for (const frame of this.backlog.take(REPLAY_CHUNK)) to.out.send(frame);
			this.changed();
			if (to.out.backlog > HIGH_WATER) await to.out.flushed();
		}
		this.changed();
	}

	/**
	 * Hand `payload` to the connected server, if there is one (nothing is kept for the next), and wait while it has more
	 * than HIGH_WATER of what it was sent still to take: omp is read again once it has caught up.
	 */
	async tell(type: number, payload: Uint8Array | readonly Uint8Array[]): Promise<void> {
		const to = this.client;
		if (!to) return;
		to.out.send(encodeFrame(type, payload));
		if (to.out.backlog > HIGH_WATER) await to.out.flushed();
	}
}

/**
 * What omp writes, as whole lines: the lines that a chunk of its output ends, each as the pieces it came in. Never half
 * of one. What has arrived of a line that is not over waits as the chunks it came in, and is joined once, into its
 * frame, when the line ends: joining at every chunk copies a long line again and again, and the garbage of that is what
 * a relay held at its high-water mark would still grow by. The next chunk is not read before the consumer asks for
 * the next lines, so a consumer that waits holds omp back.
 */
export async function* wholeLines(stream: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer[]> {
	let pending: Buffer[] = [];
	for await (const chunk of stream) {
		const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		const end = bytes.lastIndexOf(0x0a);
		if (end < 0) {
			pending.push(Buffer.from(bytes));
			continue;
		}
		const lines = [...pending, bytes.subarray(0, end + 1)];
		pending = end + 1 < bytes.length ? [Buffer.from(bytes.subarray(end + 1))] : [];
		yield lines;
	}
}

/** Returns when the relay ends the process; it never returns normally. */
export async function runRelay(args: string[]): Promise<never> {
	const [socketPath, bin, ...ompArgs] = args;
	if (!socketPath || !bin) {
		console.error("usage: --ompw-relay <socket> <omp> [args…]");
		process.exit(2);
	}
	rmSync(socketPath, { force: true });

	let omp: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
	let spawnError = "";
	let stderrTail = "";
	let exit: ExitInfo | null = null;
	// A file for what is kept beyond memory, beside the socket (see `Backlog`).
	const backlog = new Backlog(`${socketPath}.spill`);
	const link = new ServerLink(backlog);

	const cleanup = () => {
		backlog.close();
		rmSync(socketPath, { force: true });
	};

	const guard = (result: unknown) => {
		if (result instanceof Promise) result.catch(() => {});
	};
	const stdinWrite = (data: Uint8Array) => {
		if (!omp || exit) return;
		try {
			guard(omp.stdin.write(data));
			guard(omp.stdin.flush());
		} catch {
			// omp closed its input: it is on its way out
		}
	};
	const stdinEnd = () => {
		try {
			guard(omp?.stdin.end());
		} catch {
			// already closed
		}
	};

	const hello = (): Hello => ({ pid: omp?.pid ?? null, relayPid: process.pid, stderr: stderrTail });

	const detach = (gone: Client) => {
		if (!link.release(gone) || link.hold) return;
		// A connection that ends while the conversation is not held ends omp as a closed pipe would.
		stdinEnd();
		void orphaned();
	};

	const listener = Bun.listen<{ client: Client }>({
		unix: socketPath,
		socket: {
			open(socket) {
				const next = link.attach(socket);
				socket.data = { client: next };
				next.out.send(encodeFrame(FROM_RELAY.hello, JSON.stringify(hello())));
				// What omp wrote while no server was there comes first, then what ended it: nothing follows its exit.
				void link.replay(next).then(() => {
					if (exit && link.client === next) next.out.send(encodeFrame(FROM_RELAY.exit, JSON.stringify(exit)));
				});
				link.changed();
			},
			data(socket, chunk) {
				const own = socket.data?.client;
				if (!own || own.closed) return;
				for (const frame of own.decoder.push(chunk)) {
					if (frame.type === TO_RELAY.stdin) stdinWrite(Buffer.from(frame.payload));
					else if (frame.type === TO_RELAY.stdinEnd) stdinEnd();
					else if (frame.type === TO_RELAY.hold) link.hold = frame.payload[0] === 1;
				}
			},
			drain(socket) {
				socket.data?.client.out.drain();
			},
			close(socket) {
				const own = socket.data?.client;
				if (own) detach(own);
			},
			error(socket) {
				const own = socket.data?.client;
				if (own) detach(own);
			},
		},
	});

	const pumpStdout = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
		for await (const lines of wholeLines(stream)) await link.deliver(FROM_RELAY.stdout, lines);
	};

	const pumpStderr = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			stderrTail += decoder.decode(chunk, { stream: true });
			if (stderrTail.length > MAX_STDERR) stderrTail = stderrTail.slice(-MAX_STDERR);
			await link.tell(FROM_RELAY.stderr, chunk);
		}
	};

	const killGroup = (signal: NodeJS.Signals) => {
		if (!omp) return;
		try {
			process.kill(-omp.pid, signal);
		} catch {
			try {
				omp.kill(signal);
			} catch {
				// gone
			}
		}
	};

	/** What omp has started, as far as the system can list it now (not omp itself). */
	const startedBy = async (pid: number): Promise<number[]> => {
		try {
			return (await processTree(pid)).filter((p) => p !== pid);
		} catch {
			return [];
		}
	};

	/** Stop omp and what it started, then go. */
	const terminate = async (): Promise<never> => {
		if (omp && exit === null) {
			// What omp started runs in sessions of its own, out of reach of a signal to omp's group, and does not end with
			// omp: it is found now, while omp still has it below it.
			const started = await startedBy(omp.pid);
			const deadline = Date.now() + TERM_GRACE_MS;
			// A frozen group takes no signal until it runs again.
			killGroup("SIGCONT");
			signalAll(started, "SIGCONT");
			killGroup("SIGTERM");
			signalAll(started, "SIGTERM");
			await Promise.race([omp.exited, Bun.sleep(TERM_GRACE_MS)]);
			if (exit === null && omp.exitCode === null) killGroup("SIGKILL");
			while (started.some(exists) && Date.now() < deadline) await Bun.sleep(20);
			signalAll(started.filter(exists), "SIGKILL");
		}
		cleanup();
		process.exit(0);
	};

	/**
	 * The server's connection ended while omp was not held (see `detach`). A closed stdin ends an idle omp at once; one that
	 * is working would carry on with nobody to see it, so what is still running when ORPHAN_GRACE_MS is over is stopped,
	 * unless a server has connected again or the conversation was held meanwhile.
	 */
	const orphaned = async (): Promise<void> => {
		if (!omp) return;
		await Promise.race([omp.exited, Bun.sleep(ORPHAN_GRACE_MS)]);
		if (exit !== null || omp.exitCode !== null || link.client || link.hold) return;
		await terminate();
	};
	process.on("SIGTERM", () => void terminate());
	// No terminal: a stray hangup or interrupt is not for the relay.
	process.on("SIGHUP", () => {});
	process.on("SIGINT", () => {});
	// The server that started the relay never connected (it died first): there is nobody to serve.
	setTimeout(() => {
		if (!link.everAttached) void terminate();
	}, FIRST_CLIENT_MS);

	try {
		omp = Bun.spawn([bin, ...ompArgs], {
			cwd: process.cwd(),
			env: process.env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			// Its own session and process group: omp and the helpers it starts there are signalled together.
			detached: true,
		});
	} catch (e) {
		spawnError = e instanceof Error ? e.message : String(e);
		stderrTail = `error: could not start ${bin}: ${spawnError}\n`;
	}

	const finished = Promise.withResolvers<void>();
	if (omp) {
		const stdoutDone = pumpStdout(omp.stdout).catch(() => {});
		const stderrDone = pumpStderr(omp.stderr).catch(() => {});
		void omp.exited.then(async () => {
			// A held conversation has nobody to see what omp left behind, and a paused one's tools and helpers are frozen with
			// omp and nothing would ever resume them: end them. Before anything else, they may hold omp's pipes open.
			if (link.hold) killGroup("SIGKILL");
			// Let what omp wrote last go through before the exit is announced.
			await Promise.race([Promise.all([stdoutDone, stderrDone]), Bun.sleep(500)]);
			const signal = omp?.signalCode;
			exit = { code: omp?.exitCode ?? null, signal: typeof signal === "string" ? signal : null };
			finished.resolve();
		});
	} else {
		exit = { code: 127, signal: null };
		finished.resolve();
	}

	await finished.promise;
	const announced = exit as ExitInfo | null;
	// An omp that ended before its server connected still owes that server the reason.
	if (!link.client && !link.everAttached) {
		const deadline = Date.now() + FIRST_CLIENT_MS;
		while (!link.client && Date.now() < deadline) await Promise.race([link.untilChanged(), Bun.sleep(250)]);
	}
	if (link.client && announced) {
		const last: Client = link.client;
		// What is still kept for it goes before the exit, for as long as the server goes on taking it.
		let kept = link.backlog.size;
		let patience = Date.now() + EXIT_LINGER_MS;
		while (link.client === last && kept > 0 && Date.now() < patience) {
			await Promise.race([link.untilChanged(), Bun.sleep(250)]);
			if (link.backlog.size < kept) patience = Date.now() + EXIT_LINGER_MS;
			kept = link.backlog.size;
		}
		if (link.client === last) last.out.send(encodeFrame(FROM_RELAY.exit, JSON.stringify(announced)));
		await Promise.race([last.out.flushed(), Bun.sleep(EXIT_LINGER_MS)]);
		await Promise.race([
			(async () => {
				while (link.client === last) await link.untilChanged();
			})(),
			Bun.sleep(EXIT_LINGER_MS),
		]);
	}
	listener.stop(true);
	cleanup();
	process.exit(0);
}
