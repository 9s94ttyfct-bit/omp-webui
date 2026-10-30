import { childEnv } from "../env.ts";

/**
 * Commands the server runs to ask omp something (`omp config get`, `omp stats`, `omp --version`, `omp --export`): each has
 * a time limit. An omp that stops answering (a lock, a keychain prompt, a network file system, a corrupt config) must
 * hang the one feature that asked and nothing else: no start-up that never ends, no omp process piling up per request, no
 * single-flight stuck for good (#319).
 */

/** A start-up of omp or a read of its settings: `omp --version` and `omp config get` answer in well under a second. */
export const QUICK_MS = 20_000;

/** How long a listing of processes may take: `ps` answers in tens of milliseconds, even with a thousand processes. */
export const PS_MS = 10_000;

/** A command that did not finish within its limit; it has been killed. */
export class RunTimeout extends Error {}

export interface Ran {
	code: number;
	stdout: string;
	stderr: string;
	/** `maxBytes` was reached: the command was killed, and `stdout` is what it had printed up to the limit. */
	truncated?: true;
}

export interface RunOptions {
	timeoutMs: number;
	cwd?: string;
	/** What the command's environment adds to its base (minus its `OMP_WEBUI_*` settings, see `childEnv`). */
	env?: Record<string, string | undefined>;
	/** The environment the command starts from, where that is not the server's own (the login shell's, a tool's own). */
	base?: Record<string, string | undefined>;
	/**
	 * The most the command may print to stdout. A command that prints more is killed (with what it started) and answers with
	 * what it had printed up to the limit and `truncated`; its stderr is kept to `CAPPED_STDERR_BYTES` (the rest is read and
	 * dropped). Without it the output is read whole.
	 */
	maxBytes?: number;
}

/** What a command with a `maxBytes` limit keeps of its stderr. */
const CAPPED_STDERR_BYTES = 64 * 1024;

/** The command's whole process group is ended: what it started would otherwise keep its pipes open, and outlive it. */
function killGroup(proc: Bun.Subprocess): void {
	try {
		process.kill(-proc.pid, "SIGKILL");
	} catch {
		proc.kill("SIGKILL");
	}
}

/**
 * Up to `max` bytes of `stream` as text. Past the limit `onOver` ends the command and the read stops; without one the rest
 * is read and dropped, so that a command that prints a lot to its stderr is not left waiting for a pipe nobody empties.
 */
async function readCapped(
	stream: ReadableStream<Uint8Array>,
	max: number,
	onOver?: () => void,
): Promise<{ text: string; truncated: boolean }> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const room = max - size;
		if (value.byteLength <= room) {
			chunks.push(value);
			size += value.byteLength;
			continue;
		}
		if (room > 0) chunks.push(value.subarray(0, room));
		size = max;
		truncated = true;
		if (onOver) {
			onOver();
			await reader.cancel().catch(() => {});
			break;
		}
	}
	let text = new TextDecoder().decode(Buffer.concat(chunks));
	// A character cut by the limit decodes as the replacement character: it is not the command's.
	if (truncated && text.endsWith("\uFFFD")) text = text.slice(0, -1);
	return { text, truncated };
}

/**
 * Run `argv` with no input and read what it prints. A command that takes longer than `timeoutMs` is killed (with what it
 * started) and the promise rejects with a `RunTimeout`; a command that cannot be started rejects with the system's error.
 * The answer does not wait for the pipes after a kill: a child's own children may hold them open.
 */
export async function run(argv: string[], opts: RunOptions): Promise<Ran> {
	const proc = Bun.spawn(argv, {
		cwd: opts.cwd,
		env: childEnv(opts.env, opts.base),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		// A process group of its own: the kill reaches what the command started.
		detached: true,
	});
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			killGroup(proc);
			reject(
				new RunTimeout(
					`${argv.slice(1, 3).join(" ") || argv[0]} gave no answer within ${Math.round(opts.timeoutMs / 1000)} s`,
				),
			);
		}, opts.timeoutMs);
	});
	const finished =
		opts.maxBytes === undefined
			? Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
					([stdout, stderr, code]): Ran => ({ code, stdout, stderr }),
				)
			: Promise.all([
					readCapped(proc.stdout, opts.maxBytes, () => killGroup(proc)),
					readCapped(proc.stderr, CAPPED_STDERR_BYTES),
					proc.exited,
				]).then(
					([out, err, code]): Ran => ({
						code,
						stdout: out.text,
						stderr: err.text,
						...(out.truncated ? { truncated: true as const } : {}),
					}),
				);
	// After a timeout nobody reads what the pipes end with.
	finished.catch(() => {});
	try {
		return await Promise.race([finished, expired]);
	} finally {
		clearTimeout(timer);
	}
}

/** `work`, or a rejection with `RunTimeout` after `ms` (the timer is cleared when `work` settles). */
export async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new RunTimeout(what)), ms);
	});
	try {
		return await Promise.race([work, expired]);
	} finally {
		clearTimeout(timer);
	}
}
