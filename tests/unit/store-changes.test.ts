import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../server/sessions/store.ts";
import { seedFixtures } from "../support/fixtures.ts";

/**
 * The sessions list as a client that already has one needs it: what changed since the cursor of its last answer.
 * A conversation that is written to changes one summary, and only that one is sent again.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-changes-"));
const agentDir = join(root, "agent");
let store: SessionStore;
let alpha: string;
let beta: string;
let gamma: string;

beforeAll(() => {
	const seeded = seedFixtures(agentDir);
	alpha = seeded.alpha;
	beta = seeded.beta;
	gamma = seeded.gamma;
	store = new SessionStore(join(agentDir, "sessions"), join(root, "index.db"));
});
afterAll(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

const reply = (id: string) =>
	`${JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-05T10:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "more" }],
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.001 } },
		},
	})}\n`;

/** What a client holding `held` has after applying `changes` (the same fold the web UI does). */
function apply(held: { file: string }[], changes: Awaited<ReturnType<SessionStore["changes"]>>) {
	if (changes.full) return changes.sessions;
	const gone = new Set(changes.removed);
	const next = new Map(held.filter((s) => !gone.has(s.file)).map((s) => [s.file, s]));
	for (const s of changes.sessions) next.set(s.file, s);
	return [...next.values()];
}
const byFile = (list: { file: string }[]) => [...list].sort((a, b) => a.file.localeCompare(b.file));

test("without a cursor the whole list comes back, and the cursor it carries asks for nothing more", async () => {
	const first = await store.changes(null);
	expect(first.full).toBe(true);
	expect(first.sessions.map((s) => s.file)).toEqual((await store.list()).map((s) => s.file));
	expect(first.removed).toEqual([]);

	const again = await store.changes(first.cursor);
	expect(again.full).toBe(false);
	expect(again.sessions).toEqual([]);
	expect(again.removed).toEqual([]);
	expect(again.cursor).toBe(first.cursor);
});

test("writing to a conversation sends that conversation's summary and no other", async () => {
	const before = await store.changes(null);
	appendFileSync(alpha, reply("added-1"));
	await store.refresh(true);
	const delta = await store.changes(before.cursor);
	expect(delta.full).toBe(false);
	expect(delta.sessions.map((s) => s.file)).toEqual([alpha]);
	const old = before.sessions.find((s) => s.file === alpha);
	expect(delta.sessions[0]?.messageCount).toBe((old?.messageCount ?? 0) + 1);
	expect(delta.cursor).not.toBe(before.cursor);
	expect(byFile(apply(before.sessions, delta))).toEqual(byFile(await store.list()));
});

test("what a subagent spends changes its parent's summary though the parent's file did not", async () => {
	const before = await store.changes(null);
	const artifacts = gamma.replace(/\.jsonl$/, "");
	mkdirSync(artifacts, { recursive: true });
	writeFileSync(
		join(artifacts, "Helper.jsonl"),
		`${JSON.stringify({ type: "session", version: 3, id: "helper", timestamp: "2026-01-05T10:00:00.000Z" })}\n${reply("h1")}`,
	);
	await store.refresh(true);
	const delta = await store.changes(before.cursor);
	expect(delta.sessions.map((s) => s.file)).toEqual([gamma]);
	expect(delta.sessions[0]?.subagentCount).toBe(
		(before.sessions.find((s) => s.file === gamma)?.subagentCount ?? 0) + 1,
	);
	expect(byFile(apply(before.sessions, delta))).toEqual(byFile(await store.list()));
});

test("a conversation that is deleted is listed as removed, and one that comes back is not", async () => {
	const before = await store.changes(null);
	const saved = (await Bun.file(beta).text()) as string;
	rmSync(beta);
	await store.refresh(true);
	const gone = await store.changes(before.cursor);
	expect(gone.removed).toEqual([beta]);
	expect(gone.sessions).toEqual([]);
	expect(apply(before.sessions, gone).some((s) => s.file === beta)).toBe(false);

	writeFileSync(beta, saved);
	await store.refresh(true);
	const back = await store.changes(gone.cursor);
	expect(back.removed).toEqual([]);
	expect(back.sessions.map((s) => s.file)).toEqual([beta]);
	// A client that missed both steps sees the file as changed, not as gone.
	const skipped = await store.changes(before.cursor);
	expect(skipped.removed).toEqual([]);
	expect(skipped.sessions.map((s) => s.file)).toEqual([beta]);
	expect(byFile(apply(before.sessions, skipped))).toEqual(byFile(await store.list()));
});

test("a cursor that is not this store's gets the whole list", async () => {
	const ours = await store.changes(null);
	const stranger = new SessionStore(join(agentDir, "sessions"), join(root, "other.db"));
	try {
		const theirs = await stranger.changes(null);
		expect(theirs.cursor).not.toBe(ours.cursor);
		expect((await store.changes(theirs.cursor)).full).toBe(true);
	} finally {
		stranger.close();
	}
	for (const cursor of [
		"",
		"garbage",
		`${ours.cursor}9999`,
		ours.cursor.replace(/\.\d+$/, ".-1"),
		ours.cursor.replace(/\.\d+$/, ".x"),
	]) {
		expect((await store.changes(cursor)).full).toBe(true);
	}
});
