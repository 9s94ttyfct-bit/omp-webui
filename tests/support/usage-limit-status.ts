import { execFileSync } from "node:child_process";
import { compareVersions, parseVersion } from "../../shared/omp-install.ts";

let status: number | undefined;

/**
 * The HTTP status a stub provider refuses with for a usage limit that omp's turn retry waits out, whatever its reset
 * (seconds or hours), for the omp the tests run (`OMP_BIN`, else `omp`). Before 18.17 omp's transport retried a 429
 * whose reset is under a minute by itself, below the turn retry, while a 402 reached the turn retry as a usage limit;
 * from 18.17 on a 402 is a billing cap, which no reset ends, so omp fails the turn at once, and the transport leaves a
 * usage-limit 429 to the turn retry. Asked of omp once, when first needed (the stubs also run under Node, in the
 * end-to-end suite, where most never refuse).
 */
export function usageLimitStatus(): number {
	if (status !== undefined) return status;
	let version = "";
	try {
		version = execFileSync(process.env.OMP_BIN ?? "omp", ["--version"], { encoding: "utf8" }).trim();
	} catch {}
	status = parseVersion(version) !== null && compareVersions(version, "18.17.0") < 0 ? 402 : 429;
	return status;
}
