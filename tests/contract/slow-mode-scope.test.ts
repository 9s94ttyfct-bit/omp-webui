/**
 * The session controls' Slow mode row against the real omp: omp's slow mode is its own global setting, so the panel
 * says so on that row (and the claim is not made where omp does not report a scope).
 *
 * `set_slow_mode` writes omp's global `config.yml` (`providers.anthropic.slowMode`), unlike the other `set_*` commands
 * the panel sends, which write nothing. Measured against omp 18.11.0 and 18.12.4.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient } from "../../server/omp/rpc-client.ts";
import type { OmpFrame } from "../../shared/protocol.ts";
import { OFFLINE_PLACEHOLDER_KEY } from "../support/omp-env.ts";

const root = mkdtempSync(join(tmpdir(), "ompw-contract-slow-"));
const MODEL = "anthropic/claude-haiku-5-5";

/** A throwaway agent dir of its own, so what a test finds in config.yml is that test's own write. */
function agentDirOf(name: string): string {
	const dir = join(root, name, "agent");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** An omp of its own, in an agent dir of its own. */
function client(agentDir: string): RpcClient {
	return new RpcClient({
		bin: process.env.OMP_BIN ?? "omp",
		args: ["--no-session", "--model", MODEL],
		cwd: root,
		// Contract tests never prompt; the placeholder key only lets omp boot where no model is configured (CI).
		env: {
			HOME: join(root, "home"),
			PI_CODING_AGENT_DIR: agentDir,
			PI_NO_TITLE: "1",
			ANTHROPIC_API_KEY: OFFLINE_PLACEHOLDER_KEY,
			ANTHROPIC_OAUTH_TOKEN: "",
		},
		onFrame: (_f: OmpFrame) => {},
		onExit: () => {},
	});
}

/** What omp reports of its slow mode in `get_state`. */
interface SlowState {
	slowModeSupported?: boolean;
	slowModeEnabled?: boolean;
	slowModeScope?: string;
}

beforeAll(() => mkdirSync(join(root, "home"), { recursive: true }));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("slow mode", () => {
	test("omp says its slow mode is a global setting, and set_slow_mode writes omp's config", async () => {
		const agentDir = agentDirOf("global");
		const configFile = join(agentDir, "config.yml");
		const c = client(agentDir);
		await c.ready;
		const state = await c.call<SlowState>({ type: "get_state" });
		expect(state.slowModeSupported).toBe(true);
		// The scope the page reads for the note it shows on that row.
		expect(state.slowModeScope).toBe("global");
		expect(existsSync(configFile)).toBe(false);

		await c.call({ type: "set_slow_mode", enabled: true });
		// omp saves the config in the background, a moment after the command.
		const written = await waitFor(() => (existsSync(configFile) ? readFileSync(configFile, "utf8") : null));
		expect(written).toMatch(/providers:\s*\n\s*anthropic:\s*\n\s*slowMode: auto/);
		c.close();
		await c.proc.exited;
	}, 60_000);

	test("the other set_* commands of the panel write nothing", async () => {
		const agentDir = agentDirOf("process-only");
		const configFile = join(agentDir, "config.yml");
		const c = client(agentDir);
		await c.ready;
		for (const command of [
			{ type: "set_auto_compaction", enabled: true },
			{ type: "set_auto_retry", enabled: true },
			{ type: "set_steering_mode", mode: "all" },
			{ type: "set_follow_up_mode", mode: "all" },
			{ type: "set_interrupt_mode", mode: "wait" },
			{ type: "set_fast_mode", enabled: true },
			{ type: "set_cache_warming", mode: "streaming" },
		])
			await c.call(command);
		await Bun.sleep(2000);
		expect(existsSync(configFile)).toBe(false);
		c.close();
		await c.proc.exited;
	}, 60_000);
});

/** The value once it is there, or null when it does not come. */
async function waitFor(read: () => string | null, ms = 20_000): Promise<string | null> {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		const value = read();
		if (value !== null) return value;
		await Bun.sleep(200);
	}
	return null;
}
