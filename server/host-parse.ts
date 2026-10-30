import type { Pressure } from "../shared/host.ts";

/**
 * What the host sampler (`host.ts`) reads of the computer, as the text a command prints, and the arithmetic on it. No
 * process is started and no file is read here: each function takes what a command printed and says what it means, so that
 * the formats (the system's, and they change with its releases) are pinned by tests that use real output as fixtures.
 */

/** A figure to one decimal: a chart does not draw hundredths, and a day of history is a fifth smaller without them. */
export const tenth = (n: number): number => Math.round(n * 10) / 10;

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

// ------------------------------------------------------------------ CPU

/** The counters `os.cpus()` keeps per core (milliseconds), added up over all cores. */
export interface CpuTimes {
	/** User and nice time. */
	user: number;
	/** System and interrupt time. */
	sys: number;
	idle: number;
}

/** The shape of one entry of `os.cpus()` that is read. */
interface CoreTimes {
	times: { user: number; nice: number; sys: number; idle: number; irq: number };
}

export function sumCpuTimes(cores: readonly CoreTimes[]): CpuTimes {
	const sum: CpuTimes = { user: 0, sys: 0, idle: 0 };
	for (const { times } of cores) {
		sum.user += times.user + times.nice;
		sum.sys += times.sys + times.irq;
		sum.idle += times.idle;
	}
	return sum;
}

/** The share of all cores' time that was not idle between two readings, 0–100; null when no time went by or a counter ran backwards. */
export function cpuShare(prev: CpuTimes, cur: CpuTimes): number | null {
	const user = cur.user - prev.user;
	const sys = cur.sys - prev.sys;
	const idle = cur.idle - prev.idle;
	const total = user + sys + idle;
	if (total <= 0 || user < 0 || sys < 0 || idle < 0) return null;
	return tenth(clamp(((user + sys) / total) * 100, 0, 100));
}

// ------------------------------------------------------------------ memory

/** `sysctl name…` prints `name: value` per line; what is not a number (a failed name prints on stderr) is left out. */
export function parseSysctl(text: string): Map<string, number> {
	const values = new Map<string, number>();
	for (const line of text.split("\n")) {
		const m = /^([\w.]+):\s*(\d+)\s*$/.exec(line);
		if (m) values.set(m[1] as string, Number(m[2]));
	}
	return values;
}

/** The names `sysctl` is asked for on macOS (`memoryOf` reads the first four, `pressureOf` the last). */
export const MAC_SYSCTL = [
	"hw.pagesize",
	"vm.page_pageable_internal_count",
	"vm.page_purgeable_count",
	"vm.page_wired_count",
	"vm.compressor_bytes_used",
	"kern.memorystatus_vm_pressure_level",
] as const;

/**
 * Bytes of memory in use as macOS counts them in Activity Monitor's Memory Used: app memory (the pages programs hold, less
 * the purgeable ones), wired memory, and what the compressor occupies. Cached files are not in it: they are given back the
 * moment a program asks. Null when a figure the sum needs is missing.
 */
export function memoryUsedMac(v: ReadonlyMap<string, number>): number | null {
	const page = v.get("hw.pagesize");
	const internal = v.get("vm.page_pageable_internal_count");
	const wired = v.get("vm.page_wired_count");
	const compressed = v.get("vm.compressor_bytes_used");
	if (!page || internal === undefined || wired === undefined || compressed === undefined) return null;
	const purgeable = v.get("vm.page_purgeable_count") ?? 0;
	return (Math.max(0, internal - purgeable) + wired) * page + compressed;
}

/** `kern.memorystatus_vm_pressure_level`: 1 is normal, 2 warning and 4 critical, the levels Activity Monitor's pressure graph is coloured by. */
export function pressureOf(v: ReadonlyMap<string, number>): Pressure | null {
	switch (v.get("kern.memorystatus_vm_pressure_level")) {
		case 1:
			return 0;
		case 2:
			return 1;
		case 4:
			return 2;
		default:
			return null;
	}
}

export interface Meminfo {
	total: number;
	used: number;
}

