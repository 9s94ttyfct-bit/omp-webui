import { expect, test } from "bun:test";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { watchFrames } from "../support/frames.ts";
import { pollUntil, processExists } from "../support/poll.ts";
import { messageEnds, usageResetWaitFixture } from "../support/usage-reset-wait.ts";
import { connect, request } from "../support/ws.ts";

const fixture = usageResetWaitFixture();
const { api, conversation } = fixture;

/**
 * That omp did NOT retry is observed by giving a real omp's due timer time to fire: there is no event for a retry that
 * never starts, and a fake clock cannot move a process the test only watches.
 */
const omissionWindow = () => Bun.sleep(1500);

/** Whether a process is stopped (SIGSTOP: a paused conversation's omp). */
const stopped = (pid: number | null): boolean =>
	Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
		.stdout.toString()
		.trim()
		.startsWith("T");

test("a user's action on a paused conversation whose retry wait is over does not run omp: no retried turn starts while it is paused, and Resume lets omp retry", async () => {
	await api("/api/usage-reset-wait", { enabled: true });
	const chat = await conversation();
	try {
		fixture.backend.limitUntil = Date.now() + 4000;
		const started = chat.next("auto_retry_start");
		await chat.prompt("pause me, then ask");
		await started;
		const wait = (await chat.listing())?.retry;
		await request(chat.ws, { t: "pause", liveId: chat.liveId });
		const pid = (await chat.listing())?.pid as number;
		expect(stopped(pid)).toBe(true);
		// The reset passes while it is paused: omp's own timer is due, and fires the moment omp runs.
		await pollUntil(() => Date.now() > (wait?.startedAt ?? 0) + (wait?.delayMs ?? 0) + 500, "the wait to be over");
		const chatsBefore = fixture.backend.chats.length;
		const framesBefore = chat.frames.seen.length;

		// An action on the paused conversation (a picker, a thinking level, a rename) would run omp, and with it the retried turn.
		await expect(
			request(chat.ws, { t: "rpc", liveId: chat.liveId, command: { type: "get_state" }, user: true }),
		).rejects.toThrow(/paused/);
		await omissionWindow();
		expect(stopped(pid)).toBe(true);
		expect(fixture.backend.chats.length).toBe(chatsBefore);
		expect(chat.frames.seen.slice(framesBefore).some((f) => f.type === "agent_start")).toBe(false);
		expect((await chat.listing())?.pausedAt).toBeTruthy();
		expect((await chat.listing())?.retry).toMatchObject({ resumed: false });

		// Resume is what lets omp retry: the one request of the retried turn goes out, and the turn goes through.
		const ended = chat.next("auto_retry_end");
		await request(chat.ws, { t: "resume", liveId: chat.liveId });
		expect((await ended).success).toBe(true);
		expect(fixture.backend.chats.length - chatsBefore).toBe(1);
	} finally {
		chat.close();
		await api("/api/usage-reset-wait", { enabled: false });
	}
}, 90_000);

test("closing a paused conversation whose retry wait is over does not start the retried turn: not through Close, not through Quit and end paused", async () => {
	// omp's wait is a sleep to a monotonic deadline, which runs on while the process is stopped, so the retry is due the
	// moment SIGCONT lets omp run. Closing resumes it (it must run to read the closed stdin); the stdin closes within a
	// fraction of a millisecond, long before the retried turn could send its request. Measured against omp 18.12.2:
	// 0 of 84 closes sent one (24 one at a time, 60 six at a time with every core busy); a stub that answers every
	// request records the one that would have been billed. This guards what the server does and what omp does with it.
	await api("/api/usage-reset-wait", { enabled: true });
	const closed = await conversation();
	const ended = await conversation();
	try {
		fixture.backend.limitUntil = Date.now() + 4000;
		const waits = [closed.next("auto_retry_start"), ended.next("auto_retry_start")];
		await Promise.all([closed.prompt("close me while paused"), ended.prompt("end me while paused")]);
		await Promise.all(waits);
		const pids = [(await closed.listing())?.pid as number, (await ended.listing())?.pid as number];
		await request(closed.ws, { t: "pause", liveId: closed.liveId });
		await request(ended.ws, { t: "pause", liveId: ended.liveId });
		expect(pids.every(stopped)).toBe(true);
		await pollUntil(() => Date.now() > fixture.backend.limitUntil + 500, "the wait to be over");
		const requestsBefore = fixture.backend.chats.length + fixture.backend.refused.length;

		await request(closed.ws, { t: "close", liveId: closed.liveId });
		await pollUntil(() => !processExists(pids[0]), "the closed conversation's omp to end");
		await omissionWindow();
		expect(fixture.backend.chats.length + fixture.backend.refused.length).toBe(requestsBefore);

		const done = await api("/api/lives/end-kept", {});
		expect(await done.json()).toEqual({ ended: 1 });
		await pollUntil(() => !processExists(pids[1]), "the ended conversation's omp to end");
		await omissionWindow();
		expect(fixture.backend.chats.length + fixture.backend.refused.length).toBe(requestsBefore);
	} finally {
		closed.close();
		ended.close();
		await api("/api/usage-reset-wait", { enabled: false });
	}
}, 90_000);

