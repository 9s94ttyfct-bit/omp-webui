/**
 * The end-to-end suite (`bun run test:e2e [playwright args]`), safe to run twice at once in one checkout (#769).
 *
 * Each run has a folder of its own, `.tmp/e2e/<run>/`: the page is built into its `dist` (served by its test servers
 * through `OMPW_E2E_DIST`), so a second run's build never empties the `dist/web` the first one's servers serve, and its
 * traces and report go to its `results` and `report` (through `OMPW_E2E_OUTPUT`/`OMPW_E2E_REPORT`), so neither removes
 * the other's, nor does a Playwright run started by hand, which empties `test-results/` as it starts. The build goes
 * when the run ends; the results stay (a failed test's trace is what they are for) until a later run finds them older
 * than three days.
 *
 * A Playwright run started by hand (`bunx playwright test <spec>`) still serves `dist/web` and writes `test-results/`.
 * The arguments are Playwright's; the exit code is its; a signal stops it and everything it started.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { killTree, onShutdown } from "./lib/shutdown.ts";

const root = join(import.meta.dir, "..");
const runs = join(root, ".tmp", "e2e");
const run = join(runs, `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${process.pid}`);
const dist = join(run, "dist");
const output = join(run, "results");
const report = join(run, "report");
const KEEP_MS = 3 * 24 * 3600_000;

/** The runs older than `KEEP_MS`, and the builds of runs that ended (or died) without removing theirs. */
function prune(): void {
	if (!existsSync(runs)) return;
	for (const name of readdirSync(runs)) {
		const dir = join(runs, name);
		if (alive(Number(name.split("-").at(-1)))) continue;
		if (Date.now() - statSync(dir).mtimeMs > KEEP_MS) rmSync(dir, { recursive: true, force: true });
		else rmSync(join(dir, "dist"), { recursive: true, force: true });
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Run `cmd` with this environment; resolves with its exit code. */
async function exec(cmd: string[], env: Record<string, string>): Promise<number> {
	const child = spawn(cmd[0], cmd.slice(1), { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
	current = child.pid ?? null;
	const done = Promise.withResolvers<number>();
	child.once("error", (error) => {
		console.error(`${cmd[0]}: ${error.message}`);
		done.resolve(127);
	});
	child.once("exit", (status, signal) => done.resolve(status ?? 128 + (signal ? constants.signals[signal] : 0)));
	const code = await done.promise;
	current = null;
	return code;
}

let current: number | null = null;
const cleanup = onShutdown(async () => {
	if (current) await killTree(current, 15_000);
	rmSync(dist, { recursive: true, force: true });
});

let code = 1;
try {
	prune();
	code = await exec(["bunx", "vite", "build", "--outDir", dist, "--emptyOutDir"], {});
	if (code === 0) {
		code = await exec(["bunx", "playwright", "test", ...process.argv.slice(2)], {
			OMPW_E2E_DIST: dist,
			OMPW_E2E_OUTPUT: output,
			OMPW_E2E_REPORT: report,
		});
		console.log(`e2e results: ${output}${existsSync(report) ? `, report: ${report}` : ""}`);
	}
} finally {
	await cleanup();
}
process.exit(code);
