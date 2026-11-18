import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { childEnv } from "../env.ts";
import { run } from "../omp/run.ts";
import { platform } from "../platform/index.ts";

/**
 * The `llama-server` that embeds text for semantic search: started when something needs it (indexing, a search), and
 * stopped once nothing has for `idleMs`, so that the model takes no memory while the feature is not in use.
 *
 * It listens on a loopback port of its own, behind a key made for this run: llama.cpp's server answers any origin, and the
 * key keeps another program on this computer (or a web page in a browser here) from using it. Its environment has no
 * `LLAMA_ARG_*` settings of the person's: what it runs with is decided here.
 *
 * A server that crashes leaves no `llama-server` behind for long: its pid and identity are in `runtime.pid`, and the next
 * start ends a process that is still that one (`reapOrphan`).
 */

export interface Endpoint {
	url: string;
	key: string;
}

export class RuntimeError extends Error {}

export interface RuntimeOptions {
	server: string;
	model: string;
	/** Where `runtime.pid` is kept. */
	dir: string;
	/** How long after its last use the process is stopped. */
	idleMs?: number;
	/** How long the model may take to load before the start is given up on. */
	startMs?: number;
	/** Told when the process ended by itself (not stopped here), with the last lines it printed. */
	onCrash?: (detail: string) => void;
}

/**
 * Stopped this long after it was last used, its memory given back: it starts again in well under a second on Apple
 * silicon (the model file stays in the system's cache), so it is not kept loaded for a search that may not come.
 */
const IDLE_MS = 60_000;
const START_MS = 120_000;
/** What is kept of what the server printed, for a start that failed. */
const LOG_KEEP = 16 * 1024;

/**
 * The arguments it runs with: embeddings only, every layer on the GPU when there is one (llama.cpp puts what does not fit,
 * or everything on a computer without one, on the processor), four slots of 2048 tokens each (a passage of 1000 characters
 * is at most about 1100), and no prompt cache (a cache is for chat, and would hold gigabytes for nothing). Measured on an
 * Apple M4 Pro, 2048-token batches embed as fast as 4096-token ones and take about 60 MB less while working.
 */
export function serverArgs(model: string, port: number, keyFile: string): string[] {
	return [
		"-m",
		model,
		"--embeddings",
		"--host",
		"127.0.0.1",
		"--port",
		String(port),
		// From a file only this user can read: a key on the command line is in every process listing.
		"--api-key-file",
		keyFile,
		"-ngl",
		"999",
		"-c",
		"8192",
		"-np",
		"4",
		"-b",
		"2048",
		"-ub",
		"2048",
		"--cache-ram",
		"0",
	];
}

/** A loopback port nobody listens on now. */
async function freePort(): Promise<number> {
	const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const { port } = probe;
	probe.stop(true);
	return port;
}

export class Runtime {
	private child: ReturnType<typeof Bun.spawn> | null = null;
	private starting: Promise<Endpoint> | null = null;
	private endpoint: Endpoint | null = null;
	private holds = 0;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private log = "";
	/** The process `stop` last ended, until it is gone. */
	private ending: Promise<void> = Promise.resolve();
	private readonly idleMs: number;
	private readonly startMs: number;

	constructor(private readonly opts: RuntimeOptions) {
		this.idleMs = opts.idleMs ?? IDLE_MS;
		this.startMs = opts.startMs ?? START_MS;
	}

	/** The server's address, started first if it is not running; the idle clock starts over. */
	async ensure(): Promise<Endpoint> {
		this.rearm();
		if (this.endpoint) return this.endpoint;
		this.starting ??= this.start().finally(() => {
			this.starting = null;
		});
		const endpoint = await this.starting;
		this.rearm();
		return endpoint;
	}

	/** Keep the server running while `on` (indexing): it is not stopped for being idle until every hold is let go. */
	hold(on: boolean): void {
		this.holds = Math.max(0, this.holds + (on ? 1 : -1));
		this.rearm();
	}

	get running(): boolean {
		return this.child !== null;
	}

	private rearm(): void {
		clearTimeout(this.idleTimer);
		if (this.holds > 0 || !this.child) return;
		this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
		this.idleTimer.unref?.();
	}

