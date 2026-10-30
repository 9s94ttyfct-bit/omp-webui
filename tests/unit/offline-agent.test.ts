import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Config } from "../../server/config.ts";
import {
	CHAT_ROLES,
	COLLECT_GRACE_MS,
	collectOfflineAgents,
	DISABLED_PROVIDERS,
	offlineConfig,
	offlineMcp,
	offlineModels,
	readUserFiles,
	writeOfflineAgent,
} from "../../server/offline/agent.ts";
import { OfflineError, queryBackend, resolveApiKey, shown } from "../../server/offline/backend.ts";
import { type measureContext, parseContext } from "../../server/offline/context.ts";
import { chooseModel, type LaunchPlan, type LaunchRequest, ModeService } from "../../server/offline/index.ts";
import { ModeStore, mergeOffline, normalizeBaseUrl, SettingsError } from "../../server/offline/settings.ts";
import {
	type ContextBreakdown,
	DEFAULT_OFFLINE,
	type Mode,
	type ModeState,
	type OfflineSettings,
} from "../../shared/offline.ts";
import { newestOfflineAgent } from "../support/offline-agent.ts";
import { type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";

/** The files Light on a local server builds and the choices behind them (no omp process). */

const dirs: string[] = [];
const tmp = () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-offline-"));
	dirs.push(dir);
	return dir;
};

/**
 * The service as these tests use it: a plan asked for without a mode is for the mode new conversations start in (the pool
 * names the mode of every launch; a test of one mode's files says it with `update`, and one that wants another names it).
 */
