import { expect, test } from "bun:test";
import type { LiveInfo, OmpFrame } from "../../shared/protocol.ts";
import {
	applyFrame,
	denial,
	initialLive,
	isApproval,
	type LiveState,
	type UIRequest,
	withApprovalsDenied,
} from "../../web/src/store/live.ts";

/**
 * A dialog that omp gives a deadline (`ask.timeout`, an extension's `timeout`) shows it, and when omp's deadline closes it
 * the conversation says what omp did instead of the user; a message sent while tool approvals wait denies them first.
 */

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

const fold = (frames: OmpFrame[]): LiveState => frames.reduce(applyFrame, initialLive(info));

const ask = (id: string, extra: Record<string, unknown> = {}): OmpFrame => ({
	type: "extension_ui_request",
	method: "ask",
	id,
	timeout: 6000,
	questions: [
		{
			id: "colour",
			question: "Which colour?",
			options: [{ label: "Red" }, { label: "Blue" }, { label: "Green" }],
			recommended: 1,
		},
		{ id: "size", question: "Which size?", options: [{ label: "S" }, { label: "M" }] },
	],
	...extra,
});
const cancel = (targetId: string, extra: Record<string, unknown> = {}): OmpFrame => ({
	type: "extension_ui_request",
	method: "cancel",
	id: `x-${targetId}`,
	targetId,
	...extra,
});
const approval = (
	id: string,
	tool: string,
	options = ["Approve", "Approve bash for this session", "Deny"],
): OmpFrame => ({
	type: "extension_ui_request",
	method: "select",
	id,
	title: `Allow tool: ${tool}\necho hi`,
	options,
});

test("a dialog with a timeout counts down to omp's deadline; one without has none", () => {
	const before = Date.now();
	const s = fold([ask("a1"), { type: "extension_ui_request", method: "confirm", id: "c1", title: "Go?" }]);
	const [withTimeout, without] = s.uiRequests;
	expect(withTimeout.deadline).toBeGreaterThanOrEqual(before + 6000);
	expect(withTimeout.deadline).toBeLessThanOrEqual(Date.now() + 6000);
	expect(without.deadline).toBeUndefined();
});

test("the deadline the server stamped is kept, read on this page's clock, and a replay does not restart it", () => {
	const stamped = Date.now() + 2500;
	const once = fold([ask("a1", { expiresAt: stamped })]);
	// Nothing in the test sets the server's clock apart from the page's: the offset is 0.
	expect(once.uiRequests[0].deadline).toBe(stamped);
	const replayed = applyFrame(once, ask("a1", { expiresAt: stamped + 9000 }));
	expect(replayed.uiRequests).toHaveLength(1);
	expect(replayed.uiRequests[0].deadline).toBe(stamped);
});

test("omp's deadline closing an ask says what omp answered: the recommended option, else the first", () => {
	const s = fold([ask("a1"), cancel("a1", { timedOut: true })]);
	expect(s.uiRequests).toEqual([]);
	expect(s.needsInput).toBe(false);
	expect(s.notices).toHaveLength(1);
	expect(s.notices[0]).toMatchObject({
		kind: "dialogTimeout",
		title: null,
		chosen: [
			{ question: "Which colour?", answer: "Blue" },
			{ question: "Which size?", answer: "S" },
		],
	});
});

test("any other dialog timing out says omp went on without an answer", () => {
	const s = fold([approval("p1", "bash"), cancel("p1", { timedOut: true })]);
	expect(s.notices).toHaveLength(1);
	expect(s.notices[0]).toMatchObject({ kind: "dialogTimeout", title: "Allow tool: bash", chosen: [] });
});

test("a dialog closed for any other reason leaves no note: answered here or elsewhere, or the turn stopped", () => {
	expect(fold([ask("a1"), cancel("a1")]).notices).toEqual([]);
	// A cancel for a dialog this page no longer shows (it answered it itself) says nothing either.
	expect(fold([ask("a1"), cancel("a1"), cancel("a1", { timedOut: true })]).notices).toEqual([]);
});

test("only a tool approval is one: the title says so", () => {
	const [req] = fold([approval("p1", "bash")]).uiRequests;
	expect(isApproval(req)).toBe(true);
	const [other] = fold([ask("a1")]).uiRequests;
	expect(isApproval(other)).toBe(false);
	expect(isApproval({ id: "s1", method: "select", title: "Pick one", options: ["a"] })).toBe(false);
});

test("an approval is denied with its Deny choice, or dismissed when it offers none", () => {
	const [req] = fold([approval("p1", "bash")]).uiRequests;
	expect(denial(req)).toEqual({ id: "p1", value: "Deny" });
	const [bare] = fold([approval("p2", "bash", ["Approve"])]).uiRequests;
	expect(denial(bare)).toEqual({ id: "p2", cancelled: true });
});

test("denying the pending approvals clears them and notes which tools did not run", () => {
	const s = fold([approval("p1", "bash"), approval("p2", "edit"), ask("a1")]);
	const pending: UIRequest[] = s.uiRequests.filter(isApproval);
	expect(pending).toHaveLength(2);
	const denied = withApprovalsDenied(s, pending);
	// The question that is not an approval stays.
	expect(denied.uiRequests.map((r) => r.id)).toEqual(["a1"]);
	expect(denied.needsInput).toBe(true);
	expect(denied.notices).toHaveLength(1);
	expect(denied.notices[0]).toMatchObject({ kind: "approvalDenied", tools: ["bash", "edit"] });
});
