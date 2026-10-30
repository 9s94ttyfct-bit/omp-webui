import { isRecord } from "../../shared/guards.ts";
import type { OmpFrame } from "../../shared/protocol.ts";
import { childEnv } from "../env.ts";
import { RelayProc } from "./relay-client.ts";

/**
 * Minimal client for omp's JSONL RPC protocol (`omp --mode rpc-ui`).
 * Implements the public contract documented in omp's rpc.md: ready frame,
 * protocol v2 negotiation, rpc_chunk reassembly and id-correlated responses.
 */

export interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
	code?: string;
	/**
	 * A large answer's `data` as the text omp wrote it, when the client has it that way (`data` is then read from it on first use):
	 * what is only passed on does not have to be read into objects and written out again.
	 */
	readonly rawData?: string;
}

export class RpcError extends Error {
	constructor(
		message: string,
		readonly command: string,
		readonly code?: string,
	) {
		super(message);
	}
}

interface Pending {
	resolve: (r: RpcResponse) => void;
	reject: (e: Error) => void;
	command: string;
}

interface ChunkState {
	chunkId: string;
	count: number;
	byteLength: number;
	/** Bytes decoded so far. */
	bytes: number;
	/** The text of each chunk so far. */
	texts: string[];
	decoder: TextDecoder;
}

const DATA_KEY = '"data":';

/**
 * An answer to a command, as far as it can be told without reading all of it: the part before `data`, parsed, and the text
 * of `data` itself, untouched. `texts` is the document in pieces. The page is sent `data` as it is, so reading it into
 * objects and writing it out again (for a conversation of tens of MB, hundreds of ms of the server's one thread and
 * half a GB of memory) would change nothing but the time every other request waits.
 *
 * What makes it safe to cut the document without reading it: omp writes an answer as
 * `{"id":…,"type":"response","command":…,"success":…,"data":…}` with `data` last, and JSON strings cannot contain a bare
 * `"`, so the first `"data":` of the document is a key, not a piece of text; if what comes before it, closed with
 * `null}`, is an object, that key is a key of the answer itself and not of something nested in an earlier value; and a
 * document that is JSON and ends with `}` ends with the answer's own closing brace. Anything else (no `data` key in the
 * first chunk, another shape, no closing brace at the end) is `null`: the caller parses the whole document as before.
 */
export function splitResponse(texts: string[]): { head: Record<string, unknown>; data: string } | null {
	const first = texts[0];
	if (first === undefined) return null;
	const at = first.indexOf(DATA_KEY);
	if (at < 0) return null;
	let head: unknown;
	try {
		head = JSON.parse(`${first.slice(0, at + DATA_KEY.length)}null}`);
	} catch {
		return null;
	}
	if (typeof head !== "object" || head === null || Array.isArray(head)) return null;
	const answer = head as Record<string, unknown>;
	if (answer.type !== "response" || typeof answer.id !== "string" || typeof answer.success !== "boolean") return null;
	const last = texts.length - 1;
	const pieces = texts.slice();
	pieces[0] = first.slice(at + DATA_KEY.length);
	const end = (pieces[last] as string).trimEnd();
	if (!end.endsWith("}")) return null;
	pieces[last] = end.slice(0, -1);
	// Concatenated, not joined: the pieces stay a rope until the text is written out, which flattens it once.
	let data = "";
	for (const piece of pieces) data += piece;
	return data.length > 0 ? { head: answer, data } : null;
}

/** The answer whose `data` is read into objects only if someone asks for it (`rawData` is the text, for forwarding as it is). */
function lazyResponse(head: Record<string, unknown>, rawData: string): OmpFrame {
	let parsed: { value: unknown } | undefined;
	const { data: _placeholder, ...rest } = head;
	return Object.defineProperties(rest as OmpFrame, {
		data: {
			enumerable: true,
			get() {
				parsed ??= { value: JSON.parse(rawData) };
				return parsed.value;
			},
		},
		rawData: { value: rawData, enumerable: false },
	});
}