class Service extends ModeService {
	override plan(req: Omit<LaunchRequest, "mode"> & { mode?: Mode }): Promise<LaunchPlan> {
		return super.plan({ ...req, mode: req.mode ?? this.mode });
	}
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MODELS = `# my models
providers:
  ollama:
    baseUrl: http://127.0.0.1:11434/v1
    apiKey: sk-ollama-secret
  omlx:
    baseUrl: http://127.0.0.1:8000/v1
    api: openai-completions
    apiKey: sk-omlx-secret
    discovery:
      type: openai-models-list
equivalence:
  keep: me
`;

describe("models.yml", () => {
	test("is reduced to the oMLX provider, and nothing else of the file stays", () => {
		const { yaml, provider } = offlineModels(MODELS, "models.yml", "omlx");
		expect(provider).toEqual({ baseUrl: "http://127.0.0.1:8000/v1", apiKey: "sk-omlx-secret" });
		expect(yaml).toContain("sk-omlx-secret");
		expect(yaml).not.toContain("ollama");
		expect(yaml).not.toContain("sk-ollama-secret");
		expect(yaml).not.toContain("equivalence");
		expect(Bun.YAML.parse(yaml)).toEqual({
			providers: {
				omlx: {
					baseUrl: "http://127.0.0.1:8000/v1",
					api: "openai-completions",
					apiKey: "sk-omlx-secret",
					discovery: { type: "openai-models-list" },
				},
			},
		});
	});

	test("no other top-level key is written: a holder of keys that the entries point at (YAML anchors) stays behind", () => {
		const text = `_keys:
  anthropic: &anthropic sk-ant-holder-key
  omlx: &omlx sk-omlx-holder-key
providers:
  anthropic:
    apiKey: *anthropic
  omlx:
    baseUrl: http://127.0.0.1:8000/v1
    apiKey: *omlx
`;
		const { yaml, provider } = offlineModels(text, "models.yml", "omlx");
		// The entry's own key is the one it points at.
		expect(provider.apiKey).toBe("sk-omlx-holder-key");
		expect(Bun.YAML.parse(yaml)).toEqual({
			providers: { omlx: { baseUrl: "http://127.0.0.1:8000/v1", apiKey: "sk-omlx-holder-key" } },
		});
		expect(yaml).not.toContain("_keys");
		expect(yaml).not.toContain("sk-ant-holder-key");
		expect(yaml).not.toContain("anthropic");
	});

	test("without an oMLX provider (or a file) Light on a local server cannot start, and says where it looked", () => {
		for (const text of [null, "", "providers: {}", "providers:\n  omlx:\n    apiKey: x\n", "not: [valid"]) {
			expect(() => offlineModels(text, "/u/models.yml", "omlx")).toThrow(OfflineError);
		}
		expect(() => offlineModels(null, "/u/models.yml", "omlx")).toThrow(/provider named "omlx".*\/u\/models\.yml/);
		// An address typed in Settings does not make up the oMLX key and provider that only the user has.
		expect(() => offlineModels(null, "/u/models.yml", "omlx", "http://127.0.0.1:8000/v1")).toThrow(OfflineError);
	});

	test("Ollama and LM Studio need no entry: omp's own provider is made up, at the default address, without a key", () => {
		const ollama = offlineModels(null, "models.yml", "ollama");
		expect(ollama.source).toBe("default");
		expect(ollama.provider).toEqual({ baseUrl: "http://127.0.0.1:11434/v1", apiKey: null });
		expect(Bun.YAML.parse(ollama.yaml)).toEqual({
			providers: {
				ollama: {
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-responses",
					discovery: { type: "ollama", timeoutMs: 3000 },
					auth: "none",
				},
			},
		});
		const lmStudio = offlineModels("providers: {}\n", "models.yml", "lm-studio");
		expect(lmStudio.provider.baseUrl).toBe("http://127.0.0.1:1234/v1");
		expect(Bun.YAML.parse(lmStudio.yaml)).toEqual({
			providers: {
				"lm-studio": {
					baseUrl: "http://127.0.0.1:1234/v1",
					api: "openai-completions",
					discovery: { type: "lm-studio", timeoutMs: 3000 },
					auth: "none",
				},
			},
		});
	});

	test("the user's entry of an engine is kept (key, overrides) and completed with what omp needs to list its models", () => {
		const text = `providers:
  ollama:
    baseUrl: http://10.0.0.5:11434/v1
    apiKey: sk-ollama-secret
    modelOverrides:
      "qwen3:8b":
        contextWindow: 65536
  omlx:
    baseUrl: http://127.0.0.1:8000/v1
    apiKey: sk-omlx-secret
`;
		const { yaml, provider, source } = offlineModels(text, "models.yml", "ollama");
		expect(source).toBe("models.yml");
		expect(provider).toEqual({ baseUrl: "http://10.0.0.5:11434/v1", apiKey: "sk-ollama-secret" });
		expect(Bun.YAML.parse(yaml)).toEqual({
			providers: {
				ollama: {
					baseUrl: "http://10.0.0.5:11434/v1",
					apiKey: "sk-ollama-secret",
					api: "openai-responses",
					discovery: { type: "ollama", timeoutMs: 3000 },
					modelOverrides: { "qwen3:8b": { contextWindow: 65536 } },
				},
			},
		});
		expect(yaml).not.toContain("sk-omlx-secret");
		// An entry that says how to talk to the engine is not second-guessed.
		const own = offlineModels("providers:\n  ollama:\n    api: openai-completions\n", "models.yml", "ollama");
		expect(Bun.YAML.parse(own.yaml)).toMatchObject({ providers: { ollama: { api: "openai-completions" } } });
	});

	test("the address set in Settings replaces the entry's and the default; the rest of the entry stays", () => {
		const moved = offlineModels(MODELS, "models.yml", "ollama", "http://10.0.0.9:11434/v1");
		expect(moved.source).toBe("settings");
		expect(moved.provider).toEqual({ baseUrl: "http://10.0.0.9:11434/v1", apiKey: "sk-ollama-secret" });
		const omlx = offlineModels(MODELS, "models.yml", "omlx", "http://192.168.1.2:8000/v1");
		expect(omlx.source).toBe("settings");
		expect(Bun.YAML.parse(omlx.yaml)).toEqual({
			providers: {
				omlx: {
					baseUrl: "http://192.168.1.2:8000/v1",
					api: "openai-completions",
					apiKey: "sk-omlx-secret",
					discovery: { type: "openai-models-list" },
				},
			},
		});
		expect(offlineModels(null, "models.yml", "lm-studio", "http://10.0.0.7:1234/v1").provider.baseUrl).toBe(
			"http://10.0.0.7:1234/v1",
		);
	});

	test("an address typed in Settings that leaves the network is not sent the entry's credentials, unless the entry is for that host", () => {
		const text =
			"providers:\n  omlx:\n    baseUrl: http://127.0.0.1:8000/v1\n    apiKey: sk-omlx-secret\n    headers:\n      X-Org: acme\n";
		// Out of the network and not the entry's host: neither the key nor the headers go with the prompts.
		const stranger = offlineModels(text, "models.yml", "omlx", "https://api.example.com/v1");
		expect(stranger.provider).toEqual({ baseUrl: "https://api.example.com/v1", apiKey: null, keyWithheld: true });
		expect(stranger.yaml).not.toContain("sk-omlx-secret");
		expect(stranger.yaml).not.toContain("acme");
		expect(Bun.YAML.parse(stranger.yaml)).toEqual({ providers: { omlx: { baseUrl: "https://api.example.com/v1" } } });
		// Another machine on the network, or another port of the same host: the key is theirs.
		for (const url of ["http://192.168.1.2:8000/v1", "http://studio.local:8000/v1", "http://127.0.0.1:9000/v1"])
			expect(offlineModels(text, "models.yml", "omlx", url).provider).toEqual({
				baseUrl: url,
				apiKey: "sk-omlx-secret",
			});

		// The entry names a host of its own, which is where its key belongs (whatever port Settings has for it).
		const remote = "providers:\n  omlx:\n    baseUrl: https://omlx.example.com/v1\n    apiKey: sk-remote\n";
		expect(offlineModels(remote, "models.yml", "omlx").provider.apiKey).toBe("sk-remote");
		expect(offlineModels(remote, "models.yml", "omlx", "https://omlx.example.com:8443/v1").provider.apiKey).toBe(
			"sk-remote",
		);
		expect(offlineModels(remote, "models.yml", "omlx", "https://other.example.com/v1").provider.apiKey).toBeNull();

		// An engine whose entry had a key goes back to asking for none.
		const ollama = offlineModels(MODELS, "models.yml", "ollama", "https://tunnel.example.com/v1");
		expect(ollama.yaml).not.toContain("sk-ollama-secret");
		expect(Bun.YAML.parse(ollama.yaml)).toMatchObject({ providers: { ollama: { auth: "none" } } });
		// An entry without credentials has nothing to withhold.
		expect(offlineModels(null, "models.yml", "ollama", "https://tunnel.example.com/v1").provider).toEqual({
			baseUrl: "https://tunnel.example.com/v1",
			apiKey: null,
		});
	});

	test("the API key is the named environment variable when it is set, else the literal", () => {
		expect(resolveApiKey("OMLX_KEY", { OMLX_KEY: "from-env" })).toEqual({ key: "from-env", unresolved: false });
		expect(resolveApiKey("sk-literal", {})).toEqual({ key: "sk-literal", unresolved: false });
		expect(resolveApiKey(null)).toEqual({ key: null, unresolved: false });
		// A `!command` is for omp to run.
		expect(resolveApiKey("!op read x")).toEqual({ key: null, unresolved: true });
	});
});

describe("mcp.json", () => {
	const servers = { a: { command: "a", args: ["--x"] }, b: { url: "http://b" }, c: { command: "c" } };

	test("keeps the selected servers as the user wrote them and names the ones that are gone", () => {
		const { json, missing } = offlineMcp(servers, ["c", "a", "gone"]);
		expect(JSON.parse(json)).toEqual({ mcpServers: { c: servers.c, a: servers.a } });
		expect(missing).toEqual(["gone"]);
	});

	test("a name that is a property of every object is not a server", () => {
		const { json, missing } = offlineMcp(servers, ["constructor", "toString"]);
		expect(JSON.parse(json)).toEqual({ mcpServers: {} });
		expect(missing).toEqual(["constructor", "toString"]);
	});
});

describe("config.yml", () => {
	const config = (settings: Partial<OfflineSettings> = {}, model = "omlx/Bonsai-2:27B") =>
		Bun.YAML.parse(offlineConfig({ ...DEFAULT_OFFLINE, ...settings }, model)) as Record<string, unknown>;

	test("every chat role is the chosen model; the other kinds of model are left alone", () => {
		const roles = config().modelRoles as Record<string, string>;
		expect(Object.keys(roles).sort()).toEqual([...CHAT_ROLES].sort());
		for (const model of Object.values(roles)) expect(model).toBe("omlx/Bonsai-2:27B");
		for (const kind of ["image", "web", "speech", "dictation", "judge"]) expect(roles[kind]).toBeUndefined();
	});

	test("only the chosen backend's models are offered, the other local engines and the plugin sources are off, project MCP is ignored", () => {
		const c = config({ thinking: "high" });
		expect(c.enabledModels).toEqual(["omlx/**"]);
		expect(c.disabledProviders).toEqual(DISABLED_PROVIDERS);
		expect(DISABLED_PROVIDERS).toEqual(expect.arrayContaining(["ollama", "omp-plugins", "claude-plugins"]));
		expect(c.defaultThinkingLevel).toBe("high");
		expect(c.mcp).toEqual({ enableProjectConfig: false });
	});

	test("the chosen engine is the one provider omp may use: it is taken off the disabled list, the other engine stays on it", () => {
		const ollama = config({ backend: "ollama" }, "ollama/qwen3:8b");
		expect(ollama.enabledModels).toEqual(["ollama/**"]);
		expect(ollama.disabledProviders).toEqual(DISABLED_PROVIDERS.filter((id) => id !== "ollama"));
		expect(ollama.disabledProviders).toContain("lm-studio");
		const lmStudio = config({ backend: "lm-studio" }, "lm-studio/qwen/qwen3-8b");
		expect(lmStudio.enabledModels).toEqual(["lm-studio/**"]);
		expect(lmStudio.disabledProviders).toEqual(DISABLED_PROVIDERS.filter((id) => id !== "lm-studio"));
		expect(lmStudio.disabledProviders).toContain("ollama");
		for (const c of [ollama, lmStudio])
			expect(c.disabledProviders).toEqual(expect.arrayContaining(["llama.cpp", "omp-plugins"]));
	});

	test("skills: the selected ones only, or none at all", () => {
		expect(config().skills).toEqual({ includeSkills: ["reverse-engineer-anything"] });
		expect(config({ skills: ["git-*", "docker"] }).skills).toEqual({ includeSkills: ["git-*", "docker"] });
		expect(config({ skills: [] }).skills).toEqual({ enabled: false });
	});
});

describe("the offline agent directory", () => {
	function setup() {
		const root = tmp();
		const agentDir = join(root, "user");
		const offlineRoot = join(root, "data", "offline-agent");
		const sessionsDir = join(agentDir, "sessions");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "models.yml"), MODELS);
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { rea: { command: "rea" }, other: { command: "o" } } }),
		);
		writeFileSync(join(agentDir, "AGENTS.md"), "user rules\n");
		const build = (settings: Partial<OfflineSettings> = {}) => {
			const user = readUserFiles(agentDir);
			return writeOfflineAgent({
				root: offlineRoot,
				agentDir,
				sessionsDir,
				settings: { ...DEFAULT_OFFLINE, ...settings },
				model: "omlx/m",
				user,
				modelsYaml: offlineModels(user.modelsYaml, "models.yml", "omlx").yaml,
			});
		};
		return { root, agentDir, offlineRoot, sessionsDir, build };
	}
	const modeOf = (path: string) => statSync(path).mode & 0o777;
	const textOf = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

	test("holds the key and the selection, privately, and nothing of the other providers or servers", () => {
		const { build } = setup();
		const { dir, missing } = build();
		expect(missing).toEqual([]);
		expect(modeOf(dir)).toBe(0o700);
		for (const f of ["models.yml", "mcp.json", "config.yml"]) expect(modeOf(join(dir, f))).toBe(0o600);
		expect(textOf(dir, "models.yml")).toContain("sk-omlx-secret");
		expect(textOf(dir, "models.yml")).not.toContain("sk-ollama-secret");
		expect(Object.keys(JSON.parse(textOf(dir, "mcp.json")).mcpServers)).toEqual(["rea"]);
		expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
	});

	test("each configuration has a directory of its own, named by a digest of what is in it, and a directory is never changed", () => {
		const { agentDir, offlineRoot, build } = setup();
		const first = build();
		expect(basename(first.dir)).toMatch(/^[0-9a-f]{16}$/);
		expect(dirname(first.dir)).toBe(offlineRoot);
		const snapshot = () => ["models.yml", "mcp.json", "config.yml"].map((f) => textOf(first.dir, f));
		const before = snapshot();

		// The same files and settings find the directory they had, and write nothing (dated long ago: a rewrite would show).
		utimesSync(join(first.dir, "models.yml"), 1000, 1000);
		expect(build().dir).toBe(first.dir);
		expect(statSync(join(first.dir, "models.yml")).mtimeMs).toBe(1_000_000);

		// A setting, or any of the user's files, makes another directory.
		const high = build({ thinking: "high" });
		expect(high.dir).not.toBe(first.dir);
		expect(textOf(high.dir, "config.yml")).toContain("defaultThinkingLevel: high");

		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { rea: { command: "rea2" } } }));
		const mcp = build({ mcp: ["rea", "gone"] });
		expect(mcp.missing).toEqual(["gone"]);
		expect(JSON.parse(textOf(mcp.dir, "mcp.json")).mcpServers).toEqual({ rea: { command: "rea2" } });

		writeFileSync(join(agentDir, "models.yml"), MODELS.replace("8000", "9000"));
		expect(textOf(build().dir, "models.yml")).toContain(":9000/v1");

		// AGENTS.md: copied when asked for, left out when not.
		expect(textOf(build({ agentsMd: true }).dir, "AGENTS.md")).toBe("user rules\n");
		expect(existsSync(join(build({ agentsMd: false }).dir, "AGENTS.md"))).toBe(false);

		// Nothing any of them did reached the first directory, where a process may still be running.
		expect(snapshot()).toEqual(before);
		expect(readdirSync(offlineRoot)).toContain(basename(first.dir));
	});

	test("a directory is put in place whole: nothing has a revision's name before it is complete, and nothing is left aside", () => {
		const { offlineRoot, build } = setup();
		build();
		build({ thinking: "high" });
		const names = readdirSync(offlineRoot);
		expect(names).toHaveLength(2);
		for (const name of names) expect(name).toMatch(/^[0-9a-f]{16}$/);
	});

	test("conversations and images are the user's: links into the user's directory, made even when it has none yet; skills and history are linked when the user has them", () => {
		const { agentDir, sessionsDir, build } = setup();
		expect(existsSync(sessionsDir)).toBe(false);
		const { dir } = build();
		expect(readlinkSync(join(dir, "sessions"))).toBe(sessionsDir);
		expect(readlinkSync(join(dir, "blobs"))).toBe(join(agentDir, "blobs"));
		expect(existsSync(sessionsDir)).toBe(true);
		// Skills and prompt history: only when the user has them.
		expect(existsSync(join(dir, "skills"))).toBe(false);
		expect(lstatSync(join(dir, "history.db"), { throwIfNoEntry: false })).toBeUndefined();
		mkdirSync(join(agentDir, "skills"));
		writeFileSync(join(agentDir, "history.db"), "");
		// What there is to link to is part of the configuration: a directory made without the links is not changed to have them.
		const linked = build();
		expect(linked.dir).not.toBe(dir);
		expect(readlinkSync(join(linked.dir, "skills"))).toBe(join(agentDir, "skills"));
		expect(readlinkSync(join(linked.dir, "history.db"))).toBe(join(agentDir, "history.db"));
		expect(existsSync(join(dir, "skills"))).toBe(false);
		rmSync(join(agentDir, "skills"), { recursive: true });
		const without = build();
		expect(without.dir).not.toBe(linked.dir);
		expect(lstatSync(join(without.dir, "skills"), { throwIfNoEntry: false })).toBeUndefined();
	});

	test("never writes to the user's own configuration", () => {
		const { agentDir, build } = setup();
		const hash = (f: string) => new Bun.CryptoHasher("sha256").update(readFileSync(join(agentDir, f))).digest("hex");
		const files = ["models.yml", "mcp.json", "AGENTS.md"];
		const before = files.map(hash);
		build({ agentsMd: true, mcp: ["rea", "other"] });
		build({ mcp: [] });
		expect(files.map(hash)).toEqual(before);
		expect(readdirSync(agentDir).sort()).toEqual(["AGENTS.md", "blobs", "mcp.json", "models.yml", "sessions"]);
	});

	describe("collecting the directories that no process uses", () => {
		const longAgo = (dir: string) => utimesSync(dir, 1000, 1000);

		test("an unused directory goes; one in use stays however old, and one used lately stays", () => {
			const { offlineRoot, build } = setup();
			const used = build().dir;
			const unused = build({ thinking: "high" }).dir;
			const lately = build({ thinking: "low" }).dir;
			longAgo(used);
			longAgo(unused);
			expect(collectOfflineAgents(offlineRoot, [used])).toEqual([basename(unused)]);
			expect(existsSync(used)).toBe(true);
			expect(existsSync(unused)).toBe(false);
			expect(existsSync(lately)).toBe(true);

			// The configuration of a directory is planned again: it is in use again, and does not look old.
			longAgo(lately);
			expect(build({ thinking: "low" }).dir).toBe(lately);
			expect(collectOfflineAgents(offlineRoot, [])).toEqual([basename(used)]);
			expect(readdirSync(offlineRoot)).toEqual([basename(lately)]);
		});

		test("the grace period is how long after its last use a directory is left alone", () => {
			const { offlineRoot, build } = setup();
			const { dir } = build();
			expect(collectOfflineAgents(offlineRoot, [])).toEqual([]);
			expect(collectOfflineAgents(offlineRoot, [], Date.now() + COLLECT_GRACE_MS - 5_000)).toEqual([]);
			expect(collectOfflineAgents(offlineRoot, [], Date.now() + COLLECT_GRACE_MS + 5_000)).toEqual([basename(dir)]);
		});

		test("a directory half built by a server that ended meanwhile goes too, once it is old", () => {
			const { offlineRoot } = setup();
			const half = join(offlineRoot, ".0123456789abcdef-AbC123");
			mkdirSync(half, { recursive: true });
			expect(collectOfflineAgents(offlineRoot, [])).toEqual([]);
			longAgo(half);
			expect(collectOfflineAgents(offlineRoot, [])).toEqual([basename(half)]);
		});

		test("what the one directory held before each configuration had its own goes, its models.yml with the keys of every provider among it; what is the user's stays", () => {
			const { agentDir, offlineRoot, build } = setup();
			const { dir } = build();
			for (const f of ["models.yml", "mcp.json", "config.yml", "AGENTS.md"]) writeFileSync(join(offlineRoot, f), "old");
			symlinkSync(agentDir, join(offlineRoot, "sessions"));
			symlinkSync(join(agentDir, "mcp.json"), join(offlineRoot, "history.db"));
			// omp's own file, where the user had no history.db: not a link, not ours to remove.
			mkdirSync(join(offlineRoot, "other"));

			// A paused conversation of an earlier version still runs in the directory itself: its files stay.
			expect(collectOfflineAgents(offlineRoot, [offlineRoot, dir])).toEqual([]);
			expect(existsSync(join(offlineRoot, "models.yml"))).toBe(true);

			expect(collectOfflineAgents(offlineRoot, [dir]).sort()).toEqual(
				["AGENTS.md", "config.yml", "history.db", "mcp.json", "models.yml", "sessions"].sort(),
			);
			expect(readdirSync(offlineRoot).sort()).toEqual([basename(dir), "other"].sort());
			// Only the links were removed: the user's files are as they were.
			expect(readFileSync(join(agentDir, "mcp.json"), "utf8")).toContain("rea");
			expect(existsSync(agentDir)).toBe(true);
		});

		test("a directory that does not exist has nothing to collect", () => {
			expect(collectOfflineAgents(join(tmp(), "none"), [])).toEqual([]);
		});
	});
});