/** `/proc/meminfo` (Linux): the bytes in use are all of it less what is available (free, and what the cache gives back). Null when a figure is missing. */
export function parseMeminfo(text: string): Meminfo | null {
	const figure = (name: string): number | null => {
		const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m").exec(text);
		return m ? Number(m[1]) * 1024 : null;
	};
	const total = figure("MemTotal");
	const available = figure("MemAvailable");
	return total === null || available === null || total <= 0 ? null : { total, used: Math.max(0, total - available) };
}

// ------------------------------------------------------------------ processes

/**
 * A CPU time as `ps` prints it, in seconds: `0:11.81` and `81833:14.40` (macOS: minutes, then seconds and hundredths), or
 * `01:02:03` and `2-03:04:05` (Linux: hours, with days before a dash). Null for anything else.
 */
export function parseCpuTime(text: string): number | null {
	const m = /^(?:(\d+)-)?(\d+(?::\d+){1,2})(?:\.(\d+))?$/.exec(text.trim());
	if (!m) return null;
	let seconds = 0;
	for (const part of (m[2] as string).split(":")) seconds = seconds * 60 + Number(part);
	return Number(m[1] ?? 0) * 86400 + seconds + (m[3] ? Number(`0.${m[3]}`) : 0);
}

export interface PsRow {
	pid: number;
	ppid: number;
	/** Seconds of CPU the process has used in all. */
	cpu: number;
	/** Resident memory, bytes. */
	rss: number;
}

/** `ps -A -o pid=,ppid=,time=,rss=` (rss in KiB). A line that is not those four fields is skipped. */
export function parsePs(text: string): PsRow[] {
	const rows: PsRow[] = [];
	for (const line of text.split("\n")) {
		const f = line.trim().split(/\s+/);
		if (f.length !== 4) continue;
		const cpu = parseCpuTime(f[2] as string);
		const pid = Number(f[0]);
		const ppid = Number(f[1]);
		const rss = Number(f[3]);
		if (cpu === null || !Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(rss)) continue;
		rows.push({ pid, ppid, cpu, rss: rss * 1024 });
	}
	return rows;
}

/**
 * The rows of omp's group (each of `roots.omp` and everything below it, tools in sessions of their own included) and the
 * relays' (`roots.relay` alone: the omp each holds is a child of its relay, and is counted with omp's).
 */
export function groupRows(
	rows: readonly PsRow[],
	roots: { omp: readonly number[]; relay: readonly number[] },
): { omp: PsRow[]; relay: PsRow[] } {
	const byPid = new Map<number, PsRow>();
	const children = new Map<number, number[]>();
	for (const r of rows) {
		byPid.set(r.pid, r);
		const list = children.get(r.ppid);
		if (list) list.push(r.pid);
		else children.set(r.ppid, [r.pid]);
	}
	const seen = new Set<number>(roots.relay);
	const omp: PsRow[] = [];
	const walk = (pid: number) => {
		if (seen.has(pid)) return;
		seen.add(pid);
		const row = byPid.get(pid);
		if (row) omp.push(row);
		for (const c of children.get(pid) ?? []) walk(c);
	};
	for (const root of roots.omp) walk(root);
	const relay: PsRow[] = [];
	for (const pid of new Set(roots.relay)) {
		const row = byPid.get(pid);
		if (row) relay.push(row);
	}
	return { omp, relay };
}

/**
 * What `rows` used since the listing `prev` (pid → seconds of CPU) `seconds` ago, as a share of one core (100: one core
 * busy all the while), and the memory they hold now. A process that is not in `prev` started since: all of its time is
 * in the span. A null CPU where there is no earlier listing to compare with.
 */
export function groupUse(
	prev: ReadonlyMap<number, number> | null,
	rows: readonly PsRow[],
	seconds: number,
): { cpu: number | null; rss: number } {
	let rss = 0;
	let used = 0;
	for (const r of rows) {
		rss += r.rss;
		const before = prev?.get(r.pid);
		used += before === undefined ? r.cpu : Math.max(0, r.cpu - before);
	}
	return { cpu: prev && seconds > 0 ? tenth((used / seconds) * 100) : null, rss };
}