/** A line of omp's output that is a frame: an object that names its `type`. */
function isFrame(value: unknown): value is OmpFrame {
	return isRecord(value) && typeof value.type === "string";
}

/** The most useful line of omp's stderr: its `error:`/`Error:` line, else the last lines. */
export function summarizeStderr(stderr: string): string {
	const lines = Bun.stripANSI(stderr)
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const error = lines.findLast((l) => /^(error|Error)\b/.test(l));
	return (error ?? lines.slice(-3).join(" | ")).slice(0, 500);
}

/**
 * What the client needs of the process it talks to: a `Bun.Subprocess` with piped stdio, or a `RelayProc` (omp
 * behind a relay, which can outlive the server).
 */
export interface OmpProcess {
	/** omp's process id; null while a relay is still starting it. */
	readonly pid: number | null;
	readonly stdin: { write(data: string): unknown; flush(): unknown; end(): unknown };
	readonly stdout: AsyncIterable<Uint8Array>;
	readonly stderr: AsyncIterable<Uint8Array>;
	readonly exited: Promise<number | null>;
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | number | null;
	kill(signal?: NodeJS.Signals | number): void;
}

/** How the client reaches omp. */
export type RpcLaunch =
	/** Start omp with pipes of our own: it ends with this process. */
	| { kind: "direct" }
	/** Start omp behind a relay that listens on `socket` (see relay.ts). */
	| { kind: "relay"; socket: string }
	/** Connect to a relay that is already running, whose omp has done its handshake with a former server. */
	| { kind: "adopt"; socket: string };

export interface RpcClientOptions {
	bin: string;
	args: string[];
	cwd: string;
	env?: Record<string, string | undefined>;
	/** Default: `direct`. */
	via?: RpcLaunch;
	/**
	 * omp's `--mode`: `rpc-ui` (default) also carries the tool dialogs and extension UI a page answers; `rpc` is for a
	 * process no page watches (the short-lived omp of a side question).
	 */
	mode?: "rpc" | "rpc-ui";
	/**
	 * Start omp under `umask 077` (direct launch only): what it writes (and what its own helpers write) is for this user alone.
	 * For a process whose files are in a folder of the data dir, which keeps nothing that others can read.
	 */
	private?: boolean;
	onFrame: (frame: OmpFrame) => void;
	/** `code` is null when omp was ended by a signal, which is then `signal`. */
	onExit: (code: number | null, stderr: string, signal: NodeJS.Signals | null) => void;
}

const MAX_STDERR = 64 * 1024;

export class RpcClient {
	readonly proc: OmpProcess;
	private pending = new Map<string, Pending>();
	private seq = 0;
	private chunk: ChunkState | null = null;
	private maxReassembled = 64 * 1024 * 1024;
	private stderrBuf = "";
	private exited = false;
	/** The first failure writing to omp's stdin (EPIPE: omp died or closed its input); nothing can reach omp after it. */
	private stdinError: RpcError | null = null;
	/** close() was called: the process is on its way out and must not be handed new work. */
	closing = false;
	readonly ready: Promise<void>;
	/** omp's process id is known (a relay has started it; at once for a process of our own). Rejects when it never was. */
	readonly started: Promise<void>;
	private resolveReady: () => void;
	private rejectReady: (e: Error) => void;
	/** Request ids start with this: a client that took over a running omp must not mistake its predecessor's late answers for its own. */
	private readonly idPrefix: string;

