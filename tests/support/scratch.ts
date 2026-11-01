import { rmSync } from "node:fs";
import { platformId } from "../../server/platform/capabilities.ts";

/**
 * Remove a test's scratch folder. Windows refuses to delete a file this process still has open (a store's SQLite database
 * and its WAL, held until the process ends): there what cannot be removed now is left in the temp folder, which the CI
 * runner discards with the job, rather than failing the test file.
 */
export function removeScratch(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (platformId !== "win32" || (code !== "EBUSY" && code !== "EPERM")) throw error;
	}
}
