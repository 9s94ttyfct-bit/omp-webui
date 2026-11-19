/**
 * The end-to-end tests CI cannot run (`bun run test:live:e2e`, which the release runs after `test:live`): CI has no model
 * login and sets `OMPW_E2E_OFFLINE`, and these skip there because omp needs the login for what they test (the models of
 * the providers it is signed in to, a Full start, a real turn). They are found by that skip (either spelling, #214), so a
 * new one is never left to no gate.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { killTree, onShutdown } from "./lib/shutdown.ts";

const ROOT = join(import.meta.dirname, "..");
/** The two ways a spec skips without a login: CI's `OMPW_E2E_OFFLINE`, and a machine with no token (`OMPW_E2E_HAS_TOKEN`, set by `tests/e2e/global-setup.ts` only when a model can be called). */
const LOGIN_SKIP =
	/\btest\.skip\(\s*(?:Boolean\(\s*process\.env\.OMPW_E2E_OFFLINE\s*\)|!\s*process\.env\.OMPW_E2E_HAS_TOKEN)/;

/** The e2e specs under `root` with a test that skips without a login, relative to the checkout, sorted. */
export function liveE2e(root = ROOT): string[] {
	return readdirSync(join(root, "tests", "e2e"))
		.filter((name) => name.endsWith(".spec.ts"))
		.map((name) => `tests/e2e/${name}`)
		.filter((file) => LOGIN_SKIP.test(readFileSync(join(root, file), "utf8")))
		.sort();
}

if (import.meta.main) {
	if (process.env.OMPW_E2E_OFFLINE) {
		console.error("These tests need the model login: unset OMPW_E2E_OFFLINE and run them again.");
		process.exit(1);
	}
	const files = liveE2e();
	const args = [join(ROOT, "scripts", "e2e.ts"), ...files];
	console.log(`$ bun ${args.join(" ")}`);
	const child = spawn(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
	const cleanup = onShutdown(async () => {
		if (child.pid) await killTree(child.pid, 15_000);
	});
	const finished = Promise.withResolvers<number>();
	child.once("error", (error) => {
		console.error(`bun: ${error.message}`);
		finished.resolve(127);
	});
	child.once("exit", (status, signal) => finished.resolve(status ?? 128 + (signal ? constants.signals[signal] : 0)));
	const code = await finished.promise;
	await cleanup();
	process.exit(code);
}
