import type { OmpFrame } from "./protocol.ts";

/**
 * What the server holds of a process for the pages that attach to it later, beyond its dialogs and the message omp is
 * writing: omp announces these once (a compaction begins, an extension puts a line on the screen, a `!command` starts),
 * and a page that was not listening then would otherwise never know (#587). The server keeps each as the frame that
 * said it, sends them to a page that attaches (`Live.resync`) and then names what it holds (`AttachedHold`), so that a
 * page that held more than that (the thing ended while it was away) drops the rest. The page folds the same frames
 * with the same reading (`applyFrame`), which lives here so that the two cannot disagree on what a frame names.
 */

/** What the server says it holds, by the names the page keeps each under (see `ServerMessage` `attached`). */
export interface AttachedHold {
	/** omp is compacting the context by itself (`auto_compaction_start` without its end). */
	compacting: boolean;
	/** The keys of the extension status lines that are set (`setStatus`). */
	statuses: string[];
	/** The keys of the extension widgets that are set (`setWidget`). */
	widgets: string[];
	/** The `!commands` still running, by the id the server gave them (`bash_started`). */
	bashes: string[];
}

/**
 * Nothing held. An `attached` frame from a server that predates `held` names nothing of what it keeps, and is read as
 * this: the page folds it like any other (it drops what it shows beyond the frame's names) instead of throwing.
 */
export const EMPTY_HOLD: AttachedHold = { compacting: false, statuses: [], widgets: [], bashes: [] };

/** A `!command` that runs: what `bash_started` says of it. */
export interface BashRun {
	id: string;
	command: string;
	/** When it began, on the server's clock. */
	startedAt: number;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

/** The line an extension's `setStatus` sets under `key`; no `text` takes it away. */
export function statusOf(frame: OmpFrame): { key: string; text: string | undefined } {
	return {
		key: str(frame.statusKey) ?? str(frame.key) ?? "status",
		text: (str(frame.statusText) ?? str(frame.text)) || undefined,
	};
}

/** The widget an extension's `setWidget` sets under `key`; no lines take it away. */
export function widgetOf(frame: OmpFrame): { key: string; lines: string[] } {
	return {
		key: str(frame.widgetKey) ?? "widget",
		lines: Array.isArray(frame.widgetLines)
			? (frame.widgetLines as string[])
			: Array.isArray(frame.lines)
				? (frame.lines as string[])
				: [],
	};
}

/** The `bash_started` frame the server says a `!command` begins with. */
export function bashStarted(run: BashRun): OmpFrame {
	return { type: "bash_started", id: run.id, command: run.command, startedAt: run.startedAt };
}

/**
 * The `bash_ended` frame the server says a `!command` ends with. Given the run, it also says what the command was, when
 * it ended and how long it ran (#657: the page shows the length beside what the command printed), all on the server's clock.
 */
export function bashEnded(id: string, run?: BashRun, endedAt: number = Date.now()): OmpFrame {
	if (!run) return { type: "bash_ended", id };
	return { type: "bash_ended", id, command: run.command, endedAt, durationMs: Math.max(0, endedAt - run.startedAt) };
}

/** What a `bash_started` frame says, or null for one that is no use. */
export function bashRunOf(frame: OmpFrame): BashRun | null {
	const id = str(frame.id);
	const command = str(frame.command);
	const startedAt = frame.startedAt;
	return id && command !== undefined && typeof startedAt === "number" ? { id, command, startedAt } : null;
}
