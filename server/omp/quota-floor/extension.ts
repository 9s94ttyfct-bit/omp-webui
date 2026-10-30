import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	parseHoldFile,
	QUOTA_DIALOG_CONTINUE,
	QUOTA_DIALOG_TITLE,
	QUOTA_FILE_ENV,
	QUOTA_LOADED_SUFFIX,
	QUOTA_POLL_MS,
	QUOTA_STATUS_KEY,
	type QuotaHoldFile,
	warmingPlan,
	warmVerdictText,
} from "../../../shared/quota-hold.ts";

/**
 * The quota floor (#652), an omp extension: the web UI starts every conversation's omp with it, and it does something only
 * while the server says the conversation's provider is at the floor the person set. Two things, both between two model
 * requests and neither of them a signal to omp's process (a frozen omp would stop its own timers, the prompt cache's warming
 * among them):
 *
 * - **It waits.** omp calls the `tool_call` handlers of a step before it runs the step's tools, and the next model request
 *   follows the tools: a handler that waits holds the conversation after the request that is in flight has completed, and
 *   before the next one. The wait is a dialog (`ctx.ui.select`) because omp pauses the handler's own timeout while a dialog is
 *   open (`extensionHandlers.toolCallTimeoutMs`, 30 s by default, otherwise the call would be refused as timed out); the
 *   server consumes the dialog, so no page is shown it. The handler ends when the hold file is gone (it reads it every second
 *   and closes the dialog itself), when the time the file names for the extension to let go has passed, or when the turn is
 *   stopped (omp closes the dialog). Only the main agent waits: a subagent has no dialogs (omp gives it none), and a wait
 *   it could not pause the timeout of would be refused as timed out after 30 s, a failed tool call that costs a request each time.
 *   A subagent that is running when the floor is reached finishes its assignment, and the main agent waits for the next step.
 * - **It decides about the prompt cache.** While held, omp's own warming goes on in its process (the run is not settled, so
 *   it is in its working phase) and asks the extensions, before each refresh, whether to make it (`cache_warming_decision`).
 *   The cost check of `shared/quota-hold.ts` answers: keep it warm while that costs less than rebuilding it once after the
 *   reset, else let it lapse. The verdict is told to the server with a status (`ctx.ui.setStatus`), which it consumes.
 *
 * What a new turn does first is not held: omp gives a `before_agent_start` handler no more time than its 30 s, and no dialog
 * pauses it. The first request of a prompt sent to a held conversation goes through, and its tool calls wait.
 *
 * It is copied into the app's data folder (`install.ts`) with `shared/quota-hold.ts`, because omp reads an extension from a
 * file; it runs in omp's own process and imports nothing else of the app. The server's file is the one source of what is held:
 * it names the process's hold file in `OMPW_QUOTA_FILE`, writes it while the conversation is at the floor and takes it away
 * when it is not, and the handlers read it at each call. A file that is gone or unreadable means no hold (a conversation never
 * fails for this). The note `<file>.loaded` says the extension is in: omp carries on without an extension it could not load,
 * so the server does not take a command line that names it for one that runs it.
 */

/** What omp passes the handlers, as far as this reads it. */
interface DecisionEvent {
	warmCost?: number;
	missCost?: number;
	continuationProbability?: number;
}

interface Context {
	hasUI?: boolean;
	/** `main`, or `sub` for a task subagent (and an advisor). */
	agent?: { kind?: string };
	ui: {
		select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
		setStatus?(key: string, text: string | undefined): void;
	};
}

/** What this uses of omp's extension API. */
interface Pi {
	on(event: "tool_call", handler: (event: unknown, ctx: Context) => Promise<undefined>): void;
	on(event: "before_provider_request", handler: (event: unknown, ctx: Context) => undefined): void;
	on(
		event: "cache_warming_decision",
		handler: (event: DecisionEvent, ctx: Context) => { action: "warm" | "stop" } | undefined,
	): void;
}

/** The hold the file says stands now, or null: no file, one that cannot be read, or one whose time to let go has passed. */
function standing(file: string): QuotaHoldFile | null {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const hold = parseHoldFile(text);
	if (!hold) return null;
	// The server is gone or silent past the reset: the window the hold waited for is over (`QUOTA_SELF_RELEASE_MS`).
	if (hold.expiresAt !== null && Date.now() >= hold.expiresAt) return null;
	return hold;
}

/** Wait in the quota dialog until the hold is over, or the turn is stopped. */
async function waitOut(ctx: Context, file: string): Promise<void> {
	const over = new AbortController();
	const look = setInterval(() => {
		if (!standing(file)) over.abort();
	}, QUOTA_POLL_MS);
	look.unref?.();
	try {
		await ctx.ui.select(QUOTA_DIALOG_TITLE, [QUOTA_DIALOG_CONTINUE], { signal: over.signal });
	} finally {
		clearInterval(look);
		// The dialog is closed by the one that opened it, whichever way the wait ended.
		over.abort();
	}
}

export default function quotaFloor(pi: Pi): void {
	const file = process.env[QUOTA_FILE_ENV];
	/** When the prompt cache entry was last touched (a request of the main agent, or a refresh this allowed), and when its request began. */
	let touched = 0;
	let began = 0;
	pi.on("tool_call", async (_event, ctx) => {
		// A subagent cannot wait (see above), and a process without a UI has no dialog to wait in.
		if (!file || ctx?.agent?.kind !== "main" || ctx.hasUI !== true) return undefined;
		if (!standing(file)) return undefined;
		await waitOut(ctx, file);
		return undefined;
	});
	// The prompt cache entry's own clock: omp refreshes it a fixed share of its lifetime after the last touch, so the time since
	// then, when it asks whether to refresh, is the interval between two refreshes. The request that is not made during a hold is the
	// one that began the entry; a request that comes while one stands is a refresh, which touches the entry and does not begin it.
	pi.on("before_provider_request", (_event, ctx) => {
		if (!file || ctx?.agent?.kind !== "main") return undefined;
		touched = Date.now();
		if (!standing(file)) began = touched;
		return undefined;
	});
	pi.on("cache_warming_decision", (event, ctx) => {
		if (!file) return undefined;
		const hold = standing(file);
		if (!hold) return undefined;
		const now = Date.now();
		const warmCost = event?.warmCost;
		const missCost = event?.missCost;
		if (typeof warmCost !== "number" || typeof missCost !== "number") return undefined;
		const plan = warmingPlan({
			now,
			resumeAt: hold.resumeAt,
			startedAt: began || touched || now,
			delayMs: touched > 0 ? now - touched : 0,
			// omp's own chance of another request: 1 while the agent works, less when it is idle.
			streaming: (event.continuationProbability ?? 1) >= 1,
			warmCost,
			missCost,
		});
		try {
			ctx?.ui?.setStatus?.(
				QUOTA_STATUS_KEY,
				warmVerdictText({
					at: now,
					state: plan.state,
					...(plan.why ? { why: plan.why } : {}),
					pings: plan.pings,
					warmCost: plan.warmCost,
					rebuildCost: plan.rebuildCost,
				}),
			);
		} catch {
			// The verdict is for the page; omp's decision does not depend on it.
		}
		if (plan.state === "on") {
			touched = now;
			return { action: "warm" };
		}
		return { action: "stop" };
	});
	// Said last, once the handlers are in: the server calls the floor live on the strength of this note, and not of the command line.
	if (!file) return;
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		writeFileSync(`${file}${QUOTA_LOADED_SUFFIX}`, String(process.pid), { mode: 0o600 });
	} catch {
		// No note: the page says the conversation cannot be held, which is the safe thing to say.
	}
}
