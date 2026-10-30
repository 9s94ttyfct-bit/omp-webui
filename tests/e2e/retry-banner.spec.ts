import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveRetry } from "../../shared/protocol.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { openSidebar, startLive } from "../support/live.ts";
import { topTab } from "../support/panel.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * omp's own retry as the page shows it: the countdown of a usage-limit wait (hours) and of an ordinary backoff, Cancel
 * (omp's `abort_retry`), Retry now (the server's `retry_now`), and the overdue state when omp has not retried. The
 * server and omp are tested in tests/contract/usage-reset-wait.test.ts; here the page is told what omp would send, by
 * frames, and a fake clock moves the countdown. No model call.
 */

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const MINUTE = 60_000;
/** omp's `errorId` of a failure that was a usage limit: the flag 0x80000 and a status bit. */
const USAGE_LIMIT_ERROR_ID = 0x80000 | 0x1000;

/** The server's answer to the page's `attach` for `liveId` says omp is backing off: what only the server can hold, and a spec cannot bring about without a model call. */
function holdWait(tap: SocketTap, liveId: string, held: () => LiveRetry): void {
	tap.rewrite((msg, request) => {
		const data = msg.data as { liveId?: string } | undefined;
		if (msg.t !== "reply" || msg.ok !== true || request?.t !== "attach" || data?.liveId !== liveId) return msg;
		return { ...msg, data: { ...data, streaming: true, retry: held() } };
	});
}

/** A page opened on the process itself (`#/live/<id>`) attaches to it, as a second tab or a reload does. */
async function reopen(page: Page, liveId: string): Promise<void> {
	await page.evaluate((id) => {
		location.hash = `#/live/${id}`;
	}, liveId);
	await page.reload();
}

test("the setting is omp's retry.waitForUsageReset: shown from omp, changed as `omp config set`, and kept across a reload", async ({
	page,
}) => {
	await page.goto("/#/settings/chats");
	const box = page.getByTestId("usage-wait-default");
	await expect(box).toBeVisible();
	await expect(page.getByText("When the usage limit is reached, wait for the reset and retry")).toBeVisible();
	const before = await (await page.request.get("/api/usage-reset-wait")).json();
	expect(typeof before.omp).toBe("boolean");
	await expect(box).toBeChecked({ checked: before.omp });
	const configFile = join(process.env.OMPW_E2E_AGENT_DIR as string, "config.yml");
	const found = readFileSync(configFile, "utf8");
	try {
		await box.setChecked(!before.omp);
		await expect
			.poll(async () => (await (await page.request.get("/api/usage-reset-wait")).json()).omp)
			.toBe(!before.omp);
		await page.reload();
		await expect(page.getByTestId("usage-wait-default")).toBeChecked({ checked: !before.omp });
	} finally {
		await page.request.post("/api/usage-reset-wait", {
			data: { enabled: before.omp },
			headers: { "x-omp-webui": "1" },
		});
		// The worker's server serves the specs after this one: its config.yml is left as it was found. `omp config set`
		// writes it with no final newline and a key of its own, which the next spec that added to it did not expect (#600).
		writeFileSync(configFile, found);
	}
});

