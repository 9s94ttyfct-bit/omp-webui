/**
 * `bun test` with the gate's worker count (`bun scripts/gate-test.ts [bun test args]`): half the cores, rounded up, at
 * least 2, or `OMPW_TEST_WORKERS` (scripts/lib/test-workers.ts, #1). `test:release` and `test:live` run through it.
 * The command's exit code is this one's; a signal stops it and everything it started.
 */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { killTree, onShutdown } from "./lib/shutdown.ts";
import { gateTestCommand } from "./lib/test-workers.ts";

let command: string[];
try {
	command = gateTestCommand(process.argv.slice(2));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(2);
}
console.log(`$ ${command.join(" ")}`);
const [bin, ...args] = command;
const child = spawn(bin, args, { stdio: "inherit" });
const cleanup = onShutdown(async () => {
	if (child.pid) await killTree(child.pid, 15_000);
});
const finished = Promise.withResolvers<number>();
child.once("error", (error) => {
	console.error(`${bin}: ${error.message}`);
	finished.resolve(127);
});
child.once("exit", (status, signal) => finished.resolve(status ?? 128 + (signal ? constants.signals[signal] : 0)));
const code = await finished.promise;
await cleanup();
process.exit(code);
