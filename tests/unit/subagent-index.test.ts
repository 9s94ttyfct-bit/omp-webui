import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SubagentIndex, sumAdvisors, sumSubagents } from "../../server/sessions/subagents.ts";

/**
 * The subagent transcripts under a session's artifacts directory (`<session>.jsonl` → `<session>/`): every
 * one's usage is read once per revision of its file, and nested subagents count like the others.
 */

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ompw-subidx-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const session = () => join(root, "bucket", "2026-01-05T11-00-00-000Z_main.jsonl");
const artifacts = () => session().replace(/\.jsonl$/, "");

const usage = (n: number) => ({
	input: n,
	output: 2 * n,
	cacheRead: 100 * n,
	cacheWrite: 3 * n,
	totalTokens: 106 * n,
	cost: { total: n / 1000 },
});

interface Options {
	/** One assistant message per number, with usage scaled by it. */
	calls?: number[];
	start?: string;
	/** A `model_usage` record (a call outside the conversation) on top of the messages. */
	modelUsage?: number;
	/** Modification time in seconds since the epoch. */
	mtime?: number;
}

function transcript(file: string, { calls = [], start = "2026-01-05T10:00:00.000Z", modelUsage, mtime }: Options = {}) {
	mkdirSync(dirname(file), { recursive: true });
	const entries: Record<string, unknown>[] = [{ type: "session", version: 3, id: "sub", timestamp: start, cwd: "/x" }];
	calls.forEach((n, i) => {
		entries.push({
			type: "message",
			id: `m${i}`,
			parentId: i ? `m${i - 1}` : null,
			timestamp: start,
			message: { role: "assistant", content: [{ type: "text", text: `reply ${n}` }], usage: usage(n) },
		});
	});
	if (modelUsage) {
		entries.push({
			type: "model_usage",
			id: "mu",
			parentId: null,
			timestamp: start,
			purpose: "memory",
			usage: usage(modelUsage),
		});
	}
	writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	if (mtime !== undefined) utimesSync(file, mtime, mtime);
}

describe("listing", () => {
	test("names transcripts by file stem, nested ones under their parent, oldest modification first", async () => {
		transcript(join(artifacts(), "Beta.jsonl"), { calls: [1], mtime: 2000 });
		transcript(join(artifacts(), "Alpha.jsonl"), { calls: [2], mtime: 3000 });
		transcript(join(artifacts(), "Alpha", "Alpha.Inner.jsonl"), { calls: [3], mtime: 1000 });
		transcript(join(artifacts(), "Alpha", "Alpha.Inner", "Alpha.Inner.Deep.jsonl"), { calls: [4], mtime: 4000 });
		const list = await new SubagentIndex().list(session());
		expect(list.map((s) => s.id)).toEqual(["Alpha.Inner", "Beta", "Alpha", "Alpha.Inner.Deep"]);
		expect(list.map((s) => s.file)).toContain(join(artifacts(), "Alpha", "Alpha.Inner.jsonl"));
		expect(list.find((s) => s.id === "Beta")?.modifiedAt).toBe(2_000_000);
	});

	test("has no subagents when the session has no artifacts directory", async () => {
		expect(await new SubagentIndex().list(session())).toEqual([]);
	});

	test("reads each transcript's usage, `model_usage` records included, and when it started", async () => {
		transcript(join(artifacts(), "Scout.jsonl"), { calls: [1, 2], modelUsage: 4, start: "2026-01-05T10:30:00.000Z" });
		const [scout] = await new SubagentIndex().list(session());
		expect(scout.startedAt).toBe(Date.parse("2026-01-05T10:30:00.000Z"));
		expect(scout.usage).toMatchObject({
			input: 7,
			output: 14,
			cacheRead: 700,
			cacheWrite: 21,
			totalTokens: 742,
			requests: 3,
		});
		expect(scout.usage.cost).toBeCloseTo(0.007, 9);
	});

	test("takes only what the artifacts directory names: the advisor and stray folders are not subagents", async () => {
		transcript(join(artifacts(), "Scout.jsonl"), { calls: [1] });
		transcript(join(artifacts(), "__advisor.jsonl"), { calls: [9] });
		transcript(join(artifacts(), "local", "stray.jsonl"), { calls: [9] });
		transcript(join(artifacts(), "url-search", "cache.jsonl"), { calls: [9] });
		// Notes next to a transcript are not transcripts.
		writeFileSync(join(artifacts(), "Scout.md"), "# notes");
		const list = await new SubagentIndex().list(session());
		expect(list.map((s) => s.id)).toEqual(["Scout"]);
	});

	test("keeps working while a subagent is writing: a half-written last line adds nothing", async () => {
		const file = join(artifacts(), "Scout.jsonl");
		transcript(file, { calls: [1] });
		writeFileSync(
			file,
			`${JSON.stringify({ type: "message", id: "m9", message: { role: "assistant", usage: usage(5) } }).slice(0, 40)}`,
			{
				flag: "a",
			},
		);
		const [scout] = await new SubagentIndex().list(session());
		expect(scout.usage.requests).toBe(1);
	});
});

