import "./browser-globals.ts";
import { afterAll, afterEach, beforeAll, expect, type Mock, spyOn, test } from "bun:test";
import type { FamilyView, SessionEntry, SessionFileData, SessionSummary } from "../../shared/protocol.ts";
import { ApiError, api } from "../../web/src/lib/api.ts";
import { familySignature } from "../../web/src/lib/family.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * When a conversation's history is fetched again. The chat page asks for the end of the conversation (and a family's
 * files are named, not sent) and must not do it again for writes elsewhere; and when the server sends an ETag it asks with it.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const summary = (name: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
	file: `/sessions/${name}.jsonl`,
	id: `id-${name}`,
	title: null,
	preview: "",
	cwd: "/p",
	project: "p",
	createdAt: "2026-01-01T00:00:00.000Z",
	modifiedAt: 1000,
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
const file = (name: string) => `/sessions/${name}.jsonl`;

test("writes to conversations outside the family, and the order of the list, leave the signature as it was", () => {
	const list = [summary("a"), summary("b", { parentSession: file("a") }), summary("other")];
	const before = familySignature(list, file("a"), null);

	const written = [
		summary("a"),
		summary("b", { parentSession: file("a") }),
		summary("other", { modifiedAt: 9999, size: 5000 }),
	];
	expect(familySignature(written, file("a"), null)).toBe(before);
	// A write moves its conversation to the top of the list (newest first).
	expect(familySignature([...written].reverse(), file("a"), null)).toBe(before);
	// A conversation of another family appears.
	expect(
		familySignature(
			[...written, summary("new"), summary("new-branch", { parentSession: file("new") })],
			file("a"),
			null,
		),
	).toBe(before);
});

test("a write to a member, a branch joining it, or a member going away changes the signature", () => {
	const list = [summary("a"), summary("b", { parentSession: file("a") })];
	const before = familySignature(list, file("a"), null);

	expect(familySignature([summary("a", { modifiedAt: 2000, size: 150 }), list[1]], file("a"), null)).not.toBe(before);
	expect(familySignature([list[0], summary("b", { parentSession: file("a"), size: 101 })], file("a"), null)).not.toBe(
		before,
	);
	expect(familySignature([list[0]], file("a"), null)).not.toBe(before);
	// omp names the parent by path, by session id or by file name.
	for (const parentSession of [file("a"), "id-a", "a.jsonl"]) {
		const joined = [...list, summary("c", { parentSession })];
		expect(familySignature(joined, file("a"), null), parentSession).not.toBe(before);
	}
});

test("a conversation's family is its whole lineage: from a branch, the parent and the siblings count", () => {
	const list = [
		summary("root"),
		summary("left", { parentSession: file("root") }),
		summary("right", { parentSession: file("root") }),
		summary("deep", { parentSession: file("left") }),
		summary("stranger"),
	];
	const before = familySignature(list, file("deep"), null);
	// The signature is that of the family, whichever member it is asked for.
	expect(familySignature(list, file("right"), null)).toBe(before);
	expect(familySignature(list, file("stranger"), null)).not.toBe(before);
	const changed = list.map((s) => (s.file === file("right") ? { ...s, size: 999 } : s));
	expect(familySignature(changed, file("deep"), null)).not.toBe(before);
});

test("the file this page runs a process on counts by whether it exists, not by what is written to it", () => {
	const list = [summary("a"), summary("b", { parentSession: file("a") })];
	const own = familySignature(list, file("b"), file("b"));
	const written = [list[0], summary("b", { parentSession: file("a"), modifiedAt: 5000, size: 4000 })];
	expect(familySignature(written, file("b"), file("b"))).toBe(own);
	// Another member still counts.
	expect(familySignature([summary("a", { size: 7 }), list[1]], file("b"), file("b"))).not.toBe(own);
	// omp names a file before it writes it: the file appearing in the list is the news.
	const unwritten = familySignature([list[0]], file("b"), file("b"));
	expect(unwritten).not.toBe(own);
});

// ------------------------------------------------------------------ the request

let fetchSpy: Mock<typeof fetch> | undefined;
let requests: { url: string; ifNoneMatch: string | null }[] = [];

/** What the server answers each request with, in order. */
function serve(...answers: (Response | (() => Response))[]) {
	requests = [];
	fetchSpy?.mockRestore();
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		requests.push({ url: String(input), ifNoneMatch: headers.get("if-none-match") });
		const next = answers[requests.length - 1];
		return typeof next === "function" ? next() : (next as Response);
	}) as typeof fetch);
}
afterEach(() => fetchSpy?.mockRestore());

