import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../server/config.ts";
import type { Live, LivePool } from "../../server/live.ts";
import { namesClaude, setClaudeSlowMode } from "../../server/omp/panel-config.ts";
import { setSessionDefault } from "../../server/omp/session-defaults.ts";
import { withoutConfigFiles } from "../../server/omp/session-settings.ts";

/** What `omp config list --json` gives for the roles and presets: whether a Claude model is one the user has set up. */

test("a selector of Anthropic's own models, in a role, a preset, a fallback chain or a subagent's model, is a Claude model set up", () => {
	expect(namesClaude({ modelRoles: { default: "anthropic/claude-opus-5-5:high" } })).toBe(true);
	expect(namesClaude({ modelRoles: { default: "Anthropic/Claude-Haiku" } })).toBe(true);
	expect(
		namesClaude({
			modelRoles: { default: "openai/gpt-6-astra" },
			modelPresets: { cheap: { default: "anthropic/claude-haiku-5-5", thinking: "low" } },
		}),
	).toBe(true);
	expect(
		namesClaude({
			modelRoles: {},
			"retry.fallbackChains": { default: ["openai/gpt-6-astra", "anthropic/claude-opus-5-5"] },
		}),
	).toBe(true);
	expect(namesClaude({ "task.agentModelOverrides": { explore: "anthropic/claude-haiku-5-5:low" } })).toBe(true);
	// A role may list selectors.
	expect(namesClaude({ modelRoles: { default: "openai/gpt-6-astra, anthropic/claude-opus-5-5" } })).toBe(true);
});

test("a Claude model reached under another provider, a name that only mentions Claude, and keys are not", () => {
	// OpenRouter, Bedrock and proxies are not the direct lane `providers.anthropic.slowMode` is for.
	expect(namesClaude({ modelRoles: { default: "openrouter/anthropic/claude-opus-5-5" } })).toBe(false);
	expect(namesClaude({ modelRoles: { default: "amazon-bedrock/anthropic.claude-opus-5-5-v1:0" } })).toBe(false);
	expect(namesClaude({ modelRoles: { default: "claude-opus-5-5" } })).toBe(false);
	// A preset's or a role's name, and a fallback chain's key, are not selectors.
	expect(namesClaude({ modelRoles: { "anthropic/claude": "openai/gpt-6-astra" } })).toBe(false);
	expect(namesClaude({ modelPresets: { "anthropic/claude-fast": { default: "openai/gpt-6-astra" } } })).toBe(false);
	expect(namesClaude({ modelPresets: { claude: { default: "google/gemini-3.8-flash" } } })).toBe(false);
	expect(namesClaude({ "retry.fallbackChains": { "anthropic/*": ["google/*"] } })).toBe(false);
});

test("roles of other providers, or none, are not", () => {
	expect(namesClaude({ modelRoles: { default: "openai/gpt-6-astra", smol: "google/gemini-3.8-flash" } })).toBe(false);
	expect(namesClaude({ modelRoles: {}, modelPresets: undefined })).toBe(false);
	expect(namesClaude({ modelRoles: null, "retry.fallbackChains": 7 })).toBe(false);
	expect(namesClaude({})).toBe(false);
});

test("the configuration a new conversation starts with has none of the process's own --config files", () => {
	expect(withoutConfigFiles(["--config", "a.yml", "--profile", "work", "--config=b.yml", "--model", "x"])).toEqual([
		"--profile",
		"work",
		"--model",
		"x",
	]);
	expect(withoutConfigFiles([])).toEqual([]);
	// What follows `--` is not a flag.
	expect(withoutConfigFiles(["--config", "a.yml", "--", "--config", "text"])).toEqual(["--", "--config", "text"]);
});

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An omp that logs how it was run (agent directory, command line) and succeeds. */
function fakeOmp() {
	const dir = mkdtempSync(join(tmpdir(), "ompw-write-scope-"));
	dirs.push(dir);
	const bin = join(dir, "omp");
	const log = join(dir, "log");
	writeFileSync(
		bin,
		["#!/bin/sh", 'printf \'%s\\t%s\\n\' "$PI_CODING_AGENT_DIR" "$*" >> "$OMP_LOG"', "echo '{}'", ""].join("\n"),
	);
	chmodSync(bin, 0o755);
	return { cfg: { ompBin: bin, dataDir: dir } as Config, log };
}

const runs = (log: string): string[][] =>
	existsSync(log)
		? readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((line) => line.split("\t"))
		: [];

/** Only what a write reads of a conversation. */
const conversation = (log: string) =>
	({
		info: { liveId: "L1", cwd: "/nonexistent" },
		env: { OMP_LOG: log, PI_CODING_AGENT_DIR: "/profile/agent" },
		ownArgs: ["--profile", "work", "--config", "own.yml"],
	}) as unknown as Live;

test("Claude's slow mode is written in the scope the panel reads it in: the process's profile and agent directory, not its --config files", async () => {
	const { cfg, log } = fakeOmp();
	await setClaudeSlowMode(cfg, conversation(log), true);
	expect(runs(log)).toEqual([["/profile/agent", "--profile work config set providers.anthropic.slowMode auto"]]);
	await setClaudeSlowMode(cfg, conversation(log), false);
	expect(runs(log)[1]).toEqual(["/profile/agent", "--profile work config set providers.anthropic.slowMode off"]);
});

test("a default made by a star is written in the same scope, so that the panel reads it back", async () => {
	const { cfg, log } = fakeOmp();
	const pool = { otherLives: () => [] } as unknown as LivePool;
	await setSessionDefault(cfg, pool, conversation(log), "/profile/agent", "steeringMode", "all");
	expect(runs(log)).toEqual([["/profile/agent", "--profile work config set steeringMode all"]]);
});
