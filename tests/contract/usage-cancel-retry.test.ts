import { expect, test } from "bun:test";
import { pollUntil } from "../support/poll.ts";
import { messageEnds, usageResetWaitFixture } from "../support/usage-reset-wait.ts";
import { request } from "../support/ws.ts";

const fixture = usageResetWaitFixture();
const { api, conversation } = fixture;

test("Cancel is omp's abort_retry: the wait ends, nothing continues at the reset, and the failed turn stays for Retry", async () => {
	await api("/api/usage-reset-wait", { enabled: true });
	const chat = await conversation();
	try {
		fixture.backend.limitUntil = Date.now() + 6000;
		const chatsBefore = fixture.backend.chats.length;
		const started = chat.next("auto_retry_start");
		await chat.prompt("cancel me");
		await started;
		const ended = chat.next("auto_retry_end");
		await request(chat.ws, { t: "rpc", liveId: chat.liveId, command: { type: "abort_retry" } });
		const end = await ended;
		expect(end.success).toBe(false);
		expect(end.finalError).toBe("Retry cancelled");
		await pollUntil(async () => (await chat.listing())?.retry === undefined, "the countdown to end");
		// omp says the turn is over (`session_settled`) a moment after it ends the retry.
		await pollUntil(async () => (await chat.listing())?.busy === false, "the conversation to settle");

		// Past the reset, with time to spare: omp asked nothing more.
		await pollUntil(() => Date.now() > fixture.backend.limitUntil + 2500, "the reset to pass");
		expect(fixture.backend.chats.length).toBe(chatsBefore);
		expect((await chat.listing())?.streaming).toBe(false);
	} finally {
		chat.close();
		await api("/api/usage-reset-wait", { enabled: false });
	}
}, 60_000);
test("omp 18.12 loses a retry when Cancel runs two messages queued during the wait: the page is not left waiting for it, nothing comes at the reset, and Retry now redoes the turn", async () => {
	// Measured against omp 18.12.2 (issue #249): the second failure's handler resets the counter the first one's sleep
	// checks, so that at the reset `agent.continue` is skipped (`should-continue-false`) and omp never says so. This test
	// pins that omp loses the retry (it fails at the reset check once omp keeps it, and then `Live.trackRetry`'s part of the
	// workaround can go) and that Cancel and Retry now leave the conversation idle. What a stub cannot do is the late
	// announce of the real report (omp's usage bookkeeping makes a network round trip between the two failures, so it
	// announces the wait it will not keep after it said it was idle): those frames are replayed in
	// tests/unit/retry-lost.test.ts (server) and tests/e2e/retry-banner.spec.ts (page).
	await api("/api/usage-reset-wait", { enabled: true });
	const chat = await conversation();
	try {
		fixture.backend.limitUntil = Date.now() + 12_000;
		const chatsBefore = fixture.backend.chats.length;
		const started = chat.next("auto_retry_start");
		await chat.prompt("lose the retry");
		await started;
		const steer = (message: string) =>
			request(chat.ws, { t: "rpc", liveId: chat.liveId, command: { type: "steer", message } });
		await steer("one");
		await steer("two");

		// Cancel ends the wait; omp then runs the queued messages one after another and both are refused.
		const settled = chat.next("session_settled");
		await request(chat.ws, { t: "rpc", liveId: chat.liveId, command: { type: "abort_retry" } });
		await settled;
		const afterwards = await chat.listing();
		expect(afterwards?.retry).toBeUndefined();
		expect(afterwards?.busy).toBe(false);
		expect(chat.frames.seen.filter((f) => f.type === "auto_retry_end").map((f) => f.success)).toEqual([false, false]);

		// At the reset omp asks nothing, and the conversation is as idle as it was.
		await pollUntil(() => Date.now() > fixture.backend.limitUntil + 2500, "the reset to pass");
		expect(fixture.backend.chats.length).toBe(chatsBefore);
		expect((await chat.listing())?.busy).toBe(false);

		// The provider answers; Retry now redoes the failed turn, and the conversation is idle again after it.
		await request(chat.ws, { t: "retry_now", liveId: chat.liveId });
		await pollUntil(
			() => messageEnds(chat.frames.seen, "assistant").some((m) => JSON.stringify(m.content).includes("STUB-REPLY")),
			"the retried turn's reply",
		);
		expect(fixture.backend.chats.length - chatsBefore).toBe(1);
		await pollUntil(async () => (await chat.listing())?.busy === false, "the conversation to settle");
		expect((await chat.listing())?.retry).toBeUndefined();
	} finally {
		chat.close();
		await api("/api/usage-reset-wait", { enabled: false });
	}
}, 90_000);
