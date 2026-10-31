/**
 * How many `bun test` workers the gate scripts that run on a Mac in use start (#1): `test:release`, `test:mac` and
 * `test:live`, the last two run by scripts/release-local.ts. Bun's own `--parallel` starts one worker per core, and every
 * contract worker starts its own server and omp processes; on a 12-core Mac that someone is working on, the v0.12.1 gate
 * reached a load of 29–45 and swapped, and correct tests timed out. The gate takes half the cores, rounded up, and never
 * fewer than 2; `OMPW_TEST_WORKERS` (a whole number from 1) overrides it. `test`, `test:contract` and `test:all` keep one
 * worker per core.
 */
import { availableParallelism } from "node:os";

export const TEST_WORKERS_ENV = "OMPW_TEST_WORKERS";

/** The worker count for `cores` cores, unless `env` sets `OMPW_TEST_WORKERS`. A value that is not a count is refused. */
export function gateWorkers(cores: number, env: Record<string, string | undefined> = {}): number {
	const set = env[TEST_WORKERS_ENV];
	if (set !== undefined && set !== "") {
		if (!/^[1-9]\d*$/.test(set)) throw new Error(`${TEST_WORKERS_ENV} must be a whole number from 1, not "${set}"`);
		return Number(set);
	}
	return Math.max(2, Math.ceil(cores / 2));
}

/** `bun test` with the gate's worker count on this machine, then `args`. */
export function gateTestCommand(args: string[], env: Record<string, string | undefined> = process.env): string[] {
	return ["bun", "test", `--parallel=${gateWorkers(availableParallelism(), env)}`, ...args];
}
