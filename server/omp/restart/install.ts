import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { installFiles } from "../extension-files.ts";
import { source } from "../source-macro.ts" with { type: "macro" };
import { RestartStore } from "./store.ts";

/**
 * Put the `restart_session` extension (`extension.ts`) where omp can read it, beside the server's other extensions: omp
 * loads an extension from a file, and the compiled server holds its source inside itself. The file is written under
 * `<data dir>/restart/` in the layout it has in the source tree, again only when it differs (an update changes it; a
 * process started before keeps the copy it loaded).
 */
const FILES: Readonly<Record<string, string>> = {
	"server/omp/restart/extension.ts": source("server/omp/restart/extension.ts"),
};

/** The folder the extension lives in, the file omp is given (`--extension`), and where the processes' limit files go. */
export function restartPaths(dataDir: string): { dir: string; extension: string; live: string } {
	const dir = join(dataDir, "restart");
	return { dir, extension: join(dir, "server/omp/restart/extension.ts"), live: join(dir, "live") };
}

/** Write the extension's files under `dataDir`; the answer is the extension's path. Throws when they cannot be written. */
export function installRestartExtension(dataDir: string): string {
	const { dir, extension } = restartPaths(dataDir);
	installFiles(dir, FILES);
	return extension;
}

/**
 * What the server needs of `restart_session`: the extension omp is started with, the file each process reads its limit
 * from, and the requests. `LivePool.restarts` (the coordinator, which holds this) is null where the app has none (a server
 * that started without a data dir): its conversations then have no `restart_session`.
 */
export class RestartService {
	readonly store: RestartStore;

	constructor(
		private readonly dataDir: string,
		now: () => number = Date.now,
	) {
		this.store = new RestartStore(dataDir, now);
	}

	/** The extension omp is started with (`--extension`). */
	get extension(): string {
		return restartPaths(this.dataDir).extension;
	}

	/** Make sure the extension's files are as the server has them. False when they cannot be. */
	ensure(): boolean {
		try {
			installRestartExtension(this.dataDir);
			return true;
		} catch (e) {
			console.warn(`omp-webui: could not set up the restart_session tool for a conversation: ${(e as Error).message}`);
			return false;
		}
	}

	/** The file the process `liveId` reads its limit from (`OMPW_RESTART_FILE`). It follows from the id, so a server that takes the process over writes the same file. */
	fileFor(liveId: string): string {
		return join(restartPaths(this.dataDir).live, `${liveId}.json`);
	}

	/** Tell the process that reads `file` until when it may not ask for a restart (null: it may). */
	writeLimit(file: string, blockedUntil: number | null): void {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const temporary = `${file}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify({ blockedUntil }), { mode: 0o600 });
		renameSync(temporary, file);
	}

	/** The process has ended: its file goes. */
	removeLimit(file: string): void {
		rmSync(file, { force: true });
	}
}
