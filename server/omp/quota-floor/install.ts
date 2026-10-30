import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { source } from "./source-macro.ts" with { type: "macro" };

/**
 * Put the quota floor's extension (`extension.ts`) where omp can read it, beside the gate's and the others': omp loads an
 * extension from a file, and the compiled server holds its sources inside itself. The files are written under
 * `<data dir>/quota-floor/` in the layout they have in the source tree, so that the extension's one import resolves the same
 * way in both. A file is written again only when it differs (an update changes it; a process started before keeps the copy it
 * loaded).
 */
const FILES: Readonly<Record<string, string>> = {
	"server/omp/quota-floor/extension.ts": source("extension.ts"),
	"shared/quota-hold.ts": source("../../../shared/quota-hold.ts"),
};

/** The folder the extension lives in, and the file omp is given (`--extension`). */
export function quotaPaths(dataDir: string): { dir: string; extension: string } {
	const dir = join(dataDir, "quota-floor");
	return { dir, extension: join(dir, "server/omp/quota-floor/extension.ts") };
}

/** Write the extension's files under `dataDir`; the answer is the extension's path. Throws when they cannot be written. */
export function installQuotaExtension(dataDir: string): string {
	const { dir, extension: path } = quotaPaths(dataDir);
	for (const [name, text] of Object.entries(FILES)) {
		const file = join(dir, name);
		try {
			if (readFileSync(file, "utf8") === text) continue;
		} catch {
			// Not there yet.
		}
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const temporary = `${file}.${process.pid}.tmp`;
		writeFileSync(temporary, text, { mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, file);
	}
	return path;
}
