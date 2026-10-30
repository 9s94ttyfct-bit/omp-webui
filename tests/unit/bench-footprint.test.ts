import { describe, expect, test } from "bun:test";
import {
	compare,
	comparisonTable,
	footprintCoverage,
	gatedWorse,
	isFootprintMetric,
	isInformationalMetric,
	parseFootprintBytes,
	parseSmapsRollupPssKb,
	type Report,
	summarize,
} from "../../tests/support/bench-stats.ts";

/**
 * The benchmark's memory gate (#601): the server's footprint is what is gated, `ps` RSS is shown but never fails a
 * comparison (macOS keeps freed pages in RSS). The parsers read what `footprint` (macOS) and `smaps_rollup` (Linux) print.
 */

const BYTES = `======================================================================
omp [42770]: 64-bit    Footprint: 960743896 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 960743896 B
    phys_footprint_peak: 1136003184 B
`;
const FORMATTED = `======================================================================
omp [42770]: 64-bit    Footprint: 887 MB (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 887 MB
    phys_footprint_peak: 1083 MB
`;

describe("parseFootprintBytes", () => {
	test("reads the total of `--format bytes`, not the peak", () => {
		expect(parseFootprintBytes(BYTES)).toBe(960743896);
	});

	test("reads the formatted total in every unit", () => {
		expect(parseFootprintBytes(FORMATTED)).toBe(887 * 1024 ** 2);
		expect(parseFootprintBytes("p [1]: 64-bit    Footprint: 7872 KB (16384 bytes per page)")).toBe(7872 * 1024);
		expect(parseFootprintBytes("p [1]: 64-bit    Footprint: 1.5 GB (16384 bytes per page)")).toBe(1.5 * 1024 ** 3);
		expect(parseFootprintBytes("p [1]: 64-bit    Footprint: 512 B (16384 bytes per page)")).toBe(512);
	});

	test("null when there is no total (the process is gone, another tool, a permission error)", () => {
		expect(parseFootprintBytes("")).toBeNull();
		expect(parseFootprintBytes("footprint: Unable to find process with pid 1")).toBeNull();
		expect(parseFootprintBytes("Auxiliary data:\n    phys_footprint: 5 MB\n")).toBeNull();
		expect(parseFootprintBytes("Footprint: lots MB")).toBeNull();
	});
});

describe("parseSmapsRollupPssKb", () => {
	const ROLLUP = `55d4d6a00000-7ffd5c9f6000 ---p 00000000 00:00 0                          [rollup]
Rss:               41396 kB
Pss:               35128 kB
Pss_Dirty:         30000 kB
Pss_Anon:          29112 kB
Pss_File:           6016 kB
Shared_Clean:       9000 kB
`;

	test("reads the Pss line, not Pss_Anon or Pss_File", () => {
		expect(parseSmapsRollupPssKb(ROLLUP)).toBe(35128);
	});

	test("null without a Pss line", () => {
		expect(parseSmapsRollupPssKb("Rss: 5 kB\nPss_Anon: 3 kB\n")).toBeNull();
		expect(parseSmapsRollupPssKb("")).toBeNull();
	});
});

describe("which metrics are the memory gate", () => {
	test("footprint metrics are the gate, RSS metrics informational, nothing else is either", () => {
		for (const n of [
			"server.idle.footprint_mb",
			"server.list.footprint_mb",
			"server.long.footprint_mb",
			"server.stream.footprintPeak_mb",
		]) {
			expect(isFootprintMetric(n)).toBe(true);
			expect(isInformationalMetric(n)).toBe(false);
		}
		for (const n of ["server.idle.rss_mb", "server.list.rss_mb", "server.stream.rssPeak_mb"]) {
			expect(isInformationalMetric(n)).toBe(true);
			expect(isFootprintMetric(n)).toBe(false);
		}
		for (const n of ["server.idle.cpu_pct", "stream.heap_mb", "long.heap_mb", "load.cold.fcp_ms"]) {
			expect(isInformationalMetric(n)).toBe(false);
			expect(isFootprintMetric(n)).toBe(false);
		}
	});
});