describe("context breakdown", () => {
	const sample = [
		"Context window: 128000 tokens (4% used)",
		"  System prompt    [\u001b[38;2;107;114;128m░\u001b[39m\u001b[1m\u001b[38;2;0;180;255m░░░░░\u001b[22m\u001b[39m░░░░░░░░░░░░░░░░░] 2%  2099 tokens",
		"  System tools     [░░░░░░░░░░░░░░░░░░░░░░░░] 2%  2237 tokens",
		"  System context   [░░░░░░░░░░░░░░░░░░░░░░░░] 0%  114 tokens",
		"  Skills           [░░░░░░░░░░░░░░░░░░░░░░░░] 0%  32 tokens",
		"  Auto-compact buf [████░░░░░░░░░░░░░░░░░░░░] 15%  19200 tokens",
		"  Free             [████████████████████░░░░] 81%  104318 tokens",
	].join("\n");

	test("reads omp's /context table, colors and all", () => {
		expect(parseContext(sample)).toEqual({
			window: 128000,
			// What omp put into the context; not the space left, not the part auto-compaction keeps free.
			startTokens: 2099 + 2237 + 114 + 32,
			items: [
				{ label: "System prompt", tokens: 2099 },
				{ label: "System tools", tokens: 2237 },
				{ label: "System context", tokens: 114 },
				{ label: "Skills", tokens: 32 },
				{ label: "Auto-compact buf", tokens: 19200 },
				{ label: "Free", tokens: 104318 },
			],
		});
	});

	test("any other text is not a breakdown", () => {
		expect(parseContext("")).toBeNull();
		expect(parseContext("Session renamed")).toBeNull();
		expect(parseContext("Context window: 1000 tokens (1% used)")).toBeNull();
	});
});

describe("choosing the model", () => {
	test("the chosen model must be served; none chosen: the first one served", () => {
		expect(chooseModel("omlx", "omlx/a", ["a", "b"])).toBe("omlx/a");
		expect(chooseModel("omlx", null, ["b", "a"])).toBe("omlx/b");
		// oMLX did not say what it serves (a key only omp can resolve): the choice stands.
		expect(chooseModel("omlx", "omlx/a", null)).toBe("omlx/a");
		expect(() => chooseModel("omlx", "omlx/gone", ["a", "b"])).toThrow(/does not serve gone \(it serves: a, b\)/);
		expect(() => chooseModel("omlx", null, [])).toThrow(/serves no models/);
		expect(() => chooseModel("omlx", null, null)).toThrow(/Choose a model in Settings.*oMLX did not list/);
	});

	test("each backend names itself, and its model ids may hold colons and slashes", () => {
		expect(chooseModel("ollama", null, ["qwen3:8b"])).toBe("ollama/qwen3:8b");
		expect(chooseModel("lm-studio", "lm-studio/qwen/qwen3-8b", ["qwen/qwen3-8b"])).toBe("lm-studio/qwen/qwen3-8b");
		expect(() => chooseModel("ollama", "ollama/gone", ["a"])).toThrow(/^Ollama does not serve gone/);
		expect(() => chooseModel("lm-studio", null, [])).toThrow(/^LM Studio serves no models/);
		expect(() => chooseModel("ollama", null, null)).toThrow(/Choose a model in Settings.*Ollama did not list/);
	});
});

