import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Answer, ModelLike } from "../../server/omp/gate/review.ts";
import {
	buildConflictPrompt,
	CONFLICT_SYSTEM,
	ConflictCache,
	conflictKey,
	parseConflictReply,
	type SourceText,
} from "../../server/omp/guidance/conflict.ts";
import { type ConflictCheckDeps, GuidanceConflictCheck } from "../../server/omp/guidance/conflict-check.ts";
import { contextSources, labelOf, levelOf, memorySources } from "../../server/omp/guidance/conflict-sources.ts";
import { repoRuleFiles } from "../../server/omp/guidance/loaded-context.ts";
import { applyChange, CONFLICT_LIMITS, lineDiff } from "../../shared/guidance-conflict.ts";
import type { MemoryItem } from "../../shared/memory.ts";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * The guidance conflict check (v0.13.0) without omp or a model: the prompt and its size limits, the reading of the model's
 * answer (a malformed one included), the diffs and the text changes a proposal is, the cache, which context files are read
 * for a folder, and the check as the server runs it with a fake model. What a real omp sends is a contract test
 * (`tests/contract/guidance-conflict.test.ts`).
 */

const GUIDANCE = "## Model guidance\nReply in English.\nAt most 1 Sonnet subagent at a time.";

const file = (over: Partial<SourceText> = {}): SourceText => ({
	id: "f1",
	kind: "file",
	label: "AGENTS.md",
	level: "project",
	rel: "AGENTS.md",
	truncated: false,
	text: "# Project\nAlways reply in Chinese.\nRun the tests before you commit.",
	...over,
});

const memory = (over: Partial<SourceText> = {}): SourceText => ({
	id: "m1",
	kind: "memory",
	label: "The user wants terse answers",
	level: "project",
	rel: null,
	bank: "proj-bank",
	memoryId: "mem-1",
	truncated: false,
	text: "The user wants every answer in Chinese.",
	...over,
});

const reply = (conflicts: unknown[]): string => JSON.stringify({ conflicts });

describe("the prompt", () => {
	test("carries the guidance and each source fenced by its id, files marked editable or not", () => {
		const p = buildConflictPrompt(GUIDANCE, [
			file(),
			file({ id: "f2", label: "~/.omp/agent/AGENTS.md", level: "user", rel: null }),
			memory(),
		]);
		expect(p.system).toBe(CONFLICT_SYSTEM);
		expect(p.user).toContain(`<<<GUIDANCE\n${GUIDANCE}\nGUIDANCE>>>`);
		expect(p.user).toContain("SOURCE f1: project instruction file AGENTS.md (editable)");
		expect(p.user).toContain("SOURCE f2: user-level instruction file ~/.omp/agent/AGENTS.md (not editable)");
		expect(p.user).toContain("SOURCE m1: memory saved for this project");
		expect(p.user).toContain("<<<m1\nThe user wants every answer in Chinese.\nm1>>>");
		expect(p.sources.map((s) => [s.id, s.truncated])).toEqual([
			["f1", false],
			["f2", false],
			["m1", false],
		]);
		// The page is told of the sources, not their text.
		expect(p.sources[0]).not.toHaveProperty("text");
	});

	test("a long file is cut with a note of how much was left out, and the page is told", () => {
		const long = "x".repeat(CONFLICT_LIMITS.fileChars + 500);
		const p = buildConflictPrompt(GUIDANCE, [file({ text: long })]);
		expect(p.user).toContain(`${"x".repeat(CONFLICT_LIMITS.fileChars)}\n[… 500 more characters not shown`);
		expect(p.user).not.toContain("x".repeat(CONFLICT_LIMITS.fileChars + 1));
		expect(p.sources[0].truncated).toBe(true);
	});

	test("files past the total are named as not read, and are not sources the answer may name", () => {
		const big = "y".repeat(CONFLICT_LIMITS.fileChars);
		const files = [1, 2, 3, 4].map((n) => file({ id: `f${n}`, label: `F${n}.md`, text: big }));
		const p = buildConflictPrompt(GUIDANCE, files);
		// 30,000 characters: two whole files and half of the third; the fourth is not read.
		expect(p.sources.map((s) => s.id)).toEqual(["f1", "f2", "f3"]);
		expect(p.sources[2].truncated).toBe(true);
		expect(p.user).toContain("Not read (over the size limit of the check): f4 (F4.md).");
	});

	test("memories are bounded by count, by length each and in all", () => {
		const many = Array.from({ length: CONFLICT_LIMITS.memories + 5 }, (_, i) =>
			memory({ id: `m${i + 1}`, text: `memory ${i + 1} ${"z".repeat(1000)}` }),
		);
		const p = buildConflictPrompt(GUIDANCE, many);
		const told = p.sources.filter((s) => s.kind === "memory");
		// 8,000 characters at 600 each: 13 whole, a 14th cut short.
		expect(told.length).toBeLessThanOrEqual(CONFLICT_LIMITS.memories);
		expect(told.length).toBe(14);
		expect(told.every((s) => s.truncated)).toBe(true);
		expect(p.user).not.toContain("z".repeat(CONFLICT_LIMITS.memoryChars));
		expect(p.user).toContain("Not read (over the size limit of the check): m15");
	});
});

