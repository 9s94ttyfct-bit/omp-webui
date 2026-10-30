import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPACT_STEP_DIALOG_TITLE } from "../../shared/compact-step.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { type Frame, watchFrames } from "../support/frames.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import {
	type ScriptedRequest,
	type ScriptedTurn,
	type StubScripted,
	startScriptedStub,
} from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Compact between two steps (#651, option b) against the real omp and the server's own extension (`server/omp/compact-step/`),
 * with a scripted model that answers from the stub (no real model). What is shown, from what omp sends the model:
 *
 * - the compact runs at the boundary between a step's tools and the next model request: the tools of the step ran, their result
 *   is in the request that follows the summary, and the held messages go after the turn that omp carries on;
 * - a cancel leaves the turn alone, and nothing is summarized;
 * - a conversation that cannot be held (an extension of the person's own, omp set not to carry on) is compacted at the end of the
 *   turn and the page is told why;
 * - a turn with no step to hold is compacted at its end.
 */

let s: TestServer;
let agent: StubScripted;
const root = mkdtempSync(join(tmpdir(), "ompw-compact-between-"));
const SUMMARY = "A short summary of the work so far.";

/** What the script does, per scenario: the model's first request waits for `gate`, and says when it has begun. */
let gate = Promise.resolve();
let entered = Promise.withResolvers<void>();
let mainCalls = 0;
let toolFirst = true;

const isMain = (r: ScriptedRequest) => r.tools.includes("task");
const kindOf = (r: ScriptedRequest) => (isMain(r) ? "main" : /summar|conversation/i.test(r.text) ? "summary" : "other");

const script = async (req: ScriptedRequest): Promise<ScriptedTurn> => {
	const kind = kindOf(req);
	if (kind === "summary") return { text: SUMMARY };
	if (kind !== "main") return { text: "A title" };
	mainCalls++;
	if (mainCalls === 1) {
		entered.resolve();
		await gate;
		if (toolFirst)
			return {
				call: {
					name: "bash",
					args: { command: "echo STEP-A-$((40+2)); head -c 4000 /dev/zero | tr '\\0' x", timeout: 5 },
				},
			};
	}
	return { text: `Main answer ${mainCalls}.` };
};

const configText = (extra: string[] = []) =>
	[
		"modelRoles:",
		...["default", "smol", "slow", "tiny", "commit"].map((r) => `  ${r}: cb/stub-model`),
		"compaction:",
		"  keepRecentTokens: 50",
		...extra.map((l) => `  ${l}`),
		"spelling:",
		"  autocomplete: ngram",
		"",
	].join("\n");

beforeAll(async () => {
	agent = await startScriptedStub(script);
	s = await startTestServer(0, {}, { login: false });
	writeFileSync(
		join(s.agentDir, "models.yml"),
		`providers:\n  cb:\n    baseUrl: ${agent.url}\n    api: openai-completions\n    apiKey: ${agent.apiKey}\n    models:\n      - id: stub-model\n`,
	);
}, 120_000);

afterAll(async () => {
	await s?.stop();
	await agent?.stop();
	rmSync(root, { recursive: true, force: true });
});

async function until(condition: () => boolean | Promise<boolean>, what: string, ms = 90_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

interface Scenario {
	ws: WebSocket;
	liveId: string;
	frames: { seen: Frame[] };
	open(): void;
	info(): Promise<LiveInfo>;
	mains(): ScriptedRequest[];
	kinds(): string[];
	finished(): Promise<void>;
	close(): void;
}

async function scenario(options: { config?: string[]; args?: string[]; tools?: boolean }): Promise<Scenario> {
	writeFileSync(join(s.agentDir, "config.yml"), configText(options.config));
	agent.requests.length = 0;
	mainCalls = 0;
	toolFirst = options.tools ?? true;
	entered = Promise.withResolvers<void>();
	const opened = Promise.withResolvers<void>();
	gate = opened.promise;
	const ws = await connect(s);
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: {
			kind: "new",
			cwd: s.work,
			approvalMode: "yolo",
			args: ["--model", "cb/stub-model", ...(options.args ?? [])],
		},
	});
	const frames = watchFrames(ws, live.liveId);
	// The turn begins and the model's first request waits: the compact is asked for while the agent works.
	await request(ws, {
		t: "rpc",
		liveId: live.liveId,
		command: { type: "prompt", message: `PROBE-1 do things ${"lorem ipsum ".repeat(300)}` },
	});
	await entered.promise;
	const info = async () =>
		(await request<LiveInfo[]>(ws, { t: "list_lives" })).find((l) => l.liveId === live.liveId) as LiveInfo;
	return {
		ws,
		liveId: live.liveId,
		frames,
		open: () => opened.resolve(),
		info,
		mains: () => agent.requests.filter((r) => kindOf(r) === "main"),
		// omp may ask the summarizer more than once for one compact (the history, then the part of the turn it cut): one summary here.
		kinds: () =>
			agent.requests.map(kindOf).filter(
				(k, i, all) =>
					k !== "other" &&
					!(
						k === "summary" &&
						all
							.slice(0, i)
							.filter((x) => x !== "other")
							.at(-1) === "summary"
					),
			),
		finished: () =>
			until(async () => {
				const i = await info();
				return !i.streaming && i.compactQueued === undefined && i.compactEnded !== undefined;
			}, "the compact to end and the turn to settle"),
		close: () => ws.close(),
	};
}

const rpc = (c: Scenario, command: Record<string, unknown>) =>
	request<unknown>(c.ws, { t: "rpc", liveId: c.liveId, command });

test("between steps: the tools of the step run, the compact follows them, the next request carries the summary and the result, the held messages go last", async () => {
	const c = await scenario({});
	await rpc(c, { type: "prompt", message: "FOLLOW-UP-EARLY", streamingBehavior: "followUp" });
	const queued = await request<LiveInfo>(c.ws, {
		t: "compact_queue",
		liveId: c.liveId,
		where: "step",
		customInstructions: "keep the steps",
	});
	expect(queued.compactQueued).toMatchObject({ phase: "queued", where: "step", held: ["FOLLOW-UP-EARLY"] });
	expect(queued.compactQueued?.stepUnavailable).toBeUndefined();
	// A message sent while the compact waits is held with it.
	await rpc(c, { type: "prompt", message: "FOLLOW-UP-LATE", streamingBehavior: "followUp" });
	expect((await c.info()).compactQueued?.held).toEqual(["FOLLOW-UP-EARLY", "FOLLOW-UP-LATE"]);

	c.open();
	await c.finished();
	const mains = c.mains();
	// The step's tool call, the request after the compact, and one for each message that was held.
	expect(c.kinds()).toEqual(["main", "summary", "main", "main", "main"]);
	const [first, afterCompact, early, late] = mains;
	expect(first?.text).not.toContain("FOLLOW-UP");
	// Nothing of the step is lost: its result is in the request that follows the summary, which is in it too.
	expect(afterCompact?.text).toContain("STEP-A-42");
	expect(afterCompact?.text).toContain(SUMMARY);
	expect(afterCompact?.text).not.toContain("FOLLOW-UP");
	// The held messages go after the compact, in order, each in a turn of its own after the one that went on.
	expect(early?.text).toContain("FOLLOW-UP-EARLY");
	expect(late?.text).toContain("FOLLOW-UP-LATE");
	expect(late?.text.indexOf("FOLLOW-UP-EARLY")).toBeLessThan(late?.text.indexOf("FOLLOW-UP-LATE") ?? 0);
	const info = await c.info();
	expect(info.compactEnded).toMatchObject({ ok: true });
	expect(info.compactEnded?.stopped).toBeUndefined();
	// The hold is the server's: no page is shown its dialog.
	const shown = c.frames.seen.filter(
		(f: Frame) => f.type === "extension_ui_request" && f.title === COMPACT_STEP_DIALOG_TITLE,
	);
	expect(shown).toEqual([]);
	c.close();
}, 180_000);

test("cancelled before its boundary: the turn goes on as if nothing was asked, and the held message goes after it", async () => {
	const c = await scenario({});
	await rpc(c, { type: "prompt", message: "FOLLOW-UP-KEPT", streamingBehavior: "followUp" });
	await request<LiveInfo>(c.ws, { t: "compact_queue", liveId: c.liveId, where: "step" });
	const cancelled = await request<LiveInfo>(c.ws, { t: "compact_cancel", liveId: c.liveId });
	expect(cancelled.compactQueued).toBeUndefined();
	c.open();
	await until(async () => c.mains().length === 3 && !(await c.info()).streaming, "the turn and its follow-up to end");
	expect(c.kinds()).toEqual(["main", "main", "main"]);
	expect(c.mains()[2]?.text).toContain("FOLLOW-UP-KEPT");
	c.close();
}, 180_000);

test("a conversation started with the person's own --trusted-extension is compacted at the end of the turn, and says so", async () => {
	const own = join(root, "own-extension.ts");
	writeFileSync(own, "export default function () {}\n");
	const c = await scenario({ args: ["--trusted-extension", own] });
	const queued = await request<LiveInfo>(c.ws, {
		t: "compact_queue",
		liveId: c.liveId,
		where: "step",
		customInstructions: "keep the steps",
	});
	expect(queued.compactQueued).toMatchObject({ phase: "queued", where: "turn", stepUnavailable: "trustedExtension" });
	c.open();
	await c.finished();
	// Both model requests of the turn, and only then the summary.
	expect(c.kinds()).toEqual(["main", "main", "summary"]);
	expect((await c.info()).compactEnded).toMatchObject({ ok: true });
	c.close();
}, 180_000);

test("with omp set not to carry a turn on after compacting, a compact between steps is for the end of the turn", async () => {
	const c = await scenario({ config: ["autoContinue: false"] });
	const queued = await request<LiveInfo>(c.ws, { t: "compact_queue", liveId: c.liveId, where: "step" });
	expect(queued.compactQueued).toMatchObject({ phase: "queued", where: "turn", stepUnavailable: "noContinue" });
	c.open();
	await c.finished();
	expect(c.kinds()).toEqual(["main", "main", "summary"]);
	c.close();
}, 180_000);

test("a turn with no step to hold is compacted at its end", async () => {
	const c = await scenario({ tools: false });
	const queued = await request<LiveInfo>(c.ws, { t: "compact_queue", liveId: c.liveId, where: "step" });
	expect(queued.compactQueued).toMatchObject({ phase: "queued", where: "step" });
	c.open();
	await c.finished();
	expect(c.kinds()).toEqual(["main", "summary"]);
	expect((await c.info()).compactEnded).toMatchObject({ ok: true });
	c.close();
}, 180_000);