describe("caching", () => {
	test("a transcript is read once while its file stays as it is", async () => {
		transcript(join(artifacts(), "A.jsonl"), { calls: [1] });
		transcript(join(artifacts(), "B.jsonl"), { calls: [2] });
		const index = new SubagentIndex();
		await index.list(session());
		expect(index.parsed).toBe(2);
		const again = await index.list(session());
		expect(index.parsed).toBe(2);
		expect(again.map((s) => s.usage.input).sort()).toEqual([1, 2]);
	});

	test("a transcript that grew is read again, and only that one", async () => {
		const a = join(artifacts(), "A.jsonl");
		transcript(a, { calls: [1], mtime: 1000 });
		transcript(join(artifacts(), "B.jsonl"), { calls: [2], mtime: 1000 });
		const index = new SubagentIndex();
		await index.list(session());
		transcript(a, { calls: [1, 5], mtime: 2000 });
		const list = await index.list(session());
		expect(index.parsed).toBe(3);
		expect(list.find((s) => s.id === "A")?.usage.input).toBe(6);
		expect(list.find((s) => s.id === "B")?.usage.input).toBe(2);
	});

	/** The line `transcript` writes for assistant message `i` with usage scaled by `n`. */
	const messageLine = (i: number, n: number) =>
		`${JSON.stringify({
			type: "message",
			id: `m${i}`,
			parentId: i ? `m${i - 1}` : null,
			timestamp: "2026-01-05T10:00:00.000Z",
			message: { role: "assistant", content: [{ type: "text", text: `reply ${n}` }], usage: usage(n) },
		})}\n`;

	test("a transcript that grew is read on from where the last read stopped, not from its first byte", async () => {
		const a = join(artifacts(), "A.jsonl");
		transcript(a, { calls: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], mtime: 1000 });
		const size = statSync(a).size;
		const index = new SubagentIndex();
		await index.list(session());
		expect(index.bytesRead).toBe(size);
		const added = messageLine(10, 11);
		appendFileSync(a, added);
		utimesSync(a, 2000, 2000);
		const [grown] = await index.list(session());
		// Only the new line was read, and what it spent is added to what the transcript had spent before it.
		expect(index.bytesRead).toBe(size + added.length);
		expect(grown?.usage.requests).toBe(11);
		expect(grown?.usage.input).toBe(66);
	});

	test("a transcript that was rewritten is read again from its start", async () => {
		const a = join(artifacts(), "A.jsonl");
		transcript(a, { calls: [1, 2, 3], mtime: 1000 });
		const index = new SubagentIndex();
		await index.list(session());
		// Not the same transcript with more at the end: what was read before is no longer what the file starts with.
		transcript(a, { calls: [20, 30, 40, 50], mtime: 2000 });
		const [rewritten] = await index.list(session());
		expect(rewritten?.usage.requests).toBe(4);
		expect(rewritten?.usage.input).toBe(140);
		expect(index.bytesRead).toBeGreaterThan(statSync(a).size);
	});

	test("a line the writer is in the middle of is left for the next read, and counted once, when it is whole", async () => {
		const a = join(artifacts(), "A.jsonl");
		transcript(a, { calls: [1], mtime: 1000 });
		const complete = statSync(a).size;
		const line = messageLine(1, 5);
		appendFileSync(a, line.slice(0, 40));
		utimesSync(a, 2000, 2000);
		const index = new SubagentIndex();
		const [half] = await index.list(session());
		expect(half?.usage.requests).toBe(1);
		// Not read as far as the half line: it is read from its start once the rest is there.
		expect(index.bytesRead).toBe(complete);
		appendFileSync(a, line.slice(40));
		utimesSync(a, 3000, 3000);
		const [whole] = await index.list(session());
		expect(whole?.usage.requests).toBe(2);
		expect(whole?.usage.input).toBe(6);
		expect(index.bytesRead).toBe(complete + line.length);
	});

	test("the database carries the cache over to the next process", async () => {
		const db = new Database(":memory:");
		transcript(join(artifacts(), "A.jsonl"), { calls: [1, 2] });
		const first = new SubagentIndex(db);
		const before = await first.list(session());
		expect(first.parsed).toBe(1);
		const second = new SubagentIndex(db);
		const after = await second.list(session());
		expect(second.parsed).toBe(0);
		expect(after).toEqual(before);
	});

	test("each transcript's providers are read with its usage and kept; a row kept before them is read again when a page asks (#688)", async () => {
		const file = join(artifacts(), "A.jsonl");
		mkdirSync(dirname(file), { recursive: true });
		const at = "2026-01-05T10:00:00.000Z";
		const entries = [
			{ type: "session", version: 3, id: "sub", timestamp: at, cwd: "/x" },
			{
				type: "message",
				id: "m0",
				parentId: null,
				timestamp: at,
				message: { role: "assistant", provider: "anthropic", content: [], usage: usage(1) },
			},
			{
				type: "model_usage",
				id: "mu",
				parentId: null,
				timestamp: at,
				provider: "openai-codex",
				model: "gpt",
				usage: usage(1),
			},
			{
				type: "message",
				id: "m1",
				parentId: "m0",
				timestamp: at,
				message: { role: "assistant", provider: "anthropic", content: [], usage: usage(1) },
			},
		];
		writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
		// A table as a version before providers left it, with this transcript's row in it.
		const db = new Database(":memory:");
		db.run(
			"CREATE TABLE subagent_usage (file TEXT PRIMARY KEY, owner TEXT NOT NULL, mtime REAL, size INTEGER, started REAL, usage TEXT)",
		);
		const st = statSync(file);
		const kept = { input: 2, output: 4, cacheRead: 200, cacheWrite: 6, totalTokens: 212, cost: 0.002, requests: 2 };
		db.run("INSERT INTO subagent_usage VALUES (?, ?, ?, ?, ?, ?)", [
			file,
			session(),
			st.mtimeMs,
			st.size,
			1,
			JSON.stringify(kept),
		]);
		const old = new SubagentIndex(db);
		// The session list's totals do not read it again for them.
		const listed = await old.scan(session());
		expect(old.parsed).toBe(0);
		expect(listed.subagents[0]?.providers).toEqual([]);
		// A page that shows the conversation does, once.
		expect((await old.scan(session(), true)).subagents[0]?.providers).toEqual(["anthropic", "openai-codex"]);
		expect(old.parsed).toBe(1);
		await old.scan(session(), true);
		expect(old.parsed).toBe(1);
		// And the next process has them from the database.
		const next = new SubagentIndex(db);
		expect((await next.list(session()))[0]?.providers).toEqual(["anthropic", "openai-codex"]);
		expect(next.parsed).toBe(0);
	});

	test("what belongs to deleted sessions is dropped", async () => {
		const db = new Database(":memory:");
		transcript(join(artifacts(), "A.jsonl"), { calls: [1] });
		const index = new SubagentIndex(db);
		await index.list(session());
		index.prune(new Set());
		await index.list(session());
		expect(index.parsed).toBe(2);
		expect(new SubagentIndex(db).parsed).toBe(0);
		index.prune(new Set());
		const fresh = new SubagentIndex(db);
		await fresh.list(session());
		expect(fresh.parsed).toBe(1);
	});

	test("a transcript that is gone stops counting", async () => {
		transcript(join(artifacts(), "A.jsonl"), { calls: [1] });
		const b = join(artifacts(), "B.jsonl");
		transcript(b, { calls: [2] });
		const index = new SubagentIndex();
		await index.list(session());
		rmSync(b);
		expect((await index.list(session())).map((s) => s.id)).toEqual(["A"]);
	});
});

