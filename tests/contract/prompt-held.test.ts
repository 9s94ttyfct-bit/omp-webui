import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo } from "../../shared/protocol.ts";
import { messageWhere, watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";
import { connect, request } from "../support/ws.ts";

/**
 * A prompt sent while a manual `/compact` runs (issue #289). omp does not refuse it and does not answer it: it holds
 * the prompt until the compaction is over, which can be minutes, and answers then. The page used to give up on a prompt
 * at 45 s and hand the draft back, while omp went on to take the message. The server now says, with an `ack`, when it
 * has handed the command to omp, and that is all the page bounds. Against the real omp behind the real server and a stub
 * provider that holds the summary until the test lets it go (no model is called).
 */

let s: TestServer;
let omlx: StubOmlx;

beforeAll(async () => {
	omlx = await startStubOmlx();
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
			"",
		].join("\n"),
	);
}, 120_000);

afterAll(async () => {
	await s?.stop();
	await omlx?.stop();
});

test("a prompt sent during a compaction is acknowledged at once and answered when the compaction is over", async () => {
	const ws = await connect(s);
	const info = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.work } });
	const frames = watchFrames(ws, info.liveId);
	const rpc = <T>(command: Record<string, unknown>) => request<T>(ws, { t: "rpc", liveId: info.liveId, command });
	let release = () => {};
	try {
		// Enough conversation for `/compact` to ask the provider for a summary.
		for (let i = 1; i <= 6; i++) {
			const end = frames.after("agent_end");
			await rpc({ type: "prompt", message: `turn ${i} ${"lorem ipsum dolor sit amet ".repeat(4000)}` });
			await end;
		}
		// The summary is not answered until the test says so: how long the compaction runs is not a number of seconds that a
		// busy machine can overtake.
		release = omlx.hold();
		const compacted = frames.next((f) => f.type === "command_output" && String(f.text).includes("Compaction complete"));
		await rpc({ type: "prompt", message: "/compact" });
		await pollUntil(
			async () => (await rpc<{ isCompacting?: boolean }>({ type: "get_state" })).isCompacting === true,
			"omp to compact",
		);

		// The prompt, asking to be acknowledged as the page does, and what the connection says about it, in order.
		const events: string[] = [];
		const req = crypto.randomUUID();
		void messageWhere(ws, (m) => m.t === "ack" && m.req === req).then(() => events.push("ack"));
		const answered = messageWhere(ws, (m) => m.t === "reply" && m.req === req).then(() => events.push("reply"));
		void compacted.then(() => events.push("compaction over"));
		ws.send(
			JSON.stringify({
				t: "rpc",
				req,
				liveId: info.liveId,
				command: { type: "prompt", message: "while it compacts" },
				ack: true,
			}),
		);
		// Not awaited for ever: a server that does not acknowledge fails here, not at the test's own deadline.
		await pollUntil(() => events.includes("ack"), "the server to acknowledge the prompt", 15_000);
		// Acknowledged with the compaction still running (its summary is held until the test lets it go), so nothing for the
		// page to bound but that.
		expect(events).toEqual(["ack"]);
		release();
		await answered;
		// omp held it: its answer came after the compaction, not before.
		expect(events).toEqual(["ack", "compaction over", "reply"]);
	} finally {
		release();
		void request(ws, { t: "close", liveId: info.liveId }).catch(() => {});
		ws.close();
	}
}, 120_000);

test("a command that is refused or fails to be written is answered without an acknowledgement", async () => {
	const ws = await connect(s);
	try {
		const req = crypto.randomUUID();
		const seen: string[] = [];
		const answered = messageWhere(ws, (m) => {
			if (m.req === req) seen.push(m.t);
			return m.t === "reply" && m.req === req;
		});
		ws.send(
			JSON.stringify({ t: "rpc", req, liveId: "L-nowhere", command: { type: "prompt", message: "hello" }, ack: true }),
		);
		await answered;
		expect(seen).toEqual(["reply"]);
	} finally {
		ws.close();
	}
});
