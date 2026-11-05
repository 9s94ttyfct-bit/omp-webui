import { join } from "node:path";
import { installFiles } from "../extension-files.ts";
import { source } from "../source-macro.ts" with { type: "macro" };

/**
 * Put the quota floor's extension (`extension.ts`) where omp can read it, beside the gate's and the others': omp loads an
 * extension from a file, and the compiled server holds its sources inside itself. The files are written under
 * `<data dir>/quota-floor/` in the layout they have in the source tree, so that the extension's one import resolves the same
 * way in both. A file is written again only when it differs (an update changes it; a process started before keeps the copy it
 * loaded).
 */
const FILES: Readonly<Record<string, string>> = {
	"server/omp/quota-floor/extension.ts": source("server/omp/quota-floor/extension.ts"),
	"shared/quota-hold.ts": source("shared/quota-hold.ts"),
};

/** The folder the extension lives in, and the file omp is given (`--extension`). */
export function quotaPaths(dataDir: string): { dir: string; extension: string } {
	const dir = join(dataDir, "quota-floor");
	return { dir, extension: join(dir, "server/omp/quota-floor/extension.ts") };
}

/** Write the extension's files under `dataDir`; the answer is the extension's path. Throws when they cannot be written. */
export function installQuotaExtension(dataDir: string): string {
	const { dir, extension } = quotaPaths(dataDir);
	installFiles(dir, FILES);
	return extension;
}
