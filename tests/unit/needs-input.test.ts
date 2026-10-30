import { expect, test } from "bun:test";
import type { LiveInfo, OmpFrame } from "../../shared/protocol.ts";
import { applyFrame, initialLive, type LiveState } from "../../web/src/store/live.ts";

/** `needsInput`: whether a live omp process waits for the user to answer a dialog (the sidebar marks it). */

const info: LiveInfo = {
	liveId: "L1",
	pid: 1,
	cwd: "/",
	sessionFile: null,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
};

const request = (method: string, id: string): OmpFrame => ({
	type: "extension_ui_request",
	method,
	id,
	title: "Question",
});
const cancel = (targetId: string): OmpFrame => ({
	type: "extension_ui_request",
	method: "cancel",
	id: `answered-${targetId}`,
	targetId,
});

const fold = (frames: OmpFrame[]): LiveState => frames.reduce(applyFrame, initialLive(info));

test("a process needs input from the first dialog until the last one is settled", () => {
	expect(initialLive(info).needsInput).toBe(false);
	expect(fold([request("confirm", "d1")]).needsInput).toBe(true);
	expect(fold([request("confirm", "d1"), request("ask", "d2")]).needsInput).toBe(true);
	// Another tab answered the first: the server tells every tab with a cancel for it.
	expect(fold([request("confirm", "d1"), request("ask", "d2"), cancel("d1")]).needsInput).toBe(true);
	expect(fold([request("confirm", "d1"), request("ask", "d2"), cancel("d1"), cancel("d2")]).needsInput).toBe(false);
});

test("every dialog kind counts, replays of a pending one do not stack", () => {
	for (const method of ["select", "confirm", "input", "editor", "ask"]) {
		expect(fold([request(method, "d1")]).needsInput, method).toBe(true);
	}
	const replayed = fold([request("confirm", "d1"), request("confirm", "d1")]);
	expect(replayed.uiRequests).toHaveLength(1);
});

test("notifications, status lines and widgets do not ask anything", () => {
	const s = fold([
		{ type: "extension_ui_request", method: "notify", id: "n1", message: "Done" },
		{ type: "extension_ui_request", method: "setStatus", id: "n2", statusKey: "k", statusText: "busy" },
		{ type: "extension_ui_request", method: "setWidget", id: "n3", widgetKey: "w", widgetLines: ["x"] },
	]);
	expect(s.needsInput).toBe(false);
	expect(s.uiRequests).toEqual([]);
});
