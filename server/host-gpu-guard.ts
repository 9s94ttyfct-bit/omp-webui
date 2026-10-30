import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GpuReading } from "./host-gpu.ts";
import type { GpuReply, GpuRequest } from "./host-gpu-protocol.ts";

/** Where the probe's crash marker is, in the data directory. */
export const GPU_MARKER = "host-gpu-probe";

/** The failures worth one line in the log: each is told when it starts, and again only after a good read in between. */
export function failureLog() {
	const told = new Set<string>();
	return {
		failed(what: string, error: unknown): void {
			if (told.has(what)) return;
			told.add(what);
			console.warn(`omp-webui: host load: ${what}: ${(error as Error).message ?? error}`);
		},
		recovered: (what: string): void => void told.delete(what),
	};
}

export interface GpuOptions {
	/** False: the probe is never started (`OMP_WEBUI_HOST_GPU=0`). Default true. */
	enabled?: boolean;
	/** Start it although the last start did not get through its first read (`OMP_WEBUI_HOST_GPU=1`). */
	retry?: boolean;
	/** The directory the crash marker is kept in; none: no marker (a test). */
	markerDir?: string;
	/** How long a read may take before the thread is given up on. Default 2 s. */
	timeoutMs?: number;
	/** How long the first read may take: it starts the thread and opens IOKit in it. Default 5 s. */
	startMs?: number;
	/** What starts the thread; the one that looks at IOKit (`host-gpu-worker.ts`) unless a test says. */
	spawn?: () => Worker;
}

export interface GuardedGpu {
	/** Every accelerator that reports a utilisation; null when there is none, the GPU is left out, or this look failed. */
	read(): Promise<GpuReading[] | null>;
	/** Stop the thread. */
	close(): void;
}

const spawnProbe = (): Worker => new Worker(new URL("./host-gpu-worker.ts", import.meta.url));

/**
 * The GPU's reading, isolated from the rest of a look. IOKit is asked in a thread of its own, started on the first read (not
 * when the server is loaded, nor unless a read is wanted), and each read is awaited with a deadline:
 *
 * - A probe that throws is told once and gives null for that look; CPU and memory are recorded all the same.
 * - A thread that does not answer in time, throws out of its own code, or ends is stopped and given up on for the run: nothing
 *   is asked of it again, it is told once, and the next start leaves the GPU out too (the marker below). A thread blocked in
 *   the driver may stay blocked; it holds nothing the server needs, and it does not keep the server alive.
 * - A native fault ends the whole process and is no exception, so a marker file in the data directory says `probing` before
 *   the thread is started and `ok` once its first read has come back (with readings or without), and is set to `probing` again
 *   when the thread is given up on. A start that finds `probing` knows the last one did not get through, says so once, and
 *   leaves the GPU out; `retry` (`OMP_WEBUI_HOST_GPU=1`) tries it again. A marker that cannot be written is no marker: the
 *   thread is not started without one. A fault after the first read is not remembered: the marker says `ok`.
 */
export function guardedGpu(options: GpuOptions = {}): GuardedGpu {
	const marker = options.markerDir === undefined ? null : join(options.markerDir, GPU_MARKER);
	const readMs = options.timeoutMs ?? 2000;
	const startMs = options.startMs ?? 5000;
	const spawn = options.spawn ?? spawnProbe;
	// Its own log: told once per reader, not once per process (a test makes many).
	const log = failureLog();
	/** idle: not started; running: asked; off: left out for the run (turned off, none here, given up on, a crashed start). */
	let state: "idle" | "running" | "off" = "idle";
	/** `state` read afresh: it changes while a read waits, which the compiler's narrowing does not see. */
	const isOff = (): boolean => state === "off";
	let worker: Worker | null = null;
	let verified = false;
	let seq = 0;
	const waiting = new Map<number, (outcome: GpuReply | Error) => void>();

	// The data dir keeps only private files (0600): `mode` applies when the file is made, `chmodSync` to one an older build left.
	const mark = (what: "probing" | "ok"): void => {
		if (marker === null) return;
		writeFileSync(marker, `${what}\n`, { mode: 0o600 });
		chmodSync(marker, 0o600);
	};
	const crashed = (): boolean => {
		if (marker === null || options.retry) return false;
		try {
			return readFileSync(marker, "utf8").trim() === "probing";
		} catch {
			return false;
		}
	};
	const stop = (): void => {
		const w = worker;
		worker = null;
		state = "off";
		w?.terminate();
		for (const answer of waiting.values()) answer(new Error("the GPU thread was stopped"));
		waiting.clear();
	};
	/** Give the thread up for the run and for the next start. */
	const giveUp = (why: string): void => {
		if (state === "off") return;
		stop();
		try {
			mark("probing");
		} catch {
			// The marker is only what the next start reads; the run is already without the GPU.
		}
		log.failed(
			"gpu",
			new Error(
				`the GPU is left out for the rest of this run and at the next start (${why}; OMP_WEBUI_HOST_GPU=1 tries it again)`,
			),
		);
	};
	const settle = (): void => {
		verified = true;
		try {
			mark("ok");
		} catch {
			// The probe works; a marker that cannot be written only means a crash at the next start would not be remembered.
		}
	};
	const start = (): boolean => {
		if (crashed()) {
			state = "off";
			console.warn(
				"omp-webui: host load: the GPU is left out: the last start did not get through its first look at it (OMP_WEBUI_HOST_GPU=1 tries it again, 0 leaves it out)",
			);
			return false;
		}
		try {
			mark("probing");
		} catch (e) {
			state = "off";
			log.failed("gpu marker", e);
			return false;
		}
		try {
			const w = spawn();
			// A thread stuck in the driver must not keep the server from ending.
			(w as Worker & { unref?: () => void }).unref?.();
			w.onmessage = (event: MessageEvent<GpuReply>) => waiting.get(event.data.id)?.(event.data);
			w.onerror = (event: ErrorEvent) => {
				event.preventDefault?.();
				giveUp(`its thread failed: ${event.message}`);
			};
			w.addEventListener("close", () => giveUp("its thread ended"));
			worker = w;
			state = "running";
			return true;
		} catch (e) {
			giveUp(`its thread could not start: ${(e as Error).message}`);
			return false;
		}
	};

	return {
		async read() {
			if (state === "off" || options.enabled === false) return null;
			if (state === "idle" && !start()) return null;
			const w = worker;
			if (w === null) return null;
			const id = ++seq;
			const ms = verified ? readMs : startMs;
			const { promise, resolve } = Promise.withResolvers<GpuReply | Error | "late">();
			const timer = setTimeout(() => resolve("late"), ms);
			timer.unref();
			waiting.set(id, resolve);
			try {
				w.postMessage({ id } satisfies GpuRequest);
			} catch (e) {
				resolve(e as Error);
			}
			const outcome = await promise;
			clearTimeout(timer);
			waiting.delete(id);
			// Given up on while this read was waiting (the thread failed or ended): nothing more to say of it.
			if (isOff()) return null;
			if (outcome === "late") {
				giveUp(`no answer in ${ms} ms`);
				return null;
			}
			if (outcome instanceof Error) {
				giveUp(outcome.message);
				return null;
			}
			settle();
			if (!outcome.ok) {
				// An exception is no crash: the thread is here to say so. The next look asks again.
				log.failed("gpu", new Error(outcome.error));
				return null;
			}
			log.recovered("gpu");
			if (outcome.gpus === null) {
				// No probe on this computer: nothing to ask again, and no thread to keep.
				stop();
				return null;
			}
			return outcome.gpus.length > 0 ? outcome.gpus : null;
		},
		close: stop,
	};
}
