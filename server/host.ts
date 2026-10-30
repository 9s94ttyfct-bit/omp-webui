import { cpus, totalmem } from "node:os";
import type { HostHistory, HostInfo, HostPoint, HostProc } from "../shared/host.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import { type CpuTimes, cpuShare, groupRows, groupUse, type PsRow, tenth } from "./host-parse.ts";
import { type HostReader, systemReader } from "./host-read.ts";
import { HostRing, MinuteBuckets } from "./host-ring.ts";

/**
 * The load of the computer the server runs on (#613), kept as history and told to the pages that watch it.
 *
 * Two paces: every `liveMs` while some page shows the graphs of the load (the sidebar's popover, the Host tab), and every
 * `backgroundMs` for a page that shows only the line of figures (the sidebar's indicator) or nobody at all, so that the history reaches back to when nobody was looking: a look is a `sysctl` and an
 * IOKit read of the GPU (about a millisecond of CPU in all, measured), which at the slow pace is not worth a switch to turn it off. The
 * fine series is the last hour of looks (a ring of fixed size, whatever the pace), the coarse one the last day, a point
 * per finished minute. Both live in memory only: a server that restarts starts the history again.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60_000;
/** The fine ring's size: an hour at 2 s with some to spare (it also bounds a pace set faster by `OMP_WEBUI_HOST_LIVE_MS`). */
const FINE_CAPACITY = 2048;
const COARSE_CAPACITY = DAY_MS / MINUTE_MS;
/** The soonest a look follows the one before it, so that a page that starts watching never makes the CPU share one of a few milliseconds. */
const MIN_GAP_MS = 300;
/** How long after the first look (which only measures from) the first figure is taken. */
const FIRST_LOOK_MS = 1000;
/** A process listing this much older than the pace that is kept is no basis for a CPU share: the machine slept, or the loop was stuck. */
const STALE_FACTOR = 4;

/**
 * The least pace the server keeps whatever `OMP_WEBUI_HOST_*_MS` says: a look is a process to start (and a page that is
 * told of it), and a pace of a millisecond would do that in a loop and fill the ring in seconds.
 */
export const MIN_LIVE_MS = 250;
export const MIN_BACKGROUND_MS = 1000;

/** A pace from a setting: what is not a number (or is zero) is `fallback`, and a number under `floor` is `floor`. */
export function paceFrom(value: string | undefined, fallback: number, floor: number): number {
	const n = Number(value);
	return Number.isFinite(n) && n !== 0 ? Math.max(floor, n) : fallback;
}

/** The processes the server tells apart: omp's (each, with what it started) and the relays that hold omp's pipes. */
export interface HostPids {
	omp: number[];
	relay: number[];
}

export interface HostSamplerOptions {
	liveMs: number;
	backgroundMs: number;
	/** The processes of the conversations; empty when none. */
	pids?: () => HostPids;
	/** What is read; the computer's own unless a test says. */
	reader?: HostReader;
	/** The clock; `Date.now` unless a test says. */
	now?: () => number;
	/** Runs `fn` after `ms` and returns what cancels it; a timer that does not keep the server alive unless a test says. */
	schedule?: (fn: () => void, ms: number) => () => void;
}

interface Watch {
	/**
	 * The page shows the graphs of the load (the sidebar's popover, the Host tab), not only the line of figures: the server
	 * keeps the live pace while one such page watches, and the background pace otherwise.
	 */
	detail: boolean;
	procs: boolean;
	send: (msg: ServerMessage) => void;
}

/** A timer that the server does not stay up for: the history of its own load is no reason to keep it running. */
function unrefTimer(fn: () => void, ms: number): () => void {
	const timer = setTimeout(fn, ms);
	timer.unref();
	return () => clearTimeout(timer);
}

