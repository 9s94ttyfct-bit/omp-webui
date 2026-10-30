import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** An executable that is `sync-omp.ts` (usable as `OMP_BIN`), written into `dir`: the omp a test conducts. */
export function writeSyncOmp(dir: string): string {
	const bin = join(dir, "omp");
	const script = join(dirname(fileURLToPath(import.meta.url)), "sync-omp.ts");
	writeFileSync(bin, `#!/bin/sh\nexec bun ${script} "$@"\n`, { mode: 0o755 });
	return bin;
}