const def = { unit: "MB", better: "lower", floor: 2 } as const;
/** A report with the given metrics, five tight rounds each (median `value`, spread of 1% of it). */
function report(label: string, metrics: Record<string, number>): Report {
	return {
		label,
		metrics: Object.fromEntries(
			Object.entries(metrics).map(([name, v]) => [name, summarize(def, [v * 0.99, v * 0.995, v, v * 1.005, v * 1.01])]),
		),
	} as unknown as Report;
}

describe("comparing memory", () => {
	test("a footprint that grew beyond threshold and floor is worse, and gates", () => {
		const a = report("A", { "server.stream.footprintPeak_mb": 55 });
		const b = report("B", { "server.stream.footprintPeak_mb": 103 });
		const rows = compare(a, b);
		expect(rows[0].verdict).toBe("worse");
		expect(rows[0].informational).toBe(false);
		expect(gatedWorse(rows).map((r) => r.name)).toEqual(["server.stream.footprintPeak_mb"]);
	});

	test("RSS that grew is shown as worse but is informational: it does not gate", () => {
		const a = report("A", { "server.stream.rssPeak_mb": 94, "server.idle.rss_mb": 90 });
		const b = report("B", { "server.stream.rssPeak_mb": 110, "server.idle.rss_mb": 120 });
		const rows = compare(a, b);
		expect(rows.map((r) => r.verdict)).toEqual(["worse", "worse"]);
		expect(rows.every((r) => r.informational)).toBe(true);
		expect(gatedWorse(rows)).toEqual([]);
		const table = comparisonTable(rows, "A", "B");
		expect(table).toContain("informational");
		expect(table).not.toContain("**WORSE**");
	});

	test("RSS up and footprint equal: nothing gated (the freed-page case of #601)", () => {
		const a = report("A", { "server.stream.rssPeak_mb": 94, "server.stream.footprintPeak_mb": 55 });
		const b = report("B", { "server.stream.rssPeak_mb": 110, "server.stream.footprintPeak_mb": 55.4 });
		expect(gatedWorse(compare(a, b))).toEqual([]);
	});

	test("RSS equal and footprint up: gated", () => {
		const a = report("A", { "server.stream.rssPeak_mb": 94, "server.stream.footprintPeak_mb": 55 });
		const b = report("B", { "server.stream.rssPeak_mb": 94, "server.stream.footprintPeak_mb": 70 });
		expect(gatedWorse(compare(a, b)).map((r) => r.name)).toEqual(["server.stream.footprintPeak_mb"]);
	});

	test("a footprint that shrank is better, not worse", () => {
		const rows = compare(
			report("A", { "server.long.footprint_mb": 72 }),
			report("B", { "server.long.footprint_mb": 49 }),
		);
		expect(rows[0].verdict).toBe("better");
		expect(gatedWorse(rows)).toEqual([]);
	});

	test("an old report without footprint still compares: those rows are missing, not compared", () => {
		const old = report("old", { "server.stream.rssPeak_mb": 94, "stream.heap_mb": 20 });
		const now = report("new", {
			"server.stream.rssPeak_mb": 94,
			"server.stream.footprintPeak_mb": 55,
			"stream.heap_mb": 20,
		});
		const rows = compare(old, now);
		const row = rows.find((r) => r.name === "server.stream.footprintPeak_mb");
		expect(row?.verdict).toBe("missing");
		expect(row?.a).toBeNull();
		expect(gatedWorse(rows)).toEqual([]);
		expect(footprintCoverage(old, now)).toEqual({ a: false, b: true });
		expect(footprintCoverage(now, now)).toEqual({ a: true, b: true });
		expect(footprintCoverage(old, old)).toEqual({ a: false, b: false });
		expect(comparisonTable(rows, "old", "new")).toContain("| missing |");
	});
});
