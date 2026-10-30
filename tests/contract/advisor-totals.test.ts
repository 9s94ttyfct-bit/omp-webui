import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AdvisorFile, SessionEntry, SessionSummary, SubagentFile, UsageTotals } from "../../shared/protocol.ts";
import { USAGE_A1 } from "../support/fixtures.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { appendCall, type OwnSession, sessionWithSubagents, writeTranscript } from "../support/subagent-fixtures.ts";

/**
 * omp writes an advisor's requests to `__advisor*.jsonl` beside the conversation, and no total of omp's own has them.
 * What the server says a conversation spent (`/api/sessions`) and what it hands out of its transcripts (`/api/family`,
 * `/api/session`) both count them, once, and say how much of it the advisors are. No omp is started.
 */

interface Doc {
	file: string;
	entries: SessionEntry[];
	subagents: SubagentFile[];
	advisors: AdvisorFile[];
}

let s: TestServer;
const authed = () => ({ "x-omp-webui-token": s.accessToken });
const get = async <T>(path: string): Promise<T> => {
	const res = await fetch(`${s.url}${path}`, { headers: authed() });
	expect(res.status).toBe(200);
	return res.json();
};
const q = (file: string) => encodeURIComponent(file);
const summaries = () => get<SessionSummary[]>("/api/sessions");
const sum = (list: { usage: UsageTotals }[], key: keyof UsageTotals) => list.reduce((n, x) => n + x.usage[key], 0);

beforeAll(async () => {
	s = await startTestServer();
});
afterAll(async () => {
	await s?.stop();
});

/** Wait for the list to hold `own` with `requests` of its advisors' requests counted, and return that summary. */
async function summaryWith(own: OwnSession, requests: number): Promise<SessionSummary> {
	let found: SessionSummary | undefined;
	await pollUntil(async () => {
		found = (await summaries()).find((x) => x.file.endsWith(own.file.split("/").pop() as string));
		return found?.advisorUsage?.requests === requests;
	}, `${requests} advisor requests in the list`);
	return found as SessionSummary;
}

test("the list counts a conversation's advisors once, apart from its subagents", async () => {
	// Its own request is $0.012345; the scout spent $5; the advisors $2 + $1, $0.5 and the scout's own $0.1.
	const own = sessionWithSubagents(0x20, "Contract advisor", { Scout: [5000] }, s.agentDir);
	writeTranscript(own.advisor(), [2000, 1000]);
	writeTranscript(own.advisor("security"), [500]);
	writeTranscript(own.advisor("default", "Scout"), [100]);
	const sess = await summaryWith(own, 4);
	expect(sess.advisorUsage.cost).toBeCloseTo(3.6, 9);
	expect(sess.advisorUsage.input).toBe(3600);
	expect(sess.subagentCount).toBe(1);
	expect(sess.subagentUsage.cost).toBeCloseTo(5, 9);
	// Own + scout + advisors: five requests, none counted twice, and no cost lost.
	expect(sess.usage.requests).toBe(1 + 1 + 4);
	expect(sess.usage.cost).toBeCloseTo(USAGE_A1.cost + 5 + 3.6, 9);
	expect(sess.usage.totalTokens).toBe(
		USAGE_A1.input + USAGE_A1.output + USAGE_A1.cacheRead + USAGE_A1.cacheWrite + 10_000 + 7200,
	);
	// The scout's list is the subagents alone.
	const subagents = await get<SubagentFile[]>(`/api/subagents?file=${q(sess.file)}`);
	expect(subagents.map((a) => a.id)).toEqual(["Scout"]);
});

test("the transcript and the family hand out the advisors beside the subagents, and their totals are the list's", async () => {
	const own = sessionWithSubagents(0x21, "Contract documents", { Scout: [4000] }, s.agentDir);
	writeTranscript(own.advisor(), [2000]);
	writeTranscript(own.advisor("security"), [1000, 500]);
	const sess = await summaryWith(own, 3);

	const doc = await get<Doc>(`/api/session?file=${q(sess.file)}`);
	const family = await get<{ members: Doc[] }>(`/api/family?file=${q(sess.file)}`);
	for (const d of [doc, family.members[0] as Doc]) {
		expect(d.subagents.map((a) => a.id)).toEqual(["Scout"]);
		expect(d.advisors.map((a) => [a.id, a.agent]).sort()).toEqual([
			["default", ""],
			["security", ""],
		]);
		// What a client adds up from the document is what the list says, to the request.
		const own = d.entries.reduce((n, e) => {
			const usage = (e.message as { role?: string; usage?: { cost: { total: number } } } | undefined)?.usage;
			return n + (usage ? usage.cost.total : 0);
		}, 0);
		expect(own).toBeCloseTo(USAGE_A1.cost, 9);
		expect(sum(d.advisors, "cost")).toBeCloseTo(sess.advisorUsage.cost, 9);
		expect(sum(d.advisors, "requests")).toBe(sess.advisorUsage.requests);
		expect(own + sum(d.subagents, "cost") + sum(d.advisors, "cost")).toBeCloseTo(sess.usage.cost, 9);
	}
});

test("a conversation without an advisor has none to list, and spent what it did", async () => {
	const own = sessionWithSubagents(0x22, "Contract unadvised", { Scout: [4000] }, s.agentDir);
	let sess: SessionSummary | undefined;
	await pollUntil(async () => {
		sess = (await summaries()).find((x) => x.file.endsWith(own.file.split("/").pop() as string));
		return sess !== undefined;
	}, "the conversation in the list");
	expect(sess?.advisorUsage.requests).toBe(0);
	expect(sess?.advisorUsage.cost).toBe(0);
	expect(sess?.usage.cost).toBeCloseTo(USAGE_A1.cost + 4, 9);
	expect((await get<Doc>(`/api/session?file=${q(own.file)}`)).advisors).toEqual([]);
});

test("an advisor that goes on writing changes the list and makes the transcript and family new documents", async () => {
	const own = sessionWithSubagents(0x23, "Contract writing", {}, s.agentDir);
	writeTranscript(own.advisor(), [1000]);
	const sess = await summaryWith(own, 1);
	const headers = { ...authed(), "accept-encoding": "gzip" };
	const tags = async () =>
		Promise.all(
			["session", "family"].map(async (kind) =>
				(await fetch(`${s.url}/api/${kind}?file=${q(sess.file)}`, { headers })).headers.get("etag"),
			),
		);
	const before = await tags();
	expect(before.every(Boolean)).toBe(true);
	for (const kind of ["session", "family"]) {
		const again = await fetch(`${s.url}/api/${kind}?file=${q(sess.file)}`, {
			headers: { ...headers, "if-none-match": before[kind === "session" ? 0 : 1] as string },
		});
		expect(again.status).toBe(304);
	}

	// Only the advisor's file changes, not the conversation's.
	appendCall(own.advisor(), 2000);
	const after = await summaryWith(own, 2);
	expect(after.modifiedAt).toBe(sess.modifiedAt);
	expect(after.advisorUsage.cost).toBeCloseTo(3, 9);
	expect(after.usage.cost).toBeCloseTo(USAGE_A1.cost + 3, 9);
	const next = await tags();
	expect(next[0]).not.toBe(before[0]);
	expect(next[1]).not.toBe(before[1]);
	const doc = await get<Doc>(`/api/session?file=${q(sess.file)}`);
	expect(sum(doc.advisors, "cost")).toBeCloseTo(3, 9);
});
