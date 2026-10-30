import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { readlink } from "node:fs/promises";
import { join } from "node:path";
import { CodedError } from "../../shared/error-info.ts";
import { isRecord } from "../../shared/guards.ts";

/**
 * Putting a Mac back as it was before an import: what the import changed was copied to `<backup>/files/<its path>` first,
 * and what it made is listed in `created.txt`, both written down before each file was touched (see `Apply.touch`). The
 * folder says how to do it by hand too, so that nothing depends on this app being able to run.
 */

/** The marker `backup.json` carries: a folder that does not is not one of ours, and nothing in it is put anywhere. */
export const BACKUP_APP = "omp-webui-migration-backup";

export const RESTORE_NOTE =
	"Put the files under `files/` back at their own paths (a file under `files/` is the whole file; for a .db file delete " +
	"its -wal and -shm first, they describe the database that is being replaced), and delete the files listed in " +
	"created.txt. Settings › Move to another computer › Restore does exactly that.";

const lines = (file: string): string[] => {
	try {
		return readFileSync(file, "utf8").split("\n").filter(Boolean);
	} catch {
		return [];
	}
};

export interface Restored {
	restored: number;
	removed: number;
}

/** What an import changed put back, and what it made removed; a file that is gone from the backup is left as it is. */
export async function restoreBackup(dir: string): Promise<Restored> {
	let note: unknown;
	try {
		note = JSON.parse(readFileSync(join(dir, "backup.json"), "utf8"));
	} catch {
		throw new CodedError("There is no backup to put back", "migrateNoBackup");
	}
	if (!isRecord(note) || note.app !== BACKUP_APP)
		throw new CodedError("There is no backup to put back", "migrateNoBackup");
	let restored = 0;
	for (const dest of lines(join(dir, "changed.txt"))) {
		if (!dest.startsWith("/")) continue;
		const from = join(dir, "files", dest);
		let saved: ReturnType<typeof lstatSync>;
		try {
			saved = lstatSync(from);
		} catch {
			continue;
		}
		const tmp = `${dest}.ompw-restore`;
		rmSync(tmp, { force: true });
		if (saved.isSymbolicLink()) {
			symlinkSync(await readlink(from), tmp);
		} else {
			copyFileSync(from, tmp);
			chmodSync(tmp, saved.mode & 0o777);
		}
		// A database comes back without the -wal and -shm of the one it replaces: they describe that file, not this one.
		if (/\.db$/.test(dest)) {
			rmSync(`${dest}-wal`, { force: true });
			rmSync(`${dest}-shm`, { force: true });
		}
		renameSync(tmp, dest);
		restored++;
	}
	let removed = 0;
	for (const made of lines(join(dir, "created.txt"))) {
		if (!made.startsWith("/") || !existsSync(made)) continue;
		try {
			if (lstatSync(made).isDirectory()) continue;
			rmSync(made, { force: true });
			removed++;
		} catch {
			// Not there any more, or not ours to remove: left.
		}
	}
	writeFileSync(
		join(dir, "backup.json"),
		JSON.stringify({ ...note, status: "restored", restoredAt: new Date().toISOString() }, null, 2),
	);
	return { restored, removed };
}