describe("the answer", () => {
	const sources = [
		file(),
		file({ id: "f2", label: "~/x/AGENTS.md", rel: null, text: "Always reply in Chinese." }),
		memory(),
	];

	test("a conflict with a guidance change: kept with its diff", () => {
		const out = parseConflictReply(
			reply([
				{
					guidance: "Reply in English.",
					source: "f1",
					other: "Always reply in Chinese.",
					why: "Two reply languages.",
					change: { target: "guidance", find: "Reply in English.", replace: "Reply in Chinese." },
				},
			]),
			GUIDANCE,
			sources,
		);
		expect(out).toHaveLength(1);
		const change = out?.[0].change;
		expect(change?.target).toBe("guidance");
		if (change?.target !== "guidance") throw new Error("not a guidance change");
		expect(change.diff).toEqual([
			{ kind: "same", text: "## Model guidance" },
			{ kind: "del", text: "Reply in English." },
			{ kind: "add", text: "Reply in Chinese." },
			{ kind: "same", text: "At most 1 Sonnet subagent at a time." },
		]);
	});

	test("a change to an editable file, to a file that is not, and forgetting a memory", () => {
		const out = parseConflictReply(
			reply([
				{
					guidance: "Reply in English.",
					source: "f1",
					other: "Always reply in Chinese.",
					change: { target: "source", find: "Always reply in Chinese.", replace: "Reply in English." },
				},
				{
					guidance: "Reply in English.",
					source: "f2",
					other: "Always reply in Chinese.",
					change: { target: "source", find: "Always reply in Chinese.", replace: "" },
				},
				{ guidance: "Reply in English.", source: "m1", other: "every answer in Chinese", change: { target: "source" } },
			]),
			GUIDANCE,
			sources,
		);
		expect(out?.map((c) => c.change?.target ?? null)).toEqual(["file", null, "memory"]);
		expect(out?.[0].change).toMatchObject({
			target: "file",
			source: "f1",
			rel: "AGENTS.md",
			replace: "Reply in English.",
		});
		expect(out?.[2].change).toEqual({ target: "memory", source: "m1", bank: "proj-bank", memoryId: "mem-1" });
	});

	test("a change whose text is not there exactly once keeps the conflict and drops the change", () => {
		const twice = `${GUIDANCE}\nReply in English.`;
		const out = parseConflictReply(
			reply([
				{
					guidance: "Reply in English.",
					source: "f1",
					other: "Chinese",
					change: { target: "guidance", find: "Reply in English.", replace: "" },
				},
				{
					guidance: "Sonnet",
					source: "f1",
					other: "Chinese",
					change: { target: "guidance", find: "not in the text", replace: "" },
				},
				{ guidance: "Sonnet", source: "f1", other: "tests", change: { target: "guidance", find: "", replace: "x" } },
				{
					guidance: "Sonnet",
					source: "f1",
					other: "commit",
					change: { target: "nowhere", find: "Sonnet", replace: "x" },
				},
			]),
			twice,
			sources,
		);
		expect(out?.map((c) => c.change)).toEqual([null, null, null, null]);
	});

	test("a code fence around the object is tolerated; anything else is not an answer", () => {
		const ok = `\`\`\`json\n${reply([])}\n\`\`\``;
		expect(parseConflictReply(ok, GUIDANCE, sources)).toEqual([]);
		for (const bad of [
			"",
			"No conflicts.",
			`Here you go: ${reply([])}`,
			"[]",
			'{"conflicts": "none"}',
			'{"found": []}',
			"{not json}",
			"null",
		])
			expect(parseConflictReply(bad, GUIDANCE, sources)).toBeNull();
	});

	test("conflicts naming no known source or lacking a quote are dropped, repeats too, and at most the limit is kept", () => {
		const good = { guidance: "Reply in English.", source: "f1", other: "Always reply in Chinese." };
		const out = parseConflictReply(
			reply([
				{ ...good, source: "f9" },
				{ ...good, guidance: "" },
				{ ...good, other: 42 },
				"a string",
				good,
				good,
				...Array.from({ length: 20 }, (_, i) => ({ ...good, other: `other ${i}`, guidance: `g ${"q".repeat(800)}` })),
			]),
			GUIDANCE,
			sources,
		);
		expect(out).toHaveLength(CONFLICT_LIMITS.conflicts);
		expect(out?.[0]).toEqual({ ...good, why: "", change: null });
		// A quote is cut to what a person reads.
		expect(out?.[1].guidance.length).toBe(CONFLICT_LIMITS.quoteChars);
	});
});

