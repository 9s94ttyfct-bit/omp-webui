/**
 * The A / B / A′ gate: two checkouts measured with `scripts/bench.ts`, interleaved (A, B, A again) so a drift of the
 * machine falls on both, each run started only on a quiet machine, then the three comparisons written next to the reports.
 *
 *   bun scripts/bench-gate.ts --a <checkout of the baseline> --b <checkout under test> [--out dir]
 *     [--runs 12] [--warmup 1] [--shards 6] [--only server,long,stream] [--threshold 5]
 *     [--max-load 2.5] [--max-wait 30] [--poll 30] [--on-timeout refuse|provisional] [--no-build]
 *
 * What it does: copies A's checkout to a temporary directory and lays B's measuring harness over the copy (`scripts/bench.ts`
 * and the `scripts/`, `tests/` files it imports, the fake omp; never app code), so both sides record the footprint even
 * when A is a release from before it did; builds both (`bun run build`); then for A, B, A′ in turn waits until the
 * 1-minute load average is at or below --max-load (polling every --poll s for at most --max-wait minutes) and runs
 * `scripts/bench.ts` in that tree. When the machine does not get quiet the gate REFUSES (exit 2, nothing measured under load); with
 * `--on-timeout provisional` it measures anyway with `--allow-load` and the run, the summary and the exit code say
 * PROVISIONAL. There is no `--allow-load` otherwise. It writes, in --out: `bench-<label>.json` and `run-<label>.log` per
 * run, `cmp-AB.md`, `cmp-AA2.md`, `cmp-A2B.md` (made by B's `bench.ts --compare`) and `gate-summary.md`.
 *
 * Exit: 0 pass; 1 B is worse than A or A′ on a gated metric (server footprint, not `ps` RSS: see bench.ts); 2 refused or a
 * build or run failed; 3 a report is invalid or the reports are not comparable; 5 A differs from A′ (the baseline
 * drifted: A against B proves nothing); 6 nothing worse, but a run was provisional or a report has no footprint, so memory
 * was not gated (not evidence; never a pass).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Report } from "../tests/support/bench-stats.ts";
import {
	busiestFromTop,
	GATE_EXIT,
	gateExitCode,
	harnessFiles,
	labelsWithoutFootprint,
	waitForQuiet,
} from "./lib/bench-gate.ts";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

if (args.includes("--help") || args.includes("-h") || !args.includes("--a") || !args.includes("--b")) {
	console.log(
		[
			"bun scripts/bench-gate.ts --a <baseline checkout> --b <checkout under test> [--out dir] [--runs 12] [--warmup 1] [--shards 6] [--only list] [--threshold 5]",
			"  [--max-load 2.5] [--max-wait 30 (minutes)] [--poll 30 (seconds)] [--on-timeout refuse|provisional] [--no-build]",
			"",
			"Copies A to a temporary directory and lays B's measuring harness (bench.ts and what it imports from scripts/ and tests/, not app code) over the copy, so both sides record the footprint; builds both; then measures A, B, A' in turn, each only once the 1-minute load average is at or below --max-load.",
			"If the machine does not get quiet within --max-wait: refuses (exit 2) by default; --on-timeout provisional measures anyway and marks everything PROVISIONAL.",
			"Writes bench-<label>.json, run-<label>.log, cmp-AB.md, cmp-AA2.md, cmp-A2B.md and gate-summary.md to --out.",
			"Exit: 0 pass; 1 B worse than A or A'; 2 refused / build or run failed; 3 invalid or not comparable; 5 A differs from A' (baseline drifted); 6 no regression but PROVISIONAL (a run on a busy machine, or a report without footprint: memory not gated).",
		].join("\n"),
	);
	process.exit(args.includes("--help") || args.includes("-h") ? 0 : 2);
}

const dirA = resolve(opt("a", ""));
const dirB = resolve(opt("b", ""));
const runs = opt("runs", "12");
const warmup = opt("warmup", "1");
const shards = opt("shards", "6");
const only = opt("only", "");
const threshold = opt("threshold", "5");
const maxLoad = Number(opt("max-load", "2.5"));
const maxWaitMin = Number(opt("max-wait", "30"));
const pollSec = Number(opt("poll", "30"));
const onTimeout = opt("on-timeout", "refuse");
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
const out = resolve(opt("out", join(os.tmpdir(), "ompw-bench-gate", stamp)));

if (dirA === dirB) throw new Error("--a and --b are the same checkout");
if (onTimeout !== "refuse" && onTimeout !== "provisional") throw new Error("--on-timeout is refuse or provisional");
for (const [n, v] of [
	["--max-load", maxLoad],
	["--max-wait", maxWaitMin],
	["--poll", pollSec],
] as const) {
	if (!(v > 0)) throw new Error(`${n} must be a positive number`);
}
/** `scripts/bench.ts`'s own `LOAD_LIMIT`: each run refuses to start above it (without `--allow-load`), so a gate that
 * counted a higher load as quiet would wait for it and then see the run fail (#662). */