describe("settings", () => {
	test("a patch changes the fields it names, and any invalid field refuses all of it", () => {
		expect(mergeOffline(DEFAULT_OFFLINE, { thinking: "low", mcp: ["a", "a", "b"] })).toEqual({
			...DEFAULT_OFFLINE,
			thinking: "low",
			mcp: ["a", "b"],
		});
		expect(mergeOffline(DEFAULT_OFFLINE, { model: "omlx/x:7b" }).model).toBe("omlx/x:7b");
		expect(mergeOffline({ ...DEFAULT_OFFLINE, model: "omlx/x" }, { model: null }).model).toBeNull();
		for (const bad of [
			{ model: "openai/gpt" },
			{ model: "omlx/" },
			{ tools: ["read", "rm"] },
			{ tools: [] },
			{ skills: ["a b"] },
			{ mcp: "rea" },
			{ agentsMd: "yes" },
			{ nope: 1 },
			{ thinking: "off" },
		])
			expect(() => mergeOffline(DEFAULT_OFFLINE, bad)).toThrow(SettingsError);
	});

	test("the backend and the address of each are settings; another backend leaves the old one's model behind", () => {
		const onOmlx = { ...DEFAULT_OFFLINE, model: "omlx/x" };
		expect(mergeOffline(onOmlx, { backend: "ollama" })).toMatchObject({ backend: "ollama", model: null });
		expect(mergeOffline(onOmlx, { backend: "ollama", model: "ollama/qwen3:8b" })).toMatchObject({
			backend: "ollama",
			model: "ollama/qwen3:8b",
		});
		expect(mergeOffline(onOmlx, { backend: "omlx" }).model).toBe("omlx/x");
		// A model is its backend's: another's is refused, and so is a backend this does not know.
		expect(() => mergeOffline(onOmlx, { model: "ollama/qwen3:8b" })).toThrow(/model must be null or omlx\//);
		expect(() => mergeOffline(DEFAULT_OFFLINE, { backend: "ollama", model: "omlx/x" })).toThrow(SettingsError);
		expect(() => mergeOffline(DEFAULT_OFFLINE, { backend: "llama.cpp" })).toThrow(/backend must be one of/);
		// The base patch is not touched by a merge.
		expect(DEFAULT_OFFLINE.backend).toBe("omlx");
	});

	test("an address is http(s) without credentials; a bare host gets /v1, any other path is kept; null clears it", () => {
		const set = (baseUrls: unknown) => mergeOffline(DEFAULT_OFFLINE, { baseUrls }).baseUrls;
		expect(set({ ollama: "http://127.0.0.1:11434" }).ollama).toBe("http://127.0.0.1:11434/v1");
		expect(set({ ollama: " http://10.0.0.5:11434/v1/ " }).ollama).toBe("http://10.0.0.5:11434/v1");
		expect(set({ "lm-studio": "https://lm.example.com/openai" })["lm-studio"]).toBe("https://lm.example.com/openai");
		// Only the named backends change.
		const two = mergeOffline(
			{ ...DEFAULT_OFFLINE, baseUrls: { ...DEFAULT_OFFLINE.baseUrls, omlx: "http://a:1/v1" } },
			{ baseUrls: { ollama: "http://b:2/v1" } },
		);
		expect(two.baseUrls).toEqual({ omlx: "http://a:1/v1", ollama: "http://b:2/v1", "lm-studio": null });
		expect(mergeOffline(two, { baseUrls: { omlx: null } }).baseUrls.omlx).toBeNull();
		for (const bad of [
			"ftp://h/v1",
			"not a url",
			"",
			"http://user:pw@h/v1",
			"http://h/v1?key=secret",
			"http://h/v1#x",
			42,
		])
			expect(() => normalizeBaseUrl("ollama", bad)).toThrow(/must be an address like http/);
		expect(() => set({ ollama: "ftp://h" })).toThrow(SettingsError);
		expect(() => set({ llama: "http://h/v1" })).toThrow(/Unknown backend: llama/);
		expect(() => set("http://h")).toThrow(/baseUrls must be an object/);
	});

	test("a link-local address is refused: cloud metadata services answer there, and a model server never does", () => {
		for (const bad of [
			"http://169.254.169.254",
			"http://169.254.169.254/latest/meta-data",
			"http://169.254.0.7:11434/v1",
			"http://2852039166/v1",
			"http://[fe80::1]:11434/v1",
			"http://[fd00:ec2::254]/v1",
			"http://[::ffff:169.254.169.254]/v1",
			"http://metadata.google.internal/v1",
			"http://100.100.100.200/v1",
		])
			expect(() => normalizeBaseUrl("ollama", bad)).toThrow(/baseUrls\.ollama is a link-local address/);
		expect(() => mergeOffline(DEFAULT_OFFLINE, { baseUrls: { omlx: "http://169.254.169.254/v1" } })).toThrow(
			SettingsError,
		);
		// A public address is allowed (Settings warns about it); so is every address that stays on the network.
		expect(normalizeBaseUrl("ollama", "https://api.example.com")).toBe("https://api.example.com/v1");
		expect(normalizeBaseUrl("ollama", "http://[::1]:11434")).toBe("http://[::1]:11434/v1");
		for (const fine of ["http://127.0.0.1:11434", "http://192.168.1.2:1234", "http://studio.local:8000"])
			expect(normalizeBaseUrl("ollama", fine)).toBe(`${fine}/v1`);
	});

	test("are saved in the data dir (as version 2), survive a restart, and a damaged file means the defaults", () => {
		const dir = tmp();
		const store = new ModeStore(dir);
		expect(store.mode).toBe("full");
		expect(store.lightModels).toBe("yours");
		expect(store.update({ mode: "light", offline: { skills: [] } })).toBe(true);
		// Any change is a change, whoever hears of it; the same again is none.
		expect(store.update({ offline: { agentsMd: true } })).toBe(true);
		expect(store.update({ offline: { agentsMd: true } })).toBe(false);
		expect(store.update({ lightModels: "local" })).toBe(true);
		expect(() => store.update({ mode: "light", offline: { tools: [] } })).toThrow(SettingsError);
		// The modes of version 1 are no values to set.
		expect(() => store.update({ mode: "offline" })).toThrow(/mode must be full or light/);
		expect(() => store.update({ lightModels: "cloud" })).toThrow(/lightModels must be yours or local/);
		const again = new ModeStore(dir);
		expect(again.mode).toBe("light");
		expect(again.lightModels).toBe("local");
		expect(again.offline).toEqual({ ...DEFAULT_OFFLINE, skills: [], agentsMd: true });
		expect(JSON.parse(readFileSync(join(dir, "mode.json"), "utf8"))).toMatchObject({
			version: 2,
			mode: "light",
			lightModels: "local",
		});

		writeFileSync(join(dir, "mode.json"), "{ not json");
		expect(new ModeStore(dir).mode).toBe("full");
		writeFileSync(
			join(dir, "mode.json"),
			JSON.stringify({ version: 2, mode: "light", lightModels: "local", offline: { tools: ["rm"] } }),
		);
		const damaged = new ModeStore(dir);
		expect([damaged.mode, damaged.lightModels]).toEqual(["full", "yours"]);
		expect(damaged.offline).toEqual(DEFAULT_OFFLINE);
	});

	test("a file with no version is Online / Offline's: Offline becomes Light on a local server, Online becomes Full, every setting stays, and it is saved as version 2", () => {
		const settings: OfflineSettings = {
			backend: "ollama",
			baseUrls: { omlx: null, ollama: "http://10.0.0.5:11434/v1", "lm-studio": null },
			model: "ollama/qwen3:8b",
			thinking: "high",
			mcp: ["rea", "alpha"],
			tools: ["read", "bash"],
			skills: ["git-*"],
			agentsMd: true,
		};
		for (const [saved, mode, lightModels] of [
			["offline", "light", "local"],
			["online", "full", "yours"],
		] as const) {
			const dir = tmp();
			writeFileSync(join(dir, "mode.json"), JSON.stringify({ mode: saved, offline: settings }));
			const store = new ModeStore(dir);
			expect([store.mode, store.lightModels]).toEqual([mode, lightModels]);
			expect(store.offline).toEqual(settings);
			// Rewritten at once, so that a version 1 file is read only once.
			expect(JSON.parse(readFileSync(join(dir, "mode.json"), "utf8"))).toEqual({
				version: 2,
				mode,
				lightModels,
				offline: settings,
			});
			const again = new ModeStore(dir);
			expect([again.mode, again.lightModels, again.offline]).toEqual([mode, lightModels, settings]);
		}
		// A version 1 file that is damaged means the defaults, as before.
		const dir = tmp();
		writeFileSync(join(dir, "mode.json"), JSON.stringify({ mode: "offline", offline: { tools: ["rm"] } }));
		const damaged = new ModeStore(dir);
		expect([damaged.mode, damaged.lightModels]).toEqual(["full", "yours"]);
		expect(damaged.offline).toEqual(DEFAULT_OFFLINE);
	});

	test("a file from before the backend choice is an oMLX setup, as it was", () => {
		const dir = tmp();
		writeFileSync(
			join(dir, "mode.json"),
			JSON.stringify({
				mode: "offline",
				offline: {
					model: "omlx/Bonsai-2-27B",
					thinking: "high",
					mcp: ["rea"],
					tools: ["read", "bash"],
					skills: [],
					agentsMd: true,
				},
			}),
		);
		const store = new ModeStore(dir);
		expect([store.mode, store.lightModels]).toEqual(["light", "local"]);
		expect(store.offline).toEqual({
			backend: "omlx",
			baseUrls: { omlx: null, ollama: null, "lm-studio": null },
			model: "omlx/Bonsai-2-27B",
			thinking: "high",
			mcp: ["rea"],
			tools: ["read", "bash"],
			skills: [],
			agentsMd: true,
		});
		// The next save writes the new fields; a restart reads them back.
		store.update({ offline: { backend: "lm-studio", baseUrls: { "lm-studio": "http://192.168.1.5:1234" } } });
		const again = new ModeStore(dir);
		expect(again.offline).toMatchObject({
			backend: "lm-studio",
			model: null,
			baseUrls: { omlx: null, ollama: null, "lm-studio": "http://192.168.1.5:1234/v1" },
		});
	});
});

describe("oMLX", () => {
	let omlx: StubOmlx;
	beforeAll(async () => {
		omlx = await startStubOmlx({ models: ["m1", "m2"] });
	});
	afterAll(() => omlx.stop());

	test("lists its models, and refuses a key it does not know", async () => {
		expect(await queryBackend("omlx", { baseUrl: omlx.url, apiKey: omlx.apiKey })).toEqual(["m1", "m2"]);
		await expect(queryBackend("omlx", { baseUrl: omlx.url, apiKey: "sk-bad" })).rejects.toThrow(
			/refused its API key \(HTTP 401\)/,
		);
		// Only omp can run a `!command` key: nothing to check, and no complaint.
		expect(await queryBackend("omlx", { baseUrl: omlx.url, apiKey: "!echo nope" })).toBeNull();
	});

	test("a key that is not sent to the address is said so, not mistaken for a wrong one", async () => {
		const error = await queryBackend("omlx", { baseUrl: omlx.url, apiKey: null, keyWithheld: true }).catch((e) => e);
		expect(error).toBeInstanceOf(OfflineError);
		expect(error.message).toContain("wants an API key (HTTP 401), and the one in models.yml is not sent there");
		expect(error.message).not.toContain("refused its API key");
		expect(omlx.authorizations.at(-1)).toBeNull();
	});

	test("the address is shown without credentials, query or fragment", () => {
		expect(shown("http://user:pw@127.0.0.1:8000/v1?key=secret#top")).toBe("http://127.0.0.1:8000/v1");
		expect(shown("http://localhost:8000/")).toBe("http://localhost:8000");
		expect(shown("not a url")).toBe("not a url");
	});

	test("not answering is an OfflineError naming the address without its credentials", async () => {
		const error = await queryBackend("omlx", { baseUrl: "http://user:pw@127.0.0.1:1/v1", apiKey: "sk" }).catch(
			(e) => e,
		);
		expect(error).toBeInstanceOf(OfflineError);
		expect(error.message).toBe(
			"oMLX is not reachable at http://127.0.0.1:1/v1 (connection refused). Start the oMLX server, or switch to Full, or to Light with your own models.",
		);
	});

	describe("a launch in each mode", () => {
		function service(saved: string[] | null = null) {
			const root = tmp();
			const cfg: Config = {
				ompBin: "omp",
				agentDir: join(root, "user"),
				sessionsDir: join(root, "user", "sessions"),
				dataDir: join(root, "data"),
				host: "127.0.0.1",
				port: 0,
				distDir: root,
				autoPort: false,
				parentPid: null,
			};
			mkdirSync(cfg.agentDir, { recursive: true });
			mkdirSync(cfg.dataDir, { recursive: true });
			writeFileSync(
				join(cfg.agentDir, "models.yml"),
				`providers:\n  omlx:\n    baseUrl: ${omlx.url}\n    apiKey: ${omlx.apiKey}\n`,
			);
			return { cfg, svc: new Service(cfg, async () => saved) };
		}

		test("Full adds nothing to the process, whatever new conversations start in", async () => {
			const { svc } = service();
			const full: LaunchPlan = { mode: "full", args: [], env: {} };
			expect(await svc.plan({ resume: null, args: [], mode: "full" })).toEqual(full);
			svc.update({ mode: "light", lightModels: "local" });
			expect(await svc.plan({ resume: null, args: [], mode: "full" })).toEqual(full);
		});

		test("a plan is for the mode it is asked for, not the one new conversations start in", async () => {
			const { svc } = service();
			svc.update({ lightModels: "local" });
			expect(svc.mode).toBe("full");
			const plan = await svc.plan({ resume: null, args: [], mode: "light" });
			expect(plan).toMatchObject({ mode: "light", lightModels: "local" });
			expect(plan.args[0]).toBe("--tools");
		});

		test("Light on your own models restricts what is loaded and keeps the user's models, roles and logins; no local server is asked", async () => {
			const { svc, cfg } = service(["anthropic/claude-haiku-5-5"]);
			// The local server in models.yml does not answer: Light on the user's own models never asks it.
			writeFileSync(
				join(cfg.agentDir, "models.yml"),
				"providers:\n  omlx:\n    baseUrl: http://127.0.0.1:1/v1\n    apiKey: sk\n  mine:\n    baseUrl: https://models.example.com/v1\n    apiKey: sk-mine\n",
			);
			writeFileSync(
				join(cfg.agentDir, "config.yml"),
				"modelRoles:\n  default: mine/big\n  smol: mine/small\ndefaultThinkingLevel: high\n",
			);
			writeFileSync(
				join(cfg.agentDir, "mcp.json"),
				JSON.stringify({ mcpServers: { rea: { command: "r" }, other: { command: "o" } } }),
			);
			svc.update({ offline: { tools: ["read", "bash"], mcp: ["rea"] } });
			expect(svc.state().lightModels).toBe("yours");
			// A flag that picks a model is fine, as in Full; a resumed conversation keeps the model it ran on.
			const plan = await svc.plan({
				resume: "/s/x.jsonl",
				args: ["--model", "anthropic/claude-haiku-5-5"],
				mode: "light",
			});
			const dir = plan.env.PI_CODING_AGENT_DIR;
			expect(plan).toEqual({
				mode: "light",
				lightModels: "yours",
				args: ["--tools", "read,bash"],
				env: { PI_CODING_AGENT_DIR: dir },
			});
			const config = Bun.YAML.parse(readFileSync(join(dir, "config.yml"), "utf8")) as Record<string, unknown>;
			expect(config.modelRoles).toEqual({ default: "mine/big", smol: "mine/small" });
			expect(config.defaultThinkingLevel).toBe("high");
			// Their models.yml is the very file (no second copy of their keys), and only the chosen MCP servers are in mcp.json.
			expect(realpathSync(join(dir, "models.yml"))).toBe(realpathSync(join(cfg.agentDir, "models.yml")));
			expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"))).toEqual({
				mcpServers: { rea: { command: "r" } },
			});
			expect(realpathSync(join(dir, "sessions"))).toBe(realpathSync(cfg.sessionsDir));
		});

		test("Light on a local server gives the process its own agent directory and only the allowed tools", async () => {
			const { svc, cfg } = service();
			svc.update({ mode: "light", lightModels: "local", offline: { tools: ["read", "bash"] } });
			const plan = await svc.plan({ resume: null, args: [] });
			const agentDir = plan.env.PI_CODING_AGENT_DIR;
			expect(plan).toEqual({
				mode: "light",
				lightModels: "local",
				args: ["--tools", "read,bash"],
				env: { PI_CODING_AGENT_DIR: agentDir },
			});
			expect(dirname(agentDir)).toBe(join(cfg.dataDir, "offline-agent"));
			expect(realpathSync(join(agentDir, "sessions"))).toBe(realpathSync(cfg.sessionsDir));
		});

		test("the agent directory is what the files a Light process was started with are: the same while they are the same, another when they change, and the first is left as it was", async () => {
			const { svc } = service();
			svc.update({ mode: "light", lightModels: "local" });
			const first = (await svc.plan({ resume: null, args: [] })).env;
			expect((await svc.plan({ resume: null, args: [] })).env).toEqual(first);
			const config = (dir: string) => readFileSync(join(dir, "config.yml"), "utf8");
			const before = config(first.PI_CODING_AGENT_DIR);
			// Not the arguments, not the model: what the Light files say.
			svc.update({ offline: { thinking: "high" } });
			const other = (await svc.plan({ resume: null, args: [] })).env;
			expect(other.PI_CODING_AGENT_DIR).not.toBe(first.PI_CODING_AGENT_DIR);
			expect(config(first.PI_CODING_AGENT_DIR)).toBe(before);
			expect(config(other.PI_CODING_AGENT_DIR)).toContain("defaultThinkingLevel: high");
		});

		test("the directories no process uses are collected, and those of the running ones are not", async () => {
			const { svc, cfg } = service();
			svc.update({ mode: "light", lightModels: "local" });
			const first = (await svc.plan({ resume: null, args: [] })).env.PI_CODING_AGENT_DIR;
			svc.update({ offline: { thinking: "high" } });
			const second = (await svc.plan({ resume: null, args: [] })).env.PI_CODING_AGENT_DIR;
			const later = Date.now() + COLLECT_GRACE_MS + 60_000;
			expect(svc.collect([first], later)).toEqual([basename(second)]);
			expect(readdirSync(join(cfg.dataDir, "offline-agent"))).toEqual([basename(first)]);
			// The directory of a configuration that is planned again is made again.
			const again = (await svc.plan({ resume: null, args: [] })).env.PI_CODING_AGENT_DIR;
			expect(again).toBe(second);
			expect(existsSync(join(again, "config.yml"))).toBe(true);
		});

		test("every change of the mode, of Light's models or of the Light settings is announced with the whole state; one that changes nothing is not", () => {
			const { svc } = service();
			const heard: ModeState[] = [];
			svc.onChange((state) => heard.push(state));
			svc.update({ mode: "light", lightModels: "local" });
			svc.update({ offline: { mcp: ["alpha"], tools: ["read"] } });
			svc.update({ offline: { tools: ["read"] } });
			svc.update({ mode: "light", lightModels: "local" });
			svc.update({ offline: { thinking: "low" } });
			expect(heard.map((s) => [s.mode, s.offline.mcp, s.offline.tools, s.offline.thinking])).toEqual([
				["light", ["rea"], expect.any(Array), "medium"],
				["light", ["alpha"], ["read"], "medium"],
				["light", ["alpha"], ["read"], "low"],
			]);
			// What a tab applies is the state a request for it answers, but for its number: a later statement of the same.
			const last = heard.at(-1) as ModeState;
			expect(last).toEqual({ ...svc.state(), rev: last.rev });
		});

		test("the files changing and changing back don't disturb a process started before: each set of files has its own directory", async () => {
			const { svc } = service();
			svc.update({ mode: "light", lightModels: "local" });
			const dir = async () => (await svc.plan({ resume: null, args: [] })).env.PI_CODING_AGENT_DIR;
			const first = await dir();
			const firstConfig = readFileSync(join(first, "config.yml"), "utf8");
			svc.update({ offline: { thinking: "high" } });
			const changed = await dir();
			expect(changed).not.toBe(first);
			svc.update({ offline: { thinking: "medium" } });
			// Back to the first files: the first directory, never rewritten in between (omp follows its files live).
			expect(await dir()).toBe(first);
			expect(readFileSync(join(first, "config.yml"), "utf8")).toBe(firstConfig);
		});

		test("a conversation that used any other provider's model resumes on the oMLX model, unless the caller chose one", async () => {
			const resume = (saved: string[] | null, args: string[] = []) => {
				const { svc } = service(saved);
				svc.update({ mode: "light", lightModels: "local" });
				return svc.plan({ resume: "/s/x.jsonl", args });
			};
			expect((await resume(["anthropic/claude-haiku-5-5"])).args).toEqual([
				"--tools",
				"read,bash,edit,write,grep,glob,todo",
				"--model",
				"omlx/m1",
			]);
			expect((await resume(["omlx/m2", "openai/gpt-5"])).args.slice(-2)).toEqual(["--model", "omlx/m1"]);
			expect((await resume(["omlx/m2"])).args).not.toContain("--model");
			expect((await resume(null)).args).not.toContain("--model");
			expect((await resume(["anthropic/x"], ["--resume", "/s/x.jsonl", "--model", "omlx/m2"])).args).not.toContain(
				"--model",
			);
		});

		test("Light on a local server cannot start while oMLX does not answer, and nothing is written for it", async () => {
			const { svc, cfg } = service();
			writeFileSync(
				join(cfg.agentDir, "models.yml"),
				"providers:\n  omlx:\n    baseUrl: http://127.0.0.1:1/v1\n    apiKey: sk\n",
			);
			svc.update({ mode: "light", lightModels: "local" });
			await expect(svc.plan({ resume: null, args: [] })).rejects.toThrow(/oMLX is not reachable/);
			expect(existsSync(join(cfg.dataDir, "offline-agent"))).toBe(false);
		});

		test("Settings is told the address without credentials", () => {
			const { svc, cfg } = service();
			writeFileSync(
				join(cfg.agentDir, "models.yml"),
				"providers:\n  omlx:\n    baseUrl: http://me:pw@127.0.0.1:8000/v1?token=abc\n    apiKey: sk\n",
			);
			expect(svc.state().backends.omlx).toEqual({ baseUrl: "http://127.0.0.1:8000/v1", source: "models.yml" });
		});

		test("a local server cannot be Light's models without an oMLX provider, and is not chosen; Light on your own models needs none", () => {
			const { svc, cfg } = service();
			writeFileSync(join(cfg.agentDir, "models.yml"), "providers: {}\n");
			expect(() => svc.update({ mode: "light", lightModels: "local" })).toThrow(/provider named "omlx"/);
			expect(svc.state()).toMatchObject({ mode: "full", lightModels: "yours" });
			svc.update({ mode: "light" });
			expect(svc.state()).toMatchObject({ mode: "light", lightModels: "yours" });
			expect(svc.state().backends.omlx).toEqual({ baseUrl: null, source: null });
		});

		test("a model-selecting flag must name an oMLX model on a local server: anything else would run a cloud model", async () => {
			const { svc } = service();
			svc.update({ mode: "light", lightModels: "local" });
			for (const args of [
				["--model", "anthropic/claude-haiku-5-5"],
				["--model=anthropic/x"],
				["--smol=openai/gpt-5"],
				["--slow", "opus"],
				["--plan=anthropic/x"],
				["--models=omlx/m1,anthropic/x"],
				["--provider=anthropic"],
				["--plan-yolo-into=x/y"],
				["--prewalk-into", "x/y"],
			]) {
				await expect(svc.plan({ resume: null, args })).rejects.toThrow(/oMLX models only/);
			}
			const ok = await svc.plan({
				resume: null,
				args: ["--model=omlx/m2", "--smol", "omlx/m1", "--models=omlx/*", "--provider", "omlx", "--thinking=low"],
			});
			expect(ok.mode).toBe("light");
			// Full has no such rule, and neither has Light on the user's own models.
			const other = service().svc;
			expect(await other.plan({ resume: null, args: ["--model", "anthropic/x"], mode: "full" })).toEqual({
				mode: "full",
				args: [],
				env: {},
			});
			expect(await other.plan({ resume: null, args: ["--model", "anthropic/x"], mode: "light" })).toMatchObject({
				mode: "light",
				lightModels: "yours",
			});
		});

		test("a selected MCP server that mcp.json no longer has is named, and the process starts without it", async () => {
			const { svc, cfg } = service();
			writeFileSync(join(cfg.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { alpha: { command: "a" } } }));
			svc.update({ offline: { mcp: ["rea", "alpha"] } });
			expect(svc.state().mcpServers).toEqual(["alpha"]);
			expect(svc.state().missingMcp).toEqual(["rea"]);
			svc.update({ mode: "light", lightModels: "local" });
			await svc.plan({ resume: null, args: [] });
			const offlineMcpFile = join(newestOfflineAgent(join(cfg.dataDir, "offline-agent")), "mcp.json");
			expect(JSON.parse(readFileSync(offlineMcpFile, "utf8"))).toEqual({
				mcpServers: { alpha: { command: "a" } },
			});
			svc.update({ offline: { mcp: ["alpha"] } });
			expect(svc.state().missingMcp).toEqual([]);
		});

		test("a server omp has switched off (enabled: false) is named: Light loads none of those, selected or not", () => {
			const { svc, cfg } = service();
			writeFileSync(
				join(cfg.agentDir, "mcp.json"),
				JSON.stringify({
					mcpServers: {
						alpha: { command: "a" },
						beta: { command: "b", enabled: false },
						gamma: { command: "c", enabled: true },
					},
				}),
			);
			svc.update({ offline: { mcp: ["alpha", "beta"] } });
			expect(svc.state().mcpServers).toEqual(["alpha", "beta", "gamma"]);
			expect(svc.state().mcpOff).toEqual(["beta"]);
		});
	});
});