export class HostSampler {
	readonly #liveMs: number;
	readonly #backgroundMs: number;
	readonly #pids: () => HostPids;
	readonly #reader: HostReader;
	readonly #now: () => number;
	readonly #schedule: (fn: () => void, ms: number) => () => void;
	readonly #fine = new HostRing(FINE_CAPACITY);
	readonly #coarse = new HostRing(COARSE_CAPACITY);
	readonly #minute = new MinuteBuckets(MINUTE_MS);
	readonly #watches = new Map<object, Watch>();
	readonly #cores = cpus().length;
	#prev: CpuTimes | null = null;
	#gpu: HostInfo["gpu"] = null;
	#hasPressure = false;
	#cancel: (() => void) | undefined;
	#busy = false;
	#stopped = true;
	#lastAt = 0;
	/** The process listing the last per-process figures were taken from (pid → seconds of CPU), and when. */
	#procsPrev: { at: number; cpu: Map<number, number> } | null = null;
	#serverPrev: { at: number; cpu: number } | null = null;
	#procs: HostProc[] | null = null;

	constructor(opts: HostSamplerOptions) {
		this.#liveMs = opts.liveMs;
		this.#backgroundMs = opts.backgroundMs;
		this.#pids = opts.pids ?? (() => ({ omp: [], relay: [] }));
		this.#reader = opts.reader ?? systemReader();
		this.#now = opts.now ?? Date.now;
		this.#schedule = opts.schedule ?? unrefTimer;
	}

