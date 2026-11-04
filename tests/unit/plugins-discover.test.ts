import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addToMcpConfig,
	configNameOf,
	configuredAs,
	hitOf,
	mapServer,
	problemText,
	registryBase,
	validConfigName,
} from "../../server/omp/mcp-registry.ts";
import {
	asksToConfirmScripts,
	parseSkillList,
	parseSkillSearch,
	validSkillId,
	validSkillQuery,
	validSkillSpec,
} from "../../server/omp/plugin-skills.ts";
import { PluginsError, planJob, stepsOf } from "../../server/omp/plugins.ts";
import { addedMarketplace, RECOMMENDED_MARKETPLACES, WEB_CATALOGS } from "../../shared/plugins-catalogs.ts";
import { en } from "../../web/src/i18n/plugins.ts";
import { zh } from "../../web/src/i18n/zh-CN/plugins.ts";
import { REGISTRY_SERVERS } from "../support/plugins-stubs.ts";

const argsOf = (plan: ReturnType<typeof planJob>) => stepsOf(plan)[0].args;

/**
 * The Plugins page's Discover, Skills and MCP tabs, their server side: the curated marketplaces, what `omp skill` prints
 * (omp 18.16's JSON), the arguments it is given, and how an MCP Registry entry becomes a server of omp's `mcp.json`.
 */

const HOME = "/home/someone";
const PROJECT = "/work/project";

