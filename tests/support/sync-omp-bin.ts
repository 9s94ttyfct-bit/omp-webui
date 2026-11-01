import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeBunLauncher } from "./bun-program.ts";

/** An executable that is `sync-omp.ts` (usable as `OMP_BIN`), written into `dir`: the omp a test conducts. */
export function writeSyncOmp(dir: string): string {
	return writeBunLauncher(dir, "omp", join(dirname(fileURLToPath(import.meta.url)), "sync-omp.ts"));
}
