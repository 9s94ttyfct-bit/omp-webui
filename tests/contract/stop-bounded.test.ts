import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { STOP_GRACE_MS } from "../../shared/stop.ts";
import { type Frame, messageWhere, type ServerMsg, watchFrames } from "../support/frames.ts";
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
 * Stop always ends the turn, in a bounded time (#642). The page's Stop is omp's `abort_and_restore_queue`; omp's abort ends the
 * turn the model is in, and nothing else, so what Stop has to end is tried here against the real omp, the real server and a
 * scripted provider, in each state a user found it stuck in: omp backing off before a retry (a), omp that does not answer
 * (b), a subagent that waits out a usage limit for hours while the turn that started it is over (c: the incident: the
 * conversation stays busy, and the abort of the main turn is a no-op), a tool that does not end (d). Each is stopped the way
 * the page does, several times at once, and the conversation must be idle within the bound, the earlier turns kept, and the
 * next message must work: on the same process when omp ended the turn itself, on a new one on the same file when the
 * server had to end omp's process.
 */

const NESTED = "You are operating on a piece of work assigned to you by the main agent";
/** A turn is over within this long when omp does its part (it takes milliseconds); one the server had to end takes the grace and the signals. */
const ENDS_BY_ITSELF_MS = STOP_GRACE_MS;
const ENDED_BY_SERVER_MS = STOP_GRACE_MS + 6000;

type Mode = "ok" | "main-limit" | "hold" | "tool" | "tool-trap" | "bg-job" | "sub-limit";
let mode: Mode = "ok";
let server: TestServer;
let backend: StubScripted;
/** The pid files of the stuck tool of `tool-trap` and of the background job of `bg-job`: the processes the test ends itself. */
let pidFile = "";
let jobFile = "";
const never = new Promise<never>(() => {});

/** What the user said last in a request: the model's side of the scripted conversation answers it. */
const lastUser = (req: ScriptedRequest): string => {
	const messages = JSON.parse(req.text) as { role?: string; content?: unknown }[];
	return JSON.stringify(messages.filter((m) => m.role === "user").at(-1)?.content ?? "");
};

const script = async (req: ScriptedRequest): Promise<ScriptedTurn> => {
	if (req.text.includes(NESTED)) {
		return mode === "sub-limit" ? { refuse: { retryAfterMs: 600_000, status: 429 } } : { text: "SUB-DONE" };
	}
	if (!req.tools.includes("task")) return { text: "A title" };
	const user = lastUser(req);
	const mark = /MARK-[A-Z]+/.exec(user)?.[0] ?? "none";
	// A turn that is not the stuck one is answered, whatever the mode is by then.
	if (!user.includes("STUCK") || req.toolResults > 0) return { text: `ECHO ${mark}` };
	switch (mode) {
		case "main-limit":
			return { refuse: { retryAfterMs: 600_000, status: 429 } };
		case "hold":
			return never;
		case "tool":
			return { call: { name: "bash", args: { command: "sleep 600" } } };
		case "bg-job":
			// A job of the session that is not a subagent: omp starts it and the turn goes on (and ends) without waiting for it.
			return {
				call: {
					name: "bash",
					args: { command: `/bin/sh -c 'echo $$ > ${jobFile}; exec /bin/sleep 600'`, async: true },
				},
			};
		case "tool-trap":
			return {
				call: {
					name: "bash",
					// An external shell of its own: omp's embedded shell would answer `$$` with omp's own pid.
					args: {
						command: `/bin/sh -c 'echo $$ > ${pidFile}; trap "" INT TERM HUP; while :; do /bin/sleep 1; done'`,
					},
				},
			};
		case "sub-limit":
			return {
				call: {
					name: "task",
					args: { context: "One scout.", tasks: [{ name: "Sub", task: "SUB-TASK: say SUB-DONE." }] },
				},
			};
		default:
			return { text: `ECHO ${mark}` };
	}
};

beforeAll(async () => {
	backend = await startScriptedStub(script);
	server = await startTestServer();
	pidFile = join(server.root, "stuck-tool.pid");
	jobFile = join(server.root, "background-job.pid");
	writeFileSync(
		join(server.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    discovery:\n      type: openai-models-list\n`,
	);
	writeFileSync(
		join(server.agentDir, "config.yml"),
		[
			"modelRoles:",
			...["default", "smol", "slow", "tiny", "commit"].map((r) => `  ${r}: omlx/stub-model`),
			"spelling:",
			"  autocomplete: ngram",
			"retry:",
			"  maxDelayMs: 2000",
			"  waitForUsageReset: false",
			"async:",
			"  enabled: true",
			"",
		].join("\n"),
	);
	// A usage limit is waited out (hours), as the incident's was: the retry wait the user sees is not a short backoff.
	await fetch(`${server.url}/api/usage-reset-wait`, {
		method: "POST",
		headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify({ enabled: true }),
	});
}, 120_000);

afterAll(async () => {
	await server?.stop();
	await backend?.stop();
});

const assistantSaid = (f: Frame, text: string): boolean =>
	f.type === "message_end" &&
	isRecord(f.message) &&
	f.message.role === "assistant" &&
	JSON.stringify(f.message.content).includes(text);

const subagentRetry = (f: Frame): boolean =>
	f.type === "subagent_event" &&
	isRecord(f.payload) &&
	isRecord(f.payload.event) &&
	f.payload.event.type === "auto_retry_start";

/** What Stop answers (omp's own answer, or that the server ended omp: `ended`). */
interface Stopped {
	steering?: unknown[];
	followUp?: unknown[];
	ended?: string;
	joined?: boolean;
}

/** What a page heard of one process's frames, and a way to wait for one (see `watchFrames`). */
interface Watched {
	seen: Frame[];
	next(match: (f: Frame) => boolean): Promise<Frame>;
	after(type: string): Promise<Frame>;
}

/** One conversation on its own page, opened and driven the way the page does. */
interface Chat {
	ws: WebSocket;
	info: LiveInfo;
	frames: Watched;
	/** The `live_exit` message of this process, when it comes. */
	exit: Promise<ServerMsg>;
	rpc<T>(command: Record<string, unknown>, id?: string): Promise<T>;
	/** This process as the server lists it; undefined once it has ended. */
	listing(): Promise<LiveListing | undefined>;
	/** A turn that the provider answers, resolved once its reply has come. `id` and `on`: another process of the conversation. */
	say(text: string, id?: string, on?: Watched): Promise<void>;
	/**
	 * The page's Stop pressed `times` times at once; how long the answers took, and what they were. `resumeFirst`: as the page
	 * does for a paused conversation, the resume goes out first and the abort right behind it, without waiting for its answer.
	 */
	stop(times: number, resumeFirst?: boolean): Promise<{ ms: number; answers: Stopped[] }>;
	close(): void;
}

async function conversation(): Promise<Chat> {
	const ws = await connect(server);
	const info = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work } });
	const frames = watchFrames(ws, info.liveId);
	const exit = messageWhere(ws, (m) => m.t === "live_exit" && m.liveId === info.liveId);
	const rpc = <T>(command: Record<string, unknown>, id = info.liveId) =>
		request<T>(ws, { t: "rpc", liveId: id, command });
	const listing = async () =>
		(await request<LiveListing[]>(ws, { t: "list_lives" })).find((l) => l.liveId === info.liveId);
	return {
		ws,
		info,
		frames,
		exit,
		rpc,
		listing,
		/** A turn that the provider answers; resolves once it is over, with the conversation's file. */
		async say(text: string, id = info.liveId, on = frames): Promise<void> {
			const mark = /MARK-[A-Z]+/.exec(text)?.[0] ?? "none";
			const answered = on.next((f) => assistantSaid(f, `ECHO ${mark}`));
			await rpc({ type: "prompt", message: text }, id);
			await answered;
		},
		/** The page's Stop pressed `times` times at once; see `Chat.stop`. */
		async stop(times: number, resumeFirst = false): Promise<{ ms: number; answers: Stopped[] }> {
			if (resumeFirst) void request(ws, { t: "resume", liveId: info.liveId }).catch(() => {});
			const began = Date.now();
			const answers = await Promise.all(
				Array.from({ length: times }, () =>
					request<Stopped>(ws, {
						t: "rpc",
						liveId: info.liveId,
						command: { type: "abort_and_restore_queue" },
						stop: true,
					}),
				),
			);
			return { ms: Date.now() - began, answers };
		},
		close() {
			void request(ws, { t: "close", liveId: info.liveId }).catch(() => {});
			ws.close();
		},
	};
}

/** A conversation with one turn behind it (so that it has a file), and a second one that is stuck as `how` says. */
async function stuck(how: Mode, ready: (f: Frame) => boolean): Promise<{ chat: Chat; file: string }> {
	mode = "ok";
	const chat = await conversation();
	await chat.say("FIRST-TURN MARK-FIRST");
	const file = (await chat.listing())?.sessionFile;
	if (!file) throw new Error("the first turn left no session file");
	mode = how;
	const waiting = chat.frames.next(ready);
	await chat.rpc({ type: "prompt", message: "STUCK-TURN MARK-STUCK" });
	await waiting;
	return { chat, file };
}

/**
 * The conversation stopped by itself: no stream and no retry at the answer, the same process is idle a moment after (omp says the
 * session is settled with a frame of its own, behind the answer), and the next message is answered by it.
 */
async function expectIdleAndUsable(chat: Chat, ms: number): Promise<void> {
	expect(ms).toBeLessThan(ENDS_BY_ITSELF_MS);
	const over = await chat.listing();
	expect(over).toMatchObject({ exited: false, streaming: false });
	expect(over?.retry).toBeUndefined();
	await pollUntil(async () => (await chat.listing())?.busy === false, "the conversation to be idle", ENDS_BY_ITSELF_MS);
	mode = "ok";
	await chat.say("NEXT MARK-NEXT");
}

/** omp's process was ended by the server: the page was told why, nothing is left, and the file reopens with what was said before. */
async function expectEndedAndReopens(chat: Chat, file: string, ms: number, pid: number): Promise<void> {
	expect(ms).toBeLessThan(ENDED_BY_SERVER_MS);
	expect(await chat.exit).toMatchObject({ t: "live_exit", by: "server", reason: "stopped" });
	expect(processExists(pid)).toBe(false);
	// The conversation is no longer listed as running: nothing holds it busy.
	expect(await chat.listing()).toBeUndefined();
	// The file holds what was said before the stop, and a new process on it takes the next message.
	mode = "ok";
	const again = await request<LiveInfo>(chat.ws, { t: "open", target: { kind: "resume", sessionFile: file } });
	expect(again.liveId).not.toBe(chat.info.liveId);
	const frames = watchFrames(chat.ws, again.liveId);
	const entries = await chat.rpc<{ entries: unknown[] }>({ type: "get_entries" }, again.liveId);
	expect(JSON.stringify(entries)).toContain("FIRST-TURN MARK-FIRST");
	expect(JSON.stringify(entries)).toContain("ECHO MARK-FIRST");
	await chat.say("NEXT MARK-NEXT", again.liveId, frames);
	await request(chat.ws, { t: "close", liveId: again.liveId });
}

test("(a) omp backs off before a retry of a usage limit: Stop ends the wait, repeated presses do nothing more, and the next message works", async () => {
	const { chat } = await stuck("main-limit", (f) => f.type === "auto_retry_start");
	try {
		const { ms, answers } = await chat.stop(4);
		expect(answers).toHaveLength(4);
		await expectIdleAndUsable(chat, ms);
	} finally {
		chat.close();
	}
}, 90_000);

test("(b) omp does not answer at all (frozen): Stop ends its process within the bound, says why, keeps the file, and the next message reopens it", async () => {
	const { chat, file } = await stuck("hold", (f) => f.type === "agent_start");
	try {
		const pid = (await chat.listing())?.pid as number;
		expect(processExists(pid)).toBe(true);
		// Not a pause of the server's: a process that stopped answering, which no abort reaches.
		process.kill(pid, "SIGSTOP");
		const { ms, answers } = await chat.stop(10);
		// Every press got the same outcome: the one Stop that ran.
		expect(answers.every((a) => a.ended === "stopped")).toBe(true);
		await expectEndedAndReopens(chat, file, ms, pid);
	} finally {
		chat.close();
	}
}, 120_000);

test("(b2) the provider holds the request open forever: Stop ends the turn itself, and the next message works", async () => {
	const { chat } = await stuck("hold", (f) => f.type === "agent_start");
	try {
		const { ms } = await chat.stop(3);
		await expectIdleAndUsable(chat, ms);
	} finally {
		chat.close();
	}
}, 90_000);

test("(c) a subagent waits out a usage limit for hours after the turn that started it is over: Stop ends it, and the conversation is idle", async () => {
	const { chat } = await stuck("sub-limit", subagentRetry);
	try {
		// The incident: nothing streams, and the conversation is busy for as long as the subagent waits (hours).
		await chat.frames.next((f) => f.type === "agent_end");
		const waiting = await chat.listing();
		expect(waiting).toMatchObject({ streaming: false, busy: true });
		const { ms } = await chat.stop(5);
		expect(
			chat.frames.seen.some(
				(f) => f.type === "subagent_lifecycle" && isRecord(f.payload) && f.payload.status === "aborted",
			),
		).toBe(true);
		await expectIdleAndUsable(chat, ms);
	} finally {
		chat.close();
	}
}, 90_000);

test("(c) a paused conversation whose subagent waits for a usage limit is stopped too: it runs again for it, and is idle after", async () => {
	const { chat } = await stuck("sub-limit", subagentRetry);
	try {
		await chat.frames.next((f) => f.type === "agent_end");
		await request(chat.ws, { t: "pause", liveId: chat.info.liveId });
		expect((await chat.listing())?.pausedAt).not.toBeNull();
		const { ms } = await chat.stop(2, true);
		expect((await chat.listing())?.pausedAt).toBeNull();
		await expectIdleAndUsable(chat, ms);
	} finally {
		chat.close();
	}
}, 90_000);

test("(d) a tool that does not end (sleep 600): Stop ends the turn within the bound, and the next message works", async () => {
	const { chat } = await stuck("tool", (f) => f.type === "tool_execution_start");
	try {
		const { ms } = await chat.stop(3);
		await expectIdleAndUsable(chat, ms);
	} finally {
		chat.close();
	}
}, 90_000);

/**
 * A tool that ignores TERM, INT and HUP, run as a shell of its own (omp's embedded shell would answer `$$` with omp's own pid).
 * Measured against omp 18.12.6: its abort ends the turn and the tool's process with it (gone within a few seconds), and omp is
 * not ended: Stop has nothing to add here, so the conversation is idle on the same process.
 */
test("(d) a tool that ignores TERM, INT and HUP: Stop ends the turn within the bound and the conversation is idle", async () => {
	const { chat } = await stuck("tool-trap", (f) => f.type === "tool_execution_start");
	let tool = 0;
	try {
		await pollUntil(() => existsSync(pidFile), "the stuck tool to write its pid");
		tool = Number(readFileSync(pidFile, "utf8").trim());
		const omp = (await chat.listing())?.pid;
		expect(tool).not.toBe(omp);
		expect(processExists(tool)).toBe(true);
		const { ms } = await chat.stop(3);
		expect(ms).toBeLessThan(ENDED_BY_SERVER_MS);
		const left = await chat.listing();
		// omp ended the turn, or the server ended omp: either way nothing holds the conversation busy.
		expect(left === undefined || (left.busy === false && left.streaming === false)).toBe(true);
		await pollUntil(() => !processExists(tool), "omp to end the stuck tool", 10_000);
	} finally {
		// The tool is this test's own process: it does not outlive the test, whatever happened to it.
		if (tool > 0) {
			try {
				process.kill(tool, "SIGKILL");
			} catch {
				// already gone
			}
		}
		chat.close();
	}
}, 120_000);

test("a paused conversation that is mid-turn is stopped: it runs again, and the turn ends", async () => {
	const { chat } = await stuck("hold", (f) => f.type === "agent_start");
	try {
		await request(chat.ws, { t: "pause", liveId: chat.info.liveId });
		expect((await chat.listing())?.pausedAt).not.toBeNull();
		const { ms } = await chat.stop(2, true);
		expect((await chat.listing())?.pausedAt).toBeNull();
		await expectIdleAndUsable(chat, ms);
	} finally {
		chat.close();
	}
}, 90_000);

test("a Stop with no resume before it (another client's) runs a paused conversation again by itself, and the turn ends", async () => {
	const { chat } = await stuck("hold", (f) => f.type === "agent_start");
	try {
		await request(chat.ws, { t: "pause", liveId: chat.info.liveId });
		expect((await chat.listing())?.pausedAt).not.toBeNull();
		const { ms } = await chat.stop(1);
		expect((await chat.listing())?.pausedAt).toBeNull();
		await expectIdleAndUsable(chat, ms);
	} finally {
		chat.close();
	}
}, 90_000);

test("(e) a background job of the session that is not a subagent is left running by Stop: Stop answers, omp and the job are not ended", async () => {
	const { chat } = await stuck("bg-job", (f) => f.type === "tool_execution_end");
	let job = 0;
	try {
		await pollUntil(() => existsSync(jobFile), "the background job to write its pid");
		job = Number(readFileSync(jobFile, "utf8").trim());
		const omp = (await chat.listing())?.pid as number;
		expect(job).not.toBe(omp);
		// The turn is over, and the job keeps the session busy for as long as it runs (omp's `isSettled: false`).
		await pollUntil(async () => {
			const l = await chat.listing();
			return l?.streaming === false && l.busy === true;
		}, "the turn to end with the job still running");
		const { ms, answers } = await chat.stop(3);
		expect(ms).toBeLessThan(ENDS_BY_ITSELF_MS);
		expect(answers.some((a) => a.ended !== undefined)).toBe(false);
		// Stop is for the turn: omp keeps its job, and omp is not ended for it.
		expect((await chat.listing())?.pid).toBe(omp);
		expect(processExists(omp)).toBe(true);
		expect(processExists(job)).toBe(true);
		mode = "ok";
		await chat.say("NEXT MARK-NEXT");
	} finally {
		if (job > 0) {
			try {
				process.kill(job, "SIGKILL");
			} catch {
				// already gone
			}
		}
		chat.close();
	}
}, 120_000);

test("an abort without the Stop marker (cancelling an interview) is omp's plain command: no subagent is cancelled and omp is not ended", async () => {
	const { chat } = await stuck("sub-limit", subagentRetry);
	try {
		await chat.rpc({ type: "abort" });
		// A real wait: an absence has no event to wait for. A sweep of subagents, if the abort made one, goes out at once.
		await Bun.sleep(1500);
		expect(
			chat.frames.seen.some(
				(f) => f.type === "subagent_lifecycle" && isRecord(f.payload) && f.payload.status === "aborted",
			),
		).toBe(false);
		expect(await chat.listing()).toMatchObject({ exited: false, busy: true });
	} finally {
		await chat.stop(1).catch(() => {});
		chat.close();
	}
}, 90_000);

test("a press that joins a Stop under way is told so and is not given the queue again: the page that pressed first has it", async () => {
	const { chat } = await stuck("hold", (f) => f.type === "agent_start");
	try {
		await chat.rpc({ type: "prompt", message: "QUEUED MARK-Q", streamingBehavior: "followUp" });
		await pollUntil(async () => {
			const state = await chat.rpc<{ queuedMessageCount?: number }>({ type: "get_state" });
			return (state.queuedMessageCount ?? 0) > 0;
		}, "the message to be queued");
		const { answers } = await chat.stop(2);
		expect(JSON.stringify(answers[0].followUp)).toContain("QUEUED MARK-Q");
		expect(answers[0].joined).toBeUndefined();
		expect(answers[1].joined).toBe(true);
		expect(answers[1].followUp).toBeUndefined();
		expect(answers[1].steering).toBeUndefined();
	} finally {
		chat.close();
	}
}, 90_000);

test("omp that ends while Stop waits ends the Stop: no wait for the grace, no signal to a process that is gone", async () => {
	const { chat } = await stuck("hold", (f) => f.type === "agent_start");
	try {
		const pid = (await chat.listing())?.pid as number;
		// A frozen omp: the abort is never answered, so Stop waits. Then omp is killed by someone else.
		process.kill(pid, "SIGSTOP");
		const stopping = chat.stop(1);
		await Bun.sleep(300);
		process.kill(pid, "SIGKILL");
		const { ms, answers } = await stopping;
		expect(ms).toBeLessThan(STOP_GRACE_MS);
		expect(answers[0].ended).toBe("exited");
		expect(processExists(pid)).toBe(false);
	} finally {
		chat.close();
	}
}, 90_000);
