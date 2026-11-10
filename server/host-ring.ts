import { type HostPoint, type HostSeries, MAX_DISKS, type Pressure } from "../shared/host.ts";
import { tenth } from "./host-parse.ts";

/** A figure that is not there, in a column of tenths (of a percent: 0–1000; of a watt: 0–60000). */
const NONE = 0xffff;
const NO_PRESSURE = -1;
/** The most watts a column of tenths holds below `NONE`. */
const MAX_WATTS = 6000;

/** Megabytes in bytes: free disk space is kept in whole MB (a 32-bit float holds them to the MB up to 16 TB). */
const MB = 1e6;

/**
 * A fixed number of looks at the host, in columns of typed arrays (25 bytes a look, and 4 more for each disk: a day of
 * minutes and an hour of looks are 87 KB together, and 14 KB a disk), with a column for a disk made when the disk is first
 * seen and at most `MAX_DISKS` of them. Writing past the end overwrites the oldest, so the bound holds however long the
 * server runs. Percentages and watts are kept in tenths, which is all the pages draw; the network's bytes a second and a
 * disk's free megabytes as 32-bit floats (NaN: none), which keep them to a few parts in ten million.
 */
export class HostRing {
	readonly capacity: number;
	private readonly t: Float64Array;
	private readonly cpu: Uint16Array;
	private readonly gpu: Uint16Array;
	private readonly mem: Uint16Array;
	private readonly pressure: Int8Array;
	private readonly power: Uint16Array;
	private readonly rx: Float32Array;
	private readonly tx: Float32Array;
	/** A column of free megabytes per disk, by its id, in the order the disks were first seen. */
	private readonly disks = new Map<string, Float32Array>();
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
		this.power = new Uint16Array(capacity);
		this.rx = new Float32Array(capacity);
		this.tx = new Float32Array(capacity);
	}

	get length(): number {
		return this.size;
	}

	/**
	 * The column of disk `id`, made (all none) the first time it is seen. At `MAX_DISKS` the column of a disk that is not
	 * in this look (taken out) makes room, one with nothing left in it first: a disk plugged in always has a column, as the
	 * server lists at most `MAX_DISKS` at a time.
	 */
	private diskColumn(id: string, present: Record<string, unknown>): Float32Array | null {
		const had = this.disks.get(id);
		if (had) return had;
		if (this.disks.size >= MAX_DISKS) {
			const gone = [...this.disks].filter(([d]) => !Object.hasOwn(present, d));
			const drop = (gone.find(([, col]) => col.every(Number.isNaN)) ?? gone[0])?.[0];
			if (drop === undefined) return null;
			this.disks.delete(drop);
		}
		const col = new Float32Array(this.capacity).fill(Number.NaN);
		this.disks.set(id, col);
		return col;
	}

	push(p: HostPoint): void {
		const i = this.next;
		this.t[i] = p.t;
		this.cpu[i] = tenths(p.cpu);
		this.gpu[i] = tenths(p.gpu);
		this.mem[i] = tenths(p.mem);
		this.pressure[i] = p.pressure ?? NO_PRESSURE;
		this.power[i] = wattTenths(p.power);
		// `?? NaN`: a point a test makes by hand may lack them (undefined) as well as hold null.
		this.rx[i] = p.rx ?? Number.NaN;
		this.tx[i] = p.tx ?? Number.NaN;
		const disks = p.disks ?? {};
		for (const id of Object.keys(disks)) this.diskColumn(id, disks);
		for (const [id, col] of this.disks) {
			const free = disks[id];
			col[i] = free === null || free === undefined ? Number.NaN : Math.round(free / MB);
		}
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

	/** The look at storage index `i`; its disks are those that had a figure then. */
	private pointAt(i: number): HostPoint {
		const disks: Record<string, number | null> = {};
		for (const [id, col] of this.disks) {
			const free = megabytes(col[i] as number);
			if (free !== null) disks[id] = free;
		}
		return {
			t: this.t[i] as number,
			cpu: untenths(this.cpu[i] as number) as number,
			gpu: untenths(this.gpu[i] as number),
			mem: untenths(this.mem[i] as number),
			pressure: this.pressureAt(i),
			power: untenths(this.power[i] as number),
			rx: whole(this.rx[i] as number),
			tx: whole(this.tx[i] as number),
			disks,
		};
	}

	/** The looks at or after `since` (epoch ms), oldest first, as columns; a disk with no figure among them has none. */
	series(since = 0): HostSeries {
		const out: HostSeries = { t: [], cpu: [], gpu: [], mem: [], pressure: [], power: [], rx: [], tx: [], disks: {} };
		const indices: number[] = [];
		for (let n = 0; n < this.size; n++) {
			const i = this.at(n);
			if ((this.t[i] as number) < since) continue;
			indices.push(i);
			out.t.push(this.t[i] as number);
			out.cpu.push(untenths(this.cpu[i] as number) as number);
			out.gpu.push(untenths(this.gpu[i] as number));
			out.mem.push(untenths(this.mem[i] as number));
			out.pressure.push(this.pressureAt(i));
			out.power.push(untenths(this.power[i] as number));
			out.rx.push(whole(this.rx[i] as number));
			out.tx.push(whole(this.tx[i] as number));
		}
		for (const [id, col] of this.disks) {
			const free = indices.map((i) => megabytes(col[i] as number));
			if (free.some((v) => v !== null)) out.disks[id] = free;
		}
		return out;
	}
}

