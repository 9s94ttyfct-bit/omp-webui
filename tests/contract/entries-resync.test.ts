import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { LiveInfo, SessionEntry } from "../../shared/protocol.ts";
import { watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";
import { connect, request } from "../support/ws.ts";

/**
 * What a page that was away must read when it comes back (issue #290). omp does not only append to a conversation: when
 * a retry gets past a failed turn it marks the failed assistant message in place (`retryRecovery`), and tells the
 * connected page by a frame (`auto_retry_end`). A page that missed the frame and asks `get_entries` `since` its last entry
 * is never sent the entry again, so it went on showing a failure omp had recovered. Against the real omp behind the real
 * server and a stub provider that refuses with a usage limit that ends (no model is called).
 */

let s: TestServer;
let omlx: StubOmlx;

beforeAll(async () => {
	omlx = await startStubOmlx({ limit: { status: 402 } });
	s = await startTestServer();
	writeFileSync(
		join(s.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${omlx.url}\n    api: openai-completions\n    apiKey: ${omlx.apiKey}\n    discovery:\n      type: openai-models-list\n`,
	);
	writeFileSync(
		join(s.agentDir, "config.yml"),
		[
			"modelRoles:",
			...["default", "smol", "slow", "tiny", "commit"].map((r) => `  ${r}: omlx/stub-model`),
			"spelling:",
			"  autocomplete: ngram",
			"retry:",
			"  maxDelayMs: 20000",
			"  waitForUsageReset: true",
			"",
		].join("\n"),
	);
}, 120_000);

afterAll(async () => {
	await s?.stop();
	await omlx?.stop();
});

/** What the entry's message says of its recovery, when omp wrote one. */
function recoveryOf(e: SessionEntry | undefined): unknown {
	const m = e?.message;
	return isRecord(m) ? m.retryRecovery : undefined;
}

test("a failure a retry got past is rewritten in place: `since` its id does not bring it again, reading everything does", async () => {
	const ws = await connect(s);
	const info = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.work } });
	const frames = watchFrames(ws, info.liveId);
	const rpc = <T>(command: Record<string, unknown>) => request<T>(ws, { t: "rpc", liveId: info.liveId, command });
	const entries = (since?: string) =>
		rpc<{ entries: SessionEntry[]; leafId: string | null }>({ type: "get_entries", ...(since ? { since } : {}) });
	try {
		omlx.limitUntil = 0;
		const first = frames.after("agent_end");
		await rpc({ type: "prompt", message: "hello" });
		await first;

		// The limit is in force for a few seconds: the turn fails and omp backs off. This is where a page's connection drops.
		omlx.limitUntil = Date.now() + 6000;
		const backoff = frames.after("auto_retry_start");
		await rpc({ type: "prompt", message: "retry me" });
		await backoff;
		const away = await entries();
		const failed = away.entries.at(-1);
		expect(failed?.id).toBeString();
		expect(isRecord(failed?.message) && failed.message.stopReason).toBe("error");
		expect(recoveryOf(failed)).toBeUndefined();

		// The retry gets through while the page is away.
		const recovered = await frames.after("auto_retry_end");
		expect(recovered.success).toBe(true);
		// omp has the mark on its entry by the time it says so; the poll is for the entry as `get_entries` shows it.
		await pollUntil(
			async () => recoveryOf((await entries()).entries.find((e) => e.id === failed?.id)) !== undefined,
			"the failed entry to be marked",
		);

		const after = await entries(failed?.id);
		const whole = await entries();
		// What the page asked for `since` is only what was appended: the entry omp changed is not in it...
		expect(after.entries.map((e) => e.id)).not.toContain(failed?.id);
		expect(after.entries.length).toBeGreaterThan(0);
		// ...while the whole conversation has it as omp rewrote it.
		const rewritten = whole.entries.find((e) => e.id === failed?.id);
		expect(recoveryOf(rewritten)).toMatchObject({ kind: "auto-retry", status: "recovered" });
	} finally {
		void request(ws, { t: "close", liveId: info.liveId }).catch(() => {});
		ws.close();
	}
}, 90_000);
