/**
 * Write `tests/e2e/timings.json` (what `scripts/e2e-shard.ts` splits CI's end-to-end runs by) from Playwright JSON
 * reports: the seconds each test took, by `file › describe › title`.
 *
 *   gh run download <run id> -p 'e2e-report-*' -D <dir>
 *   bun scripts/e2e-timings.ts <dir>/*\/e2e-report.json
 *
 * A test in no report (one that did not run) keeps the time it had. Take the reports of a whole run (every shard), on
 * the runners CI uses: the split is only as good as the times are like the next run's.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { listedTests, readReport, readTimings, TIMINGS } from "./e2e-shard.ts";

/** The seconds each test of a report took, to a tenth. */
export function reportTimings(text: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const t of listedTests(readReport(text).suites))
		if (typeof t.ms === "number") out[t.key] = Math.round(t.ms / 100) / 10;
	return out;
}

if (import.meta.main) {
	const reports = process.argv.slice(2);
	if (!reports.length) throw new Error("name the JSON reports of a run");
	let kept: Record<string, number> = {};
	try {
		kept = readTimings(readFileSync(TIMINGS, "utf8"));
	} catch {
		// No timings yet: every test is timed afresh.
	}
	for (const report of reports) Object.assign(kept, reportTimings(readFileSync(report, "utf8")));
	const tests = Object.fromEntries(Object.entries(kept).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	writeFileSync(TIMINGS, `${JSON.stringify({ version: 1, tests }, null, "\t")}\n`);
	console.log(`${Object.keys(tests).length} tests timed, from ${reports.length} report(s)`);
}
