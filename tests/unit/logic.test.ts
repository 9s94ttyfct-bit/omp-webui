import { describe, expect, test } from "bun:test";
import { parseFlags, parseRows, sections } from "../../server/omp/cli.ts";
import { parseSessionText, summarize } from "../../server/sessions/parse.ts";
import type { SessionEntry, SessionFileData } from "../../shared/protocol.ts";
import { buildFamily, destinationFor } from "../../web/src/lib/family.ts";
import { pathTo, siblingsOf } from "../../web/src/lib/tree.ts";

const msg = (id: string, parentId: string | null, role: string, t: number, text = id): SessionEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: new Date(t * 1000).toISOString(),
	message: { role, content: [{ type: "text", text }] },
});

describe("conversation family", () => {
	// a: u1 → a1 → u2 → a2        (file A)
	// b: u1 → a1 → u3 → a3        (file B, branched from A at a1)
	const shared = [msg("u1", null, "user", 1), msg("a1", "u1", "assistant", 2)];
	const A: SessionFileData = {
		file: "A",
		header: null,
		subagents: [],
		advisors: [],
		entries: [...shared, msg("u2", "a1", "user", 3), msg("a2", "u2", "assistant", 4)],
	};
	const B: SessionFileData = {
		file: "B",
		header: null,
		subagents: [],
		advisors: [],
		entries: [...shared, msg("u3", "a1", "user", 5), msg("a3", "u3", "assistant", 6)],
	};

	test("merges files into one tree with cross-file siblings", () => {
		const fam = buildFamily([A, B], null, []);
		const u2 = fam.idx.byId.get("u2") as SessionEntry;
		expect(siblingsOf(fam.idx, u2).map((e) => e.id)).toEqual(["u2", "u3"]);
		expect(fam.filesOf.get("a1")).toEqual(["A", "B"]);
		expect(fam.headOf.get("B")).toBe("a3");
	});

	test("navigating to a sibling resolves the file that holds its newest leaf", () => {
		const fam = buildFamily([A, B], null, []);
		expect(destinationFor(fam, "u3", "A")).toEqual({ file: "B", leaf: "a3" });
		expect(destinationFor(fam, "u2", "B")).toEqual({ file: "A", leaf: "a2" });
		expect(pathTo(fam.idx, "a3").map((e) => e.id)).toEqual(["u1", "a1", "u3", "a3"]);
	});

	test("live entries replace the stale on-disk copy of the live file", () => {
		const fam = buildFamily([A], "A", [...A.entries, msg("u4", "a2", "user", 7)]);
		expect(fam.headOf.get("A")).toBe("u4");
	});
});

describe("session parsing", () => {
	test("title slot overrides the header title and usage sums assistant + model_usage", () => {
		const lines = [
			JSON.stringify({ type: "title", v: 1, title: "Slot title", source: "user", pad: "  " }),
			JSON.stringify({
				type: "session",
				version: 3,
				id: "s1",
				timestamp: "2026-01-01T00:00:00Z",
				cwd: "/w/proj",
				title: "old",
			}),
			JSON.stringify(msg("u1", null, "user", 1, "hello world")),
			JSON.stringify({
				...msg("a1", "u1", "assistant", 2),
				message: {
					role: "assistant",
					content: [],
					provider: "p",
					model: "m",
					usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } },
				},
			}),
			JSON.stringify({
				type: "model_usage",
				id: "x1",
				parentId: "a1",
				timestamp: "2026-01-01T00:00:03Z",
				usage: { input: 10, output: 0, cost: { total: 0.25 } },
			}),
			"{ not json",
		].join("\n");
		const parsed = parseSessionText(lines);
		const s = summarize("/f.jsonl", parsed, { mtimeMs: 1, size: 2 }, 0);
		expect(s?.title).toBe("Slot title");
		expect(s?.preview).toBe("hello world");
		expect(s?.project).toBe("proj");
		expect(s?.usage).toMatchObject({ input: 11, output: 2, cacheRead: 3, cacheWrite: 4, requests: 2 });
		expect(s?.usage.cost).toBeCloseTo(0.75, 9);
		expect(s?.models).toEqual(["p/m"]);
	});
});

describe("CLI help parsing", () => {
	const help = [
		"omp v1.2.3",
		"",
		"FLAGS",
		"      --model=<value>   Model to use",
		"                        (continued description)",
		"  -p, --print           Non-interactive mode",
		"",
		"COMMANDS",
		"  stats    View usage statistics",
		"  config   Manage configuration settings",
		"",
		"Environment Variables:",
		"  ANTHROPIC_API_KEY          - Anthropic Claude models",
		"",
		"Plugin Options:",
		"  --plugin-dir <path>        Load plugin from directory",
	].join("\n");

	test("sections stop at unindented trailers so env vars are not commands", () => {
		const s = sections(help);
		expect(parseRows(s.get("COMMANDS") ?? []).map((c) => c.name)).toEqual(["stats", "config"]);
	});

	test("flags keep short names, values and wrapped descriptions", () => {
		const flags = parseFlags(sections(help).get("FLAGS") ?? []);
		expect(flags).toEqual([
			{ name: "--model", short: undefined, value: "<value>", description: "Model to use (continued description)" },
			{ name: "--print", short: "-p", value: undefined, description: "Non-interactive mode" },
		]);
	});
});
