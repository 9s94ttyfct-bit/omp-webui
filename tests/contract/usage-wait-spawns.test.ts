import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * Whether a failed turn waits out a usage limit is omp's own `retry.waitForUsageReset`. Every page that shows it, and
 * each conversation's quota popover, asks the server for it, again after every reconnect and every config change: the
 * server must not start an omp (about 0.15 s and 140 MB) for each of those questions. The real omp runs behind a
 * launcher that writes down its command lines.
 */

let server: TestServer;
let dir: string;
let log: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "ompw-wait-spawns-"));
	log = join(dir, "calls");
	const real = process.env.OMP_BIN ?? Bun.which("omp");
	if (!real) throw new Error("omp is not installed");
	const launcher = join(dir, "omp");
	writeFileSync(launcher, `#!/bin/sh\necho "$*" >> "${log}"\nexec "${real}" "$@"\n`);
	chmodSync(launcher, 0o755);
	server = await startTestServer(0, { OMP_BIN: launcher }, { login: false });
});
afterAll(async () => {
	await server?.stop();
	rmSync(dir, { recursive: true, force: true });
});

const headers = () => ({
	"x-omp-webui-token": server.accessToken,
	"x-omp-webui": "1",
	"content-type": "application/json",
});
const ask = async (file?: string): Promise<{ omp: boolean | null; session: boolean | null }> =>
	(
		await fetch(`${server.url}/api/usage-reset-wait${file ? `?file=${encodeURIComponent(file)}` : ""}`, {
			headers: headers(),
		})
	).json();
/** How many times the server has asked omp for this setting. */
const asked = (): number =>
	existsSync(log)
		? readFileSync(log, "utf8")
				.split("\n")
				.filter((line) => line.startsWith("config get retry.waitForUsageReset")).length
		: 0;

test("a reconnect that asks for omp's own value, and for each of ten conversations, starts one omp; later questions start none", async () => {
	const files = Object.values(server.fixtures);
	const before = asked();
	const answers = await Promise.all([ask(), ...Array.from({ length: 10 }, (_, i) => ask(files[i % files.length]))]);
	expect(new Set(answers.map((a) => a.omp)).size).toBe(1);
	expect(asked() - before).toBe(1);

	// A popover opened afterwards, in any conversation.
	await ask(files[0]);
	await ask();
	expect(asked() - before).toBe(1);
});

test("a change made in omp's config is the next answer, with no wait for a timer or a file event", async () => {
	const current = (await ask()).omp;
	const before = asked();
	const changed = await fetch(`${server.url}/api/usage-reset-wait`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({ enabled: !current }),
	});
	expect(await changed.json()).toEqual({ omp: !current, session: null });
	expect((await ask()).omp).toBe(!current);
	// One run for the value after the change, shared by the answer to the change and the question after it.
	expect(asked() - before).toBe(1);
});
