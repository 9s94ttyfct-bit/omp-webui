import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GuardConfig, GuardDecision } from "../../shared/guard.ts";
import { isRecord } from "../../shared/guards.ts";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { RISK_DENY } from "../../shared/risk-confirm.ts";
import { type Frame, watchFrames } from "../support/frames.ts";
import { pollUntil, processExists } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import {
	type ScriptedRequest,
	type ScriptedTurn,
	type StubScripted,
	startScriptedStub,
} from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * "Open it again" of the notice over a conversation that runs without the gate of "Guard dangerous commands"
 * (`GuardUngated`), against the real omp (18.12), the real server and a scripted model. The page ends the process with the
 * restart of the loaded-extensions dialog (`POST /api/controls/restart`) and resumes the conversation's file; the server
 * refuses the restart unless the conversation is idle, so that a paused turn, a running one and a wait for a usage limit
 * are never cut off by it. The conversation here is started with the user's own `--trusted-extension`, which the server
 * marks `ungated: "chosen"` (the endpoint does not tell the two kinds of ungated apart). A risky call is a file written
 * outside the project folder, inside the folder this test made; the one that is let through the gate is refused by the
 * person, so that nothing is written whichever way the gate behaves.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-guard-reopen-"));
const outside = join(root, "outside");
let s: TestServer;
let agent: StubScripted;

/** What the scripted agent does next. */
const plan: {
	/** The one tool call the next turn makes (taken once). */
	call: { name: string; args: unknown } | null;
	/** A turn that has reached the model waits for this before it is answered. */
	hold: Promise<void> | null;
	/** While in the future, the model refuses with a usage limit that ends then. */
	limitUntil: number;
	/** The requests of the main agent so far (the title's are not). */
	arrived: number;
} = { call: null, hold: null, limitUntil: 0, arrived: 0 };

const agentScript = async (req: ScriptedRequest): Promise<ScriptedTurn> => {
	// The title of a conversation is asked with no tools.
	if (!req.tools.includes("write")) return { text: "A title" };
	plan.arrived++;
	const left = plan.limitUntil - Date.now();
	if (left > 0) return { refuse: { retryAfterMs: left } };
	if (plan.hold) await plan.hold;
	const messages: { role?: string }[] = JSON.parse(req.text);
	if (messages.at(-1)?.role === "tool") return { text: "Main done." };
	const call = plan.call;
	plan.call = null;
	return call ? { call } : { text: "Main done." };
};

/** The next turn waits at the model until `release()`. */
function holdTurn(): () => void {
	const held = Promise.withResolvers<void>();
	plan.hold = held.promise;
	return () => {
		plan.hold = null;
		held.resolve();
	};
}

const authed = (extra: Record<string, string> = {}) => ({
	"x-omp-webui-token": s.accessToken,
	"x-omp-webui": "1",
	...extra,
});
const setGuard = async (patch: Partial<GuardConfig>): Promise<void> => {
	const res = await fetch(`${s.url}/api/guard`, {
		method: "POST",
		headers: authed({ "content-type": "application/json" }),
		body: JSON.stringify(patch),
	});
	expect(res.status).toBe(200);
};
const log = async (): Promise<GuardDecision[]> => {
	const res = await fetch(`${s.url}/api/guard/log?limit=100`, { headers: authed() });
	expect(res.status).toBe(200);
	return ((await res.json()) as { decisions: GuardDecision[] }).decisions.reverse();
};

/** What the page asks of the server to end an idle process: the restart, and what it answered. */
async function restart(liveId: string): Promise<{ status: number; error: string }> {
	const res = await fetch(`${s.url}/api/controls/restart`, {
		method: "POST",
		headers: authed({ "content-type": "application/json" }),
		body: JSON.stringify({ live: liveId }),
	});
	const body: unknown = await res.json();
	return { status: res.status, error: isRecord(body) && typeof body.error === "string" ? body.error : "" };
}

