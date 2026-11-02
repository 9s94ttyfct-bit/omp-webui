import { type CdpMessage, type CdpTransport, TransportListeners } from "./transport.ts";

/**
 * The Chrome for Testing engine: headless Chrome the server starts itself, spoken to over `--remote-debugging-pipe`
 * (Chrome reads calls from its fd 3 and writes answers and events to its fd 4, each message JSON ended by a NUL), so it
 * never opens a debugging port anyone else could reach.
 *
 * Bun hands the parent's ends of fds 3 and 4 over as non-blocking descriptors: they are read and written through
 * `Bun.file(fd)` (a stream and a sink that wait for the pipe), never node:fs streams, which fail on them with EAGAIN.
 */

/** The CfT engine's transport: also the process it talks to. */
export interface CftTransport extends CdpTransport {
	readonly pid: number;
	/** Settles with the exit code once the process has exited. */
	readonly exited: Promise<number>;
}

/** How long Chrome has to leave after SIGTERM before it is killed. */
const QUIT_MS = 3000;

/** The id of the server's own first call, whose answer says Chrome runs (never delivered to the engine). */
const PROBE_ID = 2 ** 31 - 1;
/** How long the first answer is waited for before Chrome is taken to run all the same. */
const PROBE_MS = 15_000;

interface CftOptions {
	executable: string;
	profileDir: string;
	signal?: AbortSignal;
	/** The system it runs on (tests stand in for Linux). */
	platform?: NodeJS.Platform;
}

/**
 * Chrome for Testing, started. On Linux its sandbox needs unprivileged user namespaces (CfT ships no setuid helper), which
 * a system may refuse: Ubuntu 23.10 and later restrict them with AppArmor, and so do many containers and CI runners.
 * Chrome then aborts at once ("No usable sandbox!"); it is started again without the sandbox, and the server says so.
 * Everywhere else, and wherever the sandbox works, it is kept.
 */
export async function startCft(opts: CftOptions): Promise<CftTransport> {
	const first = launch(opts, []);
	if ((opts.platform ?? process.platform) !== "linux") return first.transport;
	if (await first.runs()) return first.transport;
	if (!first.sandboxRefused() || opts.signal?.aborted) return first.transport;
	console.warn(
		"omp-webui: Chrome for Testing has no usable sandbox on this system (unprivileged user namespaces are off); it runs without one",
	);
	return launch(opts, ["--no-sandbox"]).transport;
}

function launch(
	opts: CftOptions,
	extra: string[],
): { transport: CftTransport; runs(): Promise<boolean>; sandboxRefused(): boolean } {
	const proc = Bun.spawn(
		[
			opts.executable,
			"--headless=new",
			"--remote-debugging-pipe",
			`--user-data-dir=${opts.profileDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-networking",
			// Never the macOS keychain ("Chromium Safe Storage") or a Linux secret store: CfT is a fresh unsigned binary at
			// each version, so the keychain would ask the person for their login password on every start. The profile's
			// cookies are kept by the data folder's own permissions instead, as Playwright and Puppeteer run Chrome.
			"--use-mock-keychain",
			"--password-store=basic",
			...extra,
		],
		{ stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
	);
	const sink = Bun.file(proc.stdio[3] as unknown as number).writer();
	const listeners = new TransportListeners();
	let probed = null as ((runs: boolean) => void) | null;

	// What Chrome said on stderr last, for the reason given when it exits on its own; and whether it found no sandbox.
	let lastErr = "";
	let noSandbox = false;
	const stderrRead = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
			const text = decoder.decode(chunk, { stream: true });
			if (text.includes("No usable sandbox")) noSandbox = true;
			lastErr = (lastErr + text).slice(-2000);
		}
	})().catch(() => {});
	void (async () => {
		const decoder = new TextDecoder();
		let buffered = "";
		for await (const chunk of Bun.file(proc.stdio[4] as unknown as number).stream()) {
			buffered += decoder.decode(chunk, { stream: true });
			for (let end = buffered.indexOf("\0"); end !== -1; end = buffered.indexOf("\0")) {
				const text = buffered.slice(0, end);
				buffered = buffered.slice(end + 1);
				let message: CdpMessage;
				try {
					message = JSON.parse(text) as CdpMessage;
				} catch {
					continue;
				}
				if (message.id === PROBE_ID) {
					probed?.(true);
					continue;
				}
				listeners.deliver(message);
			}
		}
	})().catch((e) => close(`The pipe from Chrome for Testing broke: ${e instanceof Error ? e.message : String(e)}`));

	const exited = proc.exited.then((code) => {
		const line = lastErr.trim().split("\n").pop()?.trim();
		listeners.end(`Chrome for Testing exited (code ${code}${line ? `: ${line}` : ""})`);
		void Promise.resolve(sink.end()).catch(() => {});
		return code;
	});

	const close = (why: string) => {
		if (listeners.ended !== null) return;
		listeners.end(why);
		void Promise.resolve(sink.end()).catch(() => {});
		proc.kill("SIGTERM");
		const hard = setTimeout(() => proc.kill("SIGKILL"), QUIT_MS);
		void proc.exited.then(() => clearTimeout(hard));
	};
	if (opts.signal?.aborted) close("stopped");
	else opts.signal?.addEventListener("abort", () => close("stopped"), { once: true });

	const transport: CftTransport = {
		pid: proc.pid,
		exited,
		send(message: object) {
			if (listeners.ended !== null) return;
			sink.write(`${JSON.stringify(message)}\0`);
			void Promise.resolve(sink.flush()).catch(() => {});
		},
		onMessage: (fn) => listeners.onMessage(fn),
		onClose: (fn) => listeners.onClose(fn),
		close: () => close("closed"),
	};
	return {
		transport,
		// Whether Chrome answers a first call (false: it exited first), what it said on stderr read to its end.
		runs: async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const answered = await new Promise<boolean>((resolve) => {
				probed = resolve;
				timer = setTimeout(() => resolve(true), PROBE_MS);
				void proc.exited.then(() => resolve(false));
				transport.send({ id: PROBE_ID, method: "Browser.getVersion" });
			});
			clearTimeout(timer);
			probed = null;
			if (!answered) await stderrRead;
			return answered;
		},
		sandboxRefused: () => noSandbox,
	};
}
