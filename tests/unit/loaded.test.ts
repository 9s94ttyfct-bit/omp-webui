import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectLoaded,
	groupTools,
	type LoadedProcess,
	markServers,
	parseMcpList,
	parsePlugins,
	parseRules,
	parseTools,
	withDisabled,
} from "../../server/omp/loaded.ts";
import { isFailure, type LoadedMcpServer, type LoadedTools } from "../../shared/loaded.ts";

/**
 * The "Loaded in this chat" panel reads omp's own words: the text of `/tools` and `/mcp list` and the JSON of
 * `omp plugin list` and `omp ttsr list`. The shapes below are the ones omp 18.12 prints (the contract test runs
 * the real omp against the same parsers); a format omp changes must not silently turn into an empty panel.
 */

const TOOLS_TEXT = [
	"* read",
	"* bash",
	"- ast_edit",
	"- goal",
	"- mcp__alpha_ping",
	"- mcp__blender_ahujasid_look",
	"~ xd://ast_edit",
	"~ xd://mcp__alpha_ping",
	"~ xd://mcp__blender_ahujasid_look",
	"~ xd://mcp__stray_tool",
].join("\n");

test("/tools: `*` is offered to the model, `~ xd://` is mounted, a lone `-` is not enabled, in omp's order", () => {
	const states = parseTools(TOOLS_TEXT);
	expect([...(states ?? [])]).toEqual([
		["read", "active"],
		["bash", "active"],
		["ast_edit", "mounted"],
		["goal", "off"],
		["mcp__alpha_ping", "mounted"],
		["mcp__blender_ahujasid_look", "mounted"],
		["mcp__stray_tool", "mounted"],
	]);
	// Terminal colors do not matter.
	expect(parseTools("\u001b[32m* read\u001b[39m")?.get("read")).toBe("active");
});

test("text that is not the /tools listing is not mistaken for it", () => {
	expect(parseTools("")).toBeNull();
	expect(parseTools("Unknown command: tools")).toBeNull();
});

test("/mcp list: name, transport, enabled, target and scope of each server", () => {
	const text = [
		"alpha | stdio | enabled | bun [user]",
		"off one | stdio | disabled | /usr/bin/env [user]",
		"remote | http | enabled | http://[::1]:8080/mcp [project]",
		"bare | sse | enabled | https://example.test/sse",
	].join("\n");
	expect(parseMcpList(text)).toEqual([
		{ name: "alpha", transport: "stdio", enabled: true, target: "bun", scope: "user" },
		{ name: "off one", transport: "stdio", enabled: false, target: "/usr/bin/env", scope: "user" },
		{ name: "remote", transport: "http", enabled: true, target: "http://[::1]:8080/mcp", scope: "project" },
		{ name: "bare", transport: "sse", enabled: true, target: "https://example.test/sse", scope: null },
	]);
});

test("/mcp list: no servers is an answer, an unknown subcommand is not", () => {
	expect(parseMcpList("No MCP servers configured.")).toEqual([]);
	expect(parseMcpList("Unknown /mcp subcommand: list. Use /mcp help for available subcommands.")).toBeNull();
});

test("MCP tools go to the server with the longest matching name, however its name is spelled", () => {
	const listing = parseMcpList(
		[
			"blender | stdio | enabled | uvx [user]",
			"blender-ahujasid | stdio | enabled | uvx [user]",
			"alpha | stdio | disabled | bun [user]",
			"idle | stdio | enabled | bun [user]",
		].join("\n"),
	);
	const states = parseTools(`${TOOLS_TEXT}\n* mcp__blender_scene_info`) ?? new Map();
	const descriptions = new Map([["read", "Reads files."]]);
	const tools = groupTools(states, descriptions, listing);

	expect(tools.builtin.map((t) => [t.name, t.state, t.description])).toEqual([
		["read", "active", "Reads files."],
		["bash", "active", undefined],
		["ast_edit", "mounted", undefined],
		["goal", "off", undefined],
	]);
	const byServer = Object.fromEntries(tools.servers.map((s) => [s.name, s.tools.map((t) => t.label)]));
	// `blender_ahujasid_` outranks `blender_`; a tool is shown without its server's prefix.
	expect(byServer).toEqual({
		blender: ["scene_info"],
		"blender-ahujasid": ["look"],
		alpha: ["ping"],
		idle: [],
	});
	expect(tools.servers.map((s) => s.enabled)).toEqual([true, true, false, true]);
	expect(tools.otherMcp.map((t) => [t.name, t.label])).toEqual([["mcp__stray_tool", "stray_tool"]]);
});

