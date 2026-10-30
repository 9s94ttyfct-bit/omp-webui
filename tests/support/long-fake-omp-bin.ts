import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * An executable that is `long-fake-omp.ts` (usable as `OMP_BIN`): written into `dir`, it runs the script under Bun.
 * For the long-run harness and the specs that need an omp that streams a long turn without a model.
 */
export function writeLongFakeOmp(dir: string): string {
	const bin = join(dir, "omp");
	const script = join(dirname(fileURLToPath(import.meta.url)), "long-fake-omp.ts");
	writeFileSync(bin, `#!/bin/sh\nexec bun ${script} "$@"\n`, { mode: 0o755 });
	return bin;
}
