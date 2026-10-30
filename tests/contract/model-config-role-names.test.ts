import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ModelConfig } from "../../shared/model-config.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * omp checks no role names: its own `/modelpreset save` stores every key of `modelRoles` (`my.role`, `3d`, any length)
 * and `/modelpreset switch` applies them back; its preset parser only wants a selector for each role. A preset with such
 * roles is therefore usable, saved by "Save current", applied and active here too (#464).
 * Against the real omp in an isolated agent dir (never `~/.omp`); no model is called.
 */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer();
}, 60_000);
afterAll(async () => {
	await s?.stop();
});

const HAIKU = "anthropic/claude-haiku-5-5";
const LONG = "a".repeat(40);
const ODD = { "my.role": HAIKU, "3d": `${HAIKU}:low`, [LONG]: HAIKU };

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

const get = () => call("/api/model-config");
const post = (action: string, body: unknown) => call(`/api/model-config/${action}`, body);

const ompEnv = () => ({ ...process.env, HOME: s.home, PI_CODING_AGENT_DIR: s.agentDir });

function stored<T = unknown>(key: string): T {
	const r = Bun.spawnSync(["omp", "config", "get", key, "--json"], { env: ompEnv(), cwd: s.work });
	const parsed: { value: T } = JSON.parse(r.stdout.toString());
	return parsed.value;
}

function setStored(key: string, value: unknown): void {
	const r = Bun.spawnSync(["omp", "config", "set", key, JSON.stringify(value)], { env: ompEnv(), cwd: s.work });
	if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

test("a preset with role names of any shape is usable, and is the active one when the config has exactly its roles", async () => {
	const roles = { default: HAIKU, ...ODD };
	setStored("modelRoles", roles);
	setStored("modelPresets", { dotted: { modelRoles: roles, defaultThinkingLevel: "high" } });
	setStored("defaultThinkingLevel", "high");

	const { status, body } = await get();
	expect(status).toBe(200);
	expect(body.roles).toEqual(roles);
	expect(body.presets).toHaveLength(1);
	expect(body.presets[0].problem).toBeUndefined();
	expect(body.presets[0].roles).toEqual(roles);
	expect(body.active).toBe("dotted");
}, 60_000);

test("applying it gives back exactly its roles, odd names included, as /modelpreset switch does", async () => {
	setStored("modelRoles", { default: HAIKU, smol: HAIKU });
	const applied = await post("preset/apply", { name: "dotted" });
	expect(applied.status).toBe(200);
	expect(stored("modelRoles")).toEqual({ default: HAIKU, ...ODD });
	expect(applied.body.active).toBe("dotted");
}, 60_000);

test("Save current stores every role, as omp's own /modelpreset save does", async () => {
	const saved = await post("preset/save", { name: "kept" });
	expect(saved.status).toBe(200);
	expect(stored<Record<string, { modelRoles: unknown }>>("modelPresets").kept.modelRoles).toEqual({
		default: HAIKU,
		...ODD,
	});
}, 60_000);

test("a role named `__proto__` is an ordinary role, as in omp's config, and is not lost on a write", async () => {
	// A JSON object, so `__proto__` is an own key (an object literal would set the prototype instead).
	const withProto = (extra: string) => JSON.parse(`{"__proto__": "foo/bar", "default": "${HAIKU}"${extra}}`);

	// omp stores it as a plain key (`__proto__: foo/bar` in its config.yml) and reads it back.
	setStored("modelRoles", withProto(""));
	expect(stored("modelRoles")).toEqual(withProto(""));

	// Saving it again keeps it: a plain assignment would hit the prototype setter and drop the role.
	const roles = withProto("");
	const set = await post("roles", { roles });
	expect(set.status).toBe(200);
	expect(set.body.roles).toEqual(withProto(""));
	expect(stored("modelRoles")).toEqual(withProto(""));

	// And in a preset, which omp applies the same way.
	const preset = await post("preset/save", { name: "proto", roles });
	expect(preset.status).toBe(200);
	expect(preset.body.presets.find((p) => p.name === "proto")?.roles).toEqual(withProto(""));
	expect(stored<Record<string, { modelRoles: unknown }>>("modelPresets").proto.modelRoles).toEqual(withProto(""));

	// "Save current" takes the roles as they are, the role included.
	const kept = await post("preset/save", { name: "kept-proto" });
	expect(kept.status).toBe(200);
	expect(stored<Record<string, { modelRoles: unknown }>>("modelPresets")["kept-proto"].modelRoles).toEqual(
		withProto(""),
	);

	// And applying the preset gives the role back, as `/modelpreset switch` does.
	const applied = await post("preset/apply", { name: "proto" });
	expect(applied.status).toBe(200);
	expect(stored("modelRoles")).toEqual(withProto(""));
}, 60_000);

test("roles with such names can be saved explicitly in a preset and set as the roles; a role with no name cannot", async () => {
	const roles = { default: HAIKU, "x.y": HAIKU, "9": HAIKU };
	const preset = await post("preset/save", { name: "explicit", roles });
	expect(preset.status).toBe(200);
	expect(preset.body.presets.find((p) => p.name === "explicit")).toMatchObject({ roles });

	const set = await post("roles", { roles });
	expect(set.status).toBe(200);
	expect(stored("modelRoles")).toEqual(roles);

	for (const bad of [{ "": HAIKU }, { "  ": HAIKU }]) {
		expect((await post("preset/save", { name: "nope", roles: bad })).status).toBe(400);
		expect((await post("roles", { roles: bad })).status).toBe(400);
	}
	expect(stored("modelRoles")).toEqual(roles);
}, 60_000);