test("without the server list every MCP tool is still shown, apart from the built-in ones", () => {
	const tools = groupTools(parseTools(TOOLS_TEXT) ?? new Map(), new Map(), null);
	expect(tools.servers).toEqual([]);
	expect(tools.otherMcp.map((t) => t.label)).toEqual(["alpha_ping", "blender_ahujasid_look", "stray_tool"]);
	expect(tools.builtin.map((t) => t.name)).toEqual(["read", "bash", "ast_edit", "goal"]);
});

// ------------------------------------------------------------------ a conversation's process

const CATALOG = [
	{ name: "tools", description: "Show available tools", source: "builtin" },
	{
		name: "mcp",
		description: "Manage MCP servers",
		source: "builtin",
		subcommands: [{ name: "add" }, { name: "list" }],
	},
	{ name: "hello", description: "Say hello", source: "file", aliases: ["hi"] },
	{ name: "skill:review", description: "Review the diff", source: "skill" },
];
const STATE = {
	dumpTools: [
		{ name: "read", description: "Read files.\n\nLong text that follows." },
		{ name: "bash", description: "Run a command." },
	],
};

/** A process that answers like omp; `printed` is what each builtin command prints, and every `command` is recorded. */
function fakeProcess(options: { catalog?: unknown[]; printed?: Record<string, string | null | Error> } = {}) {
	const asked: string[] = [];
	const proc: LoadedProcess = {
		async rpc(command) {
			if (command.type === "get_available_commands")
				return { success: true, data: { commands: options.catalog ?? CATALOG } };
			if (command.type === "get_state") return { success: true, data: STATE };
			return { success: false, error: `unexpected ${String(command.type)}` };
		},
		async command(message) {
			asked.push(message);
			const printed = options.printed?.[message];
			if (printed instanceof Error) throw printed;
			return printed ?? null;
		},
	};
	return { proc, asked };
}

const collect = (process: LoadedProcess | null) =>
	// No omp binary: the CLI sections fail, which leaves the process's sections to be checked on their own.
	collectLoaded({
		bin: "/nonexistent/omp",
		cwd: "/tmp",
		agentDir: "/nonexistent/agent",
		startedAt: null,
		env: {},
		light: false,
		process,
	});

test("commands, skills and tools come from the process: skills apart from the commands, tools with MCP grouped", async () => {
	const { proc, asked } = fakeProcess({
		printed: { "/tools": TOOLS_TEXT, "/mcp list": "alpha | stdio | enabled | bun [user]" },
	});
	const data = await collect(proc);

	expect(asked).toEqual(["/tools", "/mcp list"]);
	expect(data.commands).toEqual([
		{ name: "tools", description: "Show available tools", source: "builtin", aliases: [], subcommands: 0 },
		{ name: "mcp", description: "Manage MCP servers", source: "builtin", aliases: [], subcommands: 2 },
		{ name: "hello", description: "Say hello", source: "file", aliases: ["hi"], subcommands: 0 },
	]);
	expect(data.skills).toEqual([{ name: "review", description: "Review the diff", enabled: true }]);
	const tools = data.tools as LoadedTools;
	// The description is the first line of the tool's own.
	expect(tools.builtin.find((t) => t.name === "read")?.description).toBe("Read files.");
	expect(tools.servers.map((s) => [s.name, s.tools.map((t) => t.label)])).toEqual([["alpha", ["ping"]]]);
});