beforeAll(async () => {
	mkdirSync(outside, { recursive: true });
	agent = await startScriptedStub(agentScript);
	s = await startTestServer(0, {}, { login: false });
	writeFileSync(
		join(s.agentDir, "models.yml"),
		[
			"providers:",
			"  omlx:",
			`    baseUrl: ${agent.url}`,
			"    api: openai-completions",
			`    apiKey: ${agent.apiKey}`,
			"    models:",
			"      - id: stub-model",
			"",
		].join("\n"),
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
	// A process that waits out a usage limit outlives the server unless it is ended.
	if (s) await fetch(`${s.url}/api/lives/end-kept`, { method: "POST", headers: authed() }).catch(() => {});
	await s?.stop();
	await agent?.stop();
	rmSync(root, { recursive: true, force: true });
});

/** What one tab is told of a process's frames (see `watchFrames`). */
interface Watched {
	seen: Frame[];
	next(match: (f: Frame) => boolean): Promise<Frame>;
	after(type: string): Promise<Frame>;
}

/** One tab on a conversation, and what a test needs of it. */
interface UngatedConversation {
	ws: WebSocket;
	liveId: string;
	frames: Watched;
	listing: (id?: string) => Promise<LiveListing | undefined>;
	pid: number;
	prompt: (message?: string) => Promise<unknown>;
	/** The first frame from now on that satisfies `match`. */
	next: (match: (f: Frame) => boolean) => Promise<Frame>;
	/** The conversation answered with the scripted text (the turn was not lost). */
	answered: () => boolean;
	close: () => Promise<void>;
}

/** A conversation whose omp the server started without the gate (the user's own `--trusted-extension`), on a tab of its own. */
async function ungated(): Promise<UngatedConversation> {
	await setGuard({ mode: "ask", reviewer: "" });
	const own = join(root, "trusted.ts");
	writeFileSync(own, "export default function () {}\n");
	const ws = await connect(s);
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: s.work, approvalMode: "yolo", args: ["--trusted-extension", own] },
	});
	const { liveId } = live;
	const frames = watchFrames(ws, liveId);
	const listing = async (id = liveId) =>
		(await request<LiveListing[]>(ws, { t: "list_lives" })).find((l) => l.liveId === id);
	await pollUntil(async () => (await listing())?.ungated === "chosen", "the process to be said ungated");
	expect(live.args).not.toContain("--extension");
	// Its turns are the page's to run only while the guard is off (a process without the gate is refused them otherwise).
	await setGuard({ mode: "off" });
	return {
		ws,
		liveId,
		frames,
		listing,
		pid: (await listing())?.pid as number,
		prompt: (message = "go") => request(ws, { t: "rpc", liveId, command: { type: "prompt", message } }),
		/** The first frame from now on that satisfies `match`. */
		next: (match: (f: Frame) => boolean) => {
			const from = frames.seen.length;
			return frames.next((f) => frames.seen.indexOf(f) >= from && match(f));
		},
		/** The conversation answered with the scripted text (the turn was not lost). */
		answered: () =>
			frames.seen.some(
				(f) =>
					f.type === "message_end" &&
					isRecord(f.message) &&
					f.message.role === "assistant" &&
					JSON.stringify(f.message.content).includes("Main done."),
			),
		async close() {
			await request(ws, { t: "close", liveId }).catch(() => {});
			ws.close();
		},
	};
}

/** A turn is under way: the model has been asked and has not answered. */
async function turnAtTheModel(c: UngatedConversation): Promise<() => void> {
	const release = holdTurn();
	const before = plan.arrived;
	await c.prompt();
	await pollUntil(() => plan.arrived > before, "the turn to reach the model");
	return release;
}

test("paused mid-turn: the restart is refused, and the turn is not lost", async () => {
	const c = await ungated();
	const release = await turnAtTheModel(c);
	try {
		await request(c.ws, { t: "pause", liveId: c.liveId });
		const refused = await restart(c.liveId);
		expect(refused.status).toBe(409);
		expect(refused.error).toMatch(/paused/i);
		// Nothing was cut off: the process is there, and it is still paused on its turn.
		const held = await c.listing();
		expect(held).toMatchObject({ exited: false, holding: "paused", ungated: "chosen" });
		expect(held?.pausedAt).not.toBeNull();
		expect(processExists(c.pid)).toBe(true);

		await request(c.ws, { t: "resume", liveId: c.liveId });
		const ended = c.next((f) => f.type === "agent_end");
		release();
		await ended;
		expect(c.answered()).toBe(true);
	} finally {
		release();
		await c.close();
	}
}, 120_000);

