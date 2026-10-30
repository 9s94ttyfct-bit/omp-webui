import { join } from "node:path";
import type { GuidanceProblem, GuidanceTemplate, GuidanceTemplates } from "../../../shared/model-guidance.ts";
import type { GuidanceHooks } from "./hooks.ts";
import { guidancePaths, installGuidanceExtension } from "./install.ts";
import { GuidanceSessions, guidanceFileFor, writeGuidanceFile } from "./session.ts";
import { GuidanceStore } from "./store.ts";

/**
 * The model guidance of this server (#641): the templates the person saved (`store.ts`), what each conversation was given
 * (`session.ts`), and the extension omp is started with (`install.ts`, `extension.ts`), as one thing the pool and the routes
 * ask (`GuidanceHooks`).
 *
 * The extension is installed beside the app's other files under the data dir, and made good before every process that is
 * started with it; a data dir that cannot hold it leaves those processes without it, and the conversation says so
 * (`LiveGuidance.skipped`).
 *
 * A conversation's guidance file is written beside its settings overlay, in the temp folder the overlays are made in
 * (`server/omp/approval.ts`), because it is that process's alone and goes with it. A process that has no overlay (modes are
 * not managed, as in some tests) gets a file under `<data dir>/guidance/live/`, which is a path that follows from the
 * process's id: a conversation taken over by the next server is then told the same file.
 */
export class GuidanceService implements GuidanceHooks {
	readonly sessions: GuidanceSessions;
	private readonly store: GuidanceStore;
	/** The folder of the conversations' guidance files that have no overlay. */
	private readonly fallback: string;

	constructor(private readonly dataDir: string) {
		this.store = new GuidanceStore(dataDir);
		this.sessions = new GuidanceSessions(dataDir, this.store);
		this.fallback = join(dataDir, "guidance", "live");
	}

	get extension(): string {
		return guidancePaths(this.dataDir).extension;
	}

	ensure(): boolean {
		try {
			installGuidanceExtension(this.dataDir);
			return true;
		} catch (e) {
			console.warn(`omp-webui: could not set up the model guidance of a conversation: ${(e as Error).message}`);
			return false;
		}
	}

	fileFor(liveId: string, overlay: string | null): string {
		return guidanceFileFor(liveId, overlay, this.fallback);
	}

	write(file: string, text: string | null): void {
		writeGuidanceFile(file, text);
	}

	templates(): readonly GuidanceTemplate[] {
		return this.store.list();
	}

	/** The templates as they are now, for a page. */
	snapshot(): GuidanceTemplates {
		return this.store.snapshot();
	}

	/** Save `template` (by id, else added; `update`: only an existing one); a change the store refuses is a `GuidanceStoreError`. */
	save(input: unknown, update = false): GuidanceTemplates {
		return this.store.save(input, update);
	}

	/** Forget the template `id`: a conversation that picked it keeps the text it stood for. */
	remove(id: unknown): GuidanceTemplates {
		return this.store.remove(id);
	}

	/** Put the shipped templates back as they ship. */
	restoreDefaults(): GuidanceTemplates {
		return this.store.restoreDefaults();
	}
}

/** The word a page is given for a change the store refuses (`shared/model-guidance.ts`). */
export function guidanceProblemOf(e: unknown): GuidanceProblem {
	const problem = (e as { problem?: unknown } | null)?.problem;
	return typeof problem === "string" ? (problem as GuidanceProblem) : "unknown";
}
