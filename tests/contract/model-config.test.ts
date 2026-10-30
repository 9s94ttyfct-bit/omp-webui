import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelConfig } from "../../shared/model-config.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * Model roles and presets over HTTP, against an isolated omp config (the test server's own HOME and agent dir,
 * never `~/.omp`). omp's CLI is the reference: what the API stores is read back with `omp config get`.
 * No model is called.
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

type Reply = ModelConfig & { error?: string };

async function call(path: string, body?: unknown, headers: Record<string, string> = {}) {
	const res = await fetch(`${s.url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			"x-omp-webui-token": s.accessToken,
			"x-omp-webui": "1",
			...(body === undefined ? {} : { "content-type": "application/json" }),
			...headers,
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
	const parsed: { value: T } = JSON.parse(r.stdout.toString());
	return parsed.value;
}

function setStored(key: string, value: unknown): void {
	const r = Bun.spawnSync(["omp", "config", "set", key, JSON.stringify(value)], { env: ompEnv(), cwd: s.work });
	if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

const storedPresets = () => stored<Record<string, unknown>>("modelPresets");

test("reads the configured roles, the thinking level and the presets", async () => {
	const { status, body } = await get();
	expect(status).toBe(200);
	// The roles the test server's config.yml sets.
	expect(body.roles).toEqual({
		default: `${HAIKU}:low`,
		smol: HAIKU,
		slow: HAIKU,
		tiny: `${HAIKU}:low`,
		commit: HAIKU,
	});
	expect(typeof body.defaultThinkingLevel).toBe("string");
	expect(body.presets).toEqual([]);
	expect(body.active).toBeNull();
}, 60_000);

test("saves the current configuration as a preset, which is then the active one", async () => {
	const before = (await get()).body;
	const { status, body } = await post("preset/save", { name: "base" });
	expect(status).toBe(200);
	expect(body.presets).toHaveLength(1);
	expect(body.presets[0]).toMatchObject({ name: "base", roles: before.roles, source: "global" });
	expect<string | undefined>(body.presets[0].defaultThinkingLevel).toBe(before.defaultThinkingLevel);
	expect(body.active).toBe("base");
	// omp reads it back as it would have saved it itself.
	expect(storedPresets()).toEqual({
		base: { modelRoles: before.roles, defaultThinkingLevel: before.defaultThinkingLevel },
	});
}, 60_000);

test("refuses preset names omp would refuse, before anything is written", async () => {
	for (const name of ["", "   ", "1a", "a b", "-x", "a.b", "a/b", "__proto__", "x".repeat(65), 5, null]) {
		const r = await post("preset/save", { name });
		expect(r.status).toBe(400);
		expect(r.body.error).toMatch(/name/i);
	}
	expect(Object.keys(storedPresets())).toEqual(["base"]);
}, 60_000);

test("does not replace an existing preset unless asked to", async () => {
	const roles = { default: `${SONNET}:high`, smol: HAIKU };
	const refused = await post("preset/save", { name: "base", roles });
	expect(refused.status).toBe(409);
	expect(refused.body.error).toMatch(/already exists/i);
	expect(storedPresets().base).not.toMatchObject({ modelRoles: roles });

	const replaced = await post("preset/save", { name: "base", roles, defaultThinkingLevel: "high", overwrite: true });
	expect(replaced.status).toBe(200);
	expect(storedPresets()).toEqual({ base: { modelRoles: roles, defaultThinkingLevel: "high" } });
}, 60_000);

test("saves explicit roles, and validates them like omp does", async () => {
	const ok = await post("preset/save", { name: "mini", roles: { default: `${HAIKU}:low` } });
	expect(ok.status).toBe(200);
	// A preset without a thinking level of its own is valid: it does not touch the default.
	expect(storedPresets().mini).toEqual({ modelRoles: { default: `${HAIKU}:low` } });

	const bad: [object, RegExp][] = [
		[{ roles: "x" }, /roles/i],
		[{ roles: [] }, /roles/i],
		[{ roles: {} }, /at least one/i],
		[{ roles: { "": HAIKU } }, /role name/i],
		[{ roles: { default: "" } }, /selector/i],
		[{ roles: { default: 5 } }, /selector/i],
		[{ roles: { default: "a/b\nc/d" } }, /selector/i],
		[{ roles: { default: HAIKU, x: "y".repeat(600) } }, /too long/i],
		[{ roles: { default: HAIKU }, defaultThinkingLevel: "off" }, /thinking level/i],
		[{ roles: { default: HAIKU }, defaultThinkingLevel: "ultra" }, /thinking level/i],
		[{ roles: { default: HAIKU }, defaultThinkingLevel: 3 }, /thinking level/i],
	];
	for (const [extra, message] of bad) {
		const r = await post("preset/save", { name: "nope", ...extra });
		expect(r.status).toBe(400);
		expect(r.body.error).toMatch(message);
	}
	expect(Object.keys(storedPresets()).sort()).toEqual(["base", "mini"]);
}, 120_000);

test("applies a preset without a session: the roles become exactly the preset's, and its thinking level the default", async () => {
	const applied = await post("preset/apply", { name: "base" });
	expect(applied.status).toBe(200);
	expect(applied.body.roles).toEqual({ default: `${SONNET}:high`, smol: HAIKU });
	expect(applied.body.defaultThinkingLevel).toBe("high");
	expect(applied.body.active).toBe("base");
	// Read back by omp: roles the preset lacks (slow, tiny, commit) are gone, as `/modelpreset switch` leaves them.
	expect(stored("modelRoles")).toEqual({ default: `${SONNET}:high`, smol: HAIKU });
	expect(stored("defaultThinkingLevel")).toBe("high");
	expect((await get()).body.active).toBe("base");

	// A preset that sets no thinking level leaves the default alone.
	const mini = await post("preset/apply", { name: "mini" });
	expect(mini.status).toBe(200);
	expect(mini.body.roles).toEqual({ default: `${HAIKU}:low` });
	expect(mini.body.defaultThinkingLevel).toBe("high");
	expect(mini.body.active).toBe("mini");
}, 120_000);

test("does not apply a preset omp could not: unknown, malformed, or its default model unavailable", async () => {
	expect((await post("preset/apply", { name: "ghost" })).status).toBe(404);
	expect((await post("preset/apply", { name: "1bad" })).status).toBe(400);

	await post("preset/save", { name: "offline", roles: { default: "nope/missing-model", smol: HAIKU } });
	const before = stored("modelRoles");
	const r = await post("preset/apply", { name: "offline" });
	expect(r.status).toBe(409);
	expect(r.body.error).toMatch(/nope\/missing-model.*not available/i);
	expect(stored("modelRoles")).toEqual(before);
	await post("preset/delete", { name: "offline" });
}, 120_000);

test("sets the roles and the default thinking level, replacing the roles as given", async () => {
	const roles = { default: `${SONNET}:medium`, plan: `${SONNET}:max`, web: "web/exa" };
	const r = await post("roles", { roles, defaultThinkingLevel: "low" });
	expect(r.status).toBe(200);
	expect(r.body.roles).toEqual(roles);
	expect(r.body.defaultThinkingLevel).toBe("low");
	expect(stored("modelRoles")).toEqual(roles);
	expect(stored("defaultThinkingLevel")).toBe("low");

	// No thinking level in the request leaves the default; selectors omp understands beyond provider/id are kept.
	const beyond = { default: `${HAIKU},${SONNET}`, slow: "pi/default" };
	const alias = await post("roles", { roles: beyond });
	expect(alias.status).toBe(200);
	expect(alias.body.defaultThinkingLevel).toBe("low");
	expect(stored("modelRoles")).toEqual(beyond);

	for (const bad of [
		{ roles: "x" },
		{ roles: { "": "a/b" } },
		{ roles: { default: "" } },
		{ roles: {}, defaultThinkingLevel: "nope" },
	]) {
		expect((await post("roles", bad)).status).toBe(400);
	}
	expect(stored("modelRoles")).toEqual(beyond);
	// An empty set of roles is a valid configuration (omp then picks a model it can use).
	expect((await post("roles", { roles: {} })).status).toBe(200);
	expect(stored("modelRoles")).toEqual({});
}, 120_000);

test("renames, duplicates and deletes presets, keeping the others exactly as they were", async () => {
	const keepBefore = storedPresets().mini;

	expect((await post("preset/rename", { from: "base", to: "main" })).status).toBe(200);
	let presets = storedPresets();
	expect(Object.keys(presets).sort()).toEqual(["main", "mini"]);
	expect(presets.main).toEqual({
		modelRoles: { default: `${SONNET}:high`, smol: HAIKU },
		defaultThinkingLevel: "high",
	});

	const dup = await post("preset/duplicate", { from: "main", to: "main2" });
	expect(dup.status).toBe(200);
	expect(dup.body.presets.map((p) => p.name)).toEqual(["main", "main2", "mini"]);
	presets = storedPresets();
	expect(presets.main2).toEqual(presets.main);

	// Neither overwrites, neither invents, neither accepts a name omp refuses.
	expect((await post("preset/rename", { from: "main2", to: "mini" })).status).toBe(409);
	expect((await post("preset/duplicate", { from: "main", to: "mini" })).status).toBe(409);
	expect((await post("preset/rename", { from: "ghost", to: "x" })).status).toBe(404);
	expect((await post("preset/duplicate", { from: "ghost", to: "x" })).status).toBe(404);
	expect((await post("preset/rename", { from: "main2", to: "1x" })).status).toBe(400);
	expect((await post("preset/duplicate", { from: "main2", to: "a b" })).status).toBe(400);
	expect((await post("preset/rename", { from: "main2", to: "main2" })).status).toBe(409);

	const del = await post("preset/delete", { name: "main2" });
	expect(del.status).toBe(200);
	expect(del.body.presets.map((p) => p.name)).toEqual(["main", "mini"]);
	expect((await post("preset/delete", { name: "main2" })).status).toBe(404);
	expect((await post("preset/delete", { name: "" })).status).toBe(400);
	expect(storedPresets().mini).toEqual(keepBefore);
}, 180_000);

test("presets a project defines are listed with their source and cannot be changed from the global config", async () => {
	const project = join(s.work, "with-presets");
	mkdirSync(join(project, ".omp"), { recursive: true });
	writeFileSync(
		join(project, ".omp", "config.yml"),
		[
			"modelPresets:",
			"  projonly:",
			"    modelRoles:",
			`      default: ${HAIKU}:low`,
			"    defaultThinkingLevel: low",
			"  mini:",
			"    modelRoles:",
			`      default: ${SONNET}`,
			"",
		].join("\n"),
	);

	const withProject = await get(project);
	expect(withProject.status).toBe(200);
	const byName = Object.fromEntries(withProject.body.presets.map((p) => [p.name, p]));
	expect(Object.keys(byName)).toEqual(["main", "mini", "projonly"]);
	expect(byName.main.source).toBe("global");
	expect(byName.projonly).toMatchObject({
		source: "project",
		roles: { default: `${HAIKU}:low` },
		defaultThinkingLevel: "low",
	});
	// The project overrides a global preset of the same name: what applies there is the project's.
	expect(byName.mini).toMatchObject({ source: "project", roles: { default: SONNET } });

	// Without a folder only the global config is seen, and that is what writes work on.
	const global = (await get()).body.presets;
	expect(global.map((p) => p.name)).toEqual(["main", "mini"]);
	expect(global.every((p) => p.source === "global")).toBe(true);
	expect((await post("preset/delete", { name: "projonly" })).status).toBe(404);
	expect((await post("preset/rename", { from: "projonly", to: "x" })).status).toBe(404);
	expect((await post("preset/apply", { name: "projonly" })).status).toBe(404);

	// A folder that is not absolute or is a file is refused (one that is not there reads the global config: model-config-layers.test.ts).
	expect((await get("relative/path")).status).toBe(400);
	expect((await get(join(project, ".omp", "config.yml"))).status).toBe(400);
}, 120_000);

test("presets omp cannot apply are listed with the reason, and writes leave every other entry exactly as it is", async () => {
	const raw = {
		keep: { modelRoles: { default: HAIKU }, defaultThinkingLevel: "medium", extraField: { a: [1, 2] } },
		broken: 5,
		noroles: { modelRoles: "x" },
		badlevel: { modelRoles: { default: HAIKU }, defaultThinkingLevel: "off" },
		emptyrole: { modelRoles: { default: "" } },
		"bad name": { modelRoles: { default: HAIKU } },
	};
	setStored("modelPresets", raw);

	const { body } = await get();
	const byName = Object.fromEntries(body.presets.map((p) => [p.name, p]));
	expect(body.presets.map((p) => p.name)).toEqual(["bad name", "badlevel", "broken", "emptyrole", "keep", "noroles"]);
	expect(byName.keep.problem).toBeUndefined();
	expect(byName.keep.defaultThinkingLevel).toBe("medium");
	for (const name of ["broken", "noroles", "badlevel", "emptyrole", "bad name"]) {
		expect(typeof byName[name].problem).toBe("string");
	}
	expect(byName.badlevel.problem).toMatch(/thinking level/);
	expect(byName["bad name"].problem).toMatch(/name/i);
	expect(body.active).toBeNull();

	expect((await post("preset/apply", { name: "broken" })).status).toBe(409);
	expect((await post("preset/apply", { name: "bad name" })).status).toBe(400);

	// Saving, duplicating and deleting never rewrite what they do not touch (not even fields this UI does not know).
	await post("preset/save", { name: "added", roles: { default: HAIKU } });
	await post("preset/duplicate", { from: "keep", to: "keep2" });
	await post("preset/delete", { name: "added" });
	expect(storedPresets()).toEqual({ ...raw, keep2: raw.keep });
	// And they can be cleaned up, malformed ones included.
	expect((await post("preset/delete", { name: "bad name" })).status).toBe(200);
	expect((await post("preset/delete", { name: "broken" })).status).toBe(200);
}, 120_000);

test("writes are serialized: parallel saves all survive", async () => {
	setStored("modelPresets", {});
	const names = Array.from({ length: 8 }, (_, i) => `par${i}`);
	const results = await Promise.all(names.map((name) => post("preset/save", { name, roles: { default: HAIKU } })));
	expect(results.map((r) => r.status)).toEqual(names.map(() => 200));
	expect(Object.keys(storedPresets()).sort()).toEqual(names);
}, 120_000);

test("the API needs the access token, the CSRF header for writes, and refuses unknown paths and bodies", async () => {
	const noToken = await fetch(`${s.url}/api/model-config`);
	expect(noToken.status).toBe(401);
	const noCsrf = await fetch(`${s.url}/api/model-config/preset/save`, {
		method: "POST",
		headers: { "x-omp-webui-token": s.accessToken, "content-type": "application/json" },
		body: JSON.stringify({ name: "csrf" }),
	});
	expect(noCsrf.status).toBe(403);
	expect((await post("nope", {})).status).toBe(404);
	// Writes are POST only.
	expect((await call("/api/model-config/preset/save")).status).toBe(405);
	const notJson = await fetch(`${s.url}/api/model-config/preset/save`, {
		method: "POST",
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1" },
		body: "not json",
	});
	expect(notJson.status).toBe(400);
	expect(Object.keys(storedPresets())).not.toContain("csrf");
}, 60_000);
