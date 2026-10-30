import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { retryPhase } from "../../web/src/lib/retry-wait.ts";
import { applySubagentFrame, mergeSnapshot } from "../../web/src/store/subagents-live.ts";
import { type Frame, watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import {
	type ScriptedRequest,
	type ScriptedTurn,
	type StubScripted,
	startScriptedStub,
} from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * A subagent's usage-limit wait (omp's `retry.waitForUsageReset` holds subagent turns too, in hours), against the real
 * omp, the real server and a provider that refuses with a usage limit (#594): what omp does with the wait while the
 * conversation is paused, what it reports of it, and which of its commands reach it. A scripted provider makes the main
 * agent start one subagent, `Sub`; the subagent's requests are refused until the test says the limit is over.
 */

const NESTED = "You are operating on a piece of work assigned to you by the main agent";
const STEER = "WAKE-UP-STEER";

let server: TestServer;
let backend: StubScripted;
/** The provider refuses the subagent's requests until then (epoch ms); 0: it does not. */
let limitUntil = 0;
/**
 * How long the limit lasts from the subagent's first request, until that request comes: omp's start (seconds, longer under
 * load) must not eat a limit that was armed before it, so the clock starts when the provider is first asked.
 */
let pendingLimitMs: number | null = null;

/** The limit is over: whatever the subagent asks next is answered. */
function lift(): void {
	limitUntil = 0;
	pendingLimitMs = null;
}

/** The subagent's requests that were not refused: the retries that went out. */
const answered: ScriptedRequest[] = [];

const script = async (req: ScriptedRequest): Promise<ScriptedTurn> => {
	if (req.text.includes(NESTED)) {
		if (pendingLimitMs !== null) {
			limitUntil = Date.now() + pendingLimitMs;
			pendingLimitMs = null;
		}
		const left = limitUntil - Date.now();
		if (left > 0) return { refuse: { retryAfterMs: left } };
		answered.push(req);
		return { text: "SUB-DONE" };
	}
	if (!req.tools.includes("task")) return { text: "A title" };
	if (req.toolResults === 0) {
		return {
			call: {
				name: "task",
				args: { context: "One scout.", tasks: [{ name: "Sub", task: "SUB-TASK: say SUB-DONE." }] },
			},
		};
	}
	return { text: "The scout reported." };
};

const api = (path: string, body?: unknown) =>
	fetch(`${server.url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

beforeAll(async () => {
	backend = await startScriptedStub(script);
	server = await startTestServer();
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
			"",
		].join("\n"),
	);
	await api("/api/usage-reset-wait", { enabled: true });
}, 120_000);

afterAll(async () => {
	await server?.stop();
	await backend?.stop();
});

/** That omp did NOT retry is observed by giving a real omp's timer time to fire: there is no frame for a retry that does not start. */
const omissionWindow = () => Bun.sleep(1500);

const subagentEvents = (frames: Frame[], type: string): Record<string, unknown>[] =>
	frames.flatMap((f) =>
		f.type === "subagent_event" && isRecord(f.payload) && isRecord(f.payload.event) && f.payload.event.type === type
			? [f.payload.event]
			: [],
	);

const lastStatus = (frames: Frame[]) =>
	frames.flatMap((f) => (f.type === "subagent_lifecycle" && isRecord(f.payload) ? [f.payload.status] : [])).at(-1);

/** Whether a process is stopped (SIGSTOP: a paused conversation's omp). */
const stopped = (pid: number | null): boolean =>
	Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
		.stdout.toString()
		.trim()
		.startsWith("T");

/** A conversation whose main agent has started `Sub`, which is refused for `limitMs` from its first request. */
async function started(limitMs: number) {
	answered.length = 0;
	limitUntil = 0;
	pendingLimitMs = limitMs;
	const ws = await connect(server);
	const info = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work } });
	const frames = watchFrames(ws, info.liveId);
	const rpc = (command: Record<string, unknown>) =>
		request<unknown>(ws, { t: "rpc", liveId: info.liveId, command, user: true });
	const listing = async () =>
		(await request<LiveListing[]>(ws, { t: "list_lives" })).find((l) => l.liveId === info.liveId);
	const waits = frames.next((f) => subagentEvents([f], "auto_retry_start").length > 0);
	await request(ws, { t: "rpc", liveId: info.liveId, command: { type: "prompt", message: "Send a scout" } });
	await waits;
	return {
		ws,
		liveId: info.liveId,
		frames,
		rpc,
		listing,
		close: () => {
			void request(ws, { t: "close", liveId: info.liveId }).catch(() => {});
			ws.close();
		},
	};
}

test("a subagent whose usage-limit wait came due while the conversation was paused retries the moment it is resumed, and the page's view of it follows", async () => {
	const chat = await started(5000);
	try {
		// What the page holds from omp's frames: the wait, counting down.
		let subs = {};
		for (const f of chat.frames.seen) subs = applySubagentFrame(subs, f);
		const wait = (subs as Record<string, { retry?: { phase?: string } | null }>).Sub?.retry;
		expect(wait).toMatchObject({ phase: "waiting", attempt: 1, usageLimit: true, resumed: false });

		await request(chat.ws, { t: "pause", liveId: chat.liveId });
		const pid = (await chat.listing())?.pid as number;
		expect(stopped(pid)).toBe(true);
		// The wait is over while omp is frozen: its timer is due, and nothing runs. The page does not call that late.
		const waiting = (wait ?? {}) as Parameters<typeof retryPhase>[0];
		await pollUntil(() => Date.now() > waiting.startedAt + waiting.delayMs + 500, "the wait to be over");
		expect(retryPhase(waiting, Date.now(), true)).toBe("due");
		const before = answered.length;
		await omissionWindow();
		expect(answered.length).toBe(before);
		expect(lastStatus(chat.frames.seen)).toBe("started");

		// The limit is over; Resume lets omp run, and its due timer retries the subagent at once (nothing is asked to).
		lift();
		const ended = chat.frames.after("subagent_lifecycle");
		await request(chat.ws, { t: "resume", liveId: chat.liveId });
		expect(((await ended).payload as Record<string, unknown>).status).toBe("completed");
		expect(answered.length - before).toBe(1);
		const [end] = subagentEvents(chat.frames.seen, "auto_retry_end");
		expect(end).toMatchObject({ success: true, attempt: 1 });

		// And the page's state, from the same frames, has no wait left.
		subs = {};
		for (const f of chat.frames.seen) subs = applySubagentFrame(subs, f);
		expect((subs as Record<string, { retry?: unknown }>).Sub.retry).toBeNull();
	} finally {
		lift();
		chat.close();
	}
}, 90_000);

test("omp's registry says a subagent is waiting (retryState) and the page can tell it from the frames; omp has no command that retries it now", async () => {
	const chat = await started(600_000);
	try {
		const listed = await chat.rpc({ type: "get_subagents" });
		const subagents = isRecord(listed) && Array.isArray(listed.subagents) ? listed.subagents : [];
		const sub = subagents.find((s) => isRecord(s) && s.id === "Sub");
		const retryState = isRecord(sub) && isRecord(sub.progress) ? sub.progress.retryState : undefined;
		// By type, not by `expect.any`: Bun's toMatchObject writes its matchers into the received object.
		if (!isRecord(retryState)) throw new Error("omp's registry carries no retryState for a subagent that waits");
		expect(retryState.attempt).toBe(1);
		expect(typeof retryState.delayMs).toBe("number");
		expect(typeof retryState.startedAtMs).toBe("number");
		// The page reading the registry (a tab that attached meanwhile) holds the same wait the frames told of.
		const fromFrames = chat.frames.seen.reduce((s, f) => applySubagentFrame(s, f), {});
		const fromRegistry = mergeSnapshot({}, subagents);

		expect((fromRegistry as Record<string, { retry?: { delayMs?: number } }>).Sub.retry?.delayMs).toBe(
			(fromFrames as Record<string, { retry?: { delayMs?: number } }>).Sub.retry?.delayMs,
		);

		// The conversation's own commands do not reach it: abort_retry is the main session's, and the main session has nothing to retry.
		lift();
		const asked = backend.requests.length;
		await chat.rpc({ type: "abort_retry" });
		await expect(request(chat.ws, { t: "retry_now", liveId: chat.liveId })).rejects.toThrow(/Nothing to retry/);
		// A message to the subagent is taken (omp says nothing against it) and kept for after the wait.
		await chat.rpc({ type: "steer_subagent", subagentId: "Sub", message: `${STEER}: continue now.` });
		await omissionWindow();
		expect(backend.requests.length).toBe(asked);
		expect(lastStatus(chat.frames.seen)).toBe("started");
		expect(subagentEvents(chat.frames.seen, "auto_retry_end")).toHaveLength(0);

		// Stopping it is the one command that ends its wait (and it ends the subagent with it).
		expect(await chat.rpc({ type: "cancel_subagent", subagentId: "Sub" })).toEqual({ cancelled: true });
		await pollUntil(() => lastStatus(chat.frames.seen) === "aborted", "the subagent to be aborted");
		const [end] = subagentEvents(chat.frames.seen, "auto_retry_end");
		expect(end).toMatchObject({ success: false, finalError: "Retry cancelled" });
		// A killed job with a queued message could resume a subagent a moment late: look after that moment too.
		await omissionWindow();
		expect(answered).toHaveLength(0);
	} finally {
		lift();
		chat.close();
	}
}, 90_000);

test("a message steered at a waiting subagent is read when its retry runs, not before", async () => {
	// 10 s: the checks below are made 1.5 s after the message, and a loaded machine may be slow to get that far.
	const chat = await started(10_000);
	try {
		const wait = subagentEvents(chat.frames.seen, "auto_retry_start")[0];
		expect(wait.delayMs).toBeGreaterThan(5000);
		const refused = backend.refused.length;
		await chat.rpc({ type: "steer_subagent", subagentId: "Sub", message: `${STEER}: continue now.` });
		// Nothing goes out while the limit holds (omp's timer has not run out), though the message is long since in.
		await omissionWindow();
		// The wait was still running (else this proves nothing): omp asked the provider for nothing.
		expect(Date.now()).toBeLessThan(limitUntil);
		expect(backend.refused.length).toBe(refused);
		expect(answered).toHaveLength(0);
		await pollUntil(
			() => lastStatus(chat.frames.seen) === "completed",
			"the retry to run and the subagent to finish",
			30_000,
		);
		expect(answered).toHaveLength(1);
		expect(Date.now()).toBeGreaterThanOrEqual(limitUntil);
		// The retried request is the first to carry the message.
		expect(answered[0].text).toContain(STEER);
	} finally {
		lift();
		chat.close();
	}
}, 90_000);
