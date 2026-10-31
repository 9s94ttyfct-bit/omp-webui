import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelConfig } from "../../shared/model-config.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * omp's config.yml with a syntax error, against the real omp in an isolated agent dir (never `~/.omp`). omp moves the
 * file aside as `config.yml.broken-…` on the first read that fails and starts from its defaults on the next one. The
 * settings API says why the first read failed, in omp's words rather than the source excerpt omp prints above them, and
 * keeps saying that the shown values are defaults while the copy is there (#443). No model is called.
 */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer();
}, 60_000);
afterAll(async () => {
	await s?.stop();
});

const get = async () => {
	const res = await fetch(`${s.url}/api/model-config`, { headers: { "x-omp-webui-token": s.accessToken } });
	return { status: res.status, body: (await res.json()) as ModelConfig & { error?: string } };
};
const backups = () => readdirSync(s.agentDir).filter((f) => f.startsWith("config.yml.broken-"));

test("an unreadable config.yml is reported by omp's message with the backup it made, and the defaults that follow say so", async () => {
	writeFileSync(join(s.agentDir, "config.yml"), "modelRoles:\n  default: a/b\n bad: [\n  x: y: z\n");

	const failed = await get();
	expect(failed.status).toBe(500);
	expect(failed.body.error).toContain("Settings config is invalid");
	expect(failed.body.error).toContain("YAML Parse error");
	expect(failed.body.error).toContain("config.yml.broken-");
	// The excerpt of omp's own source that Bun prints above the message is not part of it.
	expect(failed.body.error).not.toMatch(/switch \(p\.kind\)|\d+ \|/);
	expect(backups()).toHaveLength(1);
	const backup = join(s.agentDir, backups()[0]);

	// The next read works, on omp's defaults: it is told that they are not what the person had.
	const next = await get();
	expect(next.status).toBe(200);
	expect(next.body.roles).toEqual({});
	expect(next.body.movedAside).toEndWith(backups()[0]);
	expect(existsSync(next.body.movedAside as string)).toBe(true);

	// Once the copy is gone (restored or deleted) there is nothing left to say.
	rmSync(backup);
	const later = await get();
	expect(later.status).toBe(200);
	expect(later.body.movedAside).toBeUndefined();
}, 120_000);

test("a config.yml another omp moved aside is reported too, until a valid one is read again (#15)", async () => {
	const config = join(s.agentDir, "config.yml");
	const valid = "modelRoles:\n  default: anthropic/claude-haiku-5-5\n";
	writeFileSync(config, valid);
	const before = await get();
	expect(before.status).toBe(200);
	expect(before.body.movedAside).toBeUndefined();

	// Another omp (a conversation's, one in a terminal) reads the broken file first and moves it aside: the server's own
	// read never fails, so no message of omp's tells it where the file went.
	writeFileSync(config, "modelRoles:\n  default: a/b\n bad: [\n  x: y: z\n");
	const other = Bun.spawnSync([Bun.which("omp") as string, "config", "list", "--json"], {
		env: { ...process.env, HOME: s.home, PI_CODING_AGENT_DIR: s.agentDir },
		cwd: s.work,
	});
	expect(other.stderr.toString()).toContain("moved to");
	expect(existsSync(config)).toBe(false);
	expect(backups()).toHaveLength(1);

	const after = await get();
	expect(after.status).toBe(200);
	expect(after.body.roles).toEqual({});
	expect(after.body.movedAside).toEndWith(`/${backups()[0]}`);
	expect(existsSync(after.body.movedAside as string)).toBe(true);

	// The person writes a valid config.yml and keeps the copy: what is shown is theirs again, and nothing is said.
	writeFileSync(config, valid);
	const restored = await get();
	expect(restored.status).toBe(200);
	expect(restored.body.movedAside).toBeUndefined();
	for (const f of backups()) rmSync(join(s.agentDir, f));
}, 120_000);
