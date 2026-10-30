import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	McpSwitchError,
	type PluginProcess,
	setMcpServerEnabled,
	type ToggleTarget,
} from "../../server/omp/toggles.ts";

/**
 * The MCP switch against a scripted omp: `/mcp list` shows the user's entry of a name both configs define while
 * `/mcp enable|disable` writes the folder's. The contract test (mcp-switch.test.ts) runs the real omp; this one is
 * where the list can be made to disagree with what the command wrote.
 */

const server = { type: "stdio", command: "bun" };
const catalog = {
	commands: [{ name: "mcp", subcommands: [{ name: "list" }, { name: "enable" }, { name: "disable" }] }],
};

/** `listed`: what `/mcp list` prints, per call; `said`: omp's answer to each enable/disable, in order. */
function scripted(listed: string[], said: string[]) {
	const asked: string[] = [];
	const omp: PluginProcess = {
		async rpc() {
			return { success: true, data: catalog };
		},
		async command(message) {
			asked.push(message);
			if (message === "/mcp list") return listed.shift() ?? null;
			return said.shift() ?? null;
		},
	};
	return { omp, asked };
}

function target(user: object, project: object): { t: ToggleTarget; done: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "ompw-mcp-unit-"));
	const agentDir = join(dir, "agent");
	const cwd = join(dir, "folder");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".omp"), { recursive: true });
	writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: user }));
	writeFileSync(join(cwd, ".omp", "mcp.json"), JSON.stringify({ mcpServers: project }));
	return {
		t: { bin: "/nonexistent/omp", cwd, neutral: dir, agentDir, env: {} },
		done: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test("a name both configs define is refused before anything is asked of omp to change", async () => {
	const { t, done } = target({ dup: server }, { dup: server });
	try {
		const { omp, asked } = scripted(["dup | stdio | enabled | bun [user]"], []);
		const err = await setMcpServerEnabled(t, omp, "dup", false).catch((e) => e);
		expect(err).toBeInstanceOf(McpSwitchError);
		expect((err as McpSwitchError).status).toBe(409);
		expect((err as McpSwitchError).message).toContain("edit it in the terminal");
		expect(asked).toEqual(["/mcp list"]);
	} finally {
		done();
	}
});

test("a switch that omp wrote but its list does not show is undone, not left half made", async () => {
	// The folder's config appeared after the check: omp lists the user's entry, which stays enabled.
	const { t, done } = target({ solo: server }, {});
	try {
		const list = "solo | stdio | enabled | bun [user]";
		const { omp, asked } = scripted(
			[list, list],
			['Server "solo" disabled (user config).', 'Server "solo" enabled (user config).'],
		);
		const err = await setMcpServerEnabled(t, omp, "solo", false).catch((e) => e);
		expect((err as McpSwitchError).status).toBe(409);
		expect((err as McpSwitchError).message).toContain("undone");
		expect(asked).toEqual(["/mcp list", "/mcp disable solo", "/mcp list", "/mcp enable solo"]);
	} finally {
		done();
	}
});

test("nothing is undone when the entry the command wrote already said what was asked", async () => {
	// The folder's entry is off already, the user's is on: asking for off writes nothing new, so nothing is put back.
	const { t, done } = target({}, { only: { ...server, enabled: false } });
	try {
		const { omp, asked } = scripted(
			["only | stdio | enabled | bun [project]", "only | stdio | enabled | bun [project]"],
			['Server "only" disabled (project config).'],
		);
		await setMcpServerEnabled(t, omp, "only", false).catch(() => {});
		expect(asked).toEqual(["/mcp list", "/mcp disable only", "/mcp list"]);
	} finally {
		done();
	}
});
