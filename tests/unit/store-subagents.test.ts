import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../server/sessions/store.ts";
import { FIXTURE_BUCKET, FIXTURE_FILES, seedFixtures, USAGE_A1, USAGE_A2, USAGE_A3 } from "../support/fixtures.ts";

/**
 * A conversation's cost is its own requests plus its subagents' — the finished ones, the nested ones and the ones
 * still writing — and the sidebar, the usage page and the chat header all read it from the session list.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-store-sub-"));
const agentDir = join(root, "agent");
const dbFile = join(root, "index.db");
let store: SessionStore;
let gamma: string;
let artifacts: string;

beforeAll(() => {
	const seeded = seedFixtures(agentDir);
	gamma = seeded.gamma;
	artifacts = gamma.replace(/\.jsonl$/, "");
	store = new SessionStore(join(agentDir, "sessions"), dbFile);
});
afterAll(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

const reply = (id: string, calls: number) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-01-05T10:00:00.000Z",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "more work" }],
		usage: {
			input: calls,
			output: calls,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2 * calls,
			cost: { total: calls / 1000 },
		},
	},
});

const summaryOf = async (file: string) => {
	await store.refresh(true);
	const found = (await store.list()).find((s) => s.file === file);
	if (!found) throw new Error(`no summary for ${file}`);
	return found;
};

test("a conversation's usage includes its subagents', which are also listed on their own", async () => {
	const s = await summaryOf(gamma);
	// The file holds three assistant messages (one on an abandoned branch); the scout has one of its own.
	expect(s.subagentCount).toBe(1);
	expect(s.subagentUsage).toMatchObject({ input: USAGE_A3.input, output: USAGE_A3.output, requests: 1 });
	expect(s.subagentUsage.cost).toBeCloseTo(USAGE_A3.cost, 9);
	expect(s.usage.input).toBe(4 * USAGE_A3.input);
	expect(s.usage.cacheRead).toBe(4 * USAGE_A3.cacheRead);
	expect(s.usage.requests).toBe(4);
	expect(s.usage.cost).toBeCloseTo(4 * USAGE_A3.cost, 9);
});

test("a conversation without subagents is unchanged", async () => {
	const alpha = await summaryOf(join(agentDir, "sessions", FIXTURE_BUCKET, FIXTURE_FILES.alpha));
	expect(alpha.subagentCount).toBe(0);
	expect(alpha.subagentUsage.cost).toBe(0);
	expect(alpha.usage.cost).toBeCloseTo(USAGE_A1.cost + USAGE_A2.cost + USAGE_A3.cost, 9);
});

test("a subagent that keeps writing changes the total although its parent's file does not", async () => {
	const before = await summaryOf(gamma);
	appendFileSync(join(artifacts, "ScoutAgent.jsonl"), `${JSON.stringify(reply("late1", 50))}\n`);
	const after = await summaryOf(gamma);
	expect(after.modifiedAt).toBe(before.modifiedAt);
	expect(after.subagentUsage.requests).toBe(2);
	expect(after.subagentUsage.input).toBe(USAGE_A3.input + 50);
	expect(after.usage.cost).toBeCloseTo(before.usage.cost + 0.05, 9);
	expect(after.usage.input).toBe(before.usage.input + 50);
});

test("nested subagents count, under the id their parent's name gives them", async () => {
	const nested = join(artifacts, "ScoutAgent");
	mkdirSync(nested, { recursive: true });
	const file = join(nested, "ScoutAgent.Grandchild.jsonl");
	writeFileSync(
		file,
		`${[{ type: "session", version: 3, id: "gc", timestamp: "2026-01-05T10:01:00.000Z", cwd: "/x" }, reply("gc1", 100)]
			.map((e) => JSON.stringify(e))
			.join("\n")}\n`,
	);
	const s = await summaryOf(gamma);
	expect(s.subagentCount).toBe(2);
	const listed = await store.listSubagents(gamma);
	expect(listed.map((a) => a.id).sort()).toEqual(["ScoutAgent", "ScoutAgent.Grandchild"]);
	expect(listed.find((a) => a.id === "ScoutAgent.Grandchild")?.usage.input).toBe(100);
	expect(listed.find((a) => a.id === "ScoutAgent.Grandchild")?.startedAt).toBe(Date.parse("2026-01-05T10:01:00.000Z"));
});

test("a new process reads the same totals from the database without opening the transcripts again", async () => {
	const live = await summaryOf(gamma);
	const next = new SessionStore(join(agentDir, "sessions"), dbFile);
	const again = (await next.list()).find((s) => s.file === gamma);
	next.close();
	expect(again?.usage).toEqual(live.usage);
	expect(again?.subagentUsage).toEqual(live.subagentUsage);
});

test("subagents of a deleted conversation are forgotten", async () => {
	const doomed = join(agentDir, "sessions", FIXTURE_BUCKET, "2026-01-09T00-00-00-000Z_doomed.jsonl");
	writeFileSync(
		doomed,
		`${JSON.stringify({ type: "session", version: 3, id: "doomed", timestamp: "2026-01-09T00:00:00.000Z", cwd: "/x" })}\n`,
	);
	utimesSync(doomed, 5, 5);
	const dir = doomed.replace(/\.jsonl$/, "");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "Gone.jsonl"),
		`${JSON.stringify({ type: "session", version: 3, id: "g", timestamp: "2026-01-09T00:00:00.000Z" })}\n`,
	);
	expect((await summaryOf(doomed)).subagentCount).toBe(1);
	rmSync(doomed);
	rmSync(dir, { recursive: true });
	await store.refresh(true);
	expect((await store.list()).some((s) => s.file === doomed)).toBe(false);
});
