import type { HostPoint, HostSeries, Pressure } from "../shared/host.ts";
import { tenth } from "./host-parse.ts";

/** A figure that is not there, in a column of tenths of a percent (0–1000 are figures). */
const NONE = 0xffff;
const NO_PRESSURE = -1;

/**
 * A fixed number of looks at the host, in columns of typed arrays (15 bytes a look: a day of minutes and an hour of seconds
 * are 60 KB together, and nothing grows). Writing past the end overwrites the oldest, so the bound holds however long the
 * server runs. Percentages are kept in tenths, which is all the pages draw.
 */
export class HostRing {
	readonly capacity: number;
	private readonly t: Float64Array;
	private readonly cpu: Uint16Array;
	private readonly gpu: Uint16Array;
	private readonly mem: Uint16Array;
	private readonly pressure: Int8Array;
	/** Where the next look is written. */
	private next = 0;
	private size = 0;

	constructor(capacity: number) {
		if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("A ring holds at least one look");
		this.capacity = capacity;
		this.t = new Float64Array(capacity);
		this.cpu = new Uint16Array(capacity);
		this.gpu = new Uint16Array(capacity);
		this.mem = new Uint16Array(capacity);
		this.pressure = new Int8Array(capacity);
	}

	get length(): number {
		return this.size;
	}

	push(p: HostPoint): void {
		const i = this.next;
		this.t[i] = p.t;
		this.cpu[i] = tenths(p.cpu);
		this.gpu[i] = tenths(p.gpu);
		this.mem[i] = tenths(p.mem);
		this.pressure[i] = p.pressure ?? NO_PRESSURE;
		this.next = (i + 1) % this.capacity;
		if (this.size < this.capacity) this.size++;
	}

	/** The index in storage of the `n`th look, oldest first. */
	private at(n: number): number {
		return (this.next - this.size + n + this.capacity * 2) % this.capacity;
	}

	private pressureAt(i: number): Pressure | null {
		const v = this.pressure[i] as number;
		return v === NO_PRESSURE ? null : (v as Pressure);
	}

	/** The newest look; null when none. */
	last(): HostPoint | null {
		return this.size === 0 ? null : this.pointAt(this.at(this.size - 1));
	}

	private pointAt(i: number): HostPoint {
		return {
			t: this.t[i] as number,
			cpu: untenths(this.cpu[i] as number) as number,
			gpu: untenths(this.gpu[i] as number),
			mem: untenths(this.mem[i] as number),
			pressure: this.pressureAt(i),
		};
	}

	/** The looks at or after `since` (epoch ms), oldest first, as columns. */
	series(since = 0): HostSeries {
		const out: HostSeries = { t: [], cpu: [], gpu: [], mem: [], pressure: [] };
		for (let n = 0; n < this.size; n++) {
			const i = this.at(n);
			if ((this.t[i] as number) < since) continue;
			out.t.push(this.t[i] as number);
			out.cpu.push(untenths(this.cpu[i] as number) as number);
			out.gpu.push(untenths(this.gpu[i] as number));
			out.mem.push(untenths(this.mem[i] as number));
			out.pressure.push(this.pressureAt(i));
		}
		return out;
	}
}

const tenths = (v: number | null): number => (v === null ? NONE : Math.min(1000, Math.max(0, Math.round(v * 10))));
const untenths = (v: number): number | null => (v === NONE ? null : v / 10);

/**
 * The looks of a minute, added up while it goes on: `add` hands back the finished minute (its mean, at the minute's start)
 * when a look belongs to a later one. A figure the platform lacks stays null; the pressure of a minute is its worst.
 */
export class MinuteBuckets {
	constructor(private readonly spanMs = 60_000) {}

	private start = -1;
	private n = 0;
	private cpu = 0;
	private gpu = { n: 0, sum: 0 };
	private mem = { n: 0, sum: 0 };
	private pressure: Pressure | null = null;

	add(p: HostPoint): HostPoint | null {
		const start = Math.floor(p.t / this.spanMs) * this.spanMs;
		let done: HostPoint | null = null;
		if (start !== this.start) {
			done = this.finish();
			this.start = start;
		}
		this.n++;
		this.cpu += p.cpu;
		if (p.gpu !== null) {
			this.gpu.n++;
			this.gpu.sum += p.gpu;
		}
		if (p.mem !== null) {
			this.mem.n++;
			this.mem.sum += p.mem;
		}
		if (p.pressure !== null) this.pressure = Math.max(this.pressure ?? 0, p.pressure) as Pressure;
		return done;
	}

	private finish(): HostPoint | null {
		if (this.n === 0) return null;
		const done: HostPoint = {
			t: this.start,
			cpu: tenth(this.cpu / this.n),
			gpu: this.gpu.n ? tenth(this.gpu.sum / this.gpu.n) : null,
			mem: this.mem.n ? tenth(this.mem.sum / this.mem.n) : null,
			pressure: this.pressure,
		};
		this.n = 0;
		this.cpu = 0;
		this.gpu = { n: 0, sum: 0 };
		this.mem = { n: 0, sum: 0 };
		this.pressure = null;
		return done;
	}
}