describe("text changes and diffs", () => {
	test("applyChange replaces the one occurrence, and refuses none or several", () => {
		expect(applyChange("a b c", "b", "B")).toBe("a B c");
		expect(applyChange("a b c", "b ", "")).toBe("a c");
		expect(applyChange("a b b", "b", "B")).toBeNull();
		expect(applyChange("a b c", "x", "B")).toBeNull();
		expect(applyChange("a b c", "", "B")).toBeNull();
	});

	test("lineDiff folds the unchanged lines beyond the context into gaps", () => {
		const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
		const after = before.replace("line 10", "LINE TEN");
		expect(lineDiff(before, after)).toEqual([
			{ kind: "gap", lines: 8 },
			{ kind: "same", text: "line 8" },
			{ kind: "same", text: "line 9" },
			{ kind: "del", text: "line 10" },
			{ kind: "add", text: "LINE TEN" },
			{ kind: "same", text: "line 11" },
			{ kind: "same", text: "line 12" },
			{ kind: "gap", lines: 7 },
		]);
		expect(lineDiff(before, before)).toEqual([]);
	});

	test("lineDiff matches what stays between changes", () => {
		expect(lineDiff("a\nb\nc\nd", "a\nB\nc\nD\ne", 0)).toEqual([
			{ kind: "gap", lines: 1 },
			{ kind: "del", text: "b" },
			{ kind: "add", text: "B" },
			{ kind: "gap", lines: 1 },
			{ kind: "del", text: "d" },
			{ kind: "add", text: "D" },
			{ kind: "add", text: "e" },
		]);
		expect(lineDiff("", "new")).toEqual([
			{ kind: "del", text: "" },
			{ kind: "add", text: "new" },
		]);
	});
});

describe("the cache", () => {
	test("keeps the most recently used, and drops the oldest past its size", () => {
		const cache = new ConflictCache<number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		expect(cache.get("a")).toBe(1);
		cache.set("c", 3);
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBe(1);
		expect(cache.get("c")).toBe(3);
		expect(cache.size).toBe(2);
	});

	test("the key covers the whole of each source, beyond what the prompt shows", () => {
		const long = "x".repeat(CONFLICT_LIMITS.fileChars + 10);
		const a = [file({ text: `${long}A` })];
		const b = [file({ text: `${long}B` })];
		const pa = buildConflictPrompt(GUIDANCE, a);
		const pb = buildConflictPrompt(GUIDANCE, b);
		expect(pa.user).toBe(pb.user);
		expect(conflictKey(pa, GUIDANCE, a)).not.toBe(conflictKey(pb, GUIDANCE, b));
		expect(conflictKey(pa, GUIDANCE, a)).toBe(conflictKey(buildConflictPrompt(GUIDANCE, a), GUIDANCE, a));
	});
});

