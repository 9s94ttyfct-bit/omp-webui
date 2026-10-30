import "./browser-globals.ts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { SessionSummary } from "../../shared/protocol.ts";
import { applySessionChanges } from "../../web/src/lib/share.ts";
import { useApp } from "../../web/src/store/app.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * Once the sidebar has the session list, a write to one conversation must not download the other thousands again:
 * the server is asked what changed since the cursor of its last answer, and the answer is folded into the list.
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
const files = (list: SessionSummary[]) => list.map((s) => s.file);

test("a delta replaces the rows it names, drops the removed ones and keeps the newest write first", () => {
	const prev = [summary(3), summary(2), summary(1)];
	const next = applySessionChanges(prev, [summary(1, { modifiedAt: 5000, messageCount: 4 })], ["/sessions/3.jsonl"]);
	expect(files(next)).toEqual(["/sessions/1.jsonl", "/sessions/2.jsonl"]);
	expect(next[0]?.messageCount).toBe(4);
	// Rows that were not named are the objects they were.
	expect(next[1]).toBe(prev[1]);

	const joined = applySessionChanges(prev, [summary(9)], []);
	expect(files(joined)).toEqual(["/sessions/9.jsonl", "/sessions/3.jsonl", "/sessions/2.jsonl", "/sessions/1.jsonl"]);
});

test("a delta that changes nothing gives back the list it was given", () => {
	const prev = [summary(2), summary(1)];
	expect(applySessionChanges(prev, [], [])).toBe(prev);
	expect(applySessionChanges(prev, [JSON.parse(JSON.stringify(prev[0]))], ["/sessions/unknown.jsonl"])).toBe(prev);
});

let served: { since: string | null; answer: () => Response }[] = [];
let asked: (string | null)[] = [];
let fetchSpy: Mock<typeof fetch> | undefined;

beforeEach(() => {
	served = [];
	asked = [];
	fetchSpy?.mockRestore();
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input) !== "/api/sessions") return Response.json([]);
		const since = new Headers(init?.headers).get("x-sessions-since");
		asked.push(since);
		const next = served.shift();
		if (!next) throw new Error("unexpected /api/sessions request");
		return next.answer();
	}) as typeof fetch);
	useApp.setState({ sessions: [], pins: [], archived: [], sessionsLoaded: false, sessionsError: null, toasts: [] });
});
afterEach(() => fetchSpy?.mockRestore());

const full = (list: SessionSummary[], cursor: string | null) => () =>
	Response.json(JSON.parse(JSON.stringify(list)), { headers: cursor ? { "x-sessions-cursor": cursor } : {} });
const delta = (changed: SessionSummary[], removed: string[], cursor: string) => () =>
	Response.json({ changed, removed }, { headers: { "x-sessions-cursor": cursor } });

test("after the first list the server is asked for what changed since its cursor, and the answer is folded in", async () => {
	served.push({ since: null, answer: full([summary(2), summary(1)], "e1.1") });
	await useApp.getState().loadSessions();
	const first = useApp.getState().sessions;
	expect(files(first)).toEqual(["/sessions/2.jsonl", "/sessions/1.jsonl"]);

	served.push({
		since: "e1.1",
		answer: delta([summary(1, { modifiedAt: 9000, messageCount: 6 }), summary(3)], [], "e1.2"),
	});
	await useApp.getState().loadSessions();
	const second = useApp.getState().sessions;
	expect(files(second)).toEqual(["/sessions/1.jsonl", "/sessions/3.jsonl", "/sessions/2.jsonl"]);
	expect(second[0]?.messageCount).toBe(6);
	expect(second[2]).toBe(first[0]);

	served.push({ since: "e1.2", answer: delta([], ["/sessions/2.jsonl"], "e1.3") });
	await useApp.getState().loadSessions();
	expect(files(useApp.getState().sessions)).toEqual(["/sessions/1.jsonl", "/sessions/3.jsonl"]);
	expect(asked).toEqual([null, "e1.1", "e1.2"]);
});

test("a server that sends no cursor is asked for the whole list every time", async () => {
	served.push({ since: null, answer: full([summary(1)], null) });
	await useApp.getState().loadSessions();
	served.push({ since: null, answer: full([summary(2), summary(1)], null) });
	await useApp.getState().loadSessions();
	expect(asked).toEqual([null, null]);
	expect(files(useApp.getState().sessions)).toEqual(["/sessions/2.jsonl", "/sessions/1.jsonl"]);
});

test("a full list in answer to a cursor (the server forgot it) replaces the list", async () => {
	served.push({ since: null, answer: full([summary(2), summary(1)], "e1.1") });
	await useApp.getState().loadSessions();
	served.push({ since: "e1.1", answer: full([summary(5)], "e2.0") });
	await useApp.getState().loadSessions();
	expect(files(useApp.getState().sessions)).toEqual(["/sessions/5.jsonl"]);
	served.push({ since: "e2.0", answer: delta([], [], "e2.0") });
	await useApp.getState().loadSessions();
	expect(asked).toEqual([null, "e1.1", "e2.0"]);
});

test("overlapping loads run one after the other, each asking since the answer before it", async () => {
	served.push({ since: null, answer: full([summary(1)], "e1.1") });
	await useApp.getState().loadSessions();

	const slow = Promise.withResolvers<Response>();
	served.push({ since: "e1.1", answer: () => new Response() });
	fetchSpy?.mockRestore();
	const sinces: (string | null)[] = [];
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input) !== "/api/sessions") return Response.json([]);
		sinces.push(new Headers(init?.headers).get("x-sessions-since"));
		return sinces.length === 1 ? slow.promise : delta([summary(3)], [], "e1.3")();
	}) as typeof fetch);
	const older = useApp.getState().loadSessions();
	const newer = useApp.getState().loadSessions();
	// The newer one has not started: it asks after the older one's answer.
	await Promise.resolve();
	expect(sinces).toEqual(["e1.1"]);

	slow.resolve(delta([summary(2)], [], "e1.2")());
	await Promise.all([older, newer]);
	expect(sinces).toEqual(["e1.1", "e1.2"]);
	expect(files(useApp.getState().sessions)).toEqual(["/sessions/3.jsonl", "/sessions/2.jsonl", "/sessions/1.jsonl"]);
});
