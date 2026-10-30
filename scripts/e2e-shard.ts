/**
 * The end-to-end tests one CI runner runs, split by how long they take (`tests/e2e/timings.json`), written as a
 * Playwright test list for `bun run test:e2e --test-list <file>`.
 *
 *   bun scripts/e2e-shard.ts --shard <index>/<total> --out <file>
 *
 * The tests are what `playwright test --list` finds now, so a test added since the timings were taken runs too (it
 * weighs as a usual one). A file runs whole on one runner (its tests may share a server and hooks), except a file that
 * lets its tests run apart (`test.describe.configure({ mode: "parallel" })`), whose tests are split one by one.
 * Refresh the timings from a run's reports with `bun scripts/e2e-timings.ts`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../shared/guards.ts";
import { assignShards, parseShard, type Unit, weigh } from "./lib/shards.ts";

const root = join(import.meta.dir, "..");
export const TIMINGS = join(root, "tests", "e2e", "timings.json");

/** What `playwright test --list --reporter=json` (and the JSON report) says of a suite: a file or a describe. */
export interface ListSuite {
	title: string;
	file: string;
	specs?: { title: string; tests?: { results?: { duration?: number }[] }[] }[];
	suites?: ListSuite[];
}

/** A test, by the key a test list names it with (`file › describe › title`), its file, and what a report timed it at. */
export interface ListedTest {
	key: string;
	file: string;
	/** Its last result's milliseconds (a retried test's last try), in a report of a run; none in a list. */
	ms?: number;
}

/** The suites of a Playwright JSON report (the reporter's own shape), and the folder its files are named from. */
export function readReport(text: string): { rootDir: string; suites: ListSuite[] } {
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed) || !isRecord(parsed.config) || typeof parsed.config.rootDir !== "string")
		throw new Error("a Playwright JSON report without its config");
	if (!Array.isArray(parsed.suites)) throw new Error("a Playwright JSON report without suites");
	return { rootDir: parsed.config.rootDir, suites: parsed.suites };
}

/** The seconds each test took (`file › describe › title`), as `bun scripts/e2e-timings.ts` writes them. */
export function readTimings(text: string): Record<string, number> {
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed) || !isRecord(parsed.tests)) throw new Error(`${TIMINGS} has no "tests"`);
	const out: Record<string, number> = {};
	for (const [key, seconds] of Object.entries(parsed.tests)) if (typeof seconds === "number") out[key] = seconds;
	return out;
}

/** Every test of `suites` (the report's top level: one suite per file), in the report's order. */
export function listedTests(suites: readonly ListSuite[]): ListedTest[] {
	const out: ListedTest[] = [];
	const walk = (suite: ListSuite, path: string[]) => {
		for (const spec of suite.specs ?? [])
			out.push({
				key: [suite.file, ...path, spec.title].join(" › "),
				file: suite.file,
				ms: spec.tests?.at(-1)?.results?.at(-1)?.duration,
			});
		for (const child of suite.suites ?? []) walk(child, [...path, child.title]);
	};
	for (const file of suites) walk(file, []);
	return out;
}

/** Whether a spec file lets its tests run apart, on other workers and so on other runners. */
export const runsApart = (source: string): boolean =>
	/^test\.describe\.configure\(\{\s*mode:\s*["']parallel["']\s*\}\)/m.test(source);

/**
 * The units of a split: a file whose tests run apart is one unit per test, any other file one unit (the sum of its
 * tests). Keys are what a test list names them by: `file › …` for a test, the file alone for a whole file.
 */
export function units(
	tests: readonly ListedTest[],
	apart: (file: string) => boolean,
	timings: Readonly<Record<string, number>>,
): Unit[] {
	const weighed = weigh(
		tests.map((t) => t.key),
		timings,
	);
	const byFile = new Map<string, number>();
	const out: Unit[] = [];
	tests.forEach((t, i) => {
		if (apart(t.file)) out.push(weighed[i]);
		else byFile.set(t.file, (byFile.get(t.file) ?? 0) + weighed[i].weight);
	});
	for (const [file, weight] of byFile) out.push({ key: file, weight });
	return out;
}

if (import.meta.main) {
	const arg = (name: string) => {
		const at = process.argv.indexOf(`--${name}`);
		return at < 0 ? undefined : process.argv[at + 1];
	};
	const { index, total } = parseShard(arg("shard"));
	const out = arg("out");
	if (!out) throw new Error("--out <file> names the test list to write");
	const listed = Bun.spawnSync(["bunx", "playwright", "test", "--list", "--reporter=json"], {
		cwd: root,
		stderr: "inherit",
	});
	if (listed.exitCode !== 0) throw new Error(`playwright test --list exited with ${listed.exitCode}`);
	const { rootDir, suites } = readReport(listed.stdout.toString());
	const sources = new Map<string, boolean>();
	const apart = (file: string) => {
		let known = sources.get(file);
		if (known === undefined) {
			known = runsApart(readFileSync(join(rootDir, file), "utf8"));
			sources.set(file, known);
		}
		return known;
	};
	const all = units(listedTests(suites), apart, readTimings(readFileSync(TIMINGS, "utf8")));
	const mine = assignShards(all, total)[index - 1];
	writeFileSync(out, `${mine.join("\n")}\n`);
	const weight = new Map(all.map((u) => [u.key, u.weight]));
	const seconds = mine.reduce((sum, key) => sum + (weight.get(key) ?? 0), 0);
	console.log(`shard ${index}/${total}: ${mine.length} of ${all.length} units, about ${Math.round(seconds / 60)} min`);
}