const BENCH_LOAD_LIMIT = 3;
if (maxLoad > BENCH_LOAD_LIMIT)
	throw new Error(
		`--max-load ${maxLoad} is above scripts/bench.ts's own load limit (${BENCH_LOAD_LIMIT}): every run would refuse to measure. Use --max-load ${BENCH_LOAD_LIMIT} or less (with --on-timeout provisional to measure anyway if the machine does not get there)`,
	);
for (const d of [dirA, dirB]) {
	if (!existsSync(join(d, "scripts", "bench.ts"))) throw new Error(`${d} has no scripts/bench.ts`);
}
mkdirSync(out, { recursive: true });

const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
const shaA = git(dirA, "rev-parse", "--short", "HEAD");
const shaB = git(dirB, "rev-parse", "--short", "HEAD");

/** " Busiest: Google Drive 110%, …" from a 1-second `top` sample (macOS only; the load average alone names no cause: #666). */
function busiest(): string {
	if (process.platform !== "darwin") return "";
	try {
		const top = execFileSync(
			"/usr/bin/top",
			["-l", "2", "-s", "1", "-o", "cpu", "-n", "10", "-stats", "pid,command,cpu"],
			{ encoding: "utf8", timeout: 15_000 },
		);
		const rows = busiestFromTop(top);
		return rows.length ? ` Busiest: ${rows.map((r) => `${r.command} ${Math.round(r.cpu)}%`).join(", ")}.` : "";
	} catch {
		return "";
	}
}

interface Run {
	key: "A" | "B" | "A2";
	label: string;
	dir: string;
}
const plan: Run[] = [
	{ key: "A", label: `A-${shaA}`, dir: dirA },
	{ key: "B", label: `B-${shaB}`, dir: dirB },
	{ key: "A2", label: `A2-${shaA}`, dir: dirA },
];
const reportPath = (r: Run) => join(out, `bench-${r.label}.json`);

const summary: string[] = [];
const say = (line: string) => {
	console.error(line);
	summary.push(line);
};
const finish = (code: number, verdict: string): never => {
	say(`\n**GATE: ${verdict}** (exit ${code})`);
	writeFileSync(join(out, "gate-summary.md"), `${summary.join("\n")}\n`);
	console.error(`\nsummary: ${join(out, "gate-summary.md")}`);
	rmSync(copy, { recursive: true, force: true });
	process.exit(code);
};

say(`# bench gate ${stamp}\n`);
say(
	`A = ${dirA} (${shaA}), B = ${dirB} (${shaB}); runs ${runs}, warm-up ${warmup}, shards ${shards}${only ? `, only ${only}` : ""}`,
);
say(
	`quiet = 1-minute load average <= ${maxLoad}, waiting at most ${maxWaitMin} min between runs; on timeout: ${onTimeout}\n`,
);

