import { isRecord } from "./guards.ts";

/**
 * An answer without what the page does not read of it: omp's system prompt and the bodies of its tool schemas (the
 * tool names are kept, which is what the page asks omp for).
 *
 * A routine state read (`get_state`) carries the whole system prompt and every tool's schema — tens of KB, moved over
 * the WebSocket and parsed on the browser's main thread for a page that reads neither. The server strips them before
 * the answer goes out (see the `slim` of `ClientMessage`); a consumer that needs them asks without `slim` and gets the
 * whole answer.
 */
export function slimAnswer(data: unknown): unknown {
	if (!isRecord(data)) return data;
	const { systemPrompt: _systemPrompt, dumpTools, ...rest } = data;
	if (dumpTools === undefined) return rest;
	return { ...rest, dumpTools: toolNames(dumpTools) };
}

/** The tools as their names alone. A tool the page cannot name is kept as it is, so that nothing is lost. */
function toolNames(dumpTools: unknown): unknown {
	if (!Array.isArray(dumpTools)) return dumpTools;
	return dumpTools.map((tool) => (isRecord(tool) && typeof tool.name === "string" ? { name: tool.name } : tool));
}