describe("the context files of a folder", () => {
	const PROMPT = [
		"# Identity\n\nYou are an agent.",
		[
			"<project-context>",
			"<repo-rules>",
			"MUST follow these context files for all tasks:",
			'<file path="/h/.omp/agent/AGENTS.md">',
			"USER-NATIVE marker",
			"</file>",
			'<file path="~/work/repo/AGENTS.md">',
			"REPO-AGENTS marker. Read IMPORTED-TEXT marker: always use tabs",
			"</file>",
			"</repo-rules>",
			"</project-context>",
		].join("\n"),
	];

	test("the files are the ones in omp's <repo-rules>, with the text the agent sees and ~ made absolute", () => {
		const files = repoRuleFiles(PROMPT, "/h");
		expect(files).toEqual([
			{ path: "/h/.omp/agent/AGENTS.md", text: "USER-NATIVE marker" },
			{ path: "/h/work/repo/AGENTS.md", text: "REPO-AGENTS marker. Read IMPORTED-TEXT marker: always use tabs" },
		]);
		expect(repoRuleFiles(PROMPT.join("\n\n"), "/h")).toEqual(files);
	});

	test("a prompt with no rules, or none that is text, has no files", () => {
		expect(repoRuleFiles("# Identity\n\nNo context files.")).toEqual([]);
		expect(repoRuleFiles(undefined)).toEqual([]);
		expect(repoRuleFiles([1, null])).toEqual([]);
	});

	test("a file is the person's own or the project's by where it is", () => {
		const home = "/h";
		const cwd = "/h/work/repo/pkg";
		expect(levelOf("/h/work/repo/pkg/AGENTS.md", cwd, home)).toBe("project");
		expect(levelOf("/h/work/repo/AGENTS.md", cwd, home)).toBe("project");
		expect(levelOf("/h/work/repo/pkg/.omp/AGENTS.md", cwd, home)).toBe("project");
		expect(levelOf("/h/.omp/agent/AGENTS.md", cwd, home)).toBe("user");
		expect(levelOf("/h/.claude/CLAUDE.md", cwd, home)).toBe("user");
		expect(levelOf("/h/.codex/AGENTS.md", cwd, home)).toBe("user");
		expect(levelOf("/h/AGENTS.md", cwd, home)).toBe("project");
	});

	test("sources are the files that say something, once each, labelled, and editable only as they are on the disk", async () => {
		const root = realpathSync(tempDir("ompw-gc-"));
		const home = join(root, "home");
		const repo = join(home, "code", "repo");
		const cwd = join(repo, "pkg");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "AGENTS.md"), "Reply in Chinese.\n");
		writeFileSync(join(repo, "AGENTS.md"), "Read @docs/x.md\n");
		const asked: string[] = [];
		const found = await contextSources(
			[
				{ path: join(cwd, "AGENTS.md"), text: "Reply in Chinese." },
				// Its import is replaced by the imported text: it is no longer what the file holds.
				{ path: join(repo, "AGENTS.md"), text: "Read IMPORTED: always use tabs" },
				{ path: join(cwd, "AGENTS.md"), text: "Reply in Chinese." },
				{ path: join(home, ".omp", "agent", "AGENTS.md"), text: "   \n" },
				{ path: join(home, ".omp", "agent", "RULES.md"), text: "The person's own rules." },
			],
			cwd,
			home,
			async (abs) => {
				asked.push(abs);
				return abs.startsWith(cwd) ? abs.slice(cwd.length + 1) : null;
			},
		);
		expect(found.map((f) => [f.id, f.label, f.level, f.rel])).toEqual([
			["f1", "AGENTS.md", "project", "AGENTS.md"],
			["f2", "~/code/repo/AGENTS.md", "project", null],
			["f3", "~/.omp/agent/RULES.md", "user", null],
		]);
		expect(found[1].text).toBe("Read IMPORTED: always use tabs");
		expect(asked).toEqual([join(cwd, "AGENTS.md")]);
		expect(labelOf("/elsewhere/AGENTS.md", cwd, home)).toBe("/elsewhere/AGENTS.md");
	});

	test("memories become sources by bank and id, at most the limit", () => {
		const item = (n: number): MemoryItem => ({
			bank: "b",
			id: `id${n}`,
			store: "working",
			kind: "note",
			scope: "project",
			content: `Memory number ${n} ${"w".repeat(80)}`,
			length: 100,
			truncated: false,
			importance: null,
			createdAt: null,
			retired: false,
			provenance: { source: null, origin: "learn", tool: null, sessionId: null, cwd: null, context: null },
		});
		const out = memorySources(Array.from({ length: 50 }, (_, i) => item(i)));
		expect(out).toHaveLength(CONFLICT_LIMITS.memories);
		expect(out[0]).toMatchObject({ id: "m1", kind: "memory", bank: "b", memoryId: "id0", rel: null });
		expect(out[0].label.length).toBeLessThanOrEqual(60);
	});
});

