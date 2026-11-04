import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpAdded, McpSearch } from "../../shared/mcp-registry.ts";
import type { InstalledSkill, PluginJob, PluginsData, SkillSearch } from "../../shared/plugins.ts";
import { addedMarketplace, RECOMMENDED_MARKETPLACES } from "../../shared/plugins-catalogs.ts";
import { type StubRegistry, startStubRegistry, writeFakePluginsOmp } from "../support/plugins-stubs.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * The Plugins page's Discover, Skills and MCP routes against the real server, with stand-ins for what they reach: omp's
 * `plugin` and `skill` commands (a fake `omp` that keeps what it was asked in the test's HOME) and the official MCP Registry
 * (a local server, `OMPW_MCP_REGISTRY`). A recommended marketplace is added; a registry skill is searched, refused for its
 * scripts until asked with `--yes`, installed and uninstalled; an MCP server is searched and added to the user's mcp.json,
 * whose content is checked, and what cannot be added is refused with why.
 */

let s: TestServer;
let registry: StubRegistry;
let bin: string;

const headers = () => ({ "x-omp-webui-token": s.accessToken, "x-omp-webui": "1" });
const get = async <T>(path: string): Promise<{ status: number; body: T }> => {
	const res = await fetch(`${s.url}${path}`, { headers: headers() });
	return { status: res.status, body: (await res.json()) as T };
};
const post = async <T>(path: string, body: unknown): Promise<{ status: number; body: T }> => {
	const res = await fetch(`${s.url}${path}`, {
		method: "POST",
		headers: { ...headers(), "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as T };
};

/** Start a job and wait for it to end; its record at the end. */
async function job(body: Record<string, unknown>): Promise<PluginJob> {
	const started = await post<{ job: PluginJob; error?: string }>("/api/plugins/jobs", body);
	if (started.status !== 202) throw new Error(`job refused (${started.status}): ${started.body.error}`);
	let last = started.body.job;
	await pollUntil(
		async () => {
			last = (await get<{ job: PluginJob }>(`/api/plugins/jobs/${last.id}`)).body.job;
			return last.state !== "running";
		},
		`${last.command} to finish`,
		30_000,
	);
	return last;
}

/** Every command line the fake omp was given, from its log in the test's HOME. */
const calls = (): string[][] =>
	readFileSync(join(s.home, ".fake-plugins-omp.calls"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));

beforeAll(async () => {
	bin = mkdtempSync(join(tmpdir(), "ompw-plugins-discover-"));
	registry = await startStubRegistry();
	s = await startTestServer(
		0,
		{ OMP_BIN: writeFakePluginsOmp(bin), OMPW_MCP_REGISTRY: registry.url },
		{ login: false },
	);
}, 120_000);

afterAll(async () => {
	await s?.stop();
	await registry?.stop();
	rmSync(bin, { recursive: true, force: true });
});

test("a recommended marketplace is added by its repository and then listed under its catalog's name", async () => {
	const official = RECOMMENDED_MARKETPLACES[0];
	const done = await job({ action: "marketplace-add", source: official.repo });
	expect(done.state).toBe("done");
	expect(done.command).toBe("omp plugin marketplace add anthropics/claude-plugins-official");
	const data = (await get<PluginsData>("/api/plugins")).body;
	if (!Array.isArray(data.marketplaces)) throw new Error(data.marketplaces.error);
	expect(data.marketplaces).toEqual([
		{ name: "claude-plugins-official", source: "anthropics/claude-plugins-official" },
	]);
	expect(addedMarketplace(official, data.marketplaces)?.name).toBe("claude-plugins-official");
	// Its catalog is listed in Discover.
	expect(data.catalog).toEqual([
		{
			name: "example-plugin",
			version: "1.0.0",
			description: "An example plugin of claude-plugins-official",
			marketplace: "claude-plugins-official",
			installed: [],
		},
	]);
});

describe("skills", () => {
	test("the skills omp has are listed with where they come from", async () => {
		const res = await get<{ installed: InstalledSkill[] }>("/api/plugins/skills");
		expect(res.status).toBe(200);
		expect(res.body.installed.map((k) => [k.name, k.provider, k.level, k.registry])).toEqual([
			["house-style", "custom", "user", null],
		]);
	});

	test("a search: its hits, none for a word the registry does not have, a flag refused before omp runs", async () => {
		const found = await get<SkillSearch>("/api/plugins/skills/search?q=pdf");
		expect(found.status).toBe(200);
		expect(found.body.hits.map((h) => [h.id, h.version, h.publisher])).toEqual([["@acme/pdf-tools", "1.2.0", "acme"]]);
		expect((await get<SkillSearch>("/api/plugins/skills/search?q=nothing-like-it")).body).toEqual({
			total: 0,
			hits: [],
		});
		const before = calls().length;
		expect((await get<{ error: string }>("/api/plugins/skills/search?q=--json")).status).toBe(400);
		expect(calls().length).toBe(before);
	});

	test("an install for the user; one that ships scripts waits for --yes; an uninstall", async () => {
		const pdf = await job({ action: "skill-install", spec: "@acme/pdf-tools" });
		expect(pdf.state).toBe("done");
		expect(pdf.command).toBe("omp skill install @acme/pdf-tools -g");

		const refused = await job({ action: "skill-install", spec: "@acme/shell-helpers" });
		expect(refused.state).toBe("failed");
		expect(refused.confirm).toBe("scripts");
		expect(refused.error).toContain("scripts/run.sh");
		const agreed = await job({ action: "skill-install", spec: "@acme/shell-helpers", yes: true });
		expect(agreed.state).toBe("done");
		expect(agreed.command).toBe("omp skill install @acme/shell-helpers -g -y");
		expect(agreed.confirm).toBeUndefined();

		const listed = (await get<{ installed: InstalledSkill[] }>("/api/plugins/skills")).body.installed;
		expect(listed.flatMap((k) => (k.registry ? [[k.registry.id, k.registry.version, k.level]] : []))).toEqual([
			["@acme/pdf-tools", "1.2.0", "user"],
			["@acme/shell-helpers", "0.3.1", "user"],
		]);

		const gone = await job({ action: "skill-uninstall", id: "@acme/pdf-tools", scope: "user" });
		expect(gone.command).toBe("omp skill uninstall @acme/pdf-tools -g");
		expect(gone.state).toBe("done");
		const after = (await get<{ installed: InstalledSkill[] }>("/api/plugins/skills")).body.installed;
		expect(after.map((k) => k.name)).toEqual(["house-style", "shell-helpers"]);
	});
});

describe("MCP servers", () => {
	const file = () => join(s.agentDir, "mcp.json");

	test("a search goes to the registry from the server: each server with its ways of running, the names already taken", async () => {
		writeFileSync(file(), JSON.stringify({ mcpServers: { existing: { command: "node", args: ["x.js"] } } }));
		const res = await get<McpSearch>("/api/plugins/mcp/search?q=example");
		expect(res.status).toBe(200);
		expect(res.body.taken).toEqual(["existing"]);
		expect(res.body.nextCursor).toBeNull();
		expect(
			res.body.servers.map((x) => [x.name, x.added, x.options.map((o) => [o.id, o.kind, o.problem?.code ?? null])]),
		).toEqual([
			[
				"io.github.example/weather-mcp",
				null,
				[
					["package:0", "npm", null],
					["remote:0", "remote", null],
				],
			],
			["io.github.example/sqlite-mcp", null, [["package:0", "pypi", null]]],
			["io.github.example/dotnet-mcp", null, [["package:0", "nuget", "registry"]]],
		]);
		expect(registry.requests.at(-1)).toBe("/v0/servers?limit=20&version=latest&search=example");
	});

	test("Add: a required value missing is refused; given, the entry is written to the user's mcp.json beside what it had", async () => {
		const add = (values: Record<string, string>, name = "weather") =>
			post<McpAdded & { error?: string }>("/api/plugins/mcp", {
				server: "io.github.example/weather-mcp",
				version: "1.4.0",
				option: "package:0",
				name,
				values,
			});
		const missing = await add({});
		expect(missing.status).toBe(400);
		expect(missing.body.error).toBe("Fill in WEATHER_API_KEY");

		const added = await add({ "env:WEATHER_API_KEY": "secret-123" });
		expect(added.status).toBe(200);
		// The server names omp's agent folder by its real path (the temp folder may be behind a link).
		expect(added.body).toEqual({ name: "weather", file: join(realpathSync(s.agentDir), "mcp.json") });
		expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
			$schema:
				"https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
			mcpServers: {
				existing: { command: "node", args: ["x.js"] },
				weather: {
					type: "stdio",
					command: "npx",
					args: ["-y", "@example/weather-mcp@1.4.0"],
					env: { WEATHER_API_KEY: "secret-123", WEATHER_UNITS: "metric" },
				},
			},
		});
		if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600);

		// The same name again is refused; the search shows the server as added.
		const again = await add({ "env:WEATHER_API_KEY": "x" });
		expect(again.status).toBe(409);
		expect(again.body.error).toContain("already");
		const found = (await get<McpSearch>("/api/plugins/mcp/search?q=weather")).body;
		expect(found.servers[0].added).toBe("weather");
		expect(found.taken).toEqual(["existing", "weather"]);
	});

	test("a remote with its header, and what cannot be added: refused with why, nothing written", async () => {
		const remote = await post<McpAdded>("/api/plugins/mcp", {
			server: "io.github.example/weather-mcp",
			version: "1.4.0",
			option: "remote:0",
			name: "weather remote",
			values: { "var:api_key": "tok" },
		});
		expect(remote.status).toBe(200);
		expect(JSON.parse(readFileSync(file(), "utf8")).mcpServers["weather remote"]).toEqual({
			type: "http",
			url: "https://mcp.example.com/weather",
			headers: { Authorization: "Bearer tok" },
		});

		const before = readFileSync(file(), "utf8");
		const refusals = await Promise.all([
			post<{ error: string }>("/api/plugins/mcp", {
				server: "io.github.example/dotnet-mcp",
				version: "1.0.0",
				option: "package:0",
				name: "dotnet",
				values: {},
			}),
			post<{ error: string }>("/api/plugins/mcp", {
				server: "io.github.example/sqlite-mcp",
				version: "0.2.0",
				option: "package:0",
				name: "bad/name",
				values: {},
			}),
			post<{ error: string }>("/api/plugins/mcp", {
				server: "io.github.example/nowhere",
				version: "1.0.0",
				option: "package:0",
				name: "nowhere",
				values: {},
			}),
			post<{ error: string }>("/api/plugins/mcp", {
				server: "io.github.example/sqlite-mcp",
				version: "0.2.0",
				option: "package:0",
				name: "sqlite",
				values: { "arg:argument:1": "hunter2\nmore" },
			}),
		]);
		expect(refusals.map((r) => r.status)).toEqual([422, 400, 404, 400]);
		expect(refusals[0].body.error).toContain("cannot run nuget packages");
		// A value is never repeated back: it may be a secret.
		expect(refusals[3].body.error).not.toContain("hunter2");
		expect(readFileSync(file(), "utf8")).toBe(before);
	});
});
