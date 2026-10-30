import { expect, test } from "bun:test";
import { conversationBusy } from "../../web/src/lib/busy.ts";

/** When Edit, Regenerate and Branch must not run: while omp replies, runs a command or waits to retry. */

const idle = { streaming: false, retry: null };

test("an idle conversation, or none, is not busy", () => {
	expect(conversationBusy(undefined, [])).toBe(false);
	expect(conversationBusy(idle, [])).toBe(false);
});

test("a reply in progress is busy", () => {
	expect(conversationBusy({ ...idle, streaming: true }, [])).toBe(true);
});

test("a running !command is busy", () => {
	expect(conversationBusy(idle, [{ command: "sleep 5" }])).toBe(true);
});

test("a retry that is still to come is busy; one that gave up is not", () => {
	const retry = (phase: "waiting" | "failed") => ({ ...idle, retry: { phase } as never });
	expect(conversationBusy(retry("waiting"), [])).toBe(true);
	expect(conversationBusy(retry("failed"), [])).toBe(false);
});