describe("totals", () => {
	test("sum every subagent's usage and count them", async () => {
		transcript(join(artifacts(), "A.jsonl"), { calls: [1] });
		transcript(join(artifacts(), "A", "A.B.jsonl"), { calls: [2, 3] });
		const sum = sumSubagents(await new SubagentIndex().list(session()));
		expect(sum.count).toBe(2);
		expect(sum.usage).toMatchObject({
			input: 6,
			output: 12,
			cacheRead: 600,
			cacheWrite: 18,
			totalTokens: 636,
			requests: 3,
		});
		expect(sum.usage.cost).toBeCloseTo(0.006, 9);
	});

	test("are zero without subagents", () => {
		const sum = sumSubagents([]);
		expect(sum.count).toBe(0);
		expect(sum.usage).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: 0,
			requests: 0,
		});
	});
});

describe("advisor transcripts", () => {
	test("are listed apart from the subagents: the default advisor, named ones, and a subagent's own", async () => {
		transcript(join(artifacts(), "Scout.jsonl"), { calls: [1] });
		transcript(join(artifacts(), "__advisor.jsonl"), { calls: [2, 3], mtime: 1000 });
		transcript(join(artifacts(), "__advisor.security.jsonl"), { calls: [4], mtime: 2000 });
		transcript(join(artifacts(), "Scout", "__advisor.jsonl"), { calls: [5], mtime: 3000 });
		const { subagents, advisors } = await new SubagentIndex().scan(session());
		expect(subagents.map((s) => s.id)).toEqual(["Scout"]);
		expect(advisors.map((a) => [a.id, a.agent])).toEqual([
			["default", ""],
			["security", ""],
			["default", "Scout"],
		]);
		expect(advisors.map((a) => a.usage.input)).toEqual([5, 4, 5]);
		expect(advisors[0]?.file).toBe(join(artifacts(), "__advisor.jsonl"));
	});

	test("`list` still answers the subagents alone", async () => {
		transcript(join(artifacts(), "Scout.jsonl"), { calls: [1] });
		transcript(join(artifacts(), "__advisor.jsonl"), { calls: [9] });
		expect((await new SubagentIndex().list(session())).map((s) => s.id)).toEqual(["Scout"]);
	});

	test("files that only look like an advisor's (a lock, notes, `__advisors`, other `__` files) are not read", async () => {
		transcript(join(artifacts(), "__advisor.jsonl"), { calls: [1] });
		writeFileSync(join(artifacts(), ".__advisor.jsonl.lock.os"), "");
		writeFileSync(join(artifacts(), "__advisor.md"), "# notes");
		transcript(join(artifacts(), "__advisors.jsonl"), { calls: [9] });
		transcript(join(artifacts(), "__other.jsonl"), { calls: [9] });
		const { advisors } = await new SubagentIndex().scan(session());
		expect(advisors.map((a) => a.file)).toEqual([join(artifacts(), "__advisor.jsonl")]);
	});

	test("an advisor's requests are read like a subagent's: `model_usage` records too, once per revision of its file", async () => {
		transcript(join(artifacts(), "__advisor.jsonl"), {
			calls: [1, 2],
			modelUsage: 4,
			start: "2026-01-05T10:30:00.000Z",
		});
		const index = new SubagentIndex();
		const [advisor] = (await index.scan(session())).advisors;
		expect(advisor?.startedAt).toBe(Date.parse("2026-01-05T10:30:00.000Z"));
		expect(advisor?.usage).toMatchObject({
			input: 7,
			output: 14,
			cacheRead: 700,
			cacheWrite: 21,
			totalTokens: 742,
			requests: 3,
		});
		expect(advisor?.usage.cost).toBeCloseTo(0.007, 9);
		await index.scan(session());
		expect(index.parsed).toBe(1);
	});

	test("an advisor that went on is read on from where the last read stopped, and the subagents are not read again", async () => {
		const a = join(artifacts(), "__advisor.jsonl");
		transcript(a, { calls: [1, 2], mtime: 1000 });
		transcript(join(artifacts(), "Scout.jsonl"), { calls: [3], mtime: 1000 });
		const index = new SubagentIndex();
		await index.scan(session());
		const size = statSync(a).size + statSync(join(artifacts(), "Scout.jsonl")).size;
		expect(index.bytesRead).toBe(size);
		const line = `${JSON.stringify({ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", usage: usage(5) } })}\n`;
		appendFileSync(a, line);
		utimesSync(a, 2000, 2000);
		const { advisors, subagents } = await index.scan(session());
		expect(index.bytesRead).toBe(size + line.length);
		expect(advisors[0]?.usage.requests).toBe(3);
		expect(advisors[0]?.usage.input).toBe(8);
		expect(subagents[0]?.usage.input).toBe(3);
	});

	test("one that is gone stops counting, and the subagents beside it are kept", async () => {
		const a = join(artifacts(), "__advisor.jsonl");
		transcript(a, { calls: [1] });
		transcript(join(artifacts(), "Scout.jsonl"), { calls: [2] });
		const index = new SubagentIndex();
		await index.scan(session());
		rmSync(a);
		const after = await index.scan(session());
		expect(after.advisors).toEqual([]);
		expect(after.subagents.map((s) => s.id)).toEqual(["Scout"]);
		expect(index.parsed).toBe(2);
	});

	test("the database carries them over to the next process, and drops them with their session", async () => {
		const db = new Database(":memory:");
		transcript(join(artifacts(), "__advisor.jsonl"), { calls: [1, 2] });
		const first = new SubagentIndex(db);
		const before = (await first.scan(session())).advisors;
		const second = new SubagentIndex(db);
		expect((await second.scan(session())).advisors).toEqual(before);
		expect(second.parsed).toBe(0);
		second.prune(new Set());
		const fresh = new SubagentIndex(db);
		await fresh.scan(session());
		expect(fresh.parsed).toBe(1);
	});

	test("sum to one total, and are zero without any", async () => {
		transcript(join(artifacts(), "__advisor.jsonl"), { calls: [1] });
		transcript(join(artifacts(), "__advisor.security.jsonl"), { calls: [2, 3] });
		const sum = sumAdvisors((await new SubagentIndex().scan(session())).advisors);
		expect(sum).toMatchObject({ input: 6, output: 12, cacheRead: 600, cacheWrite: 18, totalTokens: 636, requests: 3 });
		expect(sum.cost).toBeCloseTo(0.006, 9);
		expect(sumAdvisors([])).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: 0,
			requests: 0,
		});
	});
});
