/**
 * Compact between two steps (#651, option b): a compact queued while the agent works can run at the next point where no
 * work is in flight, which is the moment after a step's tools have all returned and before the next model request. omp has
 * no event that says so in time for a command to arrive, so the server holds omp there with an extension of its own
 * (`server/omp/compact-step/extension.ts`): it waits in a dialog the server consumes, and the server's `compact` ends the wait.
 *
 * This file is what the server and the extension agree on. The extension is copied into the app's data folder with it
 * (`install.ts`), because omp reads an extension from a file, so it imports nothing else of the app.
 */

/** The environment variable that names a process's file: the server writes it while a compact waits for a step boundary, and takes it away when it does not. */
export const COMPACT_STEP_FILE_ENV = "OMPW_COMPACT_STEP_FILE";
/** Added to the process's settings overlay to make its file's name (`CompactStepService.fileFor`). */
export const COMPACT_STEP_SUFFIX = ".compactstep";
/** Added to the file's name for the note the extension leaves when it has started: omp carries on without an extension it could not load. */
export const COMPACT_STEP_LOADED_SUFFIX = ".loaded";
/** The dialog the extension waits in; the server takes it, so that no page is shown it. */
export const COMPACT_STEP_DIALOG_TITLE = "omp-webui: compact between two steps";
/** The one answer of that dialog: the server's way of saying "go on, nothing is compacted now". */
export const COMPACT_STEP_DIALOG_CONTINUE = "Continue";
/**
 * How long the extension holds at one boundary before it lets the conversation go on by itself. omp gives a `context` handler 30 s
 * and no dialog pauses it (only a `tool_call` handler's budget is paused), after which it goes on to the model request: the
 * extension lets go before that, so that the request is its decision, and a server that is gone costs a step this long, once.
 */
export const COMPACT_STEP_HOLD_MS = 20_000;
/** How often the extension looks at its file while it holds. */
export const COMPACT_STEP_POLL_MS = 100;

/** What the server writes: a compact waits for a step boundary, asked at `at` (the server's clock; it names the request). */
export function compactStepFileText(at: number): string {
	return `${JSON.stringify({ wanted: true, at })}\n`;
}

/** The request the file names, or null: no text, text that is not a request, or a request that is not a wait for a step boundary. */
export function parseCompactStepFile(text: string): { at: number } | null {
	let parsed: { wanted?: unknown; at?: unknown } | null;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	if (parsed.wanted !== true || typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) return null;
	return { at: parsed.at };
}
