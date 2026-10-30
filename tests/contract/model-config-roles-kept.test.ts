import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ModelConfig } from "../../shared/model-config.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * omp keeps and uses any key of `modelRoles`. The page is given every role that holds a model selector, whatever its
 * name (`my.role`, `3d`, over 32 characters: #464), and what it saves replaces them. The entries that hold no selector
 * (blank, non-text) cannot be shown, so saving must not delete them (#440).
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
const SONNET = "anthropic/claude-sonnet-5-5";
const LONG = "a".repeat(40);

const ompEnv = () => ({ ...process.env, HOME: s.home, PI_CODING_AGENT_DIR: s.agentDir });

function stored(key: string): unknown {
	const r = Bun.spawnSync(["omp", "config", "get", key, "--json"], { env: ompEnv(), cwd: s.work });
	const parsed: { value: unknown } = JSON.parse(r.stdout.toString());
	return parsed.value;
}

function setStored(key: string, value: unknown): void {
	const r = Bun.spawnSync(["omp", "config", "set", key, JSON.stringify(value)], { env: ompEnv(), cwd: s.work });
	if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

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
	const json: ModelConfig = await res.json();
	return { status: res.status, body: json };
}

test("the page is given every role that holds a selector, and none of the others", async () => {
	const unshown = { blank: "", number: 5 };
	setStored("modelRoles", {
		default: HAIKU,
		smol: HAIKU,
		"my.role": "foo/bar",
		"3d": "foo/baz",
		[LONG]: "foo/long",
		...unshown,
	});

	expect((await call("/api/model-config")).body.roles).toEqual({
		default: HAIKU,
		smol: HAIKU,
		"my.role": "foo/bar",
		"3d": "foo/baz",
		[LONG]: "foo/long",
	});
}, 60_000);

test("an unrelated edit leaves every other role in omp's config, the ones the page cannot show too", async () => {
	const roles = { default: `${SONNET}:high`, smol: HAIKU, "my.role": "foo/bar", "3d": "foo/baz", [LONG]: "foo/long" };
	const edited = await call("/api/model-config/roles", { roles });
	expect(edited.status).toBe(200);
	expect(edited.body.roles).toEqual(roles);
	expect(stored("modelRoles")).toEqual({ ...roles, blank: "", number: 5 });
}, 60_000);

test("a role removed on the page is gone, a role added is there, and the entries without a selector still are", async () => {
	const removed = await call("/api/model-config/roles", {
		roles: { default: HAIKU, plan: `${SONNET}:max`, "my.role": "foo/bar" },
	});
	expect(removed.status).toBe(200);
	expect(removed.body.roles).toEqual({ default: HAIKU, plan: `${SONNET}:max`, "my.role": "foo/bar" });
	const now = stored("modelRoles");
	expect(now).toEqual({ default: HAIKU, plan: `${SONNET}:max`, "my.role": "foo/bar", blank: "", number: 5 });
}, 60_000);