test("a command the catalog lacks is never sent: omp would hand the line to the model", async () => {
	// An omp without `/tools` or `/mcp list`: the tools are what get_state offers, and nothing is asked of the model.
	const { proc, asked } = fakeProcess({
		catalog: [{ name: "mcp", source: "builtin", subcommands: [{ name: "add" }] }],
	});
	const data = await collect(proc);
	expect(asked).toEqual([]);
	expect((data.tools as LoadedTools).builtin.map((t) => [t.name, t.state])).toEqual([
		["read", "active"],
		["bash", "active"],
	]);
	expect((data.tools as LoadedTools).servers).toEqual([]);
});

test("a command omp answered as a prompt, or could not run, leaves the other sections whole", async () => {
	const { proc } = fakeProcess({ printed: { "/tools": null, "/mcp list": new Error("This conversation is paused") } });
	const data = await collect(proc);
	expect((data.tools as LoadedTools).builtin.map((t) => t.name)).toEqual(["read", "bash"]);
	expect(Array.isArray(data.commands)).toBe(true);
});

test("a conversation without a process has no tools or commands, and its CLI sections say why they failed", async () => {
	const data = await collect(null);
	expect([data.tools, data.commands, data.skills]).toEqual([null, null, null]);
	expect(isFailure(data.plugins)).toBe(true);
	expect(isFailure(data.rules)).toBe(true);
	expect(data.mode).toBe("full");
});

// ------------------------------------------------------------------ plugins and rules

test("plugins: npm (linked ones too) and marketplace entries, whichever way omp spells them", () => {
	expect(
		parsePlugins({
			npm: [
				{
					name: "demo",
					version: "1.2.3",
					path: "/p/demo",
					manifest: { version: "1.2.3" },
					enabledFeatures: null,
					enabled: true,
				},
				{ name: "quiet", version: "0.1.0", path: "/p/quiet", enabled: false },
			],
			marketplace: [
				{
					id: "tool@market",
					scope: "user",
					entries: [
						{ scope: "user", installPath: "/cache/tool", version: "2.0.0", installedAt: "2026-01-01T00:00:00Z" },
					],
				},
			],
		}),
	).toEqual([
		{ name: "demo", version: "1.2.3", kind: "npm", scope: null, enabled: true, path: "/p/demo" },
		{ name: "quiet", version: "0.1.0", kind: "npm", scope: null, enabled: false, path: "/p/quiet" },
		{ name: "tool@market", version: "2.0.0", kind: "marketplace", scope: "user", enabled: true, path: "/cache/tool" },
	]);
	expect(parsePlugins({ npm: [], marketplace: [] })).toEqual([]);
	expect(() => parsePlugins("not json shaped")).toThrow(/does not know/);
});

test("a marketplace plugin is off when its entries say so (`omp plugin disable` writes the switch there)", () => {
	const [plugin] = parsePlugins({
		npm: [],
		marketplace: [
			{
				id: "tool@market",
				scope: "user",
				entries: [{ scope: "user", installPath: "/c", version: "2.0.0", enabled: false }],
			},
		],
	});
	expect(plugin.enabled).toBe(false);
});

test("a user plugin that the folder also has is marked shadowed, and each scope is its own row", () => {
	const rows = parsePlugins({
		npm: [],
		marketplace: [
			{ id: "tool@market", scope: "project", entries: [{ scope: "project", installPath: "/p", version: "2.0.0" }] },
			{
				id: "tool@market",
				scope: "user",
				shadowedBy: "project",
				entries: [{ scope: "user", installPath: "/u", version: "2.0.0" }],
			},
		],
	});
	expect(rows.map((p) => [p.scope, p.shadowedBy])).toEqual([
		["project", undefined],
		["user", "project"],
	]);
});