describe("recommended marketplaces", () => {
	test("each is an owner/repo with its catalog's name, of a known kind, listed once; the deprecated one is not", () => {
		const names = RECOMMENDED_MARKETPLACES.map((m) => m.name);
		const repos = RECOMMENDED_MARKETPLACES.map((m) => m.repo.toLowerCase());
		expect(new Set(names).size).toBe(names.length);
		expect(new Set(repos).size).toBe(repos.length);
		for (const m of RECOMMENDED_MARKETPLACES) {
			expect(m.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
			expect(m.name).toMatch(/^[\w][\w.-]*$/);
			expect(["plugins", "skills"]).toContain(m.kind);
			expect(m.anthropic).toBe(m.repo.startsWith("anthropics/"));
		}
		expect(repos).not.toContain("anthropics/claude-code");
		expect(RECOMMENDED_MARKETPLACES.filter((m) => m.official).map((m) => m.name)).toEqual(["claude-plugins-official"]);
		expect(RECOMMENDED_MARKETPLACES.filter((m) => m.kind === "skills").map((m) => m.repo)).toEqual([
			"anthropics/skills",
			"trailofbits/skills",
			"addyosmani/web-quality-skills",
		]);
	});

	test("each has a description in English and in Chinese", () => {
		const keys = Object.keys(en).filter((k) => k.startsWith("rec_"));
		expect(keys).toHaveLength(RECOMMENDED_MARKETPLACES.length);
		for (const k of keys) expect(zh[k as keyof typeof zh]).toBeTruthy();
	});

	test("one already added is found by its name or by its repository, however omp lists the source", () => {
		const official = RECOMMENDED_MARKETPLACES[0];
		expect(addedMarketplace(official, [])).toBeNull();
		expect(addedMarketplace(official, [{ name: "claude-plugins-official", source: "elsewhere/fork" }])?.name).toBe(
			"claude-plugins-official",
		);
		for (const source of [
			"anthropics/claude-plugins-official",
			"Anthropics/Claude-Plugins-Official",
			"https://github.com/anthropics/claude-plugins-official.git",
			"https://github.com/anthropics/claude-plugins-official/",
			"git@github.com:anthropics/claude-plugins-official.git",
		])
			expect(addedMarketplace(official, [{ name: "mine", source }])?.name).toBe("mine");
		expect(addedMarketplace(official, [{ name: "other", source: "anthropics/skills" }])).toBeNull();
	});

	test("the web catalogs are https links", () => {
		for (const c of Object.values(WEB_CATALOGS).flat()) expect(c.url).toMatch(/^https:\/\/[^\s]+$/);
		expect(WEB_CATALOGS.mcp.map((c) => c.name)).toEqual(["Smithery", "Glama", "mcp.so"]);
	});
});

describe("omp skill", () => {
	test("list --json: every skill with where omp found it; a registry skill's id and version from its store", () => {
		const skills = parseSkillList({
			skills: [
				{
					name: "a11y-debugging",
					description: "Accessibility debugging.",
					filePath: `${HOME}/.omp/plugins/cache/plugins/x/skills/a11y-debugging/SKILL.md`,
					baseDir: `${HOME}/.omp/plugins/cache/plugins/x/skills/a11y-debugging`,
					source: "agent-plugins:user",
					hide: false,
				},
				{
					name: "pdf-tools",
					description: "",
					filePath: `${HOME}/.omp/skillshare/@acme/pdf-tools/1.2.0/SKILL.md`,
					source: "skillshare:project",
					hide: true,
				},
				{ description: "no name" },
			],
			warnings: [],
		});
		expect(skills).toEqual([
			{
				name: "a11y-debugging",
				description: "Accessibility debugging.",
				provider: "agent-plugins",
				level: "user",
				path: `${HOME}/.omp/plugins/cache/plugins/x/skills/a11y-debugging/SKILL.md`,
				hidden: false,
				registry: null,
			},
			{
				name: "pdf-tools",
				description: null,
				provider: "skillshare",
				level: "project",
				path: `${HOME}/.omp/skillshare/@acme/pdf-tools/1.2.0/SKILL.md`,
				hidden: true,
				registry: { id: "@acme/pdf-tools", version: "1.2.0" },
			},
		]);
		expect(() => parseSkillList({ hits: [] })).toThrow();
	});

	test("search --json: each hit as @scope/name with its version, publisher and downloads; an empty registry is no hit", () => {
		expect(parseSkillSearch({ total: 0, page: 1, perPage: 20, hits: [] })).toEqual({ total: 0, hits: [] });
		expect(
			parseSkillSearch({
				total: 3,
				page: 1,
				perPage: 20,
				hits: [
					{
						scope: "acme",
						name: "pdf-tools",
						version: "1.2.0",
						description: "PDF forms",
						weeklyDownloads: 40,
						updatedAt: 1,
						publisher: { username: "acme" },
						keywords: ["pdf", 3],
						deprecated: "use 2.x",
					},
					{ scope: "NOT VALID", name: "x" },
					"junk",
				],
			}),
		).toEqual({
			total: 3,
			hits: [
				{
					id: "@acme/pdf-tools",
					version: "1.2.0",
					description: "PDF forms",
					weeklyDownloads: 40,
					publisher: "acme",
					keywords: ["pdf"],
					deprecated: "use 2.x",
				},
			],
		});
	});

	test("ids, specs and searches that reach omp's command line: never a flag", () => {
		expect(validSkillId("@acme/pdf-tools")).toBe(true);
		for (const bad of ["acme/pdf-tools", "@ac/x", "@acme/PDF", "-g", "@acme/pdf-tools@1"])
			expect(validSkillId(bad)).toBe(false);
		for (const ok of ["@acme/pdf-tools", "@acme/pdf-tools@1.2.0", "@acme/pdf-tools@^1.2", "@acme/pdf-tools@next"])
			expect(validSkillSpec(ok)).toBe(true);
		for (const bad of ["--yes", "@acme/pdf-tools@", "@acme/pdf-tools@1 2", "pdf-tools"])
			expect(validSkillSpec(bad)).toBe(false);
		expect(validSkillQuery("pdf forms")).toBe(true);
		for (const bad of ["", "  ", "--json", "a\nb", "x".repeat(201)]) expect(validSkillQuery(bad)).toBe(false);
	});

	test("install and uninstall: for the user (-g) unless a project is chosen; --yes only when asked", () => {
		expect(argsOf(planJob("skill-install", { spec: "@acme/pdf-tools" }, HOME, HOME))).toEqual([
			"skill",
			"install",
			"@acme/pdf-tools",
			"-g",
		]);
		expect(
			argsOf(planJob("skill-install", { spec: "@acme/pdf-tools@1.2.0", scope: "project", yes: true }, PROJECT, HOME)),
		).toEqual(["skill", "install", "@acme/pdf-tools@1.2.0", "-y"]);
		expect(argsOf(planJob("skill-uninstall", { id: "@acme/pdf-tools", scope: "user" }, PROJECT, HOME))).toEqual([
			"skill",
			"uninstall",
			"@acme/pdf-tools",
			"-g",
		]);
		expect(() => planJob("skill-install", { spec: "--yes" }, HOME, HOME)).toThrow(PluginsError);
		expect(() => planJob("skill-install", { spec: "@acme/pdf-tools", scope: "project" }, HOME, HOME)).toThrow(
			PluginsError,
		);
		expect(() => planJob("skill-uninstall", { id: "@acme/pdf-tools@1.0.0" }, HOME, HOME)).toThrow(PluginsError);
	});

	test("omp's refusal of a skill that ships scripts is told apart from other failures", () => {
		expect(
			asksToConfirmScripts(
				"error @acme/sh@0.3.1 ships scripts:\n  scripts/run.sh (executable)\nRefusing to install scripts without confirmation; re-run with --yes to allow them.",
			),
		).toBe(true);
		expect(asksToConfirmScripts("error @acme/sh was not found in the registry")).toBe(false);
	});
});

describe("MCP Registry → omp's mcp.json", () => {
	const [weather, sqlite, dotnet] = REGISTRY_SERVERS;

	test("an npm package runs with npx at its version; its variables are asked for, a secret one as secret", () => {
		const [pkg] = mapServer(weather);
		expect(pkg.option).toMatchObject({ id: "package:0", kind: "npm", transport: "stdio", problem: null });
		expect(pkg.option.summary).toBe("npx -y @example/weather-mcp@1.4.0");
		expect(pkg.option.inputs).toEqual([
			{
				key: "env:WEATHER_API_KEY",
				kind: "env",
				label: "WEATHER_API_KEY",
				description: "Your API key.",
				required: true,
				secret: true,
				default: null,
				placeholder: null,
				choices: null,
			},
			{
				key: "env:WEATHER_UNITS",
				kind: "env",
				label: "WEATHER_UNITS",
				description: "metric or imperial",
				required: false,
				secret: false,
				default: "metric",
				placeholder: null,
				choices: null,
			},
		]);
		// Missing what it requires: nothing to write.
		expect(pkg.entry).toBeNull();
		expect(pkg.missing).toEqual(["env:WEATHER_API_KEY"]);
		const filled = mapServer(weather, { "env:WEATHER_API_KEY": "k-123" })[0];
		expect(filled.entry).toEqual({
			type: "stdio",
			command: "npx",
			args: ["-y", "@example/weather-mcp@1.4.0"],
			env: { WEATHER_API_KEY: "k-123", WEATHER_UNITS: "metric" },
		});
	});

	test("a remote: http for streamable HTTP, its header's {placeholder} asked for as required and secret", () => {
		const remote = mapServer(weather)[1];
		expect(remote.option).toMatchObject({ id: "remote:0", kind: "remote", transport: "http", problem: null });
		expect(remote.option.inputs.map((i) => [i.key, i.required, i.secret])).toEqual([["var:api_key", true, true]]);
		expect(mapServer(weather, { "var:api_key": "tok" })[1].entry).toEqual({
			type: "http",
			url: "https://mcp.example.com/weather",
			headers: { Authorization: "Bearer tok" },
		});
		const sseServer = {
			name: "x/y",
			remotes: [
				{
					type: "sse",
					url: "https://{tenant}.example.com/sse",
					variables: { tenant: { description: "Your tenant", isRequired: true } },
				},
			],
		};
		const sse = mapServer(sseServer)[0];
		expect(sse.option.inputs.map((i) => [i.key, i.description])).toEqual([["var:tenant", "Your tenant"]]);
		expect(mapServer(sseServer, { "var:tenant": "acme" })[0].entry).toEqual({
			type: "sse",
			url: "https://acme.example.com/sse",
		});
	});

	test("a PyPI package runs with uvx; a named flag is passed as it is, a positional argument is asked for", () => {
		const [pkg] = mapServer(sqlite, { "arg:argument:1": "/data/app.db" });
		expect(pkg.option.summary).toBe("uvx sqlite-mcp@0.2.0");
		expect(pkg.option.inputs.map((i) => [i.key, i.label, i.required])).toEqual([
			["arg:argument:1", "database_path", true],
		]);
		expect(pkg.entry).toEqual({
			type: "stdio",
			command: "uvx",
			args: ["sqlite-mcp@0.2.0", "--read-only", "/data/app.db"],
		});
	});

	test("an OCI image runs with docker, its environment passed by name; runtime arguments go before the image", () => {
		const [pkg] = mapServer(
			{
				name: "io.github.example/box",
				packages: [
					{
						registryType: "oci",
						identifier: "ghcr.io/example/box",
						version: "2.0.0",
						runtimeArguments: [{ type: "named", name: "--network", value: "host" }],
						environmentVariables: [{ name: "TOKEN", isRequired: true, isSecret: true }],
					},
				],
			},
			{ "env:TOKEN": "t" },
		);
		expect(pkg.entry).toEqual({
			type: "stdio",
			command: "docker",
			args: ["run", "-i", "--rm", "--network", "host", "-e", "TOKEN", "ghcr.io/example/box:2.0.0"],
			env: { TOKEN: "t" },
		});
	});

	test("what cannot be mapped says why: other package kinds, private registries, local HTTP, other transports, flags", () => {
		const problems = [
			mapServer(dotnet)[0],
			mapServer({
				name: "a/b",
				packages: [{ registryType: "npm", identifier: "p", registryBaseUrl: "https://npm.corp" }],
			})[0],
			mapServer({
				name: "a/b",
				packages: [
					{
						registryType: "oci",
						identifier: "img",
						transport: { type: "streamable-http", url: "http://localhost:8080" },
					},
				],
			})[0],
			mapServer({ name: "a/b", remotes: [{ type: "websocket", url: "wss://x" }] })[0],
			mapServer({ name: "a/b", packages: [{ registryType: "npm", identifier: "--evil" }] })[0],
			mapServer({
				name: "a/b",
				packages: [{ registryType: "npm", identifier: "p", environmentVariables: [{ name: "BAD NAME" }] }],
			})[0],
		].map((m) => {
			expect(m.entry).toBeNull();
			return m.option.problem;
		});
		expect(problems).toEqual([
			{ code: "registry", detail: "nuget" },
			{ code: "private-registry", detail: "https://npm.corp" },
			{ code: "local-http", detail: "streamable-http" },
			{ code: "transport", detail: "websocket" },
			{ code: "invalid", detail: "--evil" },
			{ code: "invalid", detail: "BAD NAME" },
		]);
		for (const p of problems) if (p) expect(problemText(p)).toContain(p.detail);
		// A value that would break its line is refused.
		expect(mapServer(weather, { "env:WEATHER_API_KEY": "a\nb" })[0].option.problem).toEqual({
			code: "invalid",
			detail: "WEATHER_API_KEY",
		});
	});

	test("its name in omp's config, and the names omp allows", () => {
		expect(configNameOf("io.github.example/weather-mcp")).toBe("weather-mcp");
		expect(configNameOf("ai.smithery/Some Thing!!")).toBe("Some-Thing");
		expect(configNameOf("///")).toBe("mcp-server");
		expect(validConfigName("weather-mcp")).toBe(true);
		expect(validConfigName("my server")).toBe(true);
		for (const bad of ["", "a  b", " a", "a/b", "x".repeat(101), 3]) expect(validConfigName(bad)).toBe(false);
	});

	test("one already configured is found by its package at any version or by its address; a name alone is not it", () => {
		expect(configuredAs(weather, { mine: { command: "npx", args: ["-y", "@example/weather-mcp@1.0.0"] } })).toBe(
			"mine",
		);
		expect(configuredAs(weather, { w: { type: "http", url: "https://mcp.example.com/weather/?x=1" } })).toBe("w");
		expect(configuredAs(sqlite, { s: { command: "uvx", args: ["sqlite-mcp==0.1.0"] } })).toBe("s");
		expect(configuredAs(weather, { "weather-mcp": { command: "node", args: ["other.js"] } })).toBeNull();
		expect(
			configuredAs(
				{ name: "a/b", remotes: [{ type: "sse", url: "https://{t}.x.com" }] },
				{ o: { url: "https://z.y" } },
			),
		).toBeNull();
		const hit = hitOf(weather, { mine: { command: "npx", args: ["@example/weather-mcp"] } });
		expect(hit).toMatchObject({
			name: "io.github.example/weather-mcp",
			title: "Weather",
			version: "1.4.0",
			repository: "https://github.com/example/weather-mcp",
			configName: "weather-mcp",
			added: "mine",
		});
		expect(hit.options.map((o) => o.id)).toEqual(["package:0", "remote:0"]);
	});

	test("the registry's address: the official one unless a test names its own", () => {
		expect(registryBase({})).toBe("https://registry.modelcontextprotocol.io");
		expect(registryBase({ OMPW_MCP_REGISTRY: "http://127.0.0.1:9/" })).toBe("http://127.0.0.1:9");
	});
});

describe("writing mcp.json as omp does", () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-mcp-json-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("a new file: $schema first, the server under its name, private to the user", async () => {
		const file = join(dir, "agent", "mcp.json");
		await addToMcpConfig(file, "weather", { type: "stdio", command: "npx", args: ["-y", "w@1"], env: { K: "v" } });
		const text = readFileSync(file, "utf8");
		expect(Object.keys(JSON.parse(text))).toEqual(["$schema", "mcpServers"]);
		expect(JSON.parse(text).mcpServers).toEqual({
			weather: { type: "stdio", command: "npx", args: ["-y", "w@1"], env: { K: "v" } },
		});
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	test("an existing file keeps what it has; a name that is taken, or a file that is not JSON, is refused", async () => {
		const file = join(dir, "mcp.json");
		writeFileSync(file, JSON.stringify({ mcpServers: { old: { url: "https://o" } }, extra: 1 }));
		await addToMcpConfig(file, "new", { type: "http", url: "https://n" });
		const doc = JSON.parse(readFileSync(file, "utf8"));
		expect(doc.extra).toBe(1);
		expect(Object.keys(doc.mcpServers)).toEqual(["old", "new"]);
		await expect(addToMcpConfig(file, "old", { type: "http", url: "https://x" })).rejects.toThrow(/already/);
		writeFileSync(file, "{ not json");
		await expect(addToMcpConfig(file, "z", { type: "http", url: "https://x" })).rejects.toThrow(/fix it first/);
		expect(readFileSync(file, "utf8")).toBe("{ not json");
	});
});