	constructor(private readonly opts: RpcClientOptions) {
		const ready = Promise.withResolvers<void>();
		this.ready = ready.promise;
		this.resolveReady = ready.resolve;
		this.rejectReady = ready.reject;
		// Nobody may await `ready` when the process dies early; keep that rejection observed.
		this.ready.catch(() => {});
		const via = opts.via ?? { kind: "direct" };
		this.idPrefix = via.kind === "adopt" ? `a${Date.now().toString(36)}-` : "w";
		if (via.kind === "direct") {
			const command = [opts.bin, "--mode", opts.mode ?? "rpc-ui", ...opts.args];
			this.proc = Bun.spawn(
				opts.private ? ["/bin/sh", "-c", 'umask 077; exec "$@"', "omp-webui", ...command] : command,
				{
					cwd: opts.cwd,
					env: childEnv(opts.env),
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
					// Its own process group (and session): omp and the helpers it starts there can be signalled together,
					// and a Ctrl-C in the terminal the server runs in reaches the server, which stops its omps in order.
					detached: true,
				},
			);
			this.started = Promise.resolve();
		} else {
			const proc =
				via.kind === "relay"
					? RelayProc.spawn({
							socket: via.socket,
							command: [opts.bin, "--mode", opts.mode ?? "rpc-ui", ...opts.args],
							cwd: opts.cwd,
							env: childEnv(opts.env),
						})
					: RelayProc.attach(via.socket);
			this.proc = proc;
			this.started = proc.started.then(() => {});
			// An adopted omp has said its ready frame and negotiated its protocol with the server that started it.
			if (via.kind === "adopt")
				void this.started.then(
					() => this.resolveReady(),
					() => {},
				);
		}
		this.started.catch(() => {});
		// Nobody awaits the readers: one that fails is logged, never an unhandled rejection that ends the server.
		const reading = (what: string) => (e: unknown) =>
			console.error(`omp-webui: reading omp's ${what} stopped: ${e instanceof Error ? e.message : String(e)}`);
		void this.readStdout().catch(reading("output"));
		const stderrDone = this.readStderr().catch(reading("error output"));
		void this.proc.exited.then(async (code) => {
			// Let the stderr reader drain so the error can say why omp stopped.
			await Promise.race([stderrDone, Bun.sleep(250)]);
			this.exited = true;
			// A process ended by a signal has no exit code (what `exited` resolves to for it is made up).
			const signal = typeof this.proc.signalCode === "string" ? this.proc.signalCode : null;
			const reason = code === 0 ? "" : summarizeStderr(this.stderrBuf);
			const err = new RpcError(
				`omp exited (${signal ? `killed by ${signal}` : `code ${code}`})${reason ? `: ${reason}` : ""}`,
				"exit",
			);
			for (const p of this.pending.values()) p.reject(err);
			this.pending.clear();
			this.rejectReady(err);
			opts.onExit(signal ? null : code, this.stderrBuf, signal);
		});
	}

	/** omp's process id; null while a relay is still starting it. */
	get pid(): number | null {
		return this.proc.pid;
	}

	/** The relay this client talks through, if it has one. */
	get relay(): { pid: number | null; socket: string } | null {
		return this.proc instanceof RelayProc ? { pid: this.proc.relayPid, socket: this.proc.socketPath } : null;
	}

	/** Keep omp running if the server goes away (a paused conversation), or let it end with the server again. Relays only. */
	hold(on: boolean): void {
		if (this.proc instanceof RelayProc) this.proc.hold(on);
	}

	/** Let go of the relay and leave omp running: this client is finished, and omp's end is not reported. */
	detach(): void {
		this.closing = true;
		if (this.proc instanceof RelayProc) this.proc.detach();
	}

	get isExited(): boolean {
		return this.exited;
	}

	/** The process has not exited yet (unlike `isExited`, true right up to the exit itself). */
	get running(): boolean {
		return this.proc.exitCode === null && this.proc.signalCode === null;
	}

	/** Resolves once the omp process has exited. */
	get whenExited(): Promise<unknown> {
		return this.proc.exited;
	}

	get stderr(): string {
		return this.stderrBuf;
	}

	private write(obj: unknown): void {
		if (this.exited) throw new RpcError("omp process has exited", "write");
		if (this.stdinError) throw this.stdinError;
		try {
			this.watch(this.proc.stdin.write(`${JSON.stringify(obj)}\n`));
			this.watch(this.proc.stdin.flush());
		} catch (e) {
			throw this.stdinFailed(e);
		}
	}