test("a usage-limit wait is a card with omp's countdown, Cancel and Retry now; the countdown is no live region", async ({
	page,
}) => {
	const title = "Retry banner probe";
	writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xd9, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.clock.install({ time: NOW });
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "retry-banner-up");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	const card = page.getByTestId("retry-wait");
	const countdown = page.getByTestId("retry-countdown");
	await expect(card).toHaveCount(0);

	frame({
		type: "auto_retry_start",
		attempt: 1,
		maxAttempts: 10,
		delayMs: 72 * MINUTE,
		errorMessage: "429 usage limit",
		errorId: USAGE_LIMIT_ERROR_ID,
	});
	await expect(card).toHaveAttribute("data-kind", "usage-limit");
	await expect(card).toContainText("Usage limit reached");
	// The countdown rounds up, so that it never reads zero before the time is up.
	await expect(countdown).toContainText("Retries by itself in 1h 12m");
	await page.clock.fastForward(5 * MINUTE);
	await expect(countdown).toContainText("Retries by itself in 1h 7m");

	// What ticks is no live region; a screen reader is told once, by a hidden status that does not change with time.
	await expect(countdown.locator("xpath=ancestor-or-self::*[@role='status' or @aria-live]")).toHaveCount(0);
	const announce = page.getByTestId("retry-announce");
	await expect(announce).toHaveText("Usage limit reached. omp retries by itself when it resets.");
	await page.clock.fastForward(30 * MINUTE);
	await expect(announce).toHaveText("Usage limit reached. omp retries by itself when it resets.");

	// Retry now asks the server, which has omp end the backoff and redo the turn.
	await card.getByTestId("retry-now").click();
	await expect.poll(() => tap.sent.filter((m) => m.t === "retry_now")).toEqual([expect.objectContaining({ liveId })]);

	// Cancel is omp's own abort_retry; omp then ends the retry, and the failure is left for Retry.
	await card.getByTestId("retry-cancel").click();
	await expect.poll(() => tap.commands("abort_retry").length).toBe(1);
	frame({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
	await expect(card).toHaveCount(0);
	await expect(page.getByTestId("retry-status")).toContainText("Retry cancelled");
});

test("when the time is up and omp has not retried, the page says so and offers Retry now; omp starting the turn ends it", async ({
	page,
}) => {
	const title = "Retry overdue probe";
	writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xda, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.clock.install({ time: NOW });
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "retry-overdue-up");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	const card = page.getByTestId("retry-wait");

	frame({
		type: "auto_retry_start",
		attempt: 1,
		maxAttempts: 10,
		delayMs: 10 * MINUTE,
		errorId: USAGE_LIMIT_ERROR_ID,
	});
	await expect(card).toHaveAttribute("data-kind", "usage-limit");
	// The time is up: omp is about to start, and says nothing yet.
	await page.clock.fastForward(10 * MINUTE + 5_000);
	await expect(page.getByTestId("retry-countdown")).toHaveText("The limit has reset · retrying…");
	await expect(card).toHaveAttribute("data-kind", "usage-limit");
	await expect(card.getByTestId("retry-now")).toBeVisible();

	// Half a minute later and still nothing: omp has not retried.
	await page.clock.fastForward(30_000);
	await expect(card).toHaveAttribute("data-kind", "overdue");
	await expect(card).toContainText("omp hasn't retried yet");
	await expect(page.getByTestId("retry-announce")).toHaveText("omp has not retried yet.");
	await card.getByTestId("retry-now").click();
	await expect.poll(() => tap.sent.filter((m) => m.t === "retry_now").length).toBe(1);

	// omp did start the turn after all: not overdue any more, whatever the clock says.
	frame({ type: "agent_start" });
	await expect(card).toHaveAttribute("data-kind", "usage-limit");
	await expect(card.getByTestId("retry-now")).toHaveCount(0);
	await page.clock.fastForward(60 * MINUTE);
	await expect(card).toHaveAttribute("data-kind", "usage-limit");
	frame({ type: "auto_retry_end", success: true, attempt: 1 });
	await expect(card).toHaveCount(0);
});

test("a page that opens during a usage-limit wait shows the countdown with Cancel and Retry now, though omp reports a turn in progress", async ({
	page,
}) => {
	const title = "Retry reload probe";
	writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xdd, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "retry-reload-up");

	// What the server holds while omp sleeps through the limit (tests/contract/usage-reset-wait.test.ts has the real
	// one): omp reports a turn in progress for the whole wait, which is no sign that the retried turn runs.
	let held: LiveRetry = {
		attempt: 1,
		maxAttempts: 10,
		delayMs: 60 * MINUTE,
		startedAt: Date.now() - 5 * MINUTE,
		usageLimit: true,
		resumed: false,
	};
	holdWait(tap, liveId, () => held);
	await reopen(page, liveId);

	const card = page.getByTestId("retry-wait");
	await expect(card).toHaveAttribute("data-kind", "usage-limit");
	await expect(page.getByTestId("retry-countdown")).toContainText(/Retries by itself in (54|55)m/);
	await expect(card.getByTestId("retry-cancel")).toBeVisible();
	await expect(card.getByTestId("retry-now")).toBeVisible();

	// Once the server says omp started the retried turn, a page that opens then shows that, with nothing to cancel.
	held = { ...held, resumed: true };
	await reopen(page, liveId);
	await expect(card).toHaveAttribute("data-kind", "usage-limit");
	await expect(page.getByTestId("retry-countdown")).toHaveText("The limit has reset · retrying…");
	await expect(card.getByTestId("retry-cancel")).toHaveCount(0);
	await expect(card.getByTestId("retry-now")).toHaveCount(0);
});