// ------------------------------------------------------------------ A is measured with B's harness
// Both sides have to record the footprint, and A may be a release from before it existed (or from before the harness did):
// so A runs from a temporary copy of its checkout with B's measuring harness (bench.ts and the test support files it
// imports, not app code) laid over it. What is measured, the app, stays A's own.
const harness = harnessFiles(dirB);
say("## A's harness\n");
if (!harness.includes("scripts/bench.ts")) throw new Error(`${dirB} has no scripts/bench.ts`);
const copy = join(os.tmpdir(), `ompw-gate-a-${stamp}-${process.pid}`);
let cp = spawnSync("cp", ["-cR", dirA, copy], { stdio: "ignore" });
if (cp.status !== 0) {
	rmSync(copy, { recursive: true, force: true });
	cp = spawnSync("cp", ["-R", dirA, copy], { stdio: "ignore" });
}
if (cp.status !== 0) throw new Error(`could not copy ${dirA} to ${copy}`);
const replaced: string[] = [];
for (const file of harness) {
	const from = join(dirB, file);
	const to = join(copy, file);
	if (!existsSync(to) || !readFileSync(to).equals(readFileSync(from))) replaced.push(file);
	mkdirSync(dirname(to), { recursive: true });
	copyFileSync(from, to);
}
say(
	`A is measured in a temporary copy of ${dirA} (${copy}), with B's measuring harness laid over it so both sides record the footprint: ${harness.length} files from ${dirB} (\`scripts/bench.ts\`, \`tests/support/*\` it imports, the fake omp), of which ${replaced.length} differ from A's (${replaced.join(", ") || "none"}). A's app code (server, web, shared) is its own and is what is measured.`,
);
say("");
for (const run of plan) if (run.dir === dirA) run.dir = copy;

// ------------------------------------------------------------------ build both trees (before the wait: a build is load)
const logFile = (name: string) => openSync(join(out, name), "w");
if (!args.includes("--no-build")) {
	for (const [tag, dir] of [
		["A", copy],
		["B", dirB],
	] as const) {
		console.error(`building ${tag} (${dir}) ...`);
		const fd = logFile(`build-${tag}.log`);
		const r = spawnSync("bun", ["run", "build"], { cwd: dir, stdio: ["ignore", fd, fd] });
		closeSync(fd);
		if (r.status !== 0)
			finish(GATE_EXIT.refused, `REFUSED: \`bun run build\` failed in ${dir} (see ${join(out, `build-${tag}.log`)})`);
	}
}
if (!readFileSync(join(dirB, "scripts", "bench.ts"), "utf8").includes("footprint")) {
	say(
		`> B (${dirB}) has a bench.ts that does not record the server's footprint, and it is the harness of both sides: the memory gate cannot apply.`,
	);
}

// ------------------------------------------------------------------ A, B, A′
interface Measured {
	run: Run;
	report: Report;
	loadAtStart: number;
	waitedMin: number;
	provisional: boolean;
	caveats: string[];
}
const measured: Measured[] = [];
say("\n| run | checkout | load at start | waited | provisional |\n| --- | --- | ---: | ---: | --- |");
const rows: string[] = [];
for (const run of plan) {
	console.error(`\n=== ${run.label}: waiting for a quiet machine (load <= ${maxLoad}) ...`);
	const q = await waitForQuiet({
		readLoad: () => os.loadavg()[0],
		sleep: (ms) => sleep(ms),
		now: () => performance.now(),
		maxLoad,
		maxWaitMs: maxWaitMin * 60_000,
		pollMs: pollSec * 1000,
		onWait: (load, waited) =>
			console.error(`load ${load.toFixed(1)} > ${maxLoad}: waiting (${Math.round(waited / 1000)} s)${busiest()}`),
	});
	const allowLoad = !q.quiet;
	if (allowLoad && onTimeout === "refuse") {
		for (const r of rows) say(r);
		finish(
			GATE_EXIT.refused,
			`REFUSED: the machine did not get quiet before ${run.label} (load ${q.load.toFixed(1)} > ${maxLoad} after ${(q.waitedMs / 60_000).toFixed(1)} min); nothing was measured under load.${busiest()} Rerun later, or pass --on-timeout provisional to measure anyway (everything is then marked PROVISIONAL)`,
		);
	}
	if (allowLoad)
		console.error(
			`!!! load ${q.load.toFixed(1)} after ${(q.waitedMs / 60_000).toFixed(1)} min: measuring anyway (--on-timeout provisional): PROVISIONAL`,
		);
	const cmd = [
		"scripts/bench.ts",
		"--label",
		run.label,
		"--runs",
		runs,
		"--warmup",
		warmup,
		"--shards",
		shards,
		"--out",
		out,
	];
	if (only) cmd.push("--only", only);
	if (allowLoad) cmd.push("--allow-load");
	const fd = logFile(`run-${run.label}.log`);
	const r = spawnSync("bun", cmd, { cwd: run.dir, stdio: ["ignore", fd, fd] });
	closeSync(fd);
	if (r.status !== 0 || !existsSync(reportPath(run))) {
		for (const row of rows) say(row);
		finish(GATE_EXIT.refused, `RUN FAILED: ${run.label} exited ${r.status} (see ${join(out, `run-${run.label}.log`)})`);
	}
	const rep = JSON.parse(readFileSync(reportPath(run), "utf8")) as Report;
	const m: Measured = {
		run,
		report: rep,
		loadAtStart: q.load,
		waitedMin: q.waitedMs / 60_000,
		provisional: rep.provisional || allowLoad,
		caveats: rep.caveats,
	};
	measured.push(m);
	const row = `| ${run.label} | ${run.dir} | ${q.load.toFixed(1)} | ${m.waitedMin.toFixed(1)} min | ${m.provisional ? `**PROVISIONAL**: ${m.caveats.join("; ") || "run with --allow-load"}` : "no"} |`;
	rows.push(row);
	console.error(row);
}
for (const row of rows) say(row);