	/**
	 * A write that does not fit the pipe at once (a large image prompt) completes later, and Bun reports its
	 * failure — EPIPE when omp died meanwhile — as a rejected Promise. Left unhandled it would end this process.
	 */
	private watch(result: unknown): void {
		if (!(result instanceof Promise)) return;
		result.catch((e: unknown) => {
			this.stdinFailed(e);
		});
	}

	/** Nothing more can be sent: fail everything waiting on omp now (its exit follows) and refuse new work. */
	private stdinFailed(cause: unknown): RpcError {
		if (this.stdinError) return this.stdinError;
		const error = new RpcError(
			`Could not write to omp: ${cause instanceof Error ? cause.message : String(cause)}`,
			"write",
		);
		this.stdinError = error;
		for (const p of this.pending.values()) p.reject(error);
		this.pending.clear();
		return error;
	}

	/**
	 * Send a command and resolve with its correlated response (success or failure). `onWritten` runs once the command is
	 * handed to omp's stdin, before omp has answered (and never when it could not be written). `onAnswered` runs with the
	 * answer when it is read, before the next line of omp's output is handled: an answer says what was so when omp gave it,
	 * and the frames that follow it say what became of that, so a state an answer describes must be taken in at its place
	 * among them. A continuation of the returned Promise runs after every line read in the same chunk, and an answer taken
	 * in there would be laid over the news of the frames that follow it.
	 */
	request(
		command: Record<string, unknown>,
		timeoutMs = 0,
		onWritten?: () => void,
		onAnswered?: (answer: RpcResponse) => void,
	): Promise<RpcResponse> {
		const id = `${this.idPrefix}${++this.seq}`;
		const type = String(command.type);
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		const timer =
			timeoutMs > 0
				? setTimeout(() => {
						this.pending.delete(id);
						reject(new RpcError(`${type} timed out after ${timeoutMs}ms`, type, "timeout"));
					}, timeoutMs)
				: undefined;
		this.pending.set(id, {
			command: type,
			resolve: (r) => {
				clearTimeout(timer);
				// A handler that throws must not leave the request waiting: the line is logged, and the caller still gets its answer.
				try {
					onAnswered?.(r);
				} finally {
					resolve(r);
				}
			},
			reject: (e) => {
				clearTimeout(timer);
				reject(e);
			},
		});
		try {
			this.write({ ...command, id });
		} catch (e) {
			this.pending.delete(id);
			clearTimeout(timer);
			reject(e as Error);
			return promise;
		}
		onWritten?.();
		return promise;
	}

	/** Like request() but throws on `success: false`. */
	async call<T = unknown>(command: Record<string, unknown>, timeoutMs = 0): Promise<T> {
		const r = await this.request(command, timeoutMs);
		if (!r.success) throw new RpcError(r.error ?? "unknown error", r.command, r.code);
		return r.data as T;
	}

	/** Fire-and-forget inbound frame (extension_ui_response etc.). */
	send(frame: Record<string, unknown>): void {
		this.write(frame);
	}

	/** Close stdin; omp drains and exits with code 0. */
	close(): void {
		this.closing = true;
		if (this.exited) return;
		try {
			this.watch(this.proc.stdin.end());
		} catch {
			// already closed
		}
	}