const entry = (id: string, parentId: string | null): SessionEntry =>
	({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z" }) as SessionEntry;
const member = (name: string, entries: SessionEntry[] = []): SessionFileData => ({
	file: file(name),
	header: null,
	entries,
	subagents: [],
	advisors: [],
});
/** The answer to a request for a window: the file's own member holds the entries, `view` says where the path goes. */
const window = (name: string, ids: string[] = ["a1"], extra: Partial<FamilyView> = {}) => ({
	file: file(name),
	members: [
		member(
			name,
			ids.map((id, i) => entry(id, i ? (ids[i - 1] as string) : null)),
		),
	],
	view: {
		kind: "tail",
		leaf: ids.at(-1) ?? null,
		head: ids.at(-1) ?? null,
		earlier: false,
		later: false,
		versions: [],
		...extra,
	} satisfies FamilyView,
});
const ok = (body: unknown, etag?: string) => Response.json(body, { headers: etag ? { etag } : {} });

test("the end of a conversation is asked for with the ETag the server sent, and a 304 returns the same answer", async () => {
	serve(
		ok(window("fam-one"), '"v1"'),
		new Response(null, { status: 304 }),
		ok(window("fam-one", ["a1", "a2"]), '"v2"'),
		new Response(null, { status: 304 }),
	);

	const first = await api.history(file("fam-one"), { kind: "tail" });
	expect(requests[0]?.ifNoneMatch).toBeNull();
	expect(requests[0]?.url).toContain("view=tail");
	expect(first.members[0]?.entries.map((e) => e.id)).toEqual(["a1"]);

	const second = await api.history(file("fam-one"), { kind: "tail" });
	expect(requests[1]?.ifNoneMatch).toBe('"v1"');
	// Not downloaded, not parsed: the page gets the object it already has, and renders nothing new.
	expect(second).toBe(first);

	// The conversation changed: the new end comes back, with a new ETag.
	const third = await api.history(file("fam-one"), { kind: "tail" });
	expect(requests[2]?.ifNoneMatch).toBe('"v1"');
	expect(third).not.toBe(first);
	expect(third.members[0]?.entries).toHaveLength(2);
	expect(await api.history(file("fam-one"), { kind: "tail" })).toBe(third);
	expect(requests[3]?.ifNoneMatch).toBe('"v2"');
});

test("a server that sends no ETag is asked in full every time", async () => {
	serve(ok(window("fam-two")), ok(window("fam-two")));
	const first = await api.history(file("fam-two"), { kind: "tail" });
	const second = await api.history(file("fam-two"), { kind: "tail" });
	expect(requests.map((r) => r.ifNoneMatch)).toEqual([null, null]);
	expect(second).not.toBe(first);
});

test("each end has its own ETag, by file and branch; only the latest few are kept; a failure is an error with the server's reason", async () => {
	serve(
		ok(window("fam-a"), '"a1"'),
		ok(window("fam-b"), '"b1"'),
		new Response(null, { status: 304 }),
		ok(window("fam-c"), '"c1"'),
		ok(window("fam-d"), '"d1"'),
		ok(window("fam-e"), '"e1"'),
		ok(window("fam-a"), '"a2"'),
		ok(window("fam-a", ["a1"], { leaf: "x" }), '"a-branch"'),
		Response.json({ error: "Unknown session file" }, { status: 404 }),
	);
	await api.history(file("fam-a"), { kind: "tail" });
	await api.history(file("fam-b"), { kind: "tail" });
	// Asking again for fam-a: it is the one in use, so the next ends push fam-b out, not fam-a.
	await api.history(file("fam-a"), { kind: "tail" });
	await api.history(file("fam-c"), { kind: "tail" });
	await api.history(file("fam-d"), { kind: "tail" });
	// Four are kept (a, c, d and now e): fam-b went, fam-a stays by having been used.
	await api.history(file("fam-e"), { kind: "tail" });
	await api.history(file("fam-a"), { kind: "tail" });
	// Another branch of a conversation is another end.
	await api.history(file("fam-a"), { kind: "tail", leaf: "x" });
	expect(requests.map((r) => r.ifNoneMatch)).toEqual([null, null, '"a1"', null, null, null, '"a1"', null]);

	const failure = await api.history(file("fam-missing"), { kind: "tail" }).catch((e: unknown) => e);
	expect(failure).toBeInstanceOf(ApiError);
	expect((failure as ApiError).status).toBe(404);
	expect((failure as ApiError).message).toBe("Unknown session file");
});

test("a page above, a page below and a window around an entry are asked for by their entry, and none is kept for an ETag", async () => {
	serve(
		ok(window("fam-pages", ["p1", "p2"], { kind: "before", earlier: true }), '"p1"'),
		ok(window("fam-pages", ["p1", "p2"], { kind: "after", later: true }), '"p2"'),
		ok(window("fam-pages", ["p1", "p2"], { kind: "around" }), '"p3"'),
		ok(window("fam-pages", ["p1", "p2"], { kind: "before" }), '"p4"'),
	);
	await api.history(file("fam-pages"), { kind: "before", at: "e5" });
	await api.history(file("fam-pages"), { kind: "after", at: "e5", leaf: "e9" });
	await api.history(file("fam-pages"), { kind: "around", at: "e7" });
	await api.history(file("fam-pages"), { kind: "before", at: "e5" });
	const query = (i: number) => new URL(requests[i]?.url as string, "http://x").searchParams;
	expect([query(0).get("view"), query(0).get("at"), query(0).get("leaf")]).toEqual(["before", "e5", null]);
	expect([query(1).get("view"), query(1).get("at"), query(1).get("leaf")]).toEqual(["after", "e5", "e9"]);
	expect([query(2).get("view"), query(2).get("at")]).toEqual(["around", "e7"]);
	expect(requests.map((r) => r.ifNoneMatch)).toEqual([null, null, null, null]);
});

test("an answer that is the lineage whole, not a window, is an error: it would be shown as a conversation of one stretch", async () => {
	serve(ok({ file: file("fam-whole"), members: [member("fam-whole")] }, '"v1"'));
	await expect(api.history(file("fam-whole"), { kind: "tail" })).rejects.toThrow("window of the history");
});

test("what the whole file adds up to is asked for apart, and is the statistics document's `stats`", async () => {
	const stats = {
		through: "a9",
		usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 },
		byModel: [],
		clock: { total: 7, start: null, end: 0 },
	};
	serve(ok({ file: file("fam-stats"), stats }));
	expect(await api.historyStats(file("fam-stats"))).toEqual(stats);
	expect(new URL(requests[0]?.url as string, "http://x").searchParams.get("view")).toBe("stats");
});
