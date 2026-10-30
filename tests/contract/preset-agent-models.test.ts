import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelConfig } from "../../shared/model-config.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * A preset carries the subagent models: omp's `task.agentModelOverrides` (agent name → model selector) next to the roles.
 * omp keeps an entry's other keys untouched and never applies them, so the preset's own entry holds them
 * (`modelPresets.<name>.agentModelOverrides`) and this API applies them where omp's `/modelpreset switch` does not. Over HTTP
 * against an isolated omp config (the test server's own HOME and agent dir, never `~/.omp`), with omp's CLI as the
 * reference for what was written. No model is called.
 */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer();
}, 60_000);
afterAll(async () => {
	await s?.stop();
});

const SONNET = "anthropic/claude-sonnet-5-5";
const HAIKU = "anthropic/claude-haiku-5-5";
const ROLES = { default: `${SONNET}:high`, smol: HAIKU };
const AGENTS = { reviewer: `${HAIKU}:low`, scout: HAIKU };

type Reply = ModelConfig & { error?: string };

async function call(path: string, body?: unknown) {
	const res = await fetch(`${s.url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			"x-omp-webui-token": s.accessToken,
			"x-omp-webui": "1",
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const json: Reply = await res.json();
	return { status: res.status, body: json };
}

const get = (cwd?: string) => call(`/api/model-config${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`);
const post = (action: string, body: unknown) => call(`/api/model-config/${action}`, body);

/** The environment of an omp process that reads the test server's isolated config. */
const ompEnv = () => ({ ...process.env, HOME: s.home, PI_CODING_AGENT_DIR: s.agentDir });

/** What omp itself reads from the isolated config (the reference for what the API wrote). */
function stored<T = unknown>(key: string): T {
	const r = Bun.spawnSync(["omp", "config", "get", key, "--json"], { env: ompEnv(), cwd: s.work });
	if (r.exitCode !== 0) throw new Error(r.stderr.toString());
	const parsed: { value: T } = JSON.parse(r.stdout.toString());
	return parsed.value;
}

function setStored(key: string, value: unknown): void {
	const r = Bun.spawnSync(["omp", "config", "set", key, JSON.stringify(value)], { env: ompEnv(), cwd: s.work });
	if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

const storedPresets = () => stored<Record<string, Record<string, unknown>>>("modelPresets");

/** omp starts and lists its whole configuration: nothing in it (the presets with their extra key) is something it refuses. */
function ompStillReads(): void {
	const r = Bun.spawnSync(["omp", "config", "list", "--json"], { env: ompEnv(), cwd: s.work });
	expect(r.exitCode).toBe(0);
	expect(r.stderr.toString()).not.toMatch(/invalid|malformed|error/i);
}

/** The configuration every test starts from: the roles above, `agents` as the subagent models, and no presets. */
function reset(agents: Record<string, string> = AGENTS): void {
	setStored("modelPresets", {});
	setStored("modelRoles", ROLES);
	setStored("defaultThinkingLevel", "high");
	setStored("task.agentModelOverrides", agents);
}

test("saving the current configuration keeps its subagent models in the preset's own entry, where omp leaves them be", async () => {
	reset();
	const saved = await post("preset/save", { name: "withagents" });
	expect(saved.status).toBe(200);
	expect(storedPresets()).toEqual({
		withagents: { modelRoles: ROLES, defaultThinkingLevel: "high", agentModelOverrides: AGENTS },
	});
	const preset = saved.body.presets.find((p) => p.name === "withagents");
	expect(preset?.agentModelOverrides).toEqual(AGENTS);
	// The configuration reports its own subagent models too, and the preset is the active one while they match.
	expect(saved.body.agentModelOverrides).toEqual(AGENTS);
	expect(saved.body.active).toBe("withagents");
	ompStillReads();
	// The configuration itself was only read.
	expect(stored("task.agentModelOverrides")).toEqual(AGENTS);

	// With no subagent models set, the entry has no key for them at all: that is "leave them alone", not "none".
	reset({});
	await post("preset/save", { name: "plain" });
	expect(storedPresets()).toEqual({ plain: { modelRoles: ROLES, defaultThinkingLevel: "high" } });
}, 120_000);

test("the active preset follows the roles and thinking level only, as omp's: of twins that differ in subagent models it is the first by name", async () => {
	reset();
	setStored("modelPresets", {
		review: { modelRoles: ROLES, defaultThinkingLevel: "high", agentModelOverrides: { reviewer: SONNET } },
		plain: { modelRoles: ROLES, defaultThinkingLevel: "high" },
	});
	// The subagents run on whatever: the first of the matching presets by name is the active one, as on main.
	expect((await get()).body.active).toBe("plain");
	setStored("task.agentModelOverrides", { reviewer: SONNET });
	expect((await get()).body.active).toBe("plain");
	setStored("task.agentModelOverrides", { scout: SONNET });
	expect((await get()).body.active).toBe("plain");

	// Applying `plain` leaves the subagent models; the badge is on `plain`. Applying `review` replaces them; `plain` is
	// still the first match by name (the two cannot be told apart by the roles, which is all omp's own rule looks at).
	const plain = await post("preset/apply", { name: "plain" });
	expect(plain.body.active).toBe("plain");
	expect(stored("task.agentModelOverrides")).toEqual({ scout: SONNET });
	const review = await post("preset/apply", { name: "review" });
	expect(review.status).toBe(200);
	expect(stored("task.agentModelOverrides")).toEqual({ reviewer: SONNET });
	expect(review.body.active).toBe("plain");
}, 120_000);

test("explicit saves: the subagent models given are stored; none given are the configuration's; an empty object stores none", async () => {
	reset();
	const given = { sonic: `${HAIKU}:off`, task: SONNET };
	expect((await post("preset/save", { name: "given", roles: ROLES, agentModelOverrides: given })).status).toBe(200);
	expect(storedPresets().given).toEqual({ modelRoles: ROLES, agentModelOverrides: given });

	// Roles alone: the subagent models are whatever the configuration has now, as with the roles of a save without any.
	expect((await post("preset/save", { name: "current", roles: ROLES })).status).toBe(200);
	expect(storedPresets().current).toEqual({ modelRoles: ROLES, agentModelOverrides: AGENTS });

	// `{}` is "no subagent models" even where the configuration has some.
	expect((await post("preset/save", { name: "empty", roles: ROLES, agentModelOverrides: {} })).status).toBe(200);
	expect(storedPresets().empty).toEqual({ modelRoles: ROLES });

	// Replacing a preset replaces its subagent models with the new ones.
	const replaced = await post("preset/save", { name: "given", roles: ROLES, agentModelOverrides: {}, overwrite: true });
	expect(replaced.status).toBe(200);
	expect(storedPresets().given).toEqual({ modelRoles: ROLES });
}, 120_000);

test("bad subagent models are refused before anything is written", async () => {
	reset();
	const before = JSON.stringify(storedPresets());
	const bad: [unknown, RegExp][] = [
		["x", /subagent models/i],
		[[], /subagent models/i],
		[{ "": HAIKU }, /agent name/i],
		[{ reviewer: "" }, /needs a model selector/i],
		[{ reviewer: 5 }, /needs a model selector/i],
		[{ reviewer: "a/b\nc/d" }, /invalid model selector/i],
		[{ reviewer: "y".repeat(600) }, /too long/i],
	];
	for (const [agentModelOverrides, message] of bad) {
		const r = await post("preset/save", { name: "nope", roles: ROLES, agentModelOverrides });
		expect(r.status).toBe(400);
		expect(r.body.error).toMatch(message);
		const edited = await post("preset/agents", { name: "nope", agentModelOverrides });
		expect(edited.status).toBe(400);
		const roles = await post("roles", { roles: ROLES, agentModelOverrides });
		expect(roles.status).toBe(400);
	}
	expect(JSON.stringify(storedPresets())).toBe(before);
	expect(stored("task.agentModelOverrides")).toEqual(AGENTS);
}, 180_000);

test("applying a preset with subagent models replaces the configuration's with exactly those; one with none leaves them", async () => {
	reset({ scout: HAIKU, sonic: `${HAIKU}:low` });
	const mine = { reviewer: `${SONNET}:medium` };
	setStored("modelPresets", {
		reviewing: { modelRoles: ROLES, defaultThinkingLevel: "high", agentModelOverrides: mine },
		plain: { modelRoles: { default: `${HAIKU}:low` } },
	});

	const applied = await post("preset/apply", { name: "reviewing" });
	expect(applied.status).toBe(200);
	// Replaced, not merged: scout and sonic are gone, as a preset's roles replace the roles.
	expect(stored("task.agentModelOverrides")).toEqual(mine);
	expect(applied.body.agentModelOverrides).toEqual(mine);
	expect(stored("modelRoles")).toEqual(ROLES);
	expect(applied.body.active).toBe("reviewing");

	// A preset that sets none applies its roles and leaves the subagent models as they were.
	setStored("task.agentModelOverrides", { scout: HAIKU });
	const plain = await post("preset/apply", { name: "plain" });
	expect(plain.status).toBe(200);
	expect(stored("modelRoles")).toEqual({ default: `${HAIKU}:low` });
	expect(stored("task.agentModelOverrides")).toEqual({ scout: HAIKU });
	ompStillReads();
}, 180_000);

test("a preset omp could not apply changes no subagent model either", async () => {
	reset();
	setStored("modelPresets", {
		offline: {
			modelRoles: { default: "nope/missing-model" },
			agentModelOverrides: { reviewer: SONNET },
		},
	});
	const refused = await post("preset/apply", { name: "offline" });
	expect(refused.status).toBe(409);
	expect(stored("task.agentModelOverrides")).toEqual(AGENTS);
	expect(stored("modelRoles")).toEqual(ROLES);
}, 120_000);

test("a preset's subagent models are edited in its entry alone: every other key and every other preset stays as it is", async () => {
	reset();
	const raw = {
		target: {
			modelRoles: ROLES,
			defaultThinkingLevel: "high",
			note: { kept: [1, 2] },
			agentModelOverrides: { reviewer: HAIKU },
		},
		bystander: { modelRoles: { default: HAIKU }, agentModelOverrides: { scout: SONNET }, extra: "x" },
		odd: 5,
	};
	setStored("modelPresets", raw);

	const next = { reviewer: `${SONNET}:high`, scout: HAIKU, task: `${HAIKU}:off` };
	const edited = await post("preset/agents", { name: "target", agentModelOverrides: next });
	expect(edited.status).toBe(200);
	expect(edited.body.presets.find((p) => p.name === "target")?.agentModelOverrides).toEqual(next);
	expect<unknown>(storedPresets()).toEqual({ ...raw, target: { ...raw.target, agentModelOverrides: next } });

	// None left: the key goes, the rest of the entry stays.
	expect((await post("preset/agents", { name: "target", agentModelOverrides: {} })).status).toBe(200);
	const { agentModelOverrides: _gone, ...rest } = raw.target;
	expect<unknown>(storedPresets()).toEqual({ ...raw, target: rest });
	expect((await get()).body.presets.find((p) => p.name === "target")?.agentModelOverrides).toBeUndefined();

	// A preset that is not there, one that is no mapping, and one only a project defines cannot be edited.
	expect((await post("preset/agents", { name: "ghost", agentModelOverrides: next })).status).toBe(404);
	const notMapping = await post("preset/agents", { name: "odd", agentModelOverrides: next });
	expect(notMapping.status).toBe(409);
	expect(notMapping.body.error).toMatch(/not a mapping/i);
	const project = join(s.work, "agents-project");
	mkdirSync(join(project, ".omp"), { recursive: true });
	writeFileSync(
		join(project, ".omp", "config.yml"),
		[
			"modelPresets:",
			"  projonly:",
			"    modelRoles:",
			`      default: ${HAIKU}`,
			"    agentModelOverrides:",
			`      scout: ${SONNET}`,
			"",
		].join("\n"),
	);
	expect((await post("preset/agents", { name: "projonly", agentModelOverrides: next })).status).toBe(404);
	// It is listed, with the subagent models its entry carries, as the project's.
	const seen = (await get(project)).body.presets.find((p) => p.name === "projonly");
	expect(seen).toMatchObject({ source: "project", agentModelOverrides: { scout: SONNET } });
	ompStillReads();
}, 180_000);

test("rename, duplicate and delete keep a preset's subagent models, and a copy is independent of its original", async () => {
	reset();
	setStored("modelPresets", { src: { modelRoles: ROLES, agentModelOverrides: AGENTS } });
	await post("preset/rename", { from: "src", to: "renamed" });
	expect(storedPresets()).toEqual({ renamed: { modelRoles: ROLES, agentModelOverrides: AGENTS } });
	await post("preset/duplicate", { from: "renamed", to: "copy" });
	expect(storedPresets().copy).toEqual({ modelRoles: ROLES, agentModelOverrides: AGENTS });
	await post("preset/agents", { name: "copy", agentModelOverrides: { task: SONNET } });
	expect(storedPresets().renamed.agentModelOverrides).toEqual(AGENTS);
	expect(storedPresets().copy.agentModelOverrides).toEqual({ task: SONNET });
	await post("preset/delete", { name: "renamed" });
	expect(Object.keys(storedPresets())).toEqual(["copy"]);
}, 180_000);

test("saving, applying and saving again round-trips the entry, and omp reads the configuration throughout", async () => {
	reset();
	await post("preset/save", { name: "first" });
	ompStillReads();
	// Move the configuration elsewhere, then apply: it is what `first` holds again, and a save of it is the same entry.
	setStored("modelRoles", { default: HAIKU });
	setStored("task.agentModelOverrides", { task: SONNET });
	expect((await post("preset/apply", { name: "first" })).status).toBe(200);
	expect(stored("modelRoles")).toEqual(ROLES);
	expect(stored("task.agentModelOverrides")).toEqual(AGENTS);
	await post("preset/save", { name: "second" });
	const presets = storedPresets();
	expect(presets.second).toEqual(presets.first);
	ompStillReads();
}, 180_000);

test("the configuration reports the subagent models in effect, with a project's laid over the global ones", async () => {
	reset();
	const project = join(s.work, "agents-layer");
	mkdirSync(join(project, ".omp"), { recursive: true });
	writeFileSync(
		join(project, ".omp", "config.yml"),
		["task:", "  agentModelOverrides:", `    scout: ${SONNET}`, ""].join("\n"),
	);
	expect((await get()).body.agentModelOverrides).toEqual(AGENTS);
	expect((await get(project)).body.agentModelOverrides).toEqual({ ...AGENTS, scout: SONNET });
}, 120_000);

test("'Set as default' from a switched conversation brings its subagent models; the roles editor and an empty set change none", async () => {
	reset();
	const brought = { reviewer: SONNET };
	expect((await post("roles", { roles: ROLES, agentModelOverrides: brought })).status).toBe(200);
	expect(stored("task.agentModelOverrides")).toEqual(brought);
	// The roles editor sends none: they are left alone, as they are for `{}`.
	expect((await post("roles", { roles: ROLES })).status).toBe(200);
	expect(stored("task.agentModelOverrides")).toEqual(brought);
	expect((await post("roles", { roles: ROLES, agentModelOverrides: {} })).status).toBe(200);
	expect(stored("task.agentModelOverrides")).toEqual(brought);
}, 120_000);
