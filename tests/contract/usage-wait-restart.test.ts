import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { watchFrames } from "../support/frames.ts";
import { pollUntil, processExists } from "../support/poll.ts";
import { messageEnds, usageResetWaitFixture } from "../support/usage-reset-wait.ts";
import { connect, request } from "../support/ws.ts";

/**
 * A usage-limit wait is omp's own timer in omp's own process, so what resumes the turn at the reset is that process
 * being there. The server ending meanwhile — the app quit or restarted, a crash — must not end it: the next server
 * takes the conversation over (`LivePool.adopt`) and omp retries when it says it will, with no page open.
 */

const fixture = usageResetWaitFixture();
const { api, conversation } = fixture;

/** How many answers of the stub's model the conversation holds: the first turn's, and the one the retry got through. */
const answers = (file: string): number =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(
			(line) =>
				line.includes('"role":"assistant"') && line.includes('"stopReason":"stop"') && line.includes("STUB-REPLY"),
		).length;

/** The conversation as the server lists it now, over a connection of its own. */
async function listed(ws: WebSocket, liveId: string): Promise<LiveListing | undefined> {
	return (await request<LiveListing[]>(ws, { t: "list_lives" })).find((l) => l.liveId === liveId);
}

/**
 * Real clocks again: that omp did NOT retry has nothing to be observed by but a due timer that had time to fire.
 */
const omissionWindow = () => Bun.sleep(1500);

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
	test(`${signal === "SIGTERM" ? "the server stopped and started again" : "a crash of the server"} during a usage-limit wait does not end it: the same omp retries at the reset and the conversation has the turn`, async () => {
		await api("/api/usage-reset-wait", { enabled: true });
		const chat = await conversation();
		let ws: WebSocket | null = null;
		try {
			const file = await chat.start();
			const before = answers(file);
			fixture.backend.limitUntil = Date.now() + 8000;
			const chatsBefore = fixture.backend.chats.length;
			const started = chat.next("auto_retry_start");
			await chat.prompt(`the server goes while ${signal} waits`);
			await started;
			const pid = (await chat.listing())?.pid as number;
			chat.ws.close();

			await fixture.server.restart(undefined, { signal });
			ws = await connect(fixture.server);
			// Not a new process on the file: the one that was sleeping, found again.
			const found = await listed(ws, chat.liveId);
			expect(found?.pid).toBe(pid);

			// omp's own timer fires at the reset, whatever the server did meanwhile; the one request that goes out is the retry.
			await pollUntil(() => answers(file) === before + 1, "the retried turn to be in the conversation", 30_000);
			expect(fixture.backend.chats.length - chatsBefore).toBe(1);
			expect((fixture.backend.chats.at(-1)?.at ?? 0) >= fixture.backend.limitUntil).toBe(true);
			// The wait is over, and the conversation is an ordinary idle one again.
			await pollUntil(async () => {
				const l = await listed(ws as WebSocket, chat.liveId);
				return l?.retry === undefined && l?.busy === false;
			}, "the conversation to settle");
		} finally {
			if (ws) {
				void request(ws, { t: "close", liveId: chat.liveId }).catch(() => {});
				ws.close();
			}
			chat.close();
			await api("/api/usage-reset-wait", { enabled: false });
		}
	}, 120_000);
}

test("the reset passes while no server runs: omp retries on its own, and the server that comes back finds the turn done", async () => {
	await api("/api/usage-reset-wait", { enabled: true });
	const chat = await conversation();
	let ws: WebSocket | null = null;
	try {
		const file = await chat.start();
		const before = answers(file);
		fixture.backend.limitUntil = Date.now() + 5000;
		const chatsBefore = fixture.backend.chats.length;
		const started = chat.next("auto_retry_start");
		await chat.prompt("the reset comes with nobody there");
		await started;
		const pid = (await chat.listing())?.pid as number;
		chat.ws.close();

		// Nothing runs from the stop to the start, and the reset is inside that time.
		await fixture.server.restart(undefined, { signal: "SIGKILL", downMs: 9000 });
		expect(Date.now() >= fixture.backend.limitUntil).toBe(true);
		ws = await connect(fixture.server);
		const found = await listed(ws, chat.liveId);
		expect(found?.pid).toBe(pid);
		await pollUntil(() => answers(file) === before + 1, "the retried turn to be in the conversation", 30_000);
		expect(fixture.backend.chats.length - chatsBefore).toBe(1);
		await pollUntil(async () => {
			const l = await listed(ws as WebSocket, chat.liveId);
			return l?.retry === undefined && l?.busy === false;
		}, "the conversation to settle");
	} finally {
		if (ws) {
			void request(ws, { t: "close", liveId: chat.liveId }).catch(() => {});
			ws.close();
		}
		chat.close();
		await api("/api/usage-reset-wait", { enabled: false });
	}
}, 120_000);

