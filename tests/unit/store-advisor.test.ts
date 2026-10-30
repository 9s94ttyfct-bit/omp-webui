import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../server/sessions/store.ts";
import type { SessionSummary } from "../../shared/protocol.ts";
import { seedFixtures, USAGE_A1 } from "../support/fixtures.ts";
import { appendCall, sessionWithSubagents, writeTranscript } from "../support/subagent-fixtures.ts";

/**
 * omp writes an advisor's requests to `__advisor.jsonl` beside the conversation, outside its transcript, and its own
 * session statistics leave them out. A conversation's cost is its own requests plus its subagents' plus its advisors',
 * each counted once, and the advisors are listed apart from the subagents.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-store-advisor-"));
const agentDir = join(root, "agent");
const dbFile = join(root, "index.db");
let store: SessionStore;

beforeAll(() => {
	seedFixtures(agentDir);
	store = new SessionStore(join(agentDir, "sessions"), dbFile);
});
afterAll(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

/** A conversation of this spec's own: its request costs $0.012345, and each subagent has transcripts worth the listed requests. */
const session = (n: number, title: string, agents: Record<string, number[]>) =>
	sessionWithSubagents(n, title, agents, agentDir);

const summaryOf = async (file: string): Promise<SessionSummary> => {
	await store.refresh(true);
	const found = (await store.list()).find((s) => s.file === file);
	if (!found) throw new Error(`no summary for ${file}`);
	return found;
};

test("a conversation's usage includes its advisor's, which is kept apart from its subagents'", async () => {
	// Its own request is $0.012345; the scout spent $5, the advisor $2 + $1 in two requests.
	const own = session(0x10, "Advised", { Scout: [5000] });
	writeTranscript(own.advisor(), [2000, 1000]);
	const s = await summaryOf(own.file);
	expect(s.advisorUsage).toMatchObject({ input: 3000, output: 3000, totalTokens: 6000, requests: 2 });
	expect(s.advisorUsage.cost).toBeCloseTo(3, 9);
	// The advisor is not a subagent.
	expect(s.subagentCount).toBe(1);
	expect(s.subagentUsage.cost).toBeCloseTo(5, 9);
	// Every request is counted once: the conversation's own, the scout's and the advisor's two.
	expect(s.usage.requests).toBe(4);
	expect(s.usage.input).toBe(USAGE_A1.input + 5000 + 3000);
	expect(s.usage.cost).toBeCloseTo(USAGE_A1.cost + 5 + 3, 9);
});

test("a conversation without an advisor is unchanged", async () => {
	const own = session(0x11, "Unadvised", { Scout: [5000] });
	const s = await summaryOf(own.file);
	expect(s.advisorUsage).toEqual({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
		requests: 0,
	});
	expect(s.usage.cost).toBeCloseTo(USAGE_A1.cost + 5, 9);
});

test("a conversation with only an advisor counts it, and has no subagents", async () => {
	const own = session(0x12, "Advisor only", {});
	writeTranscript(own.advisor(), [4000]);
	const s = await summaryOf(own.file);
	expect(s.subagentCount).toBe(0);
	expect(s.subagentUsage.requests).toBe(0);
	expect(s.advisorUsage.cost).toBeCloseTo(4, 9);
	expect(s.usage.cost).toBeCloseTo(USAGE_A1.cost + 4, 9);
});

test("named advisors and a subagent's own advisor count too, each request once", async () => {
	const own = session(0x13, "Several advisors", { Scout: [1000] });
	writeTranscript(own.advisor(), [1000]);
	writeTranscript(own.advisor("security"), [2000]);
	writeTranscript(own.advisor("default", "Scout"), [4000]);
	const s = await summaryOf(own.file);
	expect(s.advisorUsage.requests).toBe(3);
	expect(s.advisorUsage.cost).toBeCloseTo(7, 9);
	expect(s.subagentUsage.requests).toBe(1);
	expect(s.usage.requests).toBe(1 + 1 + 3);
	expect(s.usage.cost).toBeCloseTo(USAGE_A1.cost + 1 + 7, 9);
	const listed = await store.listAdvisors(own.file);
	expect(listed.map((a) => [a.id, a.agent]).sort()).toEqual([
		["default", ""],
		["default", "Scout"],
		["security", ""],
	]);
});

test("an advisor that keeps writing changes the total and the list's changes although the conversation's file does not", async () => {
	const own = session(0x14, "Advisor writing", {});
	writeTranscript(own.advisor(), [1000]);
	const before = await summaryOf(own.file);
	const { cursor } = await store.changes(null);
	appendCall(own.advisor(), 2000);
	const after = await summaryOf(own.file);
	expect(after.modifiedAt).toBe(before.modifiedAt);
	expect(after.advisorUsage.requests).toBe(2);
	expect(after.usage.cost).toBeCloseTo(before.usage.cost + 2, 9);
	expect(after.usage.input).toBe(before.usage.input + 2000);
	// A client that has the list is told: this is the only summary that changed.
	const delta = await store.changes(cursor);
	expect(delta.full).toBe(false);
	expect(delta.sessions.map((s) => s.file)).toEqual([own.file]);
	expect(delta.sessions[0]?.advisorUsage.cost).toBeCloseTo(3, 9);
});

test("an advisor that is gone stops counting", async () => {
	const own = session(0x15, "Advisor gone", {});
	writeTranscript(own.advisor(), [1000]);
	expect((await summaryOf(own.file)).advisorUsage.requests).toBe(1);
	rmSync(own.advisor());
	const after = await summaryOf(own.file);
	expect(after.advisorUsage.requests).toBe(0);
	expect(after.usage.cost).toBeCloseTo(USAGE_A1.cost, 9);
});

test("a new process reads the same totals from the database", async () => {
	const own = session(0x16, "Advisor kept", { Scout: [1000] });
	writeTranscript(own.advisor(), [3000]);
	const live = await summaryOf(own.file);
	const next = new SessionStore(join(agentDir, "sessions"), dbFile);
	const again = (await next.list()).find((s) => s.file === own.file);
	next.close();
	expect(live.advisorUsage.cost).toBeCloseTo(3, 9);
	expect(again?.usage).toEqual(live.usage);
	expect(again?.advisorUsage).toEqual(live.advisorUsage);
	expect(again?.subagentUsage).toEqual(live.subagentUsage);
});
