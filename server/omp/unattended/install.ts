import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { source } from "./source-macro.ts" with { type: "macro" };

/**
 * Put the unattended-mode extension (`extension.ts`) where omp can read it, beside the gate's and the model guidance's
 * own files: omp loads an extension from a file, and the compiled server holds its sources inside itself. The file is
 * written under `<data dir>/unattended/` in the layout it has in the source tree. It is written again only when it differs
 * (an update changes it; a process started before keeps the copy it loaded).
 *
 * The extension is one file that imports nothing of the app: it reads the instruction from the file the server names in the
 * process's environment (`OMPW_UNATTENDED_FILE`), which is written per conversation (`session.ts`).
 */
const FILES: Readonly<Record<string, string>> = {
	"server/omp/unattended/extension.ts": source("extension.ts"),
};

/** The folder the extension lives in, and the file omp is given (`--extension`). */
export function unattendedPaths(dataDir: string): { dir: string; extension: string } {
	const dir = join(dataDir, "unattended");
	return { dir, extension: join(dir, "server/omp/unattended/extension.ts") };
}

/** Write the extension's files under `dataDir`; the answer is the extension's path. Throws when they cannot be written. */
export function installUnattendedExtension(dataDir: string): string {
	const { dir, extension: path } = unattendedPaths(dataDir);
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
