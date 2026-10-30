import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { LiveInfo, SessionSummary } from "../../shared/protocol.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { messageWhere, watchFrames } from "../support/frames.ts";
import { apply, call, exportTo, uploadAndVerify } from "../support/migrate-http.ts";
import { canCallModel } from "../support/omp-env.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The smoke of #572 with a real model: a conversation made on one Mac, under its home folder, is moved to another Mac with
 * another home folder, opened and resumed there by a real omp, and the model answers from the moved transcript. One short
 * turn, on Claude Haiku 5.5 (the model the conversation recorded and the only one the test servers are set to use). Skipped
 * where no model can be called.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-migrate-resume-"));
const WORD = "QUOKKA-7731";
let a: TestServer;
let b: TestServer;

beforeAll(async () => {
	if (!canCallModel()) return;
	[a, b] = await Promise.all([startTestServer(), startTestServer()]);
}, 120_000);

afterAll(async () => {
	await Promise.all([a?.stop(), b?.stop()]);
	rmSync(root, { recursive: true, force: true });
});

test.if(canCallModel())(
	"a conversation moved to another home folder resumes there with its history, and the model answers from it",
	async () => {
		expect(a.home).not.toBe(b.home);
		const oldCwd = join(realpathSync(a.home), "proj");
		const made = writeSimpleSession(a.agentDir, 0x71, "Lucky word");
		// Its first turn: the person told the model a word. The fixture's reply is the model's earlier answer.
		const text = readFileSync(made, "utf8")
			.replace('"cwd":"/tmp/ompw-fixture-project"', `"cwd":${JSON.stringify(oldCwd)}`)
			.replace("Lucky word?", `My lucky word is ${WORD}. Remember it.`);
		mkdirSync(join(a.agentDir, "sessions", "-proj"), { recursive: true });
		writeFileSync(join(a.agentDir, "sessions", "-proj", basename(made)), text);
		rmSync(made);
		expect(text).toContain(WORD);

		const archive = join(root, "moved.ompw");
		await exportTo(a, archive, { credentials: false });
		expect((await uploadAndVerify(b, archive)).state).toBe("ready");
		const { ended } = await apply(b, { mode: "merge", credentials: false });
		expect(ended?.state, JSON.stringify(ended?.error)).toBe("done");

		const folder = join(realpathSync(b.home), "proj");
		mkdirSync(folder, { recursive: true });
		const listed = (await call<SessionSummary[]>(b, "/api/sessions")).body as unknown as SessionSummary[];
		const file = listed.find((s) => s.title === "Lucky word")?.file as string;
		expect(file).toBeDefined();
		expect(listed.find((s) => s.file === file)?.cwd).toBe(folder);

		const ws = await connect(b);
		const req = crypto.randomUUID();
		const reply = messageWhere(ws, (m) => m.t === "reply" && m.req === req);
		ws.send(JSON.stringify({ t: "open", req, target: { kind: "resume", sessionFile: file } }));
		const opened = (await reply) as unknown as { ok: boolean; data?: LiveInfo; error?: string };
		expect(opened.ok, opened.error).toBe(true);
		const live = opened.data as LiveInfo;
		expect(realpathSync(live.cwd)).toBe(realpathSync(folder));

		const watch = watchFrames(ws, live.liveId);
		const settled = watch.after("session_settled");
		await request(ws, {
			t: "rpc",
			liveId: live.liveId,
			command: { type: "prompt", message: "What is my lucky word? Reply with just the word." },
		});
		await settled;
		const answer = watch.seen
			.filter((f) => f.type === "message_end")
			.map((f) => JSON.stringify(f.message))
			.join("\n");
		expect(answer).toContain(WORD);
		// Only Haiku answered.
		expect(answer).not.toMatch(/"model":"(?!claude-haiku-5-5)[^"]+"/);
		await request(ws, { t: "close", liveId: live.liveId });
		ws.close();
	},
	240_000,
);
