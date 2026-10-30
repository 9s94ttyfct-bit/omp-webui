import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Temp directories a test makes and does not remove itself. Each one is made by `mkdtemp` in the system's temp dir and
 * removed when the test process ends its tests (`removeTrackedTempDirs`, from `preload.ts` under Bun; a Playwright spec
 * calls it from its own `afterAll`), so a run does not leave thousands of them behind (#768).
 */

const dirs = new Set<string>();

/** A new directory `<tmpdir>/<prefix>XXXXXX`, removed at the end of the run (see above). Keep `prefix` short: socket paths. */
export function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.add(dir);
	return dir;
}

/** Remove every directory `tempDir` made in this process. */
export function removeTrackedTempDirs(): void {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	dirs.clear();
}
