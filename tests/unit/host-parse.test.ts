import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cpuShare,
	groupRows,
	groupUse,
	IFMIB,
	isMacPhysical,
	memoryUsedMac,
	netRate,
	parseCpuTime,
	parseIfmib,
	parseMeminfo,
	parseProcNetDev,
	parsePs,
	parseSysctl,
	pressureOf,
	sumCpuTimes,
} from "../../server/host-parse.ts";
import { createDarwin } from "../../server/platform/darwin.ts";
import { platformFor, type SystemDeps } from "../../server/platform/index.ts";
import { linuxNetBytes } from "../../server/platform/linux.ts";

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

describe("macOS 26, whose sysctl has no vm.page_wired_count", () => {
	// An Apple M4 Mac mini on macOS 26.6.2 (25G83), as printed: sysctl exits 1, names the unknown oid on stderr, prints the rest.
	const SYSCTL_26 = `hw.pagesize: 16384
vm.page_pageable_internal_count: 348020
vm.page_purgeable_count: 1308
vm.compressor_bytes_used: 4927438848
kern.memorystatus_vm_pressure_level: 1
`;
	const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     9421.
Pages wired down:                             247511.
Pages purgeable:                               56359.
`;
	const darwin = (vmStat: { code: number; stdout: string }, asked: string[][] = []) =>
		createDarwin({
			run: async (argv) => {
				asked.push(argv);
				if (argv[0] === "/usr/sbin/sysctl")
					return { code: 1, stdout: SYSCTL_26, stderr: "sysctl: unknown oid 'vm.page_wired_count'\n" };
				if (argv[0] === "/usr/bin/vm_stat") return { ...vmStat, stderr: "" };
				throw new Error(`unexpected ${argv.join(" ")}`);
			},
			runSync: () => ({ code: 1, stdout: "" }),
			readFile: () => null,
			kill: () => {},
			env: {},
		});

	test("the wired pages come from vm_stat, and memory in use has its figure", async () => {
		const memory = await darwin({ code: 0, stdout: VM_STAT }).host.memory();
		expect(memory.used).toBe((348020 - 1308 + 247511) * 16384 + 4927438848);
		expect(memory.pressure).toBe(0);
	});

	test("vm_stat failing leaves memory in use without a figure, and the pressure still read", async () => {
		const memory = await darwin({ code: 1, stdout: "" }).host.memory();
		expect(memory.used).toBeNull();
		expect(memory.pressure).toBe(0);
	});

	test("a macOS whose sysctl has the wired count never runs vm_stat", async () => {
		const asked: string[][] = [];
		const withWired = createDarwin({
			run: async (argv) => {
				asked.push(argv);
				return { code: 0, stdout: SYSCTL_M4, stderr: "" };
			},
			runSync: () => ({ code: 1, stdout: "" }),
			readFile: () => null,
			kill: () => {},
			env: {},
		});
		expect((await withWired.host.memory()).used).toBe(19032784896);
		expect(asked.map((a) => a[0])).toEqual(["/usr/sbin/sysctl"]);
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

describe("macOS network counters from sysctl's ifmibdata", () => {
	// `net.link.generic.ifdata.<n>.general` of en0 (Wi-Fi) and lo0 on an Apple M4 Pro (macOS 27.2), as sysctl(3) answered
	// them (180 bytes each), with `netstat -ibn`'s Link rows printed right after: en0 Ibytes 448862319, Obytes 586433432;
	// lo0 Ibytes and Obytes 4651164241 (over 2^32: the counters are 64-bit).
	const EN0 =
		"656e3000000000000000000000000000000000006388ffff00000000800000001b00000000000000000000000000000000000000060000060e000000dc050000000000000069eb0a000000009d0a0f000000000000000000000000008363100000000000000000000000000000000000000000006f18c11a000000009843f42200000000000000000000000000000000000000000000000000000000000000000000000000000000000000002901f26a00000000";
	const LO0 =
		"6c6f3000000000000000000000000000000000004980ffff000000000001000000000000000000000000000000000000000000001800000004000000004000000000000000000000000000007206270000000000000000000000000072062700000000000000000000000000000000000000000051223b150100000051223b15010000003a3700000000000000000000000000000000000000000000000000000000000000000000000000001a2bf26a00000000";
	const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));

	test("the name and the bytes received and sent are netstat's, to the byte", () => {
		expect(parseIfmib(bytes(EN0))).toEqual({ name: "en0", rx: 448862319, tx: 586433432 });
		expect(parseIfmib(bytes(LO0))).toEqual({ name: "lo0", rx: 4651164241, tx: 4651164241 });
	});

	test("a buffer shorter than the figures, or with no name in its first 16 bytes, is no reading (not a guess)", () => {
		expect(parseIfmib(bytes(EN0).subarray(0, IFMIB.size - 1))).toBeNull();
		expect(parseIfmib(bytes(EN0).subarray(0, IFMIB.size))).toMatchObject({ name: "en0" });
		expect(parseIfmib(new Uint8Array(180))).toBeNull();
		expect(parseIfmib(new Uint8Array(180).fill(0x61))).toBeNull();
	});

	test("a buffer that is a window into a larger one is read from its own start", () => {
		const big = new Uint8Array(512);
		big.set(bytes(EN0), 7);
		expect(parseIfmib(big.subarray(7, 7 + 180))).toEqual({ name: "en0", rx: 448862319, tx: 586433432 });
	});

	test("only the en interfaces count: not the loopback, a VPN's utun (its traffic is an en's already), AirDrop's, a bridge", () => {
		expect(["en0", "en8", "en12"].every(isMacPhysical)).toBe(true);
		const others = ["lo0", "utun3", "awdl0", "llw0", "bridge0", "ap1", "anpi0", "gif0", "stf0", "en", "pktap0"];
		expect(others.some(isMacPhysical)).toBe(false);
	});
});

describe("Linux network counters from /proc/net/dev", () => {
	// In the kernel's format (net/core/net-procfs.c, `%6s:%8llu …`): two header lines, then `name:` and 16 figures, bytes
	// first and ninth; a figure wider than its column runs into the colon.
	const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 81239876  712345    0    0    0     0          0         0 81239876  712345    0    0    0     0       0          0
  eth0:9123456789 8123456    0   12    0     0          0      1234 712345678 3123456    0    0    0     0       0          0
wlp2s0:   500000    4000    0    0    0     0          0         0    20000     300    0    0    0     0       0          0
docker0:  1000000    9000    0    0    0     0          0         0  2000000    9100    0    0    0     0       0          0
`;
	const deps = (text: string | null): SystemDeps => ({
		run: async () => {
			throw new Error("no command is run");
		},
		runSync: () => ({ code: 1, stdout: "" }),
		readFile: (path) => (path === "/proc/net/dev" ? text : null),
		kill: () => {},
		env: {},
	});

	test("each interface's bytes received and sent; the header lines are skipped", () => {
		expect([...parseProcNetDev(NET_DEV)]).toEqual([
			["lo", { rx: 81239876, tx: 81239876 }],
			["eth0", { rx: 9123456789, tx: 712345678 }],
			["wlp2s0", { rx: 500000, tx: 20000 }],
			["docker0", { rx: 1000000, tx: 2000000 }],
		]);
		expect(parseProcNetDev("").size).toBe(0);
		expect(parseProcNetDev("eth0: 1 2 3\n").size).toBe(0);
	});

	test("only the interfaces that are a device count, and which are is asked again after a minute", async () => {
		const sys = mkdtempSync(join(tmpdir(), "omp-webui-sysnet-"));
		try {
			for (const name of ["eth0", "wlp2s0"]) mkdirSync(join(sys, name, "device"), { recursive: true });
			mkdirSync(join(sys, "lo"), { recursive: true });
			mkdirSync(join(sys, "docker0"), { recursive: true });
			let now = 0;
			const read = linuxNetBytes(deps(NET_DEV), sys, () => now);
			expect([...(await read()).keys()]).toEqual(["eth0", "wlp2s0"]);
			expect((await read()).get("eth0")).toEqual({ rx: 9123456789, tx: 712345678 });
			// A name that has become a device is not asked about again within the minute…
			mkdirSync(join(sys, "docker0", "device"));
			now = 30_000;
			expect([...(await read()).keys()]).toEqual(["eth0", "wlp2s0"]);
			// …and is after it.
			now = 61_000;
			expect([...(await read()).keys()]).toEqual(["eth0", "wlp2s0", "docker0"]);
		} finally {
			rmSync(sys, { recursive: true, force: true });
		}
	});

	test("a /proc/net/dev that cannot be read is a failed read", async () => {
		await expect(linuxNetBytes(deps(null))()).rejects.toThrow("/proc/net/dev");
	});

	test("Windows has no network figure", () => {
		expect(platformFor("win32").host.netBytes).toBeNull();
	});
});

