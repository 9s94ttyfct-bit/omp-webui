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

/**
 * `vm_stat`'s `Pages wired down:` (pages of `hw.pagesize`), for a macOS whose `sysctl` has no `vm.page_wired_count`
 * (macOS 26.6 says "unknown oid"; 27 has it). Null when the line is not there.
 */
export function wiredPagesOfVmStat(text: string): number | null {
	const m = /^Pages wired down:\s+(\d+)\.?\s*$/m.exec(text);
	return m ? Number(m[1]) : null;
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

// ------------------------------------------------------------------ network

/** Bytes received and sent so far by each interface that is counted, by its name. */
export type NetCounters = ReadonlyMap<string, { rx: number; tx: number }>;

/**
 * Where macOS keeps an interface's figures in the `struct ifmibdata` that `sysctl` answers for
 * `net.link.generic.ifdata.<index>.general` (`{CTL_NET, PF_LINK, NETLINK_GENERIC, IFMIB_IFDATA, index, IFDATA_GENERAL}`):
 * the name (16 bytes, NUL-ended), then five 32-bit fields and four of filler, then `struct if_data64`, packed to 4 bytes,
 * from byte 52, with `ifi_ibytes` and `ifi_obytes` 64 and 72 bytes into it. Measured on macOS 27.2 (Apple Silicon) against
 * `netstat -ibn`, to the byte. Not the `if_msghdr2` of `NET_RT_IFLIST2`: macOS hands a process without Apple's entitlement
 * its byte counters there rounded down to a KiB and cut to 32 bits (a 4.5 GB loopback says 236 MB).
 */
export const IFMIB = { name: 0, nameBytes: 16, ibytes: 116, obytes: 124, size: 132 } as const;

/** One interface's name and byte counters from its `ifmibdata`; null when the buffer is shorter than the figures, or holds no name. */
export function parseIfmib(buf: Uint8Array): { name: string; rx: number; tx: number } | null {
	if (buf.length < IFMIB.size) return null;
	const end = buf.subarray(IFMIB.name, IFMIB.name + IFMIB.nameBytes).indexOf(0);
	if (end <= 0) return null;
	const name = new TextDecoder().decode(buf.subarray(IFMIB.name, IFMIB.name + end));
	const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
	return {
		name,
		rx: Number(view.getBigUint64(IFMIB.ibytes, true)),
		tx: Number(view.getBigUint64(IFMIB.obytes, true)),
	};
}

/**
 * The interfaces macOS counts: `en` (Ethernet, Wi-Fi, USB and Thunderbolt Ethernet). Not the loopback, nor what carries
 * traffic that is already counted on an `en` (`utun`: a VPN; `bridge`, `ap`) or that is the system's own (`awdl`, `llw`:
 * AirDrop; `anpi`, `gif`, `stf`).
 */
export const isMacPhysical = (name: string): boolean => /^en\d+$/.test(name);

/**
 * `/proc/net/dev` (Linux): a line per interface, `name: ` and sixteen figures, the bytes received first and the bytes sent
 * ninth. The two header lines, and a line that is not that, are skipped.
 */
export function parseProcNetDev(text: string): Map<string, { rx: number; tx: number }> {
	const out = new Map<string, { rx: number; tx: number }>();
	for (const line of text.split("\n")) {
		const m = /^\s*([^\s:]+):\s*(.*)$/.exec(line);
		if (!m) continue;
		const fields = (m[2] as string).trim().split(/\s+/).map(Number);
		if (fields.length < 16 || fields.some((n) => !Number.isFinite(n) || n < 0)) continue;
		out.set(m[1] as string, { rx: fields[0] as number, tx: fields[8] as number });
	}
	return out;
}

/**
 * Bytes a second received and sent between two readings `seconds` apart, added up over the interfaces. Null when there is no
 * earlier reading, no time went by, an interface came or went (its counter would be all of its life, or none of it), or a
 * counter ran backwards (an interface that was reset): never a figure below zero.
 */
export function netRate(
	prev: NetCounters | null,
	cur: NetCounters,
	seconds: number,
): { rx: number; tx: number } | null {
	if (!prev || !(seconds > 0) || prev.size !== cur.size) return null;
	let rx = 0;
	let tx = 0;
	for (const [name, c] of cur) {
		const p = prev.get(name);
		if (!p || c.rx < p.rx || c.tx < p.tx) return null;
		rx += c.rx - p.rx;
		tx += c.tx - p.tx;
	}
	return { rx: Math.round(rx / seconds), tx: Math.round(tx / seconds) };
}

// ------------------------------------------------------------------ disks

/** A mounted volume as the system lists it: where it is mounted, and what it is called. */
export interface DiskMount {
	mount: string;
	name: string;
}

const lastPart = (mount: string): string => mount.replace(/\/+$/, "").split("/").pop() || mount;

/**
 * macOS's `mount` (a line a volume: `<device> on <mount point> (<type>, <flag>, …)`): the volumes a person has, `/` and the
 * ones under /Volumes that Finder shows. Not the system's own (`/System/Volumes/*`, and what is `nobrowse`: Recovery, the
 * VM swap), not one on the network or a virtual one (no `local`, or no `/dev/` device: an SMB share, devfs, autofs), and not a
 * read-only one but `/` (the sealed system snapshot is read-only; the others are disk images and discs, whose free space
 * is nothing to watch). A volume under /Volumes is named by its folder there; `/` is named by the adapter.
 */
export function parseMacMounts(text: string): DiskMount[] {
	const out: DiskMount[] = [];
	for (const line of text.split("\n")) {
		const m = /^(\S.*?) on (\/.*) \(([^()]*)\)$/.exec(line);
		if (!m) continue;
		const [, device, mount, opts] = m as unknown as [string, string, string, string];
		const flags = opts.split(",").map((f) => f.trim());
		if (!device.startsWith("/dev/") || !flags.includes("local") || flags.includes("nobrowse")) continue;
		if (mount !== "/" && (!mount.startsWith("/Volumes/") || flags.includes("read-only"))) continue;
		out.push({ mount, name: mount === "/" ? "/" : lastPart(mount) });
	}
	return out;
}

/** A field of `/proc/mounts`, whose space, tab, newline and backslash are written in octal (`\040`). */
const unescapeMount = (s: string): string =>
	s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(Number.parseInt(o, 8)));