const tenths = (v: number | null): number => (v === null ? NONE : Math.min(1000, Math.max(0, Math.round(v * 10))));
const wattTenths = (v: number | null): number =>
	v === null ? NONE : Math.min(MAX_WATTS * 10, Math.max(0, Math.round(v * 10)));
const untenths = (v: number): number | null => (v === NONE ? null : v / 10);
const whole = (v: number): number | null => (Number.isNaN(v) ? null : Math.round(v));
const megabytes = (v: number): number | null => (Number.isNaN(v) ? null : v * MB);

/**
 * The looks of a minute, added up while it goes on: `add` hands back the finished minute (its mean, at the minute's start)
 * when a look belongs to a later one. A figure the platform lacks stays null; the pressure of a minute is its worst, a
 * disk's free space its last.
 */
export class MinuteBuckets {
	constructor(private readonly spanMs = 60_000) {}

	private start = -1;
	private n = 0;
	private cpu = 0;
	private gpu = { n: 0, sum: 0 };
	private mem = { n: 0, sum: 0 };
	private pressure: Pressure | null = null;
	private power = { n: 0, sum: 0 };
	private rx = { n: 0, sum: 0 };
	private tx = { n: 0, sum: 0 };
	private disks: Record<string, number | null> = {};

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
		if (p.power !== null) {
			this.power.n++;
			this.power.sum += p.power;
		}
		if (p.rx != null) {
			this.rx.n++;
			this.rx.sum += p.rx;
		}
		if (p.tx != null) {
			this.tx.n++;
			this.tx.sum += p.tx;
		}
		for (const [id, free] of Object.entries(p.disks ?? {})) {
			if (free !== null || !(id in this.disks)) this.disks[id] = free;
		}
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
			power: this.power.n ? tenth(this.power.sum / this.power.n) : null,
			rx: this.rx.n ? Math.round(this.rx.sum / this.rx.n) : null,
			tx: this.tx.n ? Math.round(this.tx.sum / this.tx.n) : null,
			disks: this.disks,
		};
		this.n = 0;
		this.cpu = 0;
		this.gpu = { n: 0, sum: 0 };
		this.mem = { n: 0, sum: 0 };
		this.pressure = null;
		this.power = { n: 0, sum: 0 };
		this.rx = { n: 0, sum: 0 };
		this.tx = { n: 0, sum: 0 };
		this.disks = {};
		return done;
	}
}