describe("network rate from two readings", () => {
	const counters = (...ifs: [string, number, number][]) => new Map(ifs.map(([name, rx, tx]) => [name, { rx, tx }]));

	test("bytes a second, added up over the interfaces, whole", () => {
		const a = counters(["en0", 1_000, 2_000], ["en8", 0, 0]);
		const b = counters(["en0", 4_000, 2_500], ["en8", 1_001, 0]);
		expect(netRate(a, b, 2)).toEqual({ rx: 2_001, tx: 250 });
	});

	test("none on the first reading, when no time went by, when a counter ran back, when an interface came or went", () => {
		const a = counters(["en0", 1_000, 1_000]);
		expect(netRate(null, a, 1)).toBeNull();
		expect(netRate(a, a, 0)).toBeNull();
		expect(netRate(a, counters(["en0", 999, 2_000]), 1)).toBeNull();
		expect(netRate(a, counters(["en0", 2_000, 999]), 1)).toBeNull();
		expect(netRate(a, counters(["en0", 2_000, 2_000], ["en9", 0, 0]), 1)).toBeNull();
		expect(netRate(a, counters(["en9", 2_000, 2_000]), 1)).toBeNull();
		expect(netRate(a, counters(), 1)).toBeNull();
		expect(netRate(a, a, 1)).toEqual({ rx: 0, tx: 0 });
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