// ------------------------------------------------------------------ the three comparisons, with B's own harness
const pairs = [
	["AB", plan[0], plan[1]],
	["AA2", plan[0], plan[2]],
	["A2B", plan[2], plan[1]],
] as const;
const codes: Record<string, number> = {};
for (const [name, x, y] of pairs) {
	const r = spawnSync(
		"bun",
		["scripts/bench.ts", "--compare", reportPath(x), reportPath(y), "--threshold", threshold],
		{ cwd: dirB, encoding: "utf8" },
	);
	writeFileSync(join(out, `cmp-${name}.md`), r.stdout);
	// A crash also exits 1: a real comparison says something on stdout and nothing on stderr.
	codes[name] = r.stderr.trim() || !r.stdout.trim() ? 99 : (r.status ?? 99);
	say(
		`\ncmp-${name}.md: ${x.label} vs ${y.label}: exit ${codes[name]}${r.stderr.trim() ? ` (stderr: ${r.stderr.trim().slice(0, 200)})` : ""}`,
	);
	const worse = /^\d+ metric\(s\) worse: .*$/m.exec(r.stdout)?.[0];
	if (worse) say(`  ${worse}`);
	if (/Memory gate not applied/.test(r.stdout)) say("  memory gate not applied (a report has no footprint metrics)");
}

const provisional = measured.some((m) => m.provisional);
const noFootprint = labelsWithoutFootprint(measured.map((m) => m.report));
if (noFootprint.length) say(`\nNo footprint metrics in ${noFootprint.join(", ")}: memory was not gated.`);
const code = gateExitCode(
	{ ab: codes.AB, aa2: codes.AA2, a2b: codes.A2B },
	{ provisionalRuns: provisional, memoryGated: noFootprint.length === 0 },
);
const reasons = [
	provisional ? "a run was made on a machine that was not quiet (or otherwise off)" : "",
	noFootprint.length ? `memory was not gated (no footprint metrics in ${noFootprint.join(", ")})` : "",
].filter(Boolean);
const text: Record<number, string> = {
	[GATE_EXIT.pass]:
		"PASS: B is not worse than A or A′ on any gated metric (memory included: footprint), and A matches A′",
	[GATE_EXIT.regression]: "REGRESSION: B is worse than A or A′ on a gated metric (see cmp-AB.md, cmp-A2B.md)",
	[GATE_EXIT.unusable]: "UNUSABLE: a report is invalid or the reports are not comparable (see the cmp files)",
	[GATE_EXIT.drift]:
		"DRIFT: A differs from A′ on a gated metric (cmp-AA2.md): the machine moved between the runs, A against B proves nothing; measure again",
	[GATE_EXIT.provisionalPass]: `PROVISIONAL: nothing is worse, but ${reasons.join(" and ")}: this is not evidence`,
};
finish(code, `${text[code]}${reasons.length && code !== GATE_EXIT.provisionalPass ? ` [${reasons.join("; ")}]` : ""}`);
