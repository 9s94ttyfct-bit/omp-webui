import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	COMPACT_STEP_DIALOG_CONTINUE,
	COMPACT_STEP_DIALOG_TITLE,
	COMPACT_STEP_FILE_ENV,
	COMPACT_STEP_HOLD_MS,
	COMPACT_STEP_LOADED_SUFFIX,
	COMPACT_STEP_POLL_MS,
	parseCompactStepFile,
} from "../../../shared/compact-step.ts";

/**
 * Compact between two steps (#651, option b), an omp extension: the web UI starts every conversation's omp with it, and it
 * does something only while the server says a compact waits for a step boundary (`shared/compact-step.ts`).
 *
 * The boundary is the moment between the tools of a step and the next model request: every tool call of the step has
 * returned, its results are in the conversation, nothing is in flight. omp calls a `context` handler right before each model
 * request, with the conversation that request will carry, so a handler that waits there holds the conversation at that moment
 * and no other; `compact` is then safe to send, because it ends the run that is going on (it aborts what it finds in progress)
 * and carries on after the summary is made, and what it finds in progress is this handler. Nothing is cut: the step's output
 * and its tool results are in the conversation the summary is made of, and kept past it as far as omp's own cut allows.
 * A compact sent anywhere else in a step ends a model request or the tools that run, and loses their work.
 *
 * The wait is a dialog (`ctx.ui.select`), consumed by the server, so that it is the server that decides, and sees that the
 * conversation is held: it answers with `compact` (omp then closes the dialog with the run) or, when it cannot compact, with
 * "Continue". The handler also ends when the server takes the file away (the request was taken back), and by itself after
 * `COMPACT_STEP_HOLD_MS`: omp gives a `context` handler 30 s and no dialog pauses that budget (a `tool_call` handler's is
 * paused, which is why the quota floor waits there), and a request that is made because a handler timed out is not a decision
 * of this extension's. A request that was let go in that way is not held for again.
 *
 * Only the main agent waits: a subagent's step is its own and its compaction is omp's. It does nothing for a process without
 * a UI (there is no dialog to wait in).
 *
 * It is copied into the app's data folder (`install.ts`) with `shared/compact-step.ts`, because omp reads an extension from a
 * file; it runs in omp's own process and imports nothing else of the app. The note `<file>.loaded` says the extension is in:
 * omp carries on without an extension it could not load, so the server does not take a command line that names it for one
 * that runs it.
 */

/** A message of the conversation, as far as this reads it. */
interface Message {
	role?: string;
	content?: unknown;
}

interface Context {
	hasUI?: boolean;
	/** `main`, or `sub` for a task subagent (and an advisor). */
	agent?: { kind?: string };
	ui: {
		select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	};
}

/** What this uses of omp's extension API. */
interface Pi {
	on(event: "context", handler: (event: { messages?: Message[] }, ctx: Context) => Promise<undefined>): void;
}

/** The request the file names, or null: no file, one that cannot be read, or one that asks for nothing. */
function wanted(file: string): { at: number } | null {
	try {
		return parseCompactStepFile(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Whether `messages` end where a step's tools have all returned: the last assistant message called tools and results follow it.
 * That is the conversation of the model request that comes after a tool step; the first request of a turn, and the one after
 * a message that asks for no tool, are not at such a boundary.
 */
export function afterToolStep(messages: readonly Message[]): boolean {
	let assistant = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") {
			assistant = i;
			break;
		}
	}
	if (assistant < 0) return false;
	const { content } = messages[assistant] as Message;
	const called =
		Array.isArray(content) &&
		content.some((b) => typeof b === "object" && b !== null && "type" in b && b.type === "toolCall");
	return called && messages.slice(assistant + 1).some((m) => m?.role === "toolResult");
}

/** Wait in the dialog until the server answers, the request is taken away, the turn is stopped, or the time to let go has passed. True when it was the time. */
async function hold(ctx: Context, file: string, at: number): Promise<boolean> {
	const over = new AbortController();
	let timedOut = false;
	const look = setInterval(() => {
		if (wanted(file)?.at !== at) over.abort();
	}, COMPACT_STEP_POLL_MS);
	look.unref?.();
	const limit = setTimeout(() => {
		timedOut = true;
		over.abort();
	}, COMPACT_STEP_HOLD_MS);
	limit.unref?.();
	try {
		await ctx.ui.select(COMPACT_STEP_DIALOG_TITLE, [COMPACT_STEP_DIALOG_CONTINUE], { signal: over.signal });
	} finally {
		clearInterval(look);
		clearTimeout(limit);
		// The dialog is closed by the one that opened it, whichever way the wait ended.
		over.abort();
	}
	return timedOut;
}

export default function compactStep(pi: Pi): void {
	const file = process.env[COMPACT_STEP_FILE_ENV];
	/** The request that was let go by itself: it is not held for again. */
	let letGo: number | null = null;
	pi.on("context", async (event, ctx) => {
		// A subagent's steps are its own, and a process without a UI has no dialog to wait in.
		if (!file || ctx?.agent?.kind !== "main" || ctx.hasUI !== true) return undefined;
		const request = wanted(file);
		if (!request || request.at === letGo) return undefined;
		if (!afterToolStep(event?.messages ?? [])) return undefined;
		if (await hold(ctx, file, request.at)) letGo = request.at;
		return undefined;
	});
	// Said last, once the handler is in: the server calls a step boundary available on the strength of this note, and not of the command line.
	if (!file) return;
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		writeFileSync(`${file}${COMPACT_STEP_LOADED_SUFFIX}`, String(process.pid), { mode: 0o600 });
	} catch {
		// No note: the server says the conversation cannot be held between steps, which is the safe thing to say.
	}
}