test("running mid-turn: the restart is refused, and the turn goes on to its end", async () => {
	const c = await ungated();
	const release = await turnAtTheModel(c);
	try {
		const refused = await restart(c.liveId);
		expect(refused.status).toBe(409);
		expect(refused.error).toMatch(/working/i);
		expect(await c.listing()).toMatchObject({ exited: false, holding: "working" });
		expect(processExists(c.pid)).toBe(true);

		const ended = c.next((f) => f.type === "agent_end");
		release();
		await ended;
		expect(c.answered()).toBe(true);
	} finally {
		release();
		await c.close();
	}
}, 120_000);

test("waiting out a usage limit: the restart is refused, and the wait is intact: it retries by itself at the reset", async () => {
	const c = await ungated();
	try {
		plan.limitUntil = Date.now() + 9000;
		const started = c.next((f) => f.type === "auto_retry_start");
		await c.prompt();
		await started;
		const waiting = (await c.listing())?.retry;
		expect(waiting).toMatchObject({ usageLimit: true });

		const refused = await restart(c.liveId);
		expect(refused.status).toBe(409);
		expect(refused.error).toMatch(/working/i);
		const held = await c.listing();
		expect(held).toMatchObject({ exited: false, holding: "working" });
		expect(held?.retry).toEqual(waiting);
		expect(processExists(c.pid)).toBe(true);

		// Nobody touched it: omp's own timer fires at the reset, and the turn that failed is answered.
		await pollUntil(() => c.answered(), "the retried turn to be answered", 40_000);
		await pollUntil(async () => {
			const l = await c.listing();
			return l?.retry === undefined && l?.busy === false;
		}, "the conversation to settle");
	} finally {
		plan.limitUntil = 0;
		await c.close();
		await pollUntil(() => !processExists(c.pid), "the process to end");
	}
}, 120_000);

test("idle: the restart ends it, and the same file opened again starts a process with the gate, which a risky call goes through", async () => {
	const c = await ungated();
	let again: { ws: WebSocket; liveId: string } | null = null;
	try {
		const ended = c.next((f) => f.type === "agent_end");
		await c.prompt();
		await ended;
		await pollUntil(async () => (await c.listing())?.busy === false, "the conversation to settle");
		const file = (await c.listing())?.sessionFile ?? "";
		expect(file).not.toBe("");

		expect((await restart(c.liveId)).status).toBe(200);
		await pollUntil(async () => {
			const l = await c.listing();
			return !l || l.exited;
		}, "the process to end");
		expect(processExists(c.pid)).toBe(false);

		// The page then resumes the conversation's file: a new process, started with the gate.
		await setGuard({ mode: "ask", reviewer: "" });
		const ws = await connect(s);
		const live = await request<LiveInfo>(ws, {
			t: "open",
			target: { kind: "resume", sessionFile: file },
		});
		again = { ws, liveId: live.liveId };
		expect(live.liveId).not.toBe(c.liveId);
		expect(live.sessionFile).toBe(file);
		expect(live.args).toContain("--extension");
		const listed = async () =>
			(await request<LiveListing[]>(ws, { t: "list_lives" })).find((l) => l.liveId === live.liveId);
		await pollUntil(async () => {
			const l = await listed();
			return l !== undefined && l.pid !== c.pid && l.ungated === undefined;
		}, "the new process to be covered");
		expect((await listed())?.ungated).toBeUndefined();

		// A risky call of the new process is put to the person, as the guard says: refused here, so nothing is written.
		const frames = watchFrames(ws, live.liveId);
		const target = join(outside, "after-reopen.txt");
		plan.call = { name: "write", args: { path: target, content: "from the agent" } };
		const decisions = (await log()).length;
		const question = frames.next(
			(f) =>
				f.type === "extension_ui_request" &&
				f.method === "select" &&
				String(f.title ?? "").startsWith("Confirm risky call:"),
		);
		const done = frames.after("agent_end");
		await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: "write it" } });
		const asked = await question;
		ws.send(JSON.stringify({ t: "ui_response", liveId: live.liveId, response: { id: asked.id, value: RISK_DENY } }));
		await done;
		expect(existsSync(target)).toBe(false);
		await pollUntil(async () => (await log()).length > decisions, "the gate's decision");
		expect((await log()).at(-1)).toMatchObject({ verdict: "deny", by: "person", tool: "write", mode: "ask" });
	} finally {
		await setGuard({ mode: "off" });
		if (again) {
			await request(again.ws, { t: "close", liveId: again.liveId }).catch(() => {});
			again.ws.close();
		}
		await c.close();
	}
}, 180_000);
