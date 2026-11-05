import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The files of the server's own omp extensions (the gate, the model guidance, unattended mode, the quota floor, compacting
 * between steps, `restart_session`, `webui_docs`): omp loads an extension from a file, and the compiled server holds their
 * sources inside itself (`source-macro.ts`), so it writes them out under its data dir; and the file each conversation's
 * extension reads what the server tells it from.
 */

/**
 * Write `files` (a path under `dir`, in the layout of the source tree so that their imports resolve the same way, to its
 * text) under `dir`. A file is written again only when it differs (an update changes it; a process started before keeps
 * the copy it loaded), whole to a temporary file that then replaces it. Throws when one cannot be written.
 */
export function installFiles(dir: string, files: Readonly<Record<string, string>>): void {
	for (const [name, text] of Object.entries(files)) {
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
}

/**
 * A conversation's file of one of these extensions: `text` written whole to `<file>.tmp` (private to the user) that then
 * replaces it, or the file taken away when `text` is null. Throws when it cannot be written.
 */
export function writePrivateText(file: string, text: string | null): void {
	if (text === null) {
		rmSync(file, { force: true });
		return;
	}
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, file);
}
