import { rmSync } from "node:fs";
import { platformId } from "../../server/platform/capabilities.ts";

/**
 * Remove a test's scratch folder. Windows refuses to delete a file a process still has open (a store's SQLite database
 * and its WAL, held until the process ends; a server that is still going away): there what cannot be removed after a
 * few tries is left in the temp folder, which the CI runner discards with the job, rather than failing the test file.
 */
export function removeScratch(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (platformId !== "win32" || (code !== "EBUSY" && code !== "EPERM")) throw error;
	}
}