	/** Begin looking: once now, which is only what the first CPU share is measured from, and a second later for the first figure. */
	start(): void {
		if (!this.#stopped) return;
		this.#stopped = false;
		void this.#look();
	}

	stop(): void {
		this.#stopped = true;
		this.#cancel?.();
		this.#cancel = undefined;
		this.#reader.close?.();
	}

	/**
	 * `owner` (a page's socket) shows the load from now on, and is told by `send` at each look; `detail`: it shows the
	 * graphs (the live pace is kept while one does); `procs`: it shows the processes' share too, which costs a process
	 * listing per look. Calling again changes what `owner` asked for.
	 */
	watch(owner: object, watch: Watch): void {
		const first = this.#watches.size === 0;
		const live = this.#liveNow();
		this.#watches.set(owner, watch);
		// The next look comes at the pace that is kept now, counted from the last one: a page that arrives gets figures within
		// a pace, and one that opens the graphs on top of another page's line brings the look that is due forward.
		if (!this.#stopped && (first || (!live && this.#liveNow()))) this.#arm(this.#delay(this.#pace()));
		if (!this.#wantsProcs()) this.#forgetProcs();
	}

	unwatch(owner: object): void {
		this.#watches.delete(owner);
		if (!this.#wantsProcs()) this.#forgetProcs();
	}

	get watchers(): number {
		return this.#watches.size;
	}

	/** Whether the sampler is looking (`start` has been called and `stop` has not). */
	get running(): boolean {
		return !this.#stopped;
	}

	info(): HostInfo {
		return {
			platform: this.#reader.platform,
			cores: this.#cores,
			memTotal: totalmem(),
			gpu: this.#gpu,
			pressure: this.#hasPressure,
			liveMs: this.#liveMs,
			backgroundMs: this.#backgroundMs,
			fineSpanMs: HOUR_MS,
			coarseMs: MINUTE_MS,
			coarseSpanMs: DAY_MS,
		};
	}

	history(): HostHistory {
		const now = this.#now();
		return {
			info: this.info(),
			now,
			fine: this.#fine.series(now - HOUR_MS),
			coarse: this.#coarse.series(now - DAY_MS),
			procs: this.#wantsProcs() ? this.#procs : null,
		};
	}

	#wantsProcs(): boolean {
		for (const w of this.#watches.values()) if (w.procs) return true;
		return false;
	}

	/** Whether a page that shows the graphs watches: the live pace is kept for one, the background pace otherwise. */
	#liveNow(): boolean {
		for (const w of this.#watches.values()) if (w.detail) return true;
		return false;
	}

	/** The pace that is kept now: the live one while a page shows the graphs, the background one otherwise. */
	#pace(): number {
		return this.#liveNow() ? this.#liveMs : this.#backgroundMs;
	}

	/** How long until the next look at `pace`, counted from the last look; never less than `MIN_GAP_MS`. */
	#delay(pace: number): number {
		return Math.max(MIN_GAP_MS, this.#lastAt + pace - this.#now());
	}

	#forgetProcs(): void {
		this.#procs = null;
		this.#procsPrev = null;
		this.#serverPrev = null;
	}

	#arm(ms: number): void {
		if (this.#stopped) return;
		this.#cancel?.();
		this.#cancel = this.#schedule(() => void this.#look(), Math.max(0, ms));
	}

	/** One look, then the next one at the pace that is kept. A look still under way (a command that is slow) is not started again. */
	async #look(): Promise<void> {
		if (this.#busy || this.#stopped) return;
		this.#busy = true;
		const began = this.#now();
		try {
			await this.sample();
		} catch (e) {
			console.warn(`omp-webui: host load: ${(e as Error).message}`);
		} finally {
			this.#busy = false;
			// Nothing recorded yet (the first look only measures from): the first figure is a second away, not a pace.
			const pace = this.#lastAt === 0 ? FIRST_LOOK_MS : this.#pace();
			this.#arm(pace - (this.#now() - began));
		}
	}

	/**
	 * Read the computer once and record it. The very first look has nothing to measure CPU time against and records nothing.
	 * Returns what was recorded.
	 */
	async sample(): Promise<HostPoint | null> {
		const reading = await this.#reader.read();
		const t = this.#now();
		const prev = this.#prev;
		this.#prev = reading.cpu;
		const cpu = prev ? cpuShare(prev, reading.cpu) : null;
		if (cpu === null) return null;
		const gpus = reading.gpus;
		const busiest = gpus?.reduce((a, b) => (b.util > a.util ? b : a));
		if (gpus && busiest) this.#gpu = { name: busiest.name, cores: busiest.cores };
		if (reading.pressure !== null) this.#hasPressure = true;
		const point: HostPoint = {
			t,
			cpu,
			gpu: busiest ? busiest.util : null,
			mem: reading.memUsed !== null && reading.memTotal > 0 ? tenth((reading.memUsed / reading.memTotal) * 100) : null,
			pressure: reading.pressure,
		};
		this.#fine.push(point);
		const minute = this.#minute.add(point);
		if (minute) this.#coarse.push(minute);
		this.#lastAt = t;
		const procs = this.#wantsProcs() ? await this.#measureProcs(t) : null;
		for (const w of this.#watches.values()) {
			w.send({
				t: "host_sample",
				point,
				...(minute ? { minute } : {}),
				...(w.procs && procs ? { procs } : {}),
			});
		}
		return point;
	}

	/**
	 * The processes' share: the server's own from this process's CPU time, omp's and the relays' from one `ps` listing,
	 * measured against the listing before. A listing that fails leaves the figures as they were (and is told once, by the
	 * log, as the reads are).
	 */
	async #measureProcs(at: number): Promise<HostProc[] | null> {
		const stale = (since: number | undefined) => since === undefined || at - since > this.#backgroundMs * STALE_FACTOR;
		const usage = process.cpuUsage();
		const own = (usage.user + usage.system) / 1e6;
		const server: HostProc = {
			id: "server",
			count: 1,
			cpu:
				this.#serverPrev && !stale(this.#serverPrev.at) && at > this.#serverPrev.at
					? tenth(((own - this.#serverPrev.cpu) / ((at - this.#serverPrev.at) / 1000)) * 100)
					: null,
			rss: process.memoryUsage.rss(),
		};
		this.#serverPrev = { at, cpu: own };
		const pids = this.#pids();
		let listing: PsRow[];
		try {
			listing = await this.#reader.processes();
		} catch (e) {
			console.warn(`omp-webui: host load: process listing: ${(e as Error).message}`);
			this.#procs = [server];
			return this.#procs;
		}
		const groups = groupRows(listing, pids);
		const prev = this.#procsPrev && !stale(this.#procsPrev.at) ? this.#procsPrev : null;
		const seconds = prev ? (at - prev.at) / 1000 : 0;
		const procs: HostProc[] = [server];
		for (const id of ["omp", "relay"] as const) {
			const rows = groups[id];
			if (pids[id].length === 0) continue;
			procs.push({ id, count: pids[id].length, ...groupUse(prev?.cpu ?? null, rows, seconds) });
		}
		this.#procsPrev = { at, cpu: new Map(listing.map((r) => [r.pid, r.cpu])) };
		this.#procs = procs;
		return procs;
	}
}
