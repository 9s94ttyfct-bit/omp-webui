import { expect, test } from "bun:test";
import type { LiveInfo } from "../../shared/protocol.ts";
import { isUsageLimitError } from "../../shared/retry.ts";
import { pollUntil } from "../support/poll.ts";
import { messageEnds, usageResetWaitFixture } from "../support/usage-reset-wait.ts";
import { connect, request } from "../support/ws.ts";

const fixture = usageResetWaitFixture();
const { api, conversation } = fixture;

test("omp waits out the usage limit and the turn continues at the reset, through the relay: the server shows omp's countdown and holds the process busy meanwhile", async () => {
	await api("/api/usage-reset-wait", { enabled: true });
	const chat = await conversation();
	try {
		fixture.backend.limitUntil = Date.now() + 8000;
		const refusedBefore = fixture.backend.refused.length;
		const chatsBefore = fixture.backend.chats.length;
		const started = chat.next("auto_retry_start");
		await chat.prompt("hello again");
		const start = await started;
		// omp announced the wait of the limit, and said it was the usage limit (its own flag in the errorId).
		expect(isUsageLimitError(start.errorId)).toBe(true);
		expect(start.delayMs as number).toBeGreaterThan(5000);
		const listed = await chat.listing();
		expect(listed?.retry).toMatchObject({ attempt: 1, usageLimit: true });
		expect(listed?.retry?.delayMs).toBe(start.delayMs as number);
		expect(listed?.busy).toBe(true);

		const end = await chat.next("auto_retry_end");
		expect(end.success).toBe(true);
		// The request at the reset is the one that got through: one refusal, no repeated asking.
		expect(fixture.backend.refused.length - refusedBefore).toBe(1);
		expect(fixture.backend.chats.length - chatsBefore).toBe(1);
		expect((fixture.backend.chats.at(-1)?.at ?? 0) >= fixture.backend.limitUntil).toBe(true);
		await pollUntil(async () => (await chat.listing())?.retry === undefined, "the countdown to end");
		await pollUntil(async () => (await chat.listing())?.busy === false, "the conversation to settle");
		// What the turn says, in the conversation.
		expect(
			messageEnds(chat.frames.seen, "assistant").some((m) => JSON.stringify(m.content).includes("STUB-REPLY")),
		).toBe(true);
	} finally {
		chat.close();
	}
}, 90_000);

test("the server marks the wait resumed when omp starts the retried turn, and not before: a turn in progress during the backoff says nothing", async () => {
	await api("/api/usage-reset-wait", { enabled: true });
	const chat = await conversation();
	const early = await connect(fixture.server);
	const late = await connect(fixture.server);
	let release = () => {};
	try {
		// The retried turn is not answered until the test lets it go, so that the conversation can be looked at while it
		// runs: how long that takes is not a number of seconds that a busy machine can overtake.
		release = fixture.backend.hold();
		fixture.backend.limitUntil = Date.now() + 6000;
		const started = chat.next("auto_retry_start");
		await chat.prompt("is it resumed");
		await started;

		// During the backoff a tab that attaches is told that omp is still waiting, whatever else omp reports.
		const waiting = await request<LiveInfo>(early, { t: "attach", liveId: chat.liveId });
		expect(waiting.retry).toMatchObject({ attempt: 1, usageLimit: true, resumed: false });
		// omp reports a turn in progress for the whole backoff, which is why `streaming` cannot tell the retried turn.
		expect(waiting.streaming).toBe(true);
		expect((await chat.listing())?.retry?.resumed).toBe(false);

		// omp sleeps through the limit and starts the retried turn: from then on the server says so, in its announcement too.
		await pollUntil(async () => (await chat.listing())?.retry?.resumed === true, "the retried turn to start");
		expect(Date.now() >= fixture.backend.limitUntil).toBe(true);
		expect(chat.infos.some((i) => i.retry?.resumed === true)).toBe(true);
		const running = await request<LiveInfo>(late, { t: "attach", liveId: chat.liveId });
		expect(running.retry).toMatchObject({ attempt: 1, usageLimit: true, resumed: true });

		// The wait is over when omp says so; then there is nothing to show.
		const ended = chat.next("auto_retry_end");
		release();
		const end = await ended;
		expect(end.success).toBe(true);
		await pollUntil(async () => (await chat.listing())?.retry === undefined, "the retry to end");
	} finally {
		release();
		early.close();
		late.close();
		chat.close();
		await api("/api/usage-reset-wait", { enabled: false });
	}
}, 90_000);
test("Retry now, from omp's own commands: abort_retry ends the backoff, /retry redoes the failed turn at once, and it goes through", async () => {
	await api("/api/usage-reset-wait", { enabled: true });
	const chat = await conversation();
	try {
		// A reset ten minutes away: omp sleeps for it. The provider is fine again (the page's case when omp's own timer is overdue).
		fixture.backend.limitUntil = Date.now() + 600_000;
		const chatsBefore = fixture.backend.chats.length;
		const started = chat.next("auto_retry_start");
		await chat.prompt("retry me now");
		expect((await started).delayMs as number).toBeGreaterThan(500_000);
		fixture.backend.limitUntil = 0;

		const ended = chat.next("auto_retry_end");
		const info = await request<LiveInfo>(chat.ws, { t: "retry_now", liveId: chat.liveId });
		expect(info.retry).toBeUndefined();
		const end = await ended;
		expect(end.success).toBe(false);
		expect(end.finalError).toBe("Retry cancelled");
		// omp's own /retry ran the turn again, and the provider answered it.
		await pollUntil(
			() => messageEnds(chat.frames.seen, "assistant").some((m) => JSON.stringify(m.content).includes("STUB-REPLY")),
			"the retried turn's reply",
		);
		expect(fixture.backend.chats.length - chatsBefore).toBe(1);
		// The conversation has one user message: /retry redid the turn, it did not add a prompt.
		expect(
			messageEnds(chat.frames.seen, "user").filter((m) => JSON.stringify(m.content).includes("retry me now")),
		).toHaveLength(1);
		await pollUntil(async () => (await chat.listing())?.busy === false, "the conversation to settle");
		expect((await chat.listing())?.retry).toBeUndefined();

		// With nothing failed and no backoff there is nothing to retry: omp says so and the call fails with its words.
		await expect(request(chat.ws, { t: "retry_now", liveId: chat.liveId })).rejects.toThrow(/Nothing to retry/);
	} finally {
		chat.close();
		await api("/api/usage-reset-wait", { enabled: false });
	}
}, 90_000);
