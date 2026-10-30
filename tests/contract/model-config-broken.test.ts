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
