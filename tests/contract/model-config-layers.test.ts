import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelConfig } from "../../shared/model-config.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * omp merges a project's `.omp/config.yml` over the global config, and `modelRoleStorage` (`global` | `project`) says
 * where omp saves role changes made in a terminal. The API tells both for the folder it is asked about, with omp's own
 * merge as the reference (`omp config get` run in that folder): what Settings shows of a project's layer (#442).
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

async function get(cwd?: string) {
	const res = await fetch(`${s.url}/api/model-config${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`, {
		headers: { "x-omp-webui-token": s.accessToken },
	});
	const body: ModelConfig = await res.json();
	return { status: res.status, body };
}

const ompEnv = () => ({ ...process.env, HOME: s.home, PI_CODING_AGENT_DIR: s.agentDir });

/** What omp itself reads in `cwd`: the merge of the global and the project config. */
function ompReads(cwd: string, key: string): unknown {
	const r = Bun.spawnSync(["omp", "config", "get", key, "--json"], { env: ompEnv(), cwd });
	const parsed: { value: unknown } = JSON.parse(r.stdout.toString());
	return parsed.value;
}

function projectConfig(name: string, lines: string[]): string {
	const folder = join(s.work, name);
	mkdirSync(join(folder, ".omp"), { recursive: true });
	writeFileSync(join(folder, ".omp", "config.yml"), `${lines.join("\n")}\n`);
	return folder;
}

test("a project's role overrides, its thinking level and its role storage are in the folder's view, and only there", async () => {
	const folder = projectConfig("layered", [
		"modelRoleStorage: project",
		"defaultThinkingLevel: low",
		"modelRoles:",
		`  smol: ${SONNET}:high`,
		`  plan: ${SONNET}`,
		"modelPresets:",
		"  projp:",
		"    modelRoles:",
		`      default: ${SONNET}`,
	]);

	const global = await get();
	expect(global.status).toBe(200);
	expect(global.body.roles.smol).toBe(HAIKU);
	expect(global.body.roleStorage).toBe("global");

	const project = await get(folder);
	expect(project.status).toBe(200);
	// omp's merge: the project's `smol` wins, `plan` is added, the global roles it does not mention stay.
	expect(project.body.roles).toEqual(ompReads(folder, "modelRoles") as Record<string, string>);
	expect(project.body.roles).toMatchObject({
		smol: `${SONNET}:high`,
		plan: SONNET,
		default: global.body.roles.default,
	});
	expect(project.body.defaultThinkingLevel).toBe("low");
	expect<unknown>(project.body.roleStorage).toBe(ompReads(folder, "modelRoleStorage"));
	expect(project.body.roleStorage).toBe("project");
	expect(project.body.presets.find((p) => p.name === "projp")?.source).toBe("project");

	// The global view is not changed by asking about a project.
	expect((await get()).body).toEqual(global.body);
}, 120_000);

test("a folder whose project config sets nothing about roles reports the global storage and roles", async () => {
	const folder = projectConfig("plain", ["modelPresets:", "  other:", "    modelRoles:", `      default: ${HAIKU}`]);
	const project = await get(folder);
	const global = await get();
	expect(project.body.roles).toEqual(global.body.roles);
	expect(project.body.roleStorage).toBe("global");
}, 60_000);

test("a folder that is not there any more reads the global config, not an error (a conversation whose folder went)", async () => {
	const gone = join(s.work, "moved-away-project");
	const missing = await get(gone);
	const global = await get();
	expect(missing.status).toBe(200);
	expect(missing.body.roles).toEqual(global.body.roles);
	expect(missing.body.presets).toEqual(global.body.presets);
	expect((await get("relative/path")).status).toBe(400);
	// A file is there, so it is not a folder that went: still refused.
	const file = join(s.work, "a-file.txt");
	writeFileSync(file, "x");
	expect((await get(file)).status).toBe(400);
	expect(await get(join(file, "below"))).toMatchObject({ status: 200 });
}, 60_000);