/**
 * Linux's `/proc/mounts` (a line a mount: `<source> <mount point> <type> <options> 0 0`): the mounts of a block device
 * (`/dev/…`), once per device (a device mounted in several places, a bind mount, is the first of them). Not a loop device
 * (a snap, a disk image), a RAM disk or compressed swap (`ram`, `zram`), a `squashfs` image or what is under /snap, nor a
 * read-only mount but `/`.
 */
export function parseProcMounts(text: string): DiskMount[] {
	const out: DiskMount[] = [];
	const seen = new Set<string>();
	for (const line of text.split("\n")) {
		const f = line.trim().split(/\s+/);
		if (f.length < 4) continue;
		const [source, rawMount, type, opts] = f.map(unescapeMount) as [string, string, string, string];
		if (!source.startsWith("/dev/") || /^\/dev\/(loop|ram|zram)/.test(source)) continue;
		if (type === "squashfs" || rawMount === "/snap" || rawMount.startsWith("/snap/")) continue;
		if (rawMount !== "/" && opts.split(",").includes("ro")) continue;
		if (seen.has(source)) continue;
		seen.add(source);
		out.push({ mount: rawMount, name: rawMount === "/" ? "/" : lastPart(rawMount) });
	}
	return out;
}

/** A listed disk as `statSync` and `statfsSync` saw it. */
export interface DiskLook extends DiskMount {
	/** The device the mount point is on (`stat`'s `dev`). */
	dev: number;
	blocks: number;
	bsize: number;
	bfree: number;
}

/**
 * Whether two looks are one disk: the same device (`dev`), or the same size to the block with free blocks within a
 * ten-thousandth of it (two volumes of one APFS container share its space: `Storage` and `TimeMachine` are one disk's free
 * space, read a moment apart).
 */
export const sameDisk = (a: DiskLook, b: DiskLook): boolean =>
	a.dev === b.dev || (a.blocks === b.blocks && a.bsize === b.bsize && Math.abs(a.bfree - b.bfree) <= a.blocks / 10_000);

/** The listed disks once each (`sameDisk`), at most `max`, in the order listed; a disk listed again adds its name. */
export function distinctDisks(looks: readonly DiskLook[], max: number): (DiskLook & { names: string[] })[] {
	const out: (DiskLook & { names: string[] })[] = [];
	for (const d of looks) {
		const same = out.find((o) => sameDisk(o, d));
		if (same) {
			if (!same.names.includes(d.name)) same.names.push(d.name);
			continue;
		}
		if (out.length < max) out.push({ ...d, names: [d.name] });
	}
	return out;
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