describe("the check", () => {
	const MODEL_A: ModelLike = { provider: "fake", id: "small" };
	const MODEL_B: ModelLike = { provider: "fake", id: "other" };
	const ok = (text: string): Answer => ({
		text,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 1 },
		stopReason: "stop",
	});
	const found = reply([
		{
			guidance: "Reply in English.",
			source: "f1",
			other: "Always reply in Chinese.",
			change: { target: "guidance", find: "Reply in English.", replace: "Reply in Chinese." },
		},
	]);

	function checker(over: Partial<ConflictCheckDeps> = {}) {
		const asked: string[] = [];
		const deps: ConflictCheckDeps = {
			enabled: () => true,
			models: async () => [MODEL_A, MODEL_B],
			ask: async (model) => {
				asked.push(model.id);
				return ok(found);
			},
			files: async () => [file()],
			memories: async () => [],
			...over,
		};
		return { check: new GuidanceConflictCheck(deps), asked };
	}

	test("off, empty and nothing to compare with ask no model", async () => {
		const ask = async (): Promise<Answer> => {
			throw new Error("not to be asked");
		};
		expect(await checker({ enabled: () => false, ask }).check.check("/p", GUIDANCE)).toEqual({ state: "off" });
		expect(await checker({ ask }).check.check("/p", "  \n ")).toEqual({ state: "empty" });
		expect(await checker({ ask, files: async () => [] }).check.check("/p", GUIDANCE)).toEqual({
			state: "nothing",
			sources: [],
		});
	});

	test("conflicts found, then the same check answered from the cache", async () => {
		const { check, asked } = checker();
		const first = await check.check("/p", GUIDANCE);
		expect(first.state).toBe("found");
		if (first.state !== "found") throw new Error("no conflicts");
		expect(first.model).toBe("fake/small");
		expect(first.cached).toBe(false);
		expect(first.conflicts[0].change?.target).toBe("guidance");
		const again = await check.check("/p", GUIDANCE);
		expect(again).toMatchObject({ state: "found", cached: true });
		expect(asked).toEqual(["small"]);
		// Another text is another check.
		await check.check("/p", `${GUIDANCE}\nMore.`);
		expect(asked).toEqual(["small", "small"]);
	});

	test("no conflicts is clear", async () => {
		const { check } = checker({ ask: async () => ok(reply([])) });
		expect(await check.check("/p", GUIDANCE)).toMatchObject({ state: "clear", model: "fake/small" });
	});

	test("a malformed answer ends the check (no other model is asked) and is not kept", async () => {
		const asked: string[] = [];
		const bad = checker({
			ask: async (m) => {
				asked.push(m.id);
				return ok("Sure! Here are the conflicts: none");
			},
		});
		expect(await bad.check.check("/p", GUIDANCE)).toEqual({
			state: "failed",
			reason: "malformed",
			detail: "fake/small",
		});
		expect(asked).toEqual(["small"]);
		// A failure is not kept: the next check asks again.
		await bad.check.check("/p", GUIDANCE);
		expect(asked).toEqual(["small", "small"]);
	});

	test("a model that errs or throws: the next one; neither: failed with the reason", async () => {
		const failing = checker({
			ask: async (m) => {
				if (m.id === "small") throw new Error("no credentials");
				return { ...ok(""), stopReason: "error", errorMessage: "quota exceeded" };
			},
		});
		expect(await failing.check.check("/p", GUIDANCE)).toEqual({
			state: "failed",
			reason: "model",
			detail: "fake/other: quota exceeded",
		});
	});

	test("a check that takes too long is a timeout", async () => {
		const slow = checker({
			timeoutMs: 50,
			ask: (_m, _s, _u, signal) => {
				const { promise, reject } = Promise.withResolvers<Answer>();
				signal.addEventListener("abort", () => reject(new Error("aborted")));
				return promise;
			},
		});
		expect(await slow.check.check("/p", GUIDANCE)).toEqual({ state: "failed", reason: "timeout" });
	});

	test("no model, or a folder that cannot be read, is said as such; a memory store that cannot be read is no memories", async () => {
		expect(await checker({ models: async () => [] }).check.check("/p", GUIDANCE)).toEqual({
			state: "failed",
			reason: "noModel",
		});
		expect(
			await checker({
				files: async () => {
					throw new Error("The conversation's folder is not there");
				},
			}).check.check("/p", GUIDANCE),
		).toEqual({ state: "failed", reason: "folder", detail: "The conversation's folder is not there" });
		const memoryDown = checker({
			memories: async () => {
				throw new Error("locked");
			},
		});
		expect((await memoryDown.check.check("/p", GUIDANCE)).state).toBe("found");
	});
});
