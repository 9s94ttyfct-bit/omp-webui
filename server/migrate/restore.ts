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
import path, { join } from "node:path";
import { CodedError } from "../../shared/error-info.ts";
import { isRecord } from "../../shared/guards.ts";

/**
 * Putting a computer back as it was before an import: what the import changed was copied to `<backup>/files/<its path>`
 * first (`backupCopy`), and what it made is listed in `created.txt`, both written down before each file was touched (see
 * `Apply.touch`). The folder says how to do it by hand too, so that nothing depends on this app being able to run.
 */

/** The marker `backup.json` carries: a folder that does not is not one of ours, and nothing in it is put anywhere. */
export const BACKUP_APP = "omp-webui-migration-backup";

export const RESTORE_NOTE =
	"Put the files under `files/` back at their own paths (a file under `files/` is the whole file; on Windows the first " +
	"folder is the drive, `files/C/…` being `C:\\…`, or `UNC/<host>/<share>` for a share; for a .db file delete its -wal " +
	"and -shm first, they describe the database that is being replaced), and delete the files listed in created.txt. " +
	"Settings › Move to another computer › Restore does exactly that.";

/**
 * Where a backup keeps the copy of `dest`: under `files/`, at its path from the root it is on. A drive (`C:\`) is a
 * folder of its own (`files/C/…`) and a share (`\\host\share\`) is `files/UNC/host/share/…`: Windows makes no path
 * with a second `C:` in it. On macOS and Linux it is `files/` and the path, as it always was.
 */
export function backupCopy(dir: string, dest: string, p: typeof path = path): string {
	const { root } = p.parse(dest);
	const top = root
		.split(/[\\/]/)
		.filter(Boolean)
		.map((part) => part.replace(/:$/, ""));
	if (/^[\\/]{2}/.test(root)) top.unshift("UNC");
	return p.join(dir, "files", ...top, dest.slice(root.length));
}

/** The paths a backup's list (`changed.txt`, `created.txt`) names, one a line: a line that is not a full path is passed over. */
export function listedPaths(text: string, p: typeof path = path): string[] {
	return text.split("\n").filter((line) => line !== "" && p.isAbsolute(line));
}

const listed = (file: string): string[] => {
	try {
		return listedPaths(readFileSync(file, "utf8"));
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
	for (const dest of listed(join(dir, "changed.txt"))) {
		const from = backupCopy(dir, dest);
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
	for (const made of listed(join(dir, "created.txt"))) {
		if (!existsSync(made)) continue;
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