test("a wait that outlived a restart is still the page's to end: it shows the countdown, and Retry now redoes the turn", async () => {
	await api("/api/usage-reset-wait", { enabled: true });
	const chat = await conversation();
	let ws: WebSocket | null = null;
	try {
		const file = await chat.start();
		const before = answers(file);
		// A reset ten minutes away: only the page's click can end this wait.
		fixture.backend.limitUntil = Date.now() + 600_000;
		const started = chat.next("auto_retry_start");
		await chat.prompt("wait through a restart, then retry now");
		const wait = (await started).delayMs as number;
		const waiting = (await chat.listing())?.retry;
		expect(waiting).toMatchObject({ usageLimit: true, resumed: false, delayMs: wait });
		chat.ws.close();

		await fixture.server.restart();
		ws = await connect(fixture.server);
		const found = await listed(ws, chat.liveId);
		// The very wait omp announced: its start is the one the first server stamped, not the time of the adoption.
		expect(found?.retry).toEqual(waiting);
		expect(found?.pausedAt).toBeNull();
		const frames = watchFrames(ws, chat.liveId);
		const attached = await request<LiveInfo>(ws, { t: "attach", liveId: chat.liveId });
		expect(attached.retry).toEqual(waiting);

		fixture.backend.limitUntil = 0;
		const ended = frames.after("auto_retry_end");
		const info = await request<LiveInfo>(ws, { t: "retry_now", liveId: chat.liveId });
		expect(info.retry).toBeUndefined();
		const end = await ended;
		expect(end.success).toBe(false);
		expect(end.finalError).toBe("Retry cancelled");
		await pollUntil(
			() => messageEnds(frames.seen, "assistant").some((m) => JSON.stringify(m.content).includes("STUB-REPLY")),
			"the retried turn's reply",
		);
		expect(answers(file)).toBe(before + 1);
	} finally {
		if (ws) {
			void request(ws, { t: "close", liveId: chat.liveId }).catch(() => {});
			ws.close();
		}
		chat.close();
		await api("/api/usage-reset-wait", { enabled: false });
	}
}, 120_000);

test("a wait that is over lets its process go: a conversation that finished its retry is an ordinary idle one, and a restart ends it as it always did", async () => {
	await api("/api/usage-reset-wait", { enabled: true });
	const chat = await conversation();
	let ws: WebSocket | null = null;
	try {
		const file = await chat.start();
		const before = answers(file);
		fixture.backend.limitUntil = Date.now() + 5000;
		const started = chat.next("auto_retry_start");
		await chat.prompt("wait, retry, then stop for good");
		await started;
		const pid = (await chat.listing())?.pid as number;
		await pollUntil(() => answers(file) === before + 1, "the retried turn to be in the conversation", 30_000);
		await pollUntil(async () => {
			const l = await chat.listing();
			return l?.retry === undefined && l?.busy === false;
		}, "the conversation to settle");
		chat.ws.close();

		await fixture.server.restart();
		ws = await connect(fixture.server);
		expect(await listed(ws, chat.liveId)).toBeUndefined();
		await pollUntil(() => !processExists(pid), "the idle omp to end with the server");
	} finally {
		ws?.close();
		chat.close();
		await api("/api/usage-reset-wait", { enabled: false });
	}
}, 120_000);

test("Quit and end ends a conversation that waits out a usage limit: its omp is stopped, and nothing retries at the reset", async () => {
	await api("/api/usage-reset-wait", { enabled: true });
	const chat = await conversation();
	try {
		const file = await chat.start();
		const before = answers(file);
		fixture.backend.limitUntil = Date.now() + 5000;
		const started = chat.next("auto_retry_start");
		await chat.prompt("end me while I wait");
		await started;
		const pid = (await chat.listing())?.pid as number;
		const requestsBefore = fixture.backend.chats.length + fixture.backend.refused.length;

		const done = await api("/api/lives/end-kept", {});
		expect(await done.json()).toEqual({ ended: 1 });
		await pollUntil(() => !processExists(pid), "the waiting omp to end");
		await pollUntil(() => Date.now() > fixture.backend.limitUntil + 500, "the wait to be over");
		await omissionWindow();
		expect(fixture.backend.chats.length + fixture.backend.refused.length).toBe(requestsBefore);
		expect(answers(file)).toBe(before);
	} finally {
		chat.close();
		await api("/api/usage-reset-wait", { enabled: false });
	}
}, 90_000);
