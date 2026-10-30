import { describe, expect, test } from "bun:test";
import {
	cpuShare,
	groupRows,
	groupUse,
	memoryUsedMac,
	parseCpuTime,
	parseMeminfo,
	parsePs,
	parseSysctl,
	pressureOf,
	sumCpuTimes,
} from "../../server/host-parse.ts";

// `sysctl hw.pagesize vm.page_pageable_internal_count vm.page_purgeable_count vm.page_wired_count vm.compressor_bytes_used
// kern.memorystatus_vm_pressure_level` on an Apple M4 Pro (macOS 27), as printed.
const SYSCTL_M4 = `hw.pagesize: 16384
vm.page_pageable_internal_count: 598734
vm.page_purgeable_count: 26920
vm.page_wired_count: 253903
vm.compressor_bytes_used: 5504237568
kern.memorystatus_vm_pressure_level: 1
`;

describe("macOS memory from sysctl", () => {
	test("memory in use is app memory (internal pages less purgeable) + wired + compressor, which Activity Monitor calls Memory Used", () => {
		const v = parseSysctl(SYSCTL_M4);
		// ((598734 − 26920) + 253903) pages of 16 KiB, and the compressor's bytes.
		expect(memoryUsedMac(v)).toBe((598734 - 26920 + 253903) * 16384 + 5504237568);
		expect(memoryUsedMac(v)).toBe(19032784896);
	});

	test("the pressure levels macOS reports (1, 2, 4) are normal, warning, critical", () => {
		const level = (n: number) => pressureOf(parseSysctl(`kern.memorystatus_vm_pressure_level: ${n}\n`));
		expect([level(1), level(2), level(4)]).toEqual([0, 1, 2]);
		expect(level(3)).toBeNull();
		expect(pressureOf(parseSysctl(SYSCTL_M4))).toBe(0);
	});

	test("a name the system does not know prints on stderr and is simply missing; the sum then has no figure rather than a wrong one", () => {
		const without = SYSCTL_M4.replace("vm.compressor_bytes_used: 5504237568\n", "");
		expect(memoryUsedMac(parseSysctl(without))).toBeNull();
		expect(memoryUsedMac(parseSysctl(""))).toBeNull();
		// Purgeable is a refinement of the sum, not part of what makes it possible.
		const noPurgeable = SYSCTL_M4.replace("vm.page_purgeable_count: 26920\n", "");
		expect(memoryUsedMac(parseSysctl(noPurgeable))).toBe((598734 + 253903) * 16384 + 5504237568);
	});

	test("purgeable pages beyond the internal ones never make memory negative", () => {
		const v = new Map([
			["hw.pagesize", 4096],
			["vm.page_pageable_internal_count", 10],
			["vm.page_purgeable_count", 50],
			["vm.page_wired_count", 5],
			["vm.compressor_bytes_used", 0],
		]);
		expect(memoryUsedMac(v)).toBe(5 * 4096);
	});

	test("lines that are not `name: integer` are ignored", () => {
		const v = parseSysctl(
			"sysctl: unknown oid 'vm.nope'\nhw.pagesize: 16384\nkern.osversion: 25A5316i\nhw.cpufrequency: 3.5\n",
		);
		expect([...v.entries()]).toEqual([["hw.pagesize", 16384]]);
	});
});

describe("Linux memory from /proc/meminfo", () => {
	const MEMINFO = `MemTotal:       32768000 kB
MemFree:         1234567 kB
MemAvailable:   20480000 kB
Buffers:          123456 kB
Cached:         12345678 kB
`;
	test("in use is all of it less what is available", () => {
		expect(parseMeminfo(MEMINFO)).toEqual({ total: 32768000 * 1024, used: (32768000 - 20480000) * 1024 });
	});
	test("a kernel without MemAvailable has no figure", () => {
		expect(parseMeminfo("MemTotal: 100 kB\nMemFree: 50 kB\n")).toBeNull();
		expect(parseMeminfo("")).toBeNull();
	});
});