test("an MCP server both the user's and the folder's config define is marked, so the page does not offer its switch", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-mcp-both-"));
	try {
		const agentDir = join(dir, "agent");
		const folder = join(dir, "folder");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(folder, ".omp"), { recursive: true });
		const server = { type: "stdio", command: "bun" };
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { alpha: server, solo: server } }));
		writeFileSync(join(folder, ".omp", "mcp.json"), JSON.stringify({ mcpServers: { alpha: server, proj: server } }));
		const { proc } = fakeProcess({
			printed: {
				"/tools": TOOLS_TEXT,
				"/mcp list":
					"alpha | stdio | enabled | bun [user]\nsolo | stdio | enabled | bun [user]\nproj | stdio | enabled | bun [project]",
			},
		});
		const data = await collectLoaded({
			bin: "/nonexistent/omp",
			cwd: folder,
			agentDir,
			startedAt: null,
			env: {},
			light: false,
			process: proc,
		});
		expect((data.tools as LoadedTools).servers.map((s) => [s.name, s.inBoth])).toEqual([
			["alpha", true],
			["solo", undefined],
			["proj", undefined],
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a restart is owed for a server the config turned off that still has tools, or turned on after the process started", () => {
	const server = (name: string, enabled: boolean, tools: number, scope = "user"): LoadedMcpServer => ({
		name,
		transport: "stdio",
		enabled,
		target: "bun",
		scope,
		tools: Array.from({ length: tools }, (_, i) => ({
			name: `mcp__${name}_t${i}`,
			label: `t${i}`,
			state: "active",
		})),
	});
	const owed = (servers: LoadedMcpServer[], user: number, project: number, startedAt: number | null) =>
		markServers(
			servers,
			{ user: { servers: {}, changedAt: user }, project: { servers: {}, changedAt: project } },
			startedAt,
		)
			.filter((s) => s.restartOwed)
			.map((s) => s.name);
	const all = [
		server("off-running", false, 1),
		server("off-stopped", false, 0),
		server("on-running", true, 1),
		server("on-user", true, 0),
		server("on-proj", true, 0, "project"),
	];
	// The user's file was written after the process started, the folder's before: only the user's server is owed.
	expect(owed(all, 2000, 500, 1000)).toEqual(["off-running", "on-user"]);
	expect(owed(all, 500, 2000, 1000)).toEqual(["off-running", "on-proj"]);
	// Nothing was written since the start: a server with no tools never connected, a restart would change nothing.
	expect(owed(all, 500, 500, 1000)).toEqual(["off-running"]);
	expect(owed(all, 2000, 2000, null)).toEqual(["off-running"]);
});

test("skills: the ones the setting turns off are marked off, and those omp no longer lists follow, by name", () => {
	const listed = [
		{ name: "review", description: "Review the diff", enabled: true },
		{ name: "plan", description: "Plan it", enabled: true },
	];
	expect(withDisabled(listed, [])).toEqual(listed);
	expect(withDisabled(listed, ["plan", "zeta", "alpha"])).toEqual([
		{ name: "review", description: "Review the diff", enabled: true },
		// Still listed: omp has not yet caught up with the setting; the setting is what the user chose.
		{ name: "plan", description: "Plan it", enabled: false },
		{ name: "alpha", description: "", enabled: false },
		{ name: "zeta", description: "", enabled: false },
	]);
});

test("rules: name, description, where found, what they apply to and what triggers them", () => {
	expect(
		parseRules([
			{
				name: "no-foo",
				path: "/work/.omp/rules/no-foo.md",
				provider: "native",
				condition: ["\\bfoo\\b"],
				astCondition: ["for $I := 0; $I < $N; $I++ { $$$BODY }"],
				scope: ["tool:edit(*.ts)"],
				globs: [],
				agents: [],
				description: "Stop writing foo",
			},
			{ name: "bare" },
			"junk",
		]),
	).toEqual([
		{
			name: "no-foo",
			description: "Stop writing foo",
			provider: "native",
			path: "/work/.omp/rules/no-foo.md",
			scope: ["tool:edit(*.ts)"],
			triggers: ["\\bfoo\\b", "for $I := 0; $I < $N; $I++ { $$$BODY }"],
		},
		{ name: "bare", description: "", provider: "", path: "", scope: [], triggers: [] },
	]);
	expect(() => parseRules({ rules: [] })).toThrow(/does not know/);
});
