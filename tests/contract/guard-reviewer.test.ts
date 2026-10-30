import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ompAsk, removeQuietOverlay, reviewerArgs } from "../../server/guard-reviewer.ts";
import { type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";

/**
 * What the benchmark's reviewer request is, with the real omp and a stub provider that keeps what it was sent: the
 * reviewer's prompt and nothing else of the user's. Found by reading the requests (the stub's), not by reading omp's
 * documentation: with only `--no-tools --no-skills --no-rules` omp still sends the user's AGENTS.md, the memory and
 * auto-learn guidance and two tools, and starts every MCP server of the user's configuration, waiting for each. The
 * quiet overlay (`server/guard-reviewer.ts`, `QUIET_OVERLAY`) is what removes them. The home folder, the agent folder and
 * the models are this test's own; no real model, key or MCP server is involved.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-guard-reviewer-"));
const home = join(root, "home");
const agent = join(home, ".omp", "agent");
const work = join(root, "work");
const mcpMarker = join(root, "mcp-started");
const CANARY = "CANARY-USER-AGENTS-CONTEXT-pineapple";
let stub: StubScripted;
let env: Record<string, string>;

beforeAll(async () => {
	mkdirSync(agent, { recursive: true });
	mkdirSync(work, { recursive: true });
	stub = await startScriptedStub(async () => ({ text: '{"decision":"allow"}' }));
	writeFileSync(
		join(agent, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${stub.url}\n    api: openai-completions\n    apiKey: ${stub.apiKey}\n    models:\n      - id: stub-model\n`,
	);
	// What the user has: memory and auto-learn on, an AGENTS.md of their own, an MCP server of their own.
	writeFileSync(
		join(agent, "config.yml"),
		"modelRoles:\n  default: omlx/stub-model\nmemory:\n  backend: mnemopi\nautolearn:\n  enabled: true\n",
	);
	writeFileSync(join(agent, "AGENTS.md"), `${CANARY}: always say pineapple.\n`);
	const server = join(root, "mcp.sh");
	writeFileSync(server, `#!/bin/sh\necho started >> ${mcpMarker}\ncat >/dev/null\n`);
	chmodSync(server, 0o755);
	writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { canary: { command: server, args: [] } } }));
	const natives = join(homedir(), ".omp", "natives");
	env = {
		HOME: home,
		PI_CODING_AGENT_DIR: agent,
		PI_NO_TITLE: "1",
		ANTHROPIC_OAUTH_TOKEN: "",
		ANTHROPIC_API_KEY: "ompw-offline-placeholder-key",
		...(existsSync(natives) ? { PI_NATIVES_DIR: natives } : {}),
	};
}, 60_000);

afterAll(async () => {
	await stub?.stop();
	rmSync(root, { recursive: true, force: true });
	// A test process does not exit the way a server does (no `exit` event under `bun test`): the overlay's folder goes here.
	removeQuietOverlay();
});

const MODEL = { provider: "omlx", id: "stub-model" };

describe("omp -p, as the benchmark asks its reviewer", () => {
	test("carries the reviewer's prompt and nothing of the user's: no context file, no memory, no tool, no MCP server started", async () => {
		const before = stub.requests.length;
		const started = Date.now();
		const answer = await ompAsk("omp", work, env)(
			MODEL,
			"THE-REVIEWER-SYSTEM-PROMPT",
			"Review this.",
			AbortSignal.timeout(60_000),
		);
		expect(answer).toMatchObject({ text: '{"decision":"allow"}', stopReason: "stop" });
		const sent = stub.requests.slice(before);
		expect(sent).toHaveLength(1);
		expect(sent[0].tools).toEqual([]);
		expect(sent[0].text).toContain("THE-REVIEWER-SYSTEM-PROMPT");
		expect(sent[0].text).toContain("Review this.");
		expect(sent[0].text).not.toContain(CANARY);
		expect(sent[0].text).not.toMatch(/manage_skill|autolearn|<memories>|MCP Server Instructions/i);
		// The user's MCP server was not even started, so the run did not wait for it (omp waits up to 30 s for each).
		expect(existsSync(mcpMarker)).toBe(false);
		expect(Date.now() - started).toBeLessThan(25_000);
	}, 90_000);

	test("and the control shows why: without the overlay the same request carries the user's context and starts their MCP server", async () => {
		const before = stub.requests.length;
		const args = reviewerArgs(MODEL, "THE-REVIEWER-SYSTEM-PROMPT", "Review this.", work, "unused").filter(
			(a) => !a.startsWith("--config="),
		);
		const proc = Bun.spawn(["omp", ...args], {
			env: { ...process.env, ...env, OMP_MCP_TIMEOUT_MS: "1500" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		const sent = stub.requests.slice(before);
		expect(sent).toHaveLength(1);
		expect(sent[0].text).toContain(CANARY);
		expect(sent[0].tools.length).toBeGreaterThan(0);
		expect(existsSync(mcpMarker)).toBe(true);
	}, 90_000);
});