test("a user's action on a paused conversation in the middle of a long retry wait still works, and omp is still waiting afterwards", async () => {
	await api("/api/usage-reset-wait", { enabled: true });
	const chat = await conversation();
	try {
		fixture.backend.limitUntil = Date.now() + 600_000;
		const started = chat.next("auto_retry_start");
		await chat.prompt("pause me in a long wait");
		await started;
		await request(chat.ws, { t: "pause", liveId: chat.liveId });
		const pid = (await chat.listing())?.pid as number;
		const chatsBefore = fixture.backend.chats.length;

		const state = await request<{ isStreaming?: boolean }>(chat.ws, {
			t: "rpc",
			liveId: chat.liveId,
			command: { type: "get_state" },
			user: true,
		});
		expect(state).toBeTruthy();
		expect(stopped(pid)).toBe(true);
		expect((await chat.listing())?.retry).toMatchObject({ usageLimit: true, resumed: false });
		expect(fixture.backend.chats.length).toBe(chatsBefore);
	} finally {
		chat.close();
		await api("/api/usage-reset-wait", { enabled: false });
	}
}, 60_000);

test("a conversation paused during a usage-limit wait keeps the wait across a restart of the server: the countdown is still there, and Retry now ends the backoff", async () => {
	await api("/api/usage-reset-wait", { enabled: true });
	const chat = await conversation();
	let ws: WebSocket | null = null;
	try {
		fixture.backend.limitUntil = Date.now() + 90_000;
		const started = chat.next("auto_retry_start");
		await chat.prompt("pause me while you wait");
		await started;
		await request(chat.ws, { t: "pause", liveId: chat.liveId });
		const waiting = (await chat.listing())?.retry;
		expect(waiting).toMatchObject({ attempt: 1, usageLimit: true, resumed: false });
		chat.ws.close();

		// The app is quit and opened again: the paused conversation outlives the server (server/omp/parked.ts).
		await fixture.server.restart();
		ws = await connect(fixture.server);
		const listed = (await request<LiveListing[]>(ws, { t: "list_lives" })).find((l) => l.liveId === chat.liveId);
		expect(listed?.pausedAt).toBeTruthy();
		expect(listed?.retry).toEqual(waiting);
		expect(listed?.busy).toBe(true);

		// A page that attaches shows the same wait; Retry now resumes the conversation, ends omp's backoff and redoes the turn.
		const frames = watchFrames(ws, chat.liveId);
		const attached = await request<LiveInfo>(ws, { t: "attach", liveId: chat.liveId });
		expect(attached.retry).toEqual(waiting);
		fixture.backend.limitUntil = 0;
		const chatsBefore = fixture.backend.chats.length;
		const ended = frames.after("auto_retry_end");
		const info = await request<LiveInfo>(ws, { t: "retry_now", liveId: chat.liveId });
		expect(info.retry).toBeUndefined();
		expect(info.pausedAt).toBeNull();
		const end = await ended;
		expect(end.success).toBe(false);
		expect(end.finalError).toBe("Retry cancelled");
		await pollUntil(
			() => messageEnds(frames.seen, "assistant").some((m) => JSON.stringify(m.content).includes("STUB-REPLY")),
			"the retried turn's reply",
		);
		expect(fixture.backend.chats.length - chatsBefore).toBe(1);
	} finally {
		if (ws) {
			void request(ws, { t: "close", liveId: chat.liveId }).catch(() => {});
			ws.close();
		}
		chat.close();
		await api("/api/usage-reset-wait", { enabled: false });
	}
}, 120_000);
