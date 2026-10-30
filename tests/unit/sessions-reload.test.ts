import "./browser-globals.ts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, type Mock, spyOn, test } from "bun:test";
import type { SessionSummary } from "../../shared/protocol.ts";
import { onServer, useApp } from "../../web/src/store/app.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * omp writes its session file several times a second while it answers, and the server announces every write: the
 * session list (84 KB for a thousand conversations) must not be fetched, parsed and rendered again for each one.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const summary = (n: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
	file: `/sessions/${n}.jsonl`,
	id: `id-${n}`,
	title: `Conversation ${n}`,
	preview: "",
	cwd: "/p",
	project: "p",
	createdAt: "2026-01-01T00:00:00.000Z",
	modifiedAt: 1000 + n,
	size: 100,
	messageCount: 2,
	userMessageCount: 1,
	parentSession: null,
	models: [],
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, requests: 0 },
	subagentUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, requests: 0 },
	subagentCount: 0,
	advisorUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, requests: 0 },
	...extra,
});

let server: SessionSummary[] = [];
let requests: string[] = [];
let fetchSpy: Mock<typeof fetch> | undefined;

beforeEach(() => {
	jest.useFakeTimers();
	server = [summary(1), summary(2), summary(3)];
	requests = [];
	fetchSpy?.mockRestore();
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
		const url = String(input);
		requests.push(url);
		// A fresh parse every time, as from the network.
		if (url === "/api/project-groups") return Response.json({ groups: [], problem: null });
		return Response.json(url === "/api/sessions" ? JSON.parse(JSON.stringify(server)) : []);
	}) as typeof fetch);
	useApp.setState({ sessions: [], pins: [], archived: [], sessionsLoaded: false, sessionsError: null, toasts: [] });
});
afterEach(() => {
	fetchSpy?.mockRestore();
	jest.useRealTimers();
});

const loads = () => requests.filter((u) => u === "/api/sessions").length;
/** Let the fetches and promise chains started so far finish (timers stay faked). */
const settle = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

test("a burst of changes reloads the list at once, then once more when the wait is over", async () => {
	for (let i = 0; i < 25; i++) onServer({ t: "sessions_changed" });
	jest.advanceTimersByTime(0);
	await settle();
	expect(loads()).toBe(1);

	// Changes keep coming while omp writes: they wait, and become one reload.
	for (let i = 0; i < 25; i++) {
		jest.advanceTimersByTime(50);
		onServer({ t: "sessions_changed" });
	}
	await settle();
	expect(loads()).toBe(1);
	jest.advanceTimersByTime(1500);
	await settle();
	expect(loads()).toBe(2);

	// Quiet again: nothing is scheduled, and the next change is answered at once.
	jest.advanceTimersByTime(60_000);
	await settle();
	expect(loads()).toBe(2);
	onServer({ t: "sessions_changed" });
	jest.advanceTimersByTime(0);
	await settle();
	expect(loads()).toBe(3);
});

test("a reload that changed nothing leaves the list as it was; a changed row is the only new object", async () => {
	await useApp.getState().loadSessions();
	const first = useApp.getState().sessions;
	expect(first).toHaveLength(3);

	await useApp.getState().loadSessions();
	// The very same array: nothing that shows the list renders again.
	expect(useApp.getState().sessions).toBe(first);

	// A conversation is written (it moves to the top of the list); the others keep their objects.
	server = [summary(2, { modifiedAt: 5000, size: 400, messageCount: 4 }), summary(1), summary(3)];
	await useApp.getState().loadSessions();
	const next = useApp.getState().sessions;
	expect(next).not.toBe(first);
	expect(next.map((s) => s.file)).toEqual(["/sessions/2.jsonl", "/sessions/1.jsonl", "/sessions/3.jsonl"]);
	expect(next[0]).not.toBe(first[1]);
	expect(next[0].messageCount).toBe(4);
	expect(next[1]).toBe(first[0]);
	expect(next[2]).toBe(first[2]);

	// A field the server changed without a new time or size (a title rename) is not lost.
	server = [server[0], { ...summary(1), title: "Renamed" }, server[2]];
	await useApp.getState().loadSessions();
	expect(useApp.getState().sessions[1].title).toBe("Renamed");
});