test("a wait the server stamped is counted on the page's own clock: one a day off neither inflates the countdown nor says overdue", async ({
	page,
}) => {
	const title = "Retry skew probe";
	writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xde, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	// The page's clock is about a day behind the server's (the real one, which the wait below is stamped on).
	await page.clock.install({ time: NOW });
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "retry-skew-up");
	const held: LiveRetry = {
		attempt: 1,
		maxAttempts: 10,
		delayMs: 60 * MINUTE,
		startedAt: Date.now() - 5 * MINUTE,
		usageLimit: true,
		resumed: false,
	};
	holdWait(tap, liveId, () => held);
	await reopen(page, liveId);

	const card = page.getByTestId("retry-wait");
	await expect(card).toHaveAttribute("data-kind", "usage-limit");
	await expect(page.getByTestId("retry-countdown")).toContainText(/Retries by itself in (54|55)m/);
	await page.clock.fastForward(10 * MINUTE);
	await expect(page.getByTestId("retry-countdown")).toContainText(/Retries by itself in (44|45)m/);
	await expect(card).toHaveAttribute("data-kind", "usage-limit");
});

test("a reconnect that missed the next attempt shows the server's wait, not the stale attempt as overdue", async ({
	page,
}) => {
	const title = "Retry reconnect probe";
	writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xdf, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.clock.install({ time: NOW });
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "retry-reconnect-up");
	const card = page.getByTestId("retry-wait");

	// The page sees attempt 1 of a backoff begin, and its minute runs out: it is overdue as far as the page knows.
	tap.push({
		t: "frame",
		liveId,
		frame: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 60_000, errorMessage: "429" },
	});
	await expect(page.getByTestId("retry-status")).toContainText("Retrying 1/3");
	await page.clock.fastForward(60_000 + 31_000);
	await expect(card).toHaveAttribute("data-kind", "overdue");

	// The connection drops. Meanwhile omp went on to attempt 2, which is backing off now; the page never heard.
	holdWait(tap, liveId, () => ({
		attempt: 2,
		maxAttempts: 3,
		delayMs: 60_000,
		startedAt: Date.now() - 1_000,
		usageLimit: false,
		resumed: false,
	}));
	tap.drop();
	await page.clock.fastForward(1_000);
	await expect(page.getByTestId("retry-status")).toContainText(/Retrying 2\/3 in (59|58|1m 00)s?/);
	await expect(card).toHaveAttribute("data-kind", "backoff");
});

test("while omp waits to retry, the composer says a message is sent when it retries, and steer is labelled so", async ({
	page,
}) => {
	const title = "Retry composer probe";
	writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0x9b, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "retry-composer-up");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	const composer = page.getByTestId("composer");

	// omp reports a turn in progress for the whole backoff: the composer used to offer to steer it.
	frame({ type: "agent_start" });
	await expect(composer).toHaveAttribute("placeholder", /^Queue a follow-up/);
	frame({ type: "auto_retry_start", attempt: 1, maxAttempts: 10, delayMs: 60 * MINUTE, errorId: USAGE_LIMIT_ERROR_ID });
	await expect(composer).toHaveAttribute("placeholder", "Sent when omp retries… (or use Retry now)");
	await composer.fill("a message during the wait");
	await expect(page.getByRole("button", { name: "Steer when omp retries" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Steer now" })).toHaveCount(0);
	await expect(page.getByTestId("send")).toHaveAttribute("aria-label", "Queue until omp retries");

	// The retried turn runs: the composer is the one of a turn in progress again.
	frame({ type: "agent_start" });
	await expect(composer).toHaveAttribute("placeholder", /^Queue a follow-up/);
	await expect(page.getByRole("button", { name: "Steer now" })).toBeVisible();
});

test("a subagent waiting for a usage limit shows its countdown in the Agents panel, until it retries", async ({
	page,
}) => {
	const title = "Retry agents probe";
	writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0x9a, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.clock.install({ time: NOW });
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "retry-agents-up");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	await page.getByTestId("toggle-panel").click();
	const panel = page.getByTestId("right-panel");
	await topTab(panel, /Agents/).click();

	frame({ type: "subagent_lifecycle", payload: { id: "Scout", agent: "explore", index: 0, status: "started" } });
	const wait = panel.getByTestId("subagent-wait");
	await expect(panel.getByTestId("subagent-item")).toHaveCount(1);
	await expect(wait).toHaveCount(0);
	frame({
		type: "subagent_event",
		payload: {
			id: "Scout",
			event: {
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 10,
				delayMs: 90 * MINUTE,
				errorId: USAGE_LIMIT_ERROR_ID,
			},
		},
	});
	await expect(wait).toContainText("Usage limit · retries in 1h");
	await page.clock.fastForward(45 * MINUTE);
	await expect(wait).toContainText(/retries in (44|45)m/);
	// Opened, the agent says so too.
	await panel.getByTestId("subagent-item").click();
	await expect(panel.getByTestId("subagent-detail-wait")).toContainText(/Usage limit · retries in (44|45)m/);

	// The retried turn starts, then the retry ends: nothing is waited for any more.
	frame({ type: "subagent_event", payload: { id: "Scout", event: { type: "agent_start" } } });
	await expect(panel.getByTestId("subagent-detail-wait")).toHaveText("Retrying…");
	frame({
		type: "subagent_event",
		payload: { id: "Scout", event: { type: "auto_retry_end", success: true, attempt: 1 } },
	});
	await expect(panel.getByTestId("subagent-detail-wait")).toHaveCount(0);
});

test("an ordinary backoff stays a line with Cancel and becomes the overdue card too; the card wraps on a phone", async ({
	page,
}) => {
	const title = "Retry phone probe";
	writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xdb, title);
	await page.setViewportSize({ width: 320, height: 640 });
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.clock.install({ time: NOW });
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	const liveId = await startLive(page, tap, title, "retry-phone-up");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	const card = page.getByTestId("retry-wait");

	frame({
		type: "auto_retry_start",
		attempt: 2,
		maxAttempts: 3,
		delayMs: 60_000,
		errorMessage: "429 rate_limit_error",
	});
	await expect(page.getByTestId("retry-status")).toContainText(/Retrying 2\/3 in (59|60|1m 00)s?/);
	await expect(card.getByTestId("retry-cancel")).toBeVisible();
	await expect(card.getByTestId("retry-now")).toHaveCount(0);
	await expect(card).toHaveAttribute("data-kind", "backoff");

	await page.clock.fastForward(60_000 + 31_000);
	await expect(card).toHaveAttribute("data-kind", "overdue");
	const box = await card.boundingBox();
	const cancel = await card.getByTestId("retry-cancel").boundingBox();
	const now = await card.getByTestId("retry-now").boundingBox();
	if (!box || !cancel || !now) throw new Error("the card is not laid out");
	// Nothing runs past the screen: the buttons wrap under the text instead of squeezing it or leaving the row.
	expect(box.x + box.width).toBeLessThanOrEqual(320);
	expect(cancel.x + cancel.width).toBeLessThanOrEqual(320);
	expect(now.x + now.width).toBeLessThanOrEqual(320);
	expect(box.height).toBeLessThan(200);
});

