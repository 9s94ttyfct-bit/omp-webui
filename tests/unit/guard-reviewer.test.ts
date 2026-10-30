import { describe, expect, test } from "bun:test";
import { familyOf, modelsOf, QUIET_OVERLAY, reviewerArgs } from "../../server/guard-reviewer.ts";
import { chooseReviewers, labelOf } from "../../server/omp/gate/review.ts";

/**
 * What the benchmark's reviewer is made of: omp's models and roles as the gate's own choice reads them, the family of a
 * model, and the one command line of a request. Nothing is run: `tests/contract/guard-reviewer.test.ts` runs the real omp
 * against a stub provider and reads what it was sent.
 */

const RAW = [
	{ provider: "anthropic", id: "claude-haiku-5-5", api: "anthropic-messages", cost: { input: 1, output: 5 } },
	{ provider: "anthropic", id: "claude-opus-5", cost: { output: 75 } },
	{ provider: "openai-codex", id: "gpt-5-mini", cost: { output: 2 } },
	{ provider: "ollama-cloud", id: "qwen3-coder", cost: {} },
	"not a model",
	{ provider: 5, id: "x" },
	null,
];

describe("omp's models and roles, as the gate's own choice reads them", () => {
	const roles = {
		smol: "anthropic/claude-haiku-5-5:low",
		default: "anthropic/claude-opus-5",
		slow: "@default",
		loop: "@loop",
		reviewer: "openai-codex/gpt-5-mini:high",
	};
	const models = modelsOf(RAW, roles);

	test("only what is a model is listed, with its price", () => {
		expect(models.list().map(labelOf)).toEqual([
			"anthropic/claude-haiku-5-5",
			"anthropic/claude-opus-5",
			"openai-codex/gpt-5-mini",
			"ollama-cloud/qwen3-coder",
		]);
		expect(models.list()[0]).toMatchObject({ api: "anthropic-messages", cost: { input: 1, output: 5 } });
	});

	test("a model is found by its label, its id, or what is unique in its label", () => {
		expect(models.resolve("openai-codex/gpt-5-mini")?.id).toBe("gpt-5-mini");
		expect(models.resolve("qwen3-coder")?.provider).toBe("ollama-cloud");
		expect(models.resolve("haiku")?.id).toBe("claude-haiku-5-5");
		// Two models match: not guessed.
		expect(models.resolve("claude")).toBeUndefined();
		expect(models.resolve("nothing/here")).toBeUndefined();
	});

	test("a role is what omp's modelRoles say, without the thinking level, one role may name another, a loop names none", () => {
		expect(labelOf(models.resolve("@smol") as never)).toBe("anthropic/claude-haiku-5-5");
		expect(labelOf(models.resolve("@reviewer") as never)).toBe("openai-codex/gpt-5-mini");
		expect(labelOf(models.resolve("@slow") as never)).toBe("anthropic/claude-opus-5");
		expect(models.resolve("@loop")).toBeUndefined();
		expect(models.resolve("@missing")).toBeUndefined();
	});

	test("the gate's own rule (chooseReviewers) with them: the roles first, other families than the agent's", () => {
		const agent = models.resolve("@default");
		const { models: picked } = chooseReviewers({ configured: [], chain: [], agent }, models);
		// The reviewer role, when omp has one.
		expect(picked.map(labelOf)).toEqual(["openai-codex/gpt-5-mini"]);
		const without = modelsOf(RAW, { smol: roles.smol, default: roles.default });
		const automatic = chooseReviewers({ configured: [], chain: [], agent: without.resolve("@default") }, without);
		// Not the agent's family (anthropic): the others, the cheapest first.
		expect(automatic.models.map(labelOf)).toEqual(["ollama-cloud/qwen3-coder", "openai-codex/gpt-5-mini"]);
	});
});

describe("the family of a model", () => {
	test("is the vendor its id names, else its provider", () => {
		expect(familyOf({ provider: "ollama-cloud", id: "qwen3-coder" })).toBe("qwen");
		expect(familyOf({ provider: "openrouter", id: "anthropic/claude-sonnet-5" })).toBe("anthropic");
		expect(familyOf({ provider: "openai-codex", id: "gpt-5-mini" })).toBe("openai");
		expect(familyOf({ provider: "local", id: "tinyllama" })).toBe("meta");
		expect(familyOf({ provider: "mine", id: "unheard-of" })).toBe("mine");
	});
});

describe("the request", () => {
	const args = reviewerArgs(
		{ provider: "fake", id: "reviewer-a" },
		"THE RULES",
		"Review the tool call.",
		"/tmp/x",
		"/tmp/o.yml",
	);

	test("is print mode with the reviewer's prompt as the system prompt and the message as its last argument", () => {
		expect(args[0]).toBe("-p");
		expect(args).toContain("--model=fake/reviewer-a");
		expect(args).toContain("--system-prompt=THE RULES");
		expect(args.at(-1)).toBe("Review the tool call.");
		expect(args).toContain("--cwd=/tmp/x");
		expect(args).not.toContain("--mode");
		// One argument each: nothing is put through a shell.
		expect(args.filter((a) => a.startsWith("--system-prompt"))).toHaveLength(1);
	});

	test("turns off what omp would add: tools, session, extensions, skills, rules, title, lsp, and (by the overlay) memory, context files and MCP", () => {
		for (const flag of [
			"--no-tools",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--no-title",
			"--no-lsp",
			"--no-pty",
			"--thinking=off",
			"--config=/tmp/o.yml",
		])
			expect(args, flag).toContain(flag);
	});

	test("the overlay switches the memory, the auto-learn, the context files and every source of MCP servers off, and names no model provider", () => {
		expect(QUIET_OVERLAY).toMatch(/memory:\n {2}backend: off/);
		expect(QUIET_OVERLAY).toMatch(/autolearn:\n {2}enabled: false/);
		expect(QUIET_OVERLAY).toMatch(/enabledProviders: \[\]/);
		expect(QUIET_OVERLAY).toMatch(/mcp:\n {2}enableProjectConfig: false/);
		const disabled =
			/disabledProviders: \[(.*)\]/
				.exec(QUIET_OVERLAY)?.[1]
				.split(",")
				.map((s) => s.trim()) ?? [];
		// The sources of AGENTS.md and of mcp.json, user and project.
		for (const source of ["native", "agents", "agents-md", "claude-md", "mcp-json", "agent-plugins", "omp-plugins"])
			expect(disabled, source).toContain(source);
		// The namespace is shared with the model providers: `cursor` is one, so it is not named, nor any other model backend.
		for (const backend of ["cursor", "anthropic", "openai", "openai-codex", "google", "groq", "ollama", "openrouter"])
			expect(disabled, backend).not.toContain(backend);
	});
});
