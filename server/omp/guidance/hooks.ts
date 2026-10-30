import type { GuidanceTemplate, LiveGuidance } from "../../../shared/model-guidance.ts";
import type { GuidanceSessions, KeptGuidance } from "./session.ts";

/**
 * What the pool needs of model guidance (#641), as `RiskGate` is what it needs of the guard: the extension omp is started
 * with, the files it reads, and the templates the pages manage.
 *
 * `LivePool.guidance` is null where the app has none (a server that started without a data dir): a conversation then
 * carries no guidance, and the routes are not there.
 */
export interface GuidanceHooks {
	/** The extension omp is started with (`--extension`), written by `ensure`. */
	extension: string;
	/**
	 * Make sure the extension's files are as the server has them, before a process is started with it: files deleted or
	 * changed since the server started are written again. False when they cannot be: that process starts without it.
	 */
	ensure(): boolean;
	/** The file the conversation `liveId`'s omp reads its guidance from (`overlay`: its settings overlay, whose folder goes with it). */
	fileFor(liveId: string, overlay: string | null): string;
	/** Write the text, or take the file away when there is none (a process that reads it then carries none). */
	write(file: string, text: string | null): void;
	/** What each conversation carries, kept by session file. */
	sessions: GuidanceSessions;
	/** The templates as they are now, for the name a page shows of the one a conversation uses. */
	templates(): readonly GuidanceTemplate[];
}

/** What a page is told of one conversation's guidance. */
export type { LiveGuidance };

/** `kept` as the page shows it: the template it names, as the store has it now. */
export function liveGuidanceOf(
	kept: KeptGuidance | null,
	templates: readonly GuidanceTemplate[],
	live: boolean,
	skipped?: LiveGuidance["skipped"],
): LiveGuidance | null {
	const text = kept?.text ? kept.text : "";
	if (!text) return null;
	const found = kept?.template ? templates.find((t) => t.id === kept.template) : undefined;
	return {
		template: found ? found.id : null,
		templateName: found ? found.name : null,
		text,
		live,
		...(skipped ? { skipped } : {}),
	};
}