test("omp 18.12 lost the retry (two messages queued during the wait, then Cancel): the page says the turn failed at once and counts down to nothing", async ({
	page,
}) => {
	// The frames omp 18.12.2 sent, measured against the real process (tests/contract/usage-reset-wait.test.ts): the first
	// wait is cancelled, both queued turns fail, omp says the turn ended and it is idle, and only then announces a wait
	// (attempt 0) that it sleeps through and never keeps. A countdown to that retry is hours of "Retrying…" that ends in nothing.
	const title = "Retry lost probe";
	writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xe0, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.clock.install({ time: NOW });
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "retry-lost-up");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	const card = page.getByTestId("retry-wait");
	const wait = (attempt: number, delayMs: number) => ({
		type: "auto_retry_start",
		attempt,
		maxAttempts: 10,
		delayMs,
		errorMessage: "429 You have reached your usage limit.",
		errorId: USAGE_LIMIT_ERROR_ID,
	});

	frame(wait(1, 72 * MINUTE));
	await expect(card).toHaveAttribute("data-kind", "usage-limit");
	frame({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
	frame({ type: "agent_end", isTerminal: false });
	frame({ type: "agent_start" });
	frame(wait(1, 71 * MINUTE));
	frame({ type: "agent_start" });
	frame({
		type: "auto_retry_end",
		success: false,
		attempt: 2,
		finalError: "429 You have reached your usage limit. (type=usage_limit_reached)",
	});
	frame({ type: "agent_end", isTerminal: true });
	frame({ type: "session_settled" });
	await expect(page.getByTestId("retry-status")).toContainText("Retry failed after 2 attempts");
	await expect(card).toHaveCount(0);

	// omp now announces the wait it will not keep: nothing to count down to, and nothing to wait for.
	frame(wait(0, 71 * MINUTE));
	await expect(card).toHaveCount(0);
	await expect(page.getByTestId("retry-status")).toContainText("Retry failed after 2 attempts");
	await page.clock.fastForward(72 * MINUTE + 60_000);
	await expect(card).toHaveCount(0);

	// The next turn clears what is left of it, as after any retry that gave up.
	frame({ type: "agent_start" });
	await expect(page.getByTestId("retry-status")).toHaveCount(0);
});