describe("CPU share from os.cpus() counters", () => {
	const core = (user: number, sys: number, idle: number, nice = 0, irq = 0) => ({
		times: { user, nice, sys, idle, irq },
	});

	test("the counters of all cores are added up, nice with user and interrupts with system", () => {
		expect(sumCpuTimes([core(10, 20, 30, 1, 2), core(5, 5, 5)])).toEqual({ user: 16, sys: 27, idle: 35 });
	});

	test("the share is the part of the elapsed time that was not idle", () => {
		const a = sumCpuTimes([core(100, 50, 850), core(100, 50, 850)]);
		const b = sumCpuTimes([core(200, 100, 1700), core(150, 70, 1780)]);
		// user +150, sys +70, idle +1780 of 2000 in all.
		expect(cpuShare(a, b)).toBe(11);
	});

	test("no time elapsed, or counters that went backwards, is no reading", () => {
		const a = { user: 10, sys: 10, idle: 10 };
		expect(cpuShare(a, a)).toBeNull();
		expect(cpuShare(a, { user: 5, sys: 20, idle: 30 })).toBeNull();
	});

	test("a fully busy and a fully idle window are 100 and 0", () => {
		const a = { user: 0, sys: 0, idle: 0 };
		expect(cpuShare(a, { user: 90, sys: 10, idle: 0 })).toBe(100);
		expect(cpuShare(a, { user: 0, sys: 0, idle: 100 })).toBe(0);
	});
});

// Real lines of `ps -A -o pid=,ppid=,time=,rss=` (macOS 27): minutes:seconds.hundredths, and rss in KiB.
const PS_LINES = `    1     0 294:13.82  22272
  345     1 133:15.44  31824
  348     1   3:23.61   8528
  350     1 409:41.04  11760
   not a process line
`;

describe("process listings", () => {
	test("CPU times, as macOS and Linux print them", () => {
		expect(parseCpuTime("0:01.96")).toBeCloseTo(1.96);
		expect(parseCpuTime("409:41.04")).toBeCloseTo(409 * 60 + 41.04);
		expect(parseCpuTime("81833:14.40")).toBeCloseTo(81833 * 60 + 14.4);
		expect(parseCpuTime("01:02:03")).toBe(3723);
		expect(parseCpuTime("2-03:04:05")).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5);
		expect(parseCpuTime("00:46")).toBe(46);
		expect(parseCpuTime("abc")).toBeNull();
		expect(parseCpuTime("")).toBeNull();
	});

	test("rows of ps, with memory in bytes; a line that is not four fields of the kind is skipped", () => {
		const rows = parsePs(PS_LINES);
		expect(rows).toHaveLength(4);
		expect(rows[0]).toEqual({ pid: 1, ppid: 0, cpu: 294 * 60 + 13.82, rss: 22272 * 1024 });
		expect(rows[3]?.pid).toBe(350);
	});

	// A server (100) with two conversations: omp 200 (its relay 150), which started a shell 201 and a build 202 under it,
	// and omp 300 (relay 250) that started nothing. 999 is somebody else's.
	const rows = parsePs(`100 1 0:10.00 1000
150 100 0:01.00 100
200 150 0:20.00 5000
201 200 0:02.00 300
202 201 0:03.00 700
250 100 0:01.50 100
300 250 0:30.00 4000
999 1 9:00.00 9999
`);
	const roots = { omp: [200, 300], relay: [150, 250] };

	test("omp's group is each omp and everything below it; the relay is a group of its own and its omp is not counted twice", () => {
		const g = groupRows(rows, roots);
		expect(g.omp.map((r) => r.pid).sort()).toEqual([200, 201, 202, 300]);
		expect(g.relay.map((r) => r.pid).sort()).toEqual([150, 250]);
	});

	test("a process that has gone from the listing is just missing from its group", () => {
		const g = groupRows(rows, { omp: [200, 7777], relay: [150, 8888] });
		expect(g.omp.map((r) => r.pid).sort()).toEqual([200, 201, 202]);
		expect(g.relay.map((r) => r.pid)).toEqual([150]);
	});

	test("use is the CPU time spent since the earlier listing, as a share of one core, and the memory now", () => {
		const g = groupRows(rows, roots);
		const before = new Map([
			[200, 19],
			[201, 2],
			[300, 29],
		]);
		// 200: +1, 201: +0, 202 is new (all 3 s), 300: +1 — 5 s of CPU in 2 s of time: 250 % of one core.
		expect(groupUse(before, g.omp, 2)).toEqual({ cpu: 250, rss: (5000 + 300 + 700 + 4000) * 1024 });
	});

	test("without an earlier listing there is memory and no CPU share; a process that restarted never counts negative", () => {
		const g = groupRows(rows, roots);
		expect(groupUse(null, g.omp, 2).cpu).toBeNull();
		expect(groupUse(new Map([[200, 999]]), [g.omp[0] as (typeof g.omp)[number]], 2).cpu).toBe(0);
	});
});