describe("Ollama and LM Studio", () => {
	let engine: StubOmlx;
	const served = ["qwen3:8b", "qwen/qwen3-8b"];
	beforeAll(async () => {
		engine = await startStubOmlx({ models: served, apiKey: null, ollama: true });
	});
	afterAll(() => engine.stop());

	/** A service whose user has no models.yml (or the one given): neither engine needs an entry. */
	function service(modelsYaml?: string, saved: string[] | null = null) {
		const root = tmp();
		const cfg: Config = {
			ompBin: "omp",
			agentDir: join(root, "user"),
			sessionsDir: join(root, "user", "sessions"),
			dataDir: join(root, "data"),
			host: "127.0.0.1",
			port: 0,
			distDir: root,
			autoPort: false,
			parentPid: null,
		};
		mkdirSync(cfg.agentDir, { recursive: true });
		mkdirSync(cfg.dataDir, { recursive: true });
		if (modelsYaml !== undefined) writeFileSync(join(cfg.agentDir, "models.yml"), modelsYaml);
		return { cfg, svc: new Service(cfg, async () => saved) };
	}
	const offlineFile = (cfg: Config, name: string) =>
		readFileSync(join(newestOfflineAgent(join(cfg.dataDir, "offline-agent")), name), "utf8");
	type OfflineConfig = { modelRoles: Record<string, string>; enabledModels: string[]; disabledProviders: string[] };

	test("both list their models in OpenAI's format; Ollama also answers with its own list", async () => {
		expect(await queryBackend("ollama", { baseUrl: engine.url, apiKey: null })).toEqual(served);
		expect(await queryBackend("lm-studio", { baseUrl: engine.url, apiKey: null })).toEqual(served);
		// An address without /v1 has no /models; Ollama's own list is at its root.
		const root = engine.url.replace(/\/v1$/, "");
		expect(await queryBackend("ollama", { baseUrl: root, apiKey: null })).toEqual(served);
		expect(engine.requests).toContain("GET /api/tags");
		expect(await queryBackend("lm-studio", { baseUrl: root, apiKey: null })).toBeNull();
		const down = await queryBackend("lm-studio", { baseUrl: "http://127.0.0.1:1/v1", apiKey: null }).catch((e) => e);
		expect(down).toBeInstanceOf(OfflineError);
		expect(down.message).toBe(
			"LM Studio is not reachable at http://127.0.0.1:1/v1 (connection refused). Start the LM Studio server, or switch to Full, or to Light with your own models.",
		);
	});

	test("Light on Ollama needs no models.yml: the process gets Ollama's provider, its first model, and no other engine", async () => {
		const { svc, cfg } = service();
		svc.update({
			mode: "light",
			lightModels: "local",
			offline: { backend: "ollama", baseUrls: { ollama: engine.url } },
		});
		const plan = await svc.plan({ resume: null, args: [] });
		expect(plan.args[0]).toBe("--tools");
		expect(Bun.YAML.parse(offlineFile(cfg, "models.yml"))).toEqual({
			providers: {
				ollama: {
					baseUrl: engine.url,
					api: "openai-responses",
					discovery: { type: "ollama", timeoutMs: 3000 },
					auth: "none",
				},
			},
		});
		const config = Bun.YAML.parse(offlineFile(cfg, "config.yml")) as OfflineConfig;
		expect(config.modelRoles.default).toBe("ollama/qwen3:8b");
		expect(config.enabledModels).toEqual(["ollama/**"]);
		expect(config.disabledProviders).not.toContain("ollama");
		expect(config.disabledProviders).toContain("lm-studio");
		// The user's own files are not made for it.
		expect(existsSync(join(cfg.agentDir, "models.yml"))).toBe(false);
	});

	test("Light on LM Studio runs the chosen model, whose id has a slash, and refuses one it does not serve", async () => {
		const { svc, cfg } = service();
		svc.update({
			mode: "light",
			lightModels: "local",
			offline: { backend: "lm-studio", baseUrls: { "lm-studio": engine.url }, model: "lm-studio/qwen/qwen3-8b" },
		});
		await svc.plan({ resume: null, args: [] });
		const config = Bun.YAML.parse(offlineFile(cfg, "config.yml")) as OfflineConfig;
		expect(config.modelRoles.advisor).toBe("lm-studio/qwen/qwen3-8b");
		expect(config.enabledModels).toEqual(["lm-studio/**"]);
		expect(config.disabledProviders).toContain("ollama");
		expect(config.disabledProviders).not.toContain("lm-studio");
		expect(Bun.YAML.parse(offlineFile(cfg, "models.yml"))).toEqual({
			providers: {
				"lm-studio": {
					baseUrl: engine.url,
					api: "openai-completions",
					discovery: { type: "lm-studio", timeoutMs: 3000 },
					auth: "none",
				},
			},
		});
		svc.update({ offline: { model: "lm-studio/gone" } });
		await expect(svc.plan({ resume: null, args: [] })).rejects.toThrow(/^LM Studio does not serve gone/);
	});

	test("an engine that does not answer is named with its address, and nothing is written for it", async () => {
		const { svc, cfg } = service();
		svc.update({
			mode: "light",
			lightModels: "local",
			offline: { backend: "ollama", baseUrls: { ollama: "http://127.0.0.1:1" } },
		});
		await expect(svc.plan({ resume: null, args: [] })).rejects.toThrow(
			/^Ollama is not reachable at http:\/\/127\.0\.0\.1:1\/v1 \(connection refused\)\. Start the Ollama server/,
		);
		expect(existsSync(join(cfg.dataDir, "offline-agent"))).toBe(false);
	});

	test("Settings is told each backend's address without credentials, and where it comes from", () => {
		const { svc } = service("providers:\n  ollama:\n    baseUrl: http://me:pw@10.0.0.5:11434/v1?k=1\n");
		expect(svc.state().backends).toEqual({
			omlx: { baseUrl: null, source: null },
			ollama: { baseUrl: "http://10.0.0.5:11434/v1", source: "models.yml" },
			"lm-studio": { baseUrl: "http://127.0.0.1:1234/v1", source: "default" },
		});
		svc.update({
			offline: { baseUrls: { ollama: "http://192.168.1.2:11434", "lm-studio": "http://192.168.1.3:1234/v1" } },
		});
		expect(svc.state().backends).toEqual({
			omlx: { baseUrl: null, source: null },
			ollama: { baseUrl: "http://192.168.1.2:11434/v1", source: "settings" },
			"lm-studio": { baseUrl: "http://192.168.1.3:1234/v1", source: "settings" },
		});
	});

	test("a local server cannot be Light's models on oMLX without its provider, but can on Ollama; nor can oMLX be switched to without it", () => {
		const { svc } = service();
		expect(() => svc.update({ mode: "light", lightModels: "local" })).toThrow(/provider named "omlx"/);
		expect(svc.mode).toBe("full");
		svc.update({ mode: "light", lightModels: "local", offline: { backend: "ollama" } });
		expect(svc.mode).toBe("light");
		expect(() => svc.update({ offline: { backend: "omlx" } })).toThrow(/provider named "omlx"/);
		expect(svc.state().offline.backend).toBe("ollama");
	});

	test("a model-selecting flag must name the chosen backend's model: another's would run elsewhere", async () => {
		const { svc } = service();
		svc.update({
			mode: "light",
			lightModels: "local",
			offline: { backend: "ollama", baseUrls: { ollama: engine.url } },
		});
		for (const args of [
			["--model", "omlx/m1"],
			["--model=anthropic/x"],
			["--provider", "omlx"],
			["--models=ollama/qwen3:8b,lm-studio/x"],
			["--smol=lm-studio/x"],
		])
			await expect(svc.plan({ resume: null, args })).rejects.toThrow(/Ollama models only/);
		const ok = await svc.plan({
			resume: null,
			args: ["--model=ollama/qwen3:8b", "--provider", "ollama", "--models=ollama/*"],
		});
		expect(ok.mode).toBe("light");
	});

	test("a conversation that used another provider's model resumes on the engine's model", async () => {
		for (const used of [["omlx/m1"], ["anthropic/claude-haiku-5-5"], ["ollama/qwen3:8b", "lm-studio/x"]]) {
			const { svc } = service(undefined, used);
			svc.update({
				mode: "light",
				lightModels: "local",
				offline: { backend: "ollama", baseUrls: { ollama: engine.url } },
			});
			expect((await svc.plan({ resume: "/s/x.jsonl", args: [] })).args.slice(-2)).toEqual([
				"--model",
				"ollama/qwen3:8b",
			]);
		}
		const { svc } = service(undefined, ["ollama/qwen3:8b"]);
		svc.update({
			mode: "light",
			lightModels: "local",
			offline: { backend: "ollama", baseUrls: { ollama: engine.url } },
		});
		expect((await svc.plan({ resume: "/s/x.jsonl", args: [] })).args).not.toContain("--model");
	});

	test("any backend's models can be asked for; the selected one's are what the resume dialog lists", async () => {
		const { svc } = service();
		svc.update({ offline: { baseUrls: { ollama: engine.url } } });
		expect(await svc.backendModels("ollama")).toEqual({ backend: "ollama", baseUrl: engine.url, models: served });
		svc.update({ mode: "light", lightModels: "local", offline: { backend: "ollama" } });
		expect(await svc.modelInfos()).toEqual(served.map((id) => ({ provider: "ollama", id, name: id })));
	});
});

