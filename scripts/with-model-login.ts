/**
 * Runs a command with this machine's Anthropic login in its environment (`bun scripts/with-model-login.ts <cmd> [args]`;
 * the package's test scripts use it): omp is asked for the token once, here, not once by every test file and worker
 * that starts a server. A login that cannot be read (omp failing or timing out) stops the run before it starts, with
 * the reason; a machine with no login runs on, and the live-model tests skip. `OMPW_E2E_OFFLINE=1` looks nothing up.
 * `--require-login` (the `test:live` script: the tests that call a real model, nothing else) refuses to start without a
 * login, offline included, since a run in which every one of them skipped would pass and prove nothing.
 * The command's exit code is this one's; a signal stops the command and everything it started.
 */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { exportModelLogin } from "../tests/support/omp-env.ts";
import { killTree, onShutdown } from "./lib/shutdown.ts";

const requireLogin = process.argv[2] === "--require-login";
const [command, ...args] = process.argv.slice(requireLogin ? 3 : 2);
if (!command) {
	console.error("usage: bun scripts/with-model-login.ts [--require-login] <command> [args...]");
	process.exit(2);
}
try {
	if (!exportModelLogin() && requireLogin) {
		console.error(
			`These tests call a real model and need this machine's Anthropic login${process.env.OMPW_E2E_OFFLINE ? ", but OMPW_E2E_OFFLINE is set" : ""}: log in to Anthropic in omp (\`omp token anthropic\` prints it), then run them again.`,
		);
		process.exit(1);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

const child = spawn(command, args, { stdio: "inherit" });
const cleanup = onShutdown(async () => {
	if (child.pid) await killTree(child.pid, 15_000);
});
const finished = Promise.withResolvers<number>();
child.once("error", (error) => {
	console.error(`${command}: ${error.message}`);
	finished.resolve(127);
});
child.once("exit", (status, signal) => finished.resolve(status ?? 128 + (signal ? constants.signals[signal] : 0)));
const code = await finished.promise;
await cleanup();
process.exit(code);
