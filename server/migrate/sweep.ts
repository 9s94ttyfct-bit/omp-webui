import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * What a migration leaves in `<data dir>/migrate` — an upload (a full copy of every conversation), a finished export
 * nobody downloaded, a scratch folder — is for the server that made it: after a restart or a crash nobody asks for it, and
 * it holds the person's conversations. The server clears it when it starts. Cheap: nothing is read when the folder is not
 * there, and none of the migration code is loaded.
 */
export function sweepMigrateDir(dataDir: string): void {
	const dir = join(dataDir, "migrate");
	if (!existsSync(dir)) return;
	for (const name of readdirSync(dir)) {
		try {
			rmSync(join(dir, name), { recursive: true, force: true });
		} catch (e) {
			console.warn(`omp-webui: could not remove ${join(dir, name)}: ${(e as Error).message}`);
		}
	}
}
