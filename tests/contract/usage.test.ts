import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProviderId, providerUsage } from "../../server/omp/usage.ts";
import { remainingFraction } from "../../shared/quota.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/** `omp usage --json`, the quota pill's source: shape the web UI relies on (no model calls). */

const root = mkdtempSync(join(tmpdir(), "ompw-usage-"));
const saved = { ...process.env };
let s: TestServer;
beforeAll(async () => {
	Object.assign(process.env, await isolatedEnv(root));
	s = await startTestServer();
}, 60_000);
afterAll(async () => {
	await s?.stop();
	process.env = saved;
	rmSync(root, { recursive: true, force: true });
});

const usage = (provider: string) =>
	fetch(`${s.url}/api/usage?provider=${encodeURIComponent(provider)}`, {
		headers: { "x-omp-webui-token": s.accessToken, Origin: s.url },
	});

test("/api/usage refuses provider values that are not plain ids, before omp sees them", async () => {
	for (const bad of ["--extension=/tmp/x.ts", "-e", "a b", "../x", "x".repeat(65)]) {
		expect(isProviderId(bad)).toBe(false);
		expect((await usage(bad)).status).toBe(400);
		await expect(providerUsage("omp", bad)).rejects.toThrow("invalid provider id");
	}
});

test("/api/usage answers for a real provider id and for all providers", async () => {
	for (const good of ["anthropic", "openai-codex", ""]) {
		const r = await usage(good);
		expect(r.status).toBe(200);
		expect(Array.isArray(await r.json())).toBe(true);
	}
}, 60_000);

test("omp usage --json yields reports the quota pill can read", async () => {
	const reports = await providerUsage("omp", "anthropic", true);
	expect(Array.isArray(reports)).toBe(true);
	for (const r of reports) {
		expect(typeof r.provider).toBe("string");
		expect(Array.isArray(r.limits)).toBe(true);
		for (const l of r.limits) {
			expect(typeof l.label).toBe("string");
			const f = remainingFraction(l);
			if (f !== null) expect(f).toBeGreaterThanOrEqual(0);
		}
	}
}, 60_000);