	/**
	 * Send `signal` to omp's process group: omp and the helpers (MCP servers, …) that share it. The tool
	 * processes omp starts for a `!command` are sessions of their own; see `LivePool.shutdown`.
	 */
	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		const pid = this.proc.pid;
		// A relay still starting omp: it ends omp itself.
		if (pid === null) {
			this.proc.kill(signal);
			return;
		}
		try {
			process.kill(-pid, signal);
		} catch {
			// No such group (omp is gone): the process itself, if it is still there.
			this.proc.kill(signal);
		}
	}

	private async readStderr(): Promise<void> {
		const dec = new TextDecoder();
		for await (const chunk of this.proc.stderr) {
			this.stderrBuf += dec.decode(chunk, { stream: true });
			if (this.stderrBuf.length > MAX_STDERR) this.stderrBuf = this.stderrBuf.slice(-MAX_STDERR);
		}
	}

	private async readStdout(): Promise<void> {
		const dec = new TextDecoder();
		let buf = "";
		for await (const chunk of this.proc.stdout) {
			buf += dec.decode(chunk, { stream: true });
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.trim()) this.handleLineSafely(line);
				nl = buf.indexOf("\n");
			}
		}
	}

	/**
	 * One frame is not the whole conversation: what throws while it is handled (a handler of the server's, a frame of a
	 * shape nobody expected) is logged, and the lines after it are still read. This reader is not awaited by anyone, so a
	 * throw would be an unhandled rejection, which ends the server and with it every conversation (#315).
	 */
	private handleLineSafely(line: string): void {
		try {
			this.handleLine(line);
		} catch (e) {
			console.error(
				`omp-webui: a line of omp's output could not be handled: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	private handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		// JSON that is no frame (`null`, a number, text, a list) is no more than a line that is not JSON.
		if (!isFrame(parsed)) return;
		const frame = parsed;
		if (frame.type === "rpc_chunk") {
			const whole = this.acceptChunk(frame);
			if (whole) this.dispatch(whole);
			return;
		}
		if (this.chunk) {
			// An interleaved frame interrupts a chunk sequence: protocol violation, drop it.
			this.chunk = null;
		}
		this.dispatch(frame);
	}

	private acceptChunk(f: OmpFrame): OmpFrame | null {
		const chunkId = String(f.chunkId);
		const index = Number(f.index);
		const count = Number(f.count);
		const byteLength = Number(f.byteLength);
		const data = Buffer.from(String(f.data ?? ""), "base64");
		if (index === 0) {
			if (!(count > 0) || byteLength > this.maxReassembled) {
				this.chunk = null;
				return null;
			}
			this.chunk = {
				chunkId,
				count,
				byteLength,
				bytes: 0,
				texts: [],
				decoder: new TextDecoder("utf-8", { fatal: true }),
			};
		}
		const c = this.chunk;
		if (!c || c.chunkId !== chunkId || c.texts.length !== index || c.count !== count) {
			this.chunk = null;
			return null;
		}
		// Each chunk is decoded as it arrives (a character cut by the chunk's end waits in the decoder for the next one), so
		// a very large answer costs a little at every chunk and nothing at the end, when it is complete.
		try {
			c.texts.push(c.decoder.decode(data, { stream: true }));
			c.bytes += data.byteLength;
			if (c.texts.length < c.count) return null;
			this.chunk = null;
			const rest = c.decoder.decode();
			if (rest) c.texts[c.texts.length - 1] += rest;
			if (c.bytes !== c.byteLength) return null;
			const split = splitResponse(c.texts);
			return split ? lazyResponse(split.head, split.data) : JSON.parse(c.texts.join(""));
		} catch {
			this.chunk = null;
			return null;
		}
	}

	private dispatch(frame: OmpFrame): void {
		if (frame.type === "ready") {
			const maxR = Number(frame.maxReassembledFrameBytes);
			if (maxR > 0) this.maxReassembled = maxR;
			const versions = Array.isArray(frame.supportedProtocolVersions) ? frame.supportedProtocolVersions : [];
			if (versions.includes(2)) {
				this.request({ type: "negotiate_protocol", protocolVersion: 2 }).then(
					() => this.resolveReady(),
					(e) => this.rejectReady(e),
				);
			} else {
				this.resolveReady();
			}
			this.opts.onFrame(frame);
			return;
		}
		if (frame.type === "response" && typeof frame.id === "string") {
			const p = this.pending.get(frame.id);
			if (p) {
				this.pending.delete(frame.id);
				p.resolve(frame as unknown as RpcResponse);
				return;
			}
		}
		this.opts.onFrame(frame);
	}
}
