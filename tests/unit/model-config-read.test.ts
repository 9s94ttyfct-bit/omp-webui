import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleModelConfig } from "../../server/omp/model-config.ts";
import { fakeConfig } from "../support/fake-omp.ts";

/**
 * A read of the model configuration asked for after a change sees the change, even while an earlier read is
 * still running: omp saves a preset switch a moment after it, and the page asks again when it is told.
 */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * An omp whose `config list` reports the default role written in `roleFile` when it began, says it has read it
 * (a `read-<n>` marker file), then takes `delayMs` to answer.
 */
function slowOmp(dir: string, roleFile: string, delayMs: number): string {
	const bin = join(dir, "omp");
	writeFileSync(
		bin,
		`#!/usr/bin/env bun
const role = await Bun.file(${JSON.stringify(roleFile)}).text();
const { readdirSync, writeFileSync } = await import("node:fs");
const n = readdirSync(${JSON.stringify(dir)}).filter((f) => f.startsWith("read-")).length;
writeFileSync(${JSON.stringify(dir)} + "/read-" + n, role);
await Bun.sleep(${delayMs});
console.log(JSON.stringify({
	modelRoles: { value: { default: role.trim() } },
	defaultThinkingLevel: { value: "high" },
	modelPresets: { value: {} },
}));
`,
	);
	chmodSync(bin, 0o755);
	return bin;
}

async function untilExists(path: string): Promise<void> {
	while (!existsSync(path)) await Bun.sleep(10);
}

const get = (cfg: ReturnType<typeof fakeConfig>) =>
	handleModelConfig(new Request("http://x/api/model-config"), new URL("http://x/api/model-config"), cfg).then(
		(r) => r.json() as Promise<{ roles: Record<string, string> }>,
	);

test("a request made after the config changed is not answered with a read that began before it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-cfgread-"));
	dirs.push(dir);
	const roleFile = join(dir, "role");
	writeFileSync(roleFile, "a/old");
	const cfg = fakeConfig(dir, slowOmp(dir, roleFile, 400));

	const early = get(cfg);
	await untilExists(join(dir, "read-0")); // the first read has begun and read "a/old"
	writeFileSync(roleFile, "a/new"); // omp saves the switch
	const late = get(cfg); // the page, told about the change, asks again
	const also = get(cfg); // and another view at the same moment: it shares the second read

	expect((await early).roles.default).toBe("a/old");
	expect((await late).roles.default).toBe("a/new");
	expect((await also).roles.default).toBe("a/new");
});
