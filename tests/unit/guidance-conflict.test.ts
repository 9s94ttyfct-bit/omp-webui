import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
import {
	type ContextFileRules,
	contextFileCandidates,
	contextFiles,
	labelOf,
	memorySources,
	standaloneWalk,
} from "../../server/omp/guidance/conflict-sources.ts";
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
	const world = () => {
		const root = realpathSync(tempDir("ompw-gc-"));
		const home = join(root, "home");
		const repo = join(home, "code", "repo");
		const cwd = join(repo, "pkg");
		const agentDir = join(home, ".omp", "agent");
		for (const dir of [cwd, agentDir, join(repo, ".git"), join(home, ".claude"), join(cwd, ".omp")])
			mkdirSync(dir, { recursive: true });
		const rules: ContextFileRules = { home, agentDir, disabled: [], extra: [] };
		return { root, home, repo, cwd, agentDir, rules };
	};

	test("the walk goes up to the home folder from a repository in it, and stops at a repository outside it", () => {
		const home = "/h";
		expect(standaloneWalk("/h/code/repo/pkg", home, "/h/code/repo")).toEqual([
			"/h/code/repo/pkg",
			"/h/code/repo",
			"/h/code",
		]);
		expect(standaloneWalk("/h/notes/a", home, null)).toEqual(["/h/notes/a", "/h/notes", "/h"]);
		expect(standaloneWalk("/srv/repo/x", home, "/srv/repo")).toEqual(["/srv/repo/x", "/srv/repo"]);
		expect(standaloneWalk("/srv/plain/x", home, null)).toEqual(["/srv/plain/x", "/srv/plain", "/srv"]);
		expect(standaloneWalk("/h/.config/tool", home, null)).toEqual(["/h/.config/tool", "/h"]);
	});

	test("a provider turned off in omp is not read, and extra names are", () => {
		const { cwd, rules } = world();
		const all = contextFileCandidates(cwd, rules).map((f) => f.path);
		expect(all).toContain(join(cwd, "AGENTS.md"));
		expect(all).toContain(join(cwd, "CLAUDE.md"));
		const without = contextFileCandidates(cwd, {
			...rules,
			disabled: ["claude-md", "claude"],
			extra: ["RULES.md"],
		}).map((f) => f.path);
		expect(without.some((p) => p.endsWith("CLAUDE.md"))).toBe(false);
		expect(without).toContain(join(cwd, "RULES.md"));
	});

	test("the files that exist, read once each, labelled, and editable as the callback says", async () => {
		const { home, repo, cwd, agentDir, rules } = world();
		writeFileSync(join(cwd, "AGENTS.md"), "Reply in Chinese.\n");
		writeFileSync(join(repo, "AGENTS.md"), "Repository rules.\n");
		writeFileSync(join(cwd, "CLAUDE.md"), "   \n");
		symlinkSync(join(cwd, "AGENTS.md"), join(cwd, ".omp", "AGENTS.md"));
		writeFileSync(join(agentDir, "AGENTS.md"), "The person's own rules.\n");
		writeFileSync(join(home, ".claude", "CLAUDE.md"), "Claude's rules.\n");
		const asked: string[] = [];
		const found = await contextFiles(cwd, rules, async (abs) => {
			asked.push(abs);
			return abs.startsWith(cwd) ? abs.slice(cwd.length + 1) : null;
		});
		expect(found.map((f) => [f.id, f.label, f.level, f.rel])).toEqual([
			["f1", "AGENTS.md", "project", "AGENTS.md"],
			["f2", "~/code/repo/AGENTS.md", "project", null],
			["f3", "~/.omp/agent/AGENTS.md", "user", null],
			["f4", "~/.claude/CLAUDE.md", "user", null],
		]);
		expect(found[0].text).toBe("Reply in Chinese.\n");
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
