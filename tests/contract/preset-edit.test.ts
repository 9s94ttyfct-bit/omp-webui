import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelConfig } from "../../shared/model-config.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * Editing a saved global preset in one write (`POST /api/model-config/preset/edit`): its role models, default thinking level
 * and subagent models are replaced in that preset's entry in omp's config, through `omp config set`, and nothing else of the
 * entry or of any other preset changes. Over HTTP against an isolated omp config (the test server's own HOME and agent
 * dir, never `~/.omp`), with omp's CLI as the reference for what was written. No model is called.
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

const ompEnv = () => ({ ...process.env, HOME: s.home, PI_CODING_AGENT_DIR: s.agentDir });

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

/** omp starts and lists its whole configuration: nothing in it is something it refuses. */
function ompStillReads(): void {
	const r = Bun.spawnSync(["omp", "config", "list", "--json"], { env: ompEnv(), cwd: s.work });
	expect(r.exitCode).toBe(0);
	expect(r.stderr.toString()).not.toMatch(/invalid|malformed|error/i);
}

function reset(): void {
	setStored("modelPresets", {});
	setStored("modelRoles", ROLES);
	setStored("defaultThinkingLevel", "high");
	setStored("task.agentModelOverrides", {});
}

test("one edit rewrites a preset's roles, thinking level and subagent models; unknown keys and every other preset stay", async () => {
	reset();
	const raw = {
		target: {
			modelRoles: ROLES,
			note: { kept: [1, 2] },
			defaultThinkingLevel: "high",
			agentModelOverrides: { reviewer: HAIKU },
			future: "kept",
		},
		bystander: { modelRoles: { default: HAIKU }, agentModelOverrides: { scout: SONNET }, extra: "x" },
		odd: 5,
	};
	setStored("modelPresets", raw);
	const globalRolesBefore = stored("modelRoles");

	const roles = { default: `${HAIKU}:low`, slow: SONNET, smol: `${HAIKU}:off` };
	const agents = { reviewer: `${SONNET}:high`, task: HAIKU };
	const edited = await post("preset/edit", {
		name: "target",
		roles,
		defaultThinkingLevel: "xhigh",
		agentModelOverrides: agents,
	});
	expect(edited.status).toBe(200);
	expect(edited.body.presets.find((p) => p.name === "target")).toMatchObject({
		roles,
		defaultThinkingLevel: "xhigh",
		agentModelOverrides: agents,
		source: "global",
	});
	// The entry as omp holds it: the three keys replaced where they stood, the rest untouched, key order kept.
	const after = storedPresets();
	expect<unknown>(after).toEqual({
		...raw,
		target: { ...raw.target, modelRoles: roles, defaultThinkingLevel: "xhigh", agentModelOverrides: agents },
	});
	expect(Object.keys(after.target)).toEqual(Object.keys(raw.target));
	// Editing a preset is not applying it.
	expect(stored("modelRoles")).toEqual(globalRolesBefore);

	// No thinking level (null) and no subagent models: both keys go, the others stay.
	const bare = await post("preset/edit", {
		name: "target",
		roles,
		defaultThinkingLevel: null,
		agentModelOverrides: {},
	});
	expect(bare.status).toBe(200);
	expect<unknown>(storedPresets()).toEqual({
		...raw,
		target: { modelRoles: roles, note: raw.target.note, future: "kept" },
	});

	// A key the entry lacked is added at the end.
	const again = await post("preset/edit", {
		name: "target",
		roles,
		defaultThinkingLevel: "low",
		agentModelOverrides: agents,
	});
	expect(again.status).toBe(200);
	expect(Object.keys(storedPresets().target)).toEqual([
		"modelRoles",
		"note",
		"future",
		"defaultThinkingLevel",
		"agentModelOverrides",
	]);
	ompStillReads();
}, 180_000);

test("an edit that is wrong, or for a preset that is not the global config's, writes nothing", async () => {
	reset();
	const raw = { target: { modelRoles: ROLES, defaultThinkingLevel: "high" }, odd: 5 };
	setStored("modelPresets", raw);
	const good = { roles: ROLES, defaultThinkingLevel: "high", agentModelOverrides: {} };

	for (const bad of [
		{ ...good, roles: {} },
		{ ...good, roles: { default: "" } },
		{ ...good, roles: { default: "a/b\u0000c" } },
		{ ...good, roles: "nope" },
		{ ...good, defaultThinkingLevel: "loud" },
		{ ...good, agentModelOverrides: { reviewer: "" } },
		{ ...good, agentModelOverrides: [HAIKU] },
	]) {
		expect((await post("preset/edit", { name: "target", ...bad })).status).toBe(400);
	}
	// The thinking level must be said (null is "none"), so a request that forgot it cannot drop the preset's.
	const { defaultThinkingLevel: _omitted, ...forgot } = good;
	expect((await post("preset/edit", { name: "target", ...forgot })).status).toBe(400);
	expect((await post("preset/edit", { ...good })).status).toBe(400);
	expect<unknown>(storedPresets()).toEqual(raw);

	expect((await post("preset/edit", { name: "ghost", ...good })).status).toBe(404);
	const notMapping = await post("preset/edit", { name: "odd", ...good });
	expect(notMapping.status).toBe(409);
	expect(notMapping.body.error).toMatch(/not a mapping/i);

	// A preset only a project defines is refused: it can only be changed in that project's config.
	const project = join(s.work, "edit-project");
	mkdirSync(join(project, ".omp"), { recursive: true });
	writeFileSync(
		join(project, ".omp", "config.yml"),
		["modelPresets:", "  projonly:", "    modelRoles:", `      default: ${HAIKU}`, ""].join("\n"),
	);
	expect((await get(project)).body.presets.find((p) => p.name === "projonly")?.source).toBe("project");
	const refused = await post("preset/edit", { name: "projonly", ...good });
	expect(refused.status).toBe(404);
	expect(refused.body.error).toMatch(/project/i);
	expect<unknown>(storedPresets()).toEqual(raw);
	ompStillReads();
}, 180_000);

test("a preset's name, a role named __proto__ and a quirky entry survive an edit as ordinary keys", async () => {
	reset();
	setStored("modelPresets", { target: { modelRoles: ROLES } });
	const roles = JSON.parse(`{"default":"${HAIKU}","__proto__":"${SONNET}"}`);
	expect(
		(await post("preset/edit", { name: "target", roles, defaultThinkingLevel: null, agentModelOverrides: {} })).status,
	).toBe(200);
	const entry = storedPresets().target;
	expect(Object.keys(entry.modelRoles as object)).toEqual(["default", "__proto__"]);
	ompStillReads();
}, 120_000);