describe("what a context measurement depends on", () => {
	/** An oMLX whose model list the test changes. */
	let served: string[] = ["m1"];
	let omlx: Bun.Server<undefined>;
	beforeAll(() => {
		omlx = Bun.serve({
			port: 0,
			fetch: () => Response.json({ data: served.map((id) => ({ id })) }),
		});
	});
	afterAll(() => omlx.stop(true));

	function service(measurer?: typeof measureContext) {
		const root = tmp();
		const cfg: Config = {
			ompBin: join(root, "no-such-omp"),
			agentDir: join(root, "user"),
			sessionsDir: join(root, "user", "sessions"),
			dataDir: join(root, "data"),
			host: "127.0.0.1",
			port: 0,
			distDir: root,
			autoPort: false,
			parentPid: null,
		};
		mkdirSync(cfg.agentDir, { recursive: true });
		mkdirSync(cfg.dataDir, { recursive: true });
		served = ["m1"];
		const models = (contextWindow: number) =>
			writeFileSync(
				join(cfg.agentDir, "models.yml"),
				`providers:\n  omlx:\n    baseUrl: http://127.0.0.1:${omlx.port}/v1\n    apiKey: sk\n    models:\n      - id: m1\n        contextWindow: ${contextWindow}\n`,
			);
		models(32000);
		const measured = { full: 0, light: 0 };
		const svc = new Service(
			cfg,
			async () => null,
			measurer ??
				(async (o) => {
					measured[o.args.includes("--tools") ? "light" : "full"]++;
					return { window: 1, startTokens: 1, items: [], incomplete: false };
				}),
		);
		// Light on a local server, whose model and address a measurement depends on (Light on the user's own models is its own test).
		svc.update({ lightModels: "local" });
		/** Both sides measured: how many of each were measured by this call. */
		const run = async () => {
			const before = { ...measured };
			await svc.context();
			return { full: measured.full - before.full, light: measured.light - before.light };
		};
		return { cfg, svc, models, run };
	}

	test("is kept while nothing changed, and not asked for again", async () => {
		const { run } = service();
		expect(await run()).toEqual({ full: 1, light: 1 });
		expect(await run()).toEqual({ full: 0, light: 0 });
	});

	test("both sides are measured again once omp was installed or updated, and not before (#313)", async () => {
		const { run, cfg } = service();
		// omp is missing at first (its version is unknown, and that is not remembered).
		expect(await run()).toEqual({ full: 1, light: 1 });
		expect(await run()).toEqual({ full: 0, light: 0 });
		const bin = join(cfg.dataDir, "omp");
		const install = (version: string) => {
			writeFileSync(bin, `#!/bin/sh\necho "omp/${version}"\n`);
			chmodSync(bin, 0o755);
		};
		install("18.12.2");
		cfg.ompBin = bin;
		// The install: omp is found, and its version is part of what a measurement depends on.
		expect(await run()).toEqual({ full: 1, light: 1 });
		expect(await run()).toEqual({ full: 0, light: 0 });
		// The update replaces the program, the server keeps running: the numbers are the new omp's to measure.
		install("18.13.0-beta.1");
		expect(await run()).toEqual({ full: 1, light: 1 });
		expect(await run()).toEqual({ full: 0, light: 0 });
	});

	test("Light is measured again when its models.yml entry (the context window) changes", async () => {
		const { run, models } = service();
		await run();
		models(64000);
		expect((await run()).light).toBe(1);
	});

	test("Light on a local server is measured again when the model it will use changes: the first one oMLX serves, when none is chosen", async () => {
		const { run, svc } = service();
		await run();
		served = ["m2", "m1"];
		expect(await run()).toEqual({ full: 0, light: 1 });
		// A chosen model is the model, whatever oMLX lists first.
		svc.update({ offline: { model: "omlx/m1" } });
		expect((await run()).light).toBe(1);
		served = ["m3", "m1"];
		expect((await run()).light).toBe(0);
	});

	test("Light on a local server is measured again when the backend or its address changes: it is another server's model", async () => {
		const { run, svc } = service();
		await run();
		// The same stub answers as LM Studio: nothing but the backend differs.
		svc.update({ offline: { backend: "lm-studio", baseUrls: { "lm-studio": `http://127.0.0.1:${omlx.port}/v1` } } });
		expect(await run()).toEqual({ full: 0, light: 1 });
		svc.update({ offline: { baseUrls: { "lm-studio": `http://localhost:${omlx.port}/v1` } } });
		expect(await run()).toEqual({ full: 0, light: 1 });
	});

	test("a skill added or changed is measured again by both sides; Light only when it loads skills", async () => {
		const { run, svc, cfg } = service();
		await run();
		const skill = join(cfg.agentDir, "skills", "git-flow", "SKILL.md");
		mkdirSync(join(cfg.agentDir, "skills", "git-flow"), { recursive: true });
		writeFileSync(skill, "---\nname: git-flow\n---\none");
		expect(await run()).toEqual({ full: 1, light: 1 });
		writeFileSync(skill, "---\nname: git-flow\n---\nlonger text");
		expect(await run()).toEqual({ full: 1, light: 1 });
		// Light without skills does not read the folder at all.
		svc.update({ offline: { skills: [] } });
		await run();
		writeFileSync(skill, "---\nname: git-flow\n---\nlonger text still");
		expect(await run()).toEqual({ full: 1, light: 0 });
	});

	test("the user's AGENTS.md is measured again in Full; Light only when it loads it", async () => {
		const { run, svc, cfg } = service();
		await run();
		writeFileSync(join(cfg.agentDir, "AGENTS.md"), "rules");
		expect(await run()).toEqual({ full: 1, light: 0 });
		svc.update({ offline: { agentsMd: true } });
		await run();
		writeFileSync(join(cfg.agentDir, "AGENTS.md"), "more rules");
		expect((await run()).light).toBe(1);
	});

	test("Light on the user's own models asks no local server, and is measured again when their config.yml or models.yml changes", async () => {
		const { run, svc, cfg, models } = service();
		svc.update({ lightModels: "yours" });
		await run();
		expect(await run()).toEqual({ full: 0, light: 0 });
		// The local server's models are not its models.
		served = ["m2", "m1"];
		expect((await run()).light).toBe(0);
		writeFileSync(join(cfg.agentDir, "config.yml"), "defaultThinkingLevel: low\n");
		expect((await run()).light).toBe(1);
		expect((await run()).light).toBe(0);
		models(64000);
		expect((await run()).light).toBe(1);
		// Choosing the other kind of models is another measurement.
		svc.update({ lightModels: "local" });
		expect((await run()).light).toBe(1);
	});

	describe("one at a time, and only the newest", () => {
		type Run = { side: Mode; stopped: Promise<void>; release: () => void };
		/** A measurer whose runs the test releases by hand, and that notes how many are running at once. */
		function gated() {
			const waiting: ((run: Run) => void)[] = [];
			const started: Run[] = [];
			let count = 0;
			let active = 0;
			let peak = 0;
			const measurer: typeof measureContext = (o) => {
				active++;
				peak = Math.max(peak, active);
				const id = count++;
				return new Promise<ContextBreakdown>((resolve, reject) => {
					const stopped = new Promise<void>((done) =>
						o.signal?.addEventListener("abort", () => {
							reject(new Error("stopped"));
							done();
						}),
					);
					const run: Run = {
						side: o.args.includes("--tools") ? "light" : "full",
						stopped,
						release: () => resolve({ window: 1, startTokens: id, items: [], incomplete: false }),
					};
					const waiter = waiting.shift();
					if (waiter) waiter(run);
					else started.push(run);
				}).finally(() => active--);
			};
			/** The next run to start (or one that started before it was asked for). */
			const next = (): Promise<Run> => {
				const run = started.shift();
				return run ? Promise.resolve(run) : new Promise<Run>((resolve) => waiting.push(resolve));
			};
			return { measurer, next, peak: () => peak, runs: () => count };
		}

		test("a measurement that runs is stopped when the settings change, and the next one starts after it has stopped", async () => {
			const { measurer, next, peak, runs } = gated();
			const { svc } = service(measurer);
			const first = svc.context();
			const full = await next();
			expect(full.side).toBe("full");
			full.release();
			const light = await next();
			expect(light.side).toBe("light");
			svc.update({ offline: { thinking: "high" } });
			const second = svc.context();
			await light.stopped;
			const replacement = await next();
			expect(replacement.side).toBe("light");
			expect(peak()).toBe(1);
			replacement.release();
			const [a, b] = await Promise.all([first, second]);
			// Both askers have the newest measurement, and the stopped one was not kept as one.
			expect(a.light).toEqual(b.light);
			expect(b.light).toMatchObject({ ok: true, breakdown: { startTokens: 2 } });
			expect(runs()).toBe(3);
			await svc.context();
			expect(runs()).toBe(3);
		});

		test("the same thing asked for twice is measured once", async () => {
			const { measurer, next, runs } = gated();
			const { svc } = service(measurer);
			const asked = [svc.context(), svc.context()];
			(await next()).release();
			(await next()).release();
			const [a, b] = await Promise.all(asked);
			expect(runs()).toBe(2);
			expect(a).toEqual(b);
		});
	});
});
