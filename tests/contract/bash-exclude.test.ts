import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { LiveInfo } from "../../shared/protocol.ts";
import { startAppServer } from "../support/app-server.ts";
import { writeFakeOmp } from "../support/fake-omp.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import { removeScratch } from "../support/scratch.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The composer's `!!command` is sent as `bash` with `excludeFromContext` (#305). An omp whose `ready` frame does not say
 * `supportsBashExcludeFromContext` (before 18.18.1) would run it and share the run with the model, the opposite of what `!!`
 * asks: the server refuses it with a coded error and sends omp nothing, and a plain `!command` still runs. Real server, a
 * scripted omp that says no such thing in its ready frame; no model.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-bash-exclude-"));
const work = join(root, "work");
let env: Record<string, string>;
const procs: Subprocess[] = [];

beforeAll(async () => {
	env = await isolatedEnv(root);
	mkdirSync(work, { recursive: true });
});
afterEach(() => {
	for (const p of procs.splice(0)) p.kill("SIGKILL");
});
afterAll(() => removeScratch(root));

test("a !!command for an omp that cannot keep it out of the context is refused, not run and shared", async () => {
	const bin = writeFakeOmp(root, {});
	const dataDir = join(root, "data");
	mkdirSync(dataDir, { recursive: true });
	const server = await startAppServer(env, dataDir, 0, { OMP_BIN: bin });
	procs.push(server.proc);
	const ws = await connect({ url: `http://127.0.0.1:${server.port}`, accessToken: server.token });
	const started: unknown[] = [];
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(String(ev.data));
		if (m.t === "frame" && m.frame?.type === "bash_started") started.push(m.frame);
	});
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: work } });

	const refused = await request(ws, {
		t: "rpc",
		liveId: live.liveId,
		command: { type: "bash", command: "git log", excludeFromContext: true },
	}).then(
		() => null,
		(e: Error & { code?: string }) => e,
	);
	expect(refused?.code).toBe("bashExcludeUnsupported");
	expect(refused?.message).toContain("omp 18.18.1");
	// Nothing ran: no page was told a command started.
	expect(started).toHaveLength(0);

	// A `!command` is sent as before.
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "bash", command: "git log" } });
	expect(started).toHaveLength(1);
	ws.close();
});
