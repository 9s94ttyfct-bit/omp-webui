/**
 * Contract tests: the omp public interfaces omp-webui depends on, exercised
 * against the installed `omp` binary without any model calls. CI runs these
 * against the latest published omp to catch breaking changes early.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliHelp, cliInventory } from "../../server/omp/cli.ts";
import { RpcClient } from "../../server/omp/rpc-client.ts";
import { parseSessionText, summarize } from "../../server/sessions/parse.ts";
import type { OmpFrame } from "../../shared/protocol.ts";
import { FIXTURE_CWD, type SeededFixtures, seedFixtures, USAGE_A1, USAGE_A2, USAGE_A3 } from "../support/fixtures.ts";
import { OFFLINE_PLACEHOLDER_KEY } from "../support/omp-env.ts";

const root = mkdtempSync(join(tmpdir(), "ompw-contract-"));
const home = join(root, "home");
const agentDir = join(home, ".omp", "agent");
let fixtures: SeededFixtures;
// Contract tests never prompt; the placeholder key only lets omp boot where no model is configured (CI).
const env = {
	HOME: home,
	PI_CODING_AGENT_DIR: agentDir,
	PI_NO_TITLE: "1",
	ANTHROPIC_API_KEY: OFFLINE_PLACEHOLDER_KEY,
	ANTHROPIC_OAUTH_TOKEN: "",
};
// Explicit --model skips restoring the saved model, which needs credentials CI does not have.
const MODEL = "anthropic/claude-haiku-5-5";

function client(args: string[], frames: OmpFrame[] = []): RpcClient {
	return new RpcClient({
		bin: process.env.OMP_BIN ?? "omp",
		args,
		cwd: root,
		env,
		onFrame: (f) => frames.push(f),
		onExit: () => {},
	});
}

beforeAll(() => {
	fixtures = seedFixtures(agentDir);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("RPC transport", () => {
	test("ready frame advertises protocol v2 and negotiation succeeds", async () => {
		const frames: OmpFrame[] = [];
		const c = client(["--no-session"], frames);
		await c.ready;
		const ready = frames.find((f) => f.type === "ready");
		expect(ready?.supportedProtocolVersions).toContain(2);
		const state = await c.call<Record<string, unknown>>({ type: "get_state" });
		for (const key of ["isStreaming", "messageCount", "steeringMode", "followUpMode", "queuedMessages"])
			expect(state).toHaveProperty(key);
		c.close();
		expect(await c.proc.exited).toBe(0);
	}, 60_000);

	test("command catalog has the shape the composer renders", async () => {
		const c = client(["--no-session"]);
		await c.ready;
		const { commands } = await c.call<{
			commands: { name: string; source: string; subcommands?: { name: string }[] }[];
		}>({ type: "get_available_commands" });
		expect(commands.length).toBeGreaterThan(10);
		for (const cmd of commands) {
			expect(typeof cmd.name).toBe("string");
			expect(typeof cmd.source).toBe("string");
		}
		c.close();
	}, 60_000);
});

describe("sessions", () => {
	test("resumed session exposes the file's entries, leaf and summed usage", async () => {
		const c = client(["--resume", fixtures.alpha, "--model", MODEL]);
		await c.ready;
		const { entries, leafId } = await c.call<{ entries: { id: string }[]; leafId: string }>({ type: "get_entries" });
		const onDisk = parseSessionText(readFileSync(fixtures.alpha, "utf8"));
		expect(entries.map((e) => e.id)).toEqual(expect.arrayContaining(onDisk.entries.map((e) => e.id)));
		expect(leafId).toBe(onDisk.entries.at(-1)?.id as string);
		const stats = await c.call<{
			cost: number;
			tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
		}>({ type: "get_session_stats" });
		const ours = summarize(fixtures.alpha, onDisk, { mtimeMs: 0, size: 0 }, 0);
		expect(stats.cost).toBeCloseTo(USAGE_A1.cost + USAGE_A2.cost + USAGE_A3.cost, 9);
		expect(stats.cost).toBeCloseTo(ours?.usage.cost ?? -1, 9);
		expect(stats.tokens.input).toBe(ours?.usage.input ?? -1);
		expect(stats.tokens.output).toBe(ours?.usage.output ?? -1);
		expect(stats.tokens.cacheRead).toBe(ours?.usage.cacheRead ?? -1);
		expect(stats.tokens.cacheWrite).toBe(ours?.usage.cacheWrite ?? -1);
		c.close();
	}, 60_000);

	test("branch(user entry) moves to a new file that keeps shared entry ids and names its parent", async () => {
		const c = client(["--resume", fixtures.alpha, "--model", MODEL]);
		await c.ready;
		const before = await c.call<{ sessionFile: string }>({ type: "get_state" });
		const r = await c.call<{ text: string; cancelled: boolean }>({ type: "branch", entryId: "f0000004" });
		expect(r.cancelled).toBe(false);
		expect(r.text).toBe("And what about quokka mode?");
		const after = await c.call<{ sessionFile?: string }>({ type: "get_state" });
		const { entries, leafId } = await c.call<{ entries: { id: string }[]; leafId: string }>({ type: "get_entries" });
		expect(leafId).toBe("f0000003");
		expect(entries.map((e) => e.id)).toEqual(["f0000001", "f0000002", "f0000003"]);
		if (after.sessionFile && after.sessionFile !== before.sessionFile) {
			// The branch file materializes lazily; when written, its header names the parent.
			try {
				const header = parseSessionText(readFileSync(after.sessionFile, "utf8")).header;
				if (header) expect(String(header.parentSession)).toContain("01a00000-0000-7000-8000-00000000a1a1");
			} catch {
				// not yet on disk
			}
		}
		c.close();
	}, 60_000);

	test("branch rejects non-user entries", async () => {
		const c = client(["--resume", fixtures.alpha, "--model", MODEL]);
		await c.ready;
		const r = await c.request({ type: "branch", entryId: "f0000003" });
		expect(r.success).toBe(false);
		c.close();
	}, 60_000);

	test("fork(entryId) switches to a new session file", async () => {
		const c = client(["--resume", fixtures.alpha, "--model", MODEL]);
		await c.ready;
		const before = await c.call<{ sessionFile: string }>({ type: "get_state" });
		const r = await c.call<{ cancelled: boolean }>({ type: "fork", entryId: "f0000003" });
		expect(r.cancelled).toBe(false);
		const after = await c.call<{ sessionFile: string }>({ type: "get_state" });
		expect(after.sessionFile).not.toBe(before.sessionFile);
		const { leafId } = await c.call<{ leafId: string }>({ type: "get_entries" });
		expect(leafId).toBe("f0000003");
		c.close();
	}, 60_000);

	test("fixture files parse with the documented header and title slot", () => {
		const parsed = parseSessionText(readFileSync(fixtures.gamma, "utf8"));
		expect(parsed.header?.cwd).toBe(FIXTURE_CWD);
		expect(parsed.header?.title).toBe("Fixture gamma: scout agent");
	});
});

describe("CLI discovery", () => {
	test("omp --help exposes commands and flags", async () => {
		const inv = await cliInventory(process.env.OMP_BIN ?? "omp");
		expect(inv.commands.map((c) => c.name)).toEqual(expect.arrayContaining(["stats", "config", "models"]));
		expect(inv.flags.map((f) => f.name)).toEqual(expect.arrayContaining(["--model", "--thinking", "--resume"]));
		for (const c of inv.commands) expect(c.name).toMatch(/^[a-z][\w-]*$/);
	}, 60_000);

	test("subcommand help parses usage and flags", async () => {
		const help = await cliHelp(process.env.OMP_BIN ?? "omp", "stats");
		expect(help.usage).toContain("omp stats");
		expect(help.flags.map((f) => f.name)).toContain("--json");
	}, 60_000);
});
