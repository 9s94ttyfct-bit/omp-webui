import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeBunLauncher } from "./bun-program.ts";

/**
 * An executable that is `long-fake-omp.ts` (usable as `OMP_BIN`): written into `dir`, it runs the script under Bun.
 * For the long-run harness and the specs that need an omp that streams a long turn without a model.
 */
export function writeLongFakeOmp(dir: string): string {
	return writeBunLauncher(dir, "omp", join(dirname(fileURLToPath(import.meta.url)), "long-fake-omp.ts"));
}
