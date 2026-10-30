import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { COMPACT_STEP_SUFFIX, compactStepFileText } from "../../../shared/compact-step.ts";
import { compactStepPaths, installCompactStepExtension } from "./install.ts";

/**
 * What the pool needs of compacting between two steps (#651), as `QuotaFloorHooks` is what it needs of the quota floor: the
 * extension omp is started with and the file it reads. `LivePool.compactStep` is null where the app has none (a server that
 * started without a data dir): a conversation then compacts at the end of the turn, and says so.
 */
export interface CompactStepHooks {
	/** The extension omp is started with (`--extension`). */
	readonly extension: string;
	/** Make sure the extension's files are as the server has them, before a process is started with it. False when they cannot be. */
	ensure(): boolean;
	/** The file the conversation `liveId`'s omp reads its request from (`overlay`: its settings overlay, whose folder goes with it). */
	fileFor(liveId: string, overlay: string | null): string;
	/** Say that a compact waits for a step boundary (`at` names the request), or take the file away when none does. Throws when it cannot. */
	write(file: string, at: number | null): void;
}

/**
 * A conversation's file is written beside its settings overlay, in the temp folder the overlays are made in
 * (`server/omp/approval.ts`), because it is that process's alone and goes with it. A process that has no overlay (modes are not
 * managed, as in some tests) gets a file under `<data dir>/compact-step/live/`, a path that follows from the process's id: a
 * conversation taken over by the next server is then told the same file.
 */
export class CompactStepService implements CompactStepHooks {
	private readonly fallback: string;

	constructor(private readonly dataDir: string) {
		this.fallback = join(dataDir, "compact-step", "live");
	}

	get extension(): string {
		return compactStepPaths(this.dataDir).extension;
	}

	ensure(): boolean {
		try {
			installCompactStepExtension(this.dataDir);
			return true;
		} catch (e) {
			console.warn(`omp-webui: could not set up compacting between steps for a conversation: ${(e as Error).message}`);
			return false;
		}
	}

	fileFor(liveId: string, overlay: string | null): string {
		return overlay ? `${overlay}${COMPACT_STEP_SUFFIX}` : join(this.fallback, `${liveId}${COMPACT_STEP_SUFFIX}`);
	}

	write(file: string, at: number | null): void {
		if (at === null) {
			rmSync(file, { force: true });
			return;
		}
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, compactStepFileText(at), { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, file);
	}
}
