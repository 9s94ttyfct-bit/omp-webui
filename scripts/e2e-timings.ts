/**
 * Write `tests/e2e/timings.json` (what `scripts/e2e-shard.ts` splits CI's end-to-end runs by) from Playwright JSON
 * reports: the seconds each test took, by `file › describe › title`.
 *
 *   gh run download <run id> -p 'e2e-report-*' -D <dir>/<run id>     (for each of a few recent runs)
 *   bun scripts/e2e-timings.ts <dir>/*\/*\/e2e-report.json
 *
 * A test that several reports timed (the reports of several runs) is given the median of their times: one run's time of
 * a test is up to half again another's on CI's runners, and a split by one run's times is as uneven as that run was.
 * A test in no report (one that did not run) keeps the time it had; a time whose test is gone (renamed, removed) is
 * dropped, and a test that has no time yet is named, to be timed by a run of its own (`OMPW_E2E_JSON=<file>`). Take the
 * reports of whole runs (every shard), on the runners CI uses: a test timed on a Mac takes about a third of its time on
 * CI's, and the runner its file lands on runs that much longer than the others until the next refresh from CI.
 * `tests/unit/timings-coverage.test.ts` fails while a test has no time or a time has no test.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { listedTests, listSuite, readReport, readTimings, TIMINGS } from "./e2e-shard.ts";

/** The seconds each test of a report took, to a tenth. */
export function reportTimings(text: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const t of listedTests(readReport(text).suites))
		if (typeof t.ms === "number") out[t.key] = Math.round(t.ms / 100) / 10;
	return out;
}

/** Each key's median over the timings given (the mean of the middle two of an even count), to a tenth. */
export function medianTimings(all: readonly Record<string, number>[]): Record<string, number> {
	const seen = new Map<string, number[]>();
	for (const timings of all)
		for (const [key, seconds] of Object.entries(timings)) seen.set(key, [...(seen.get(key) ?? []), seconds]);
	const out: Record<string, number> = {};
	for (const [key, times] of seen) {
		times.sort((a, b) => a - b);
		const mid = times.length >> 1;
		const median = times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2;
		out[key] = Math.round(median * 10) / 10;
	}
	return out;
}

if (import.meta.main) {
	const reports = process.argv.slice(2);
	if (!reports.length) throw new Error("name the JSON reports of one run or more");
	let kept: Record<string, number> = {};
	try {
		kept = readTimings(readFileSync(TIMINGS, "utf8"));
	} catch {
		// No timings yet: every test is timed afresh.
	}
	Object.assign(kept, medianTimings(reports.map((report) => reportTimings(readFileSync(report, "utf8")))));
	const now = new Set(listedTests(listSuite().suites).map((t) => t.key));
	const stale = Object.keys(kept).filter((key) => !now.has(key));
	for (const key of stale) delete kept[key];
	const tests = Object.fromEntries(Object.entries(kept).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	writeFileSync(TIMINGS, `${JSON.stringify({ version: 1, tests }, null, "\t")}\n`);
	console.log(
		`${Object.keys(tests).length} tests timed, from ${reports.length} report(s); ${stale.length} gone dropped`,
	);
	for (const key of now) if (!(key in tests)) console.log(`no time yet: ${key}`);
}