	private async start(): Promise<Endpoint> {
		const port = await freePort();
		const key = randomUUID();
		const keyFile = join(this.opts.dir, "runtime.key");
		rmSync(keyFile, { force: true });
		writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
		const env = childEnv();
		for (const name of Object.keys(env)) if (name.startsWith("LLAMA_ARG_")) delete env[name];
		this.log = "";
		const child = Bun.spawn([this.opts.server, ...serverArgs(this.opts.model, port, keyFile)], {
			cwd: dirname(this.opts.server),
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			...platform.proc.groupSpawn,
		});
		this.child = child;
		const keep = async (stream: ReadableStream<Uint8Array>) => {
			const decoder = new TextDecoder();
			for await (const chunk of stream)
				this.log = (this.log + decoder.decode(chunk, { stream: true })).slice(-LOG_KEEP);
		};
		void keep(child.stdout as ReadableStream<Uint8Array>).catch(() => {});
		void keep(child.stderr as ReadableStream<Uint8Array>).catch(() => {});
		const identity = await platform.proc.identity(child.pid).catch(() => null);
		writeFileSync(join(this.opts.dir, "runtime.pid"), JSON.stringify({ pid: child.pid, identity }));
		let exited = false;
		void child.exited.then(() => {
			exited = true;
			if (this.child !== child) return;
			this.child = null;
			this.endpoint = null;
			clearTimeout(this.idleTimer);
			rmSync(join(this.opts.dir, "runtime.pid"), { force: true });
			this.opts.onCrash?.(this.lastLines());
		});
		const url = `http://127.0.0.1:${port}`;
		const began = Date.now();
		while (Date.now() - began < this.startMs) {
			if (exited) throw new RuntimeError(`llama-server stopped: ${this.lastLines()}`);
			const ok = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })
				.then((r) => r.ok)
				.catch(() => false);
			if (ok) {
				this.endpoint = { url, key };
				return this.endpoint;
			}
			await Bun.sleep(200);
		}
		this.stop();
		throw new RuntimeError(
			`llama-server did not start within ${Math.round(this.startMs / 1000)} s: ${this.lastLines()}`,
		);
	}

	/** The last lines it printed, for the page and the log. */
	lastLines(): string {
		return this.log.trim().split("\n").slice(-3).join(" | ").slice(0, 500);
	}

	/** Stop the server now (it starts again when something needs it). */
	stop(): void {
		clearTimeout(this.idleTimer);
		const child = this.child;
		this.child = null;
		this.endpoint = null;
		if (!child) return;
		rmSync(join(this.opts.dir, "runtime.pid"), { force: true });
		platform.proc.signalChild(child, "SIGTERM");
		const kill = setTimeout(() => platform.proc.signalChild(child, "SIGKILL"), 3000);
		kill.unref?.();
		this.ending = child.exited.then(() => clearTimeout(kill));
	}

	/** Resolves once the process `stop` ended is gone (its files can be deleted then, on Windows too). */
	async stopped(): Promise<void> {
		await this.ending;
	}
}

/**
 * The `llama-server` an earlier run of this server left (it crashed, or was killed): ended, if the process with that pid is
 * still the one it started (its identity is the same: pids are reused).
 */
export async function reapOrphan(dir: string): Promise<void> {
	const file = join(dir, "runtime.pid");
	let saved: { pid?: unknown; identity?: unknown };
	try {
		saved = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return;
	}
	rmSync(file, { force: true });
	if (typeof saved.pid !== "number" || typeof saved.identity !== "string") return;
	const now = await platform.proc.identity(saved.pid).catch(() => null);
	if (now !== saved.identity) return;
	try {
		platform.proc.signal(saved.pid, "SIGKILL");
	} catch {
		// gone meanwhile
	}
}

/**
 * The device llama.cpp would run the model on (`llama-server --list-devices`): the first that is not the processor's (Metal's
 * `MTL0: Apple M4 Pro`, a Vulkan GPU's). Null when it lists none: the model runs on the processor. Undefined when it could
 * not be asked.
 */
export async function gpuDevice(server: string): Promise<string | null | undefined> {
	const env = childEnv();
	for (const name of Object.keys(env)) if (name.startsWith("LLAMA_ARG_")) delete env[name];
	const out = await run([server, "--list-devices"], { timeoutMs: 30_000, cwd: dirname(server), base: env }).catch(
		() => null,
	);
	if (out?.code !== 0) return undefined;
	return gpuOf(`${out.stdout}\n${out.stderr}`);
}

/** `gpuDevice`'s reading of the list: lines `  NAME: description (N MiB, M MiB free)`. */
export function gpuOf(listing: string): string | null {
	for (const line of listing.split("\n")) {
		const m = /^\s+([A-Za-z][\w-]*):\s+(.+?)\s+\(\d+ MiB/.exec(line);
		if (!m) continue;
		const name = m[1] as string;
		if (/^(BLAS|CPU|RPC)/i.test(name)) continue;
		return (m[2] as string).trim();
	}
	return null;
}
