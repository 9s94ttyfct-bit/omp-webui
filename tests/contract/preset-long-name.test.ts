import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ModelConfig } from "../../shared/model-config.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * A preset whose name is longer than the 64 characters this UI allows for new names: omp itself has no cap, so such a
 * preset can exist in the config and is applied, renamed and deleted like any other. Against an isolated omp config.
 */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer();
}, 60_000);
afterAll(async () => {
	await s?.stop();
});

const HAIKU = "anthropic/claude-haiku-5-5";
const LONG = `long-${"x".repeat(65)}`;

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
	return { status: res.status, body: (await res.json()) as ModelConfig & { error?: string } };
}

test("a 70-character preset already in the config is listed as usable, applies, and can be renamed and deleted", async () => {
	expect(LONG.length).toBe(70);
	const env = { ...process.env, HOME: s.home, PI_CODING_AGENT_DIR: s.agentDir };
	const set = Bun.spawnSync(
		[
			"omp",
			"config",
			"set",
			"modelPresets",
			JSON.stringify({ [LONG]: { modelRoles: { default: `${HAIKU}:low`, smol: HAIKU } } }),
		],
		{ env, cwd: s.work },
	);
	expect(set.exitCode).toBe(0);

	const listed = (await call("/api/model-config")).body.presets.find((p) => p.name === LONG);
	expect(listed).toBeDefined();
	expect(listed?.problem).toBeUndefined();

	const applied = await call("/api/model-config/preset/apply", { name: LONG });
	expect(applied.status).toBe(200);
	expect(applied.body.roles).toEqual({ default: `${HAIKU}:low`, smol: HAIKU });
	expect(applied.body.active).toBe(LONG);

	// A new name still has the cap.
	const refused = await call("/api/model-config/preset/duplicate", { from: LONG, to: LONG });
	expect(refused.status).toBe(400);
	expect(refused.body.error).toMatch(/too long/i);
	const renamed = await call("/api/model-config/preset/rename", { from: LONG, to: "short" });
	expect(renamed.status).toBe(200);
	expect((await call("/api/model-config/preset/delete", { name: "short" })).status).toBe(200);
}, 120_000);
