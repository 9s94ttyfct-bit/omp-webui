import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boxOf } from "../support/geometry.ts";
import { openSidebar, ownSession, sessionRow, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * The stats line under each agent turn (the TUI prints `10:49:50  Δ 5m6s  ↘419  ↗3.2K  💾 391K  ⏱ 1.6s  ⚡ 102.0/s`
 * after a turn): when it finished, how long it took, the tokens it used, how soon the first one came and how fast they
 * flowed. From a session file for history, from the frames as they arrive for a turn that is running. No model call.
 * UTC, so the finish times read the same wherever the spec runs.
 */

test.use({ timezoneId: "UTC" });

const stamp = (ms: number) => new Date(ms).toISOString();
const at = (h: number, m: number, s: number, ms = 0) => Date.UTC(2026, 0, 9, h, m, s, ms);

const HISTORY = "Turn stats history probe";
const LIVE = "Turn stats live probe";

const usage = (u: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }) => ({
	input: u.input,
	output: u.output,
	cacheRead: u.cacheRead,
	cacheWrite: u.cacheWrite,
	totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
	cost: { total: u.cost },
});

const user = (id: string, parentId: string | null, ms: number, text: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: stamp(ms),
	message: { role: "user", content: [{ type: "text", text }], attribution: "user", timestamp: ms },
});

const assistant = (id: string, parentId: string, savedAt: number, message: Record<string, unknown>) => ({
	type: "message",
	id,
	parentId,
	timestamp: stamp(savedAt),
	message: {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-5-5",
		stopReason: "stop",
		...message,
	},
});

/**
 * Two turns. The first is two requests with a long tool step between them, as omp records them now (every timing
 * field); the second is a request an older omp recorded: its usage and when it started, and nothing else.
 */
function writeHistory(): void {
	const id = "01a00000-0000-7000-8000-0000000099c1";
	const first = at(10, 44, 44);
	const second = at(10, 49, 18, 600);
	const lines = [
		{
			type: "session",
			version: 3,
			id,
			timestamp: stamp(at(10, 44, 0)),
			cwd: "/tmp/ompw-fixture-project",
			title: HISTORY,
		},
		user("t1", null, at(10, 44, 43, 900), "Run the long check"),
		assistant("t2", "t1", first + 2028, {
			content: [{ type: "toolCall", id: "toolu_stats_1", name: "bash", arguments: { command: "sleep 270" } }],
			usage: usage({ input: 4, output: 78, cacheRead: 12020, cacheWrite: 367, cost: 0.000233 }),
			stopReason: "toolUse",
			timestamp: first,
			duration: 2028.125,
			ttft: 1361.871,
			completedAt: first + 2028,
		}),
		{
			type: "message",
			id: "t3",
			parentId: "t2",
			timestamp: stamp(second - 100),
			message: {
				role: "toolResult",
				toolCallId: "toolu_stats_1",
				toolName: "bash",
				content: [{ type: "text", text: "done\n" }],
				isError: false,
				timestamp: second - 100,
			},
		},
		assistant("t4", "t3", at(10, 49, 50), {
			content: [{ type: "text", text: "The long check passed." }],
			usage: usage({ input: 12, output: 3200, cacheRead: 391_000, cacheWrite: 407, cost: 0.1 }),
			timestamp: second,
			duration: 31_400,
			ttft: 900,
			completedAt: at(10, 49, 50),
		}),
		user("t5", "t4", at(10, 51, 0), "And a quick follow-up"),
		assistant("t6", "t5", at(10, 51, 4, 500), {
			content: [{ type: "text", text: "Done." }],
			usage: usage({ input: 10, output: 20, cacheRead: 0, cacheWrite: 5, cost: 0.0004 }),
			timestamp: at(10, 51, 1),
		}),
	];
	const dir = join(process.env.OMPW_E2E_AGENT_DIR as string, "sessions", "-turn-stats-probe");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `2026-01-09T10-44-00-000Z_${id}.jsonl`),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);
}

async function openHistory(page: Page): Promise<void> {
	writeHistory();
	// Later the same day, so the finish times read as the time of day alone, as they do for a turn that just ended.
	await page.clock.setFixedTime(new Date(at(18, 0, 0)));
	await page.goto("/");
	await openSidebar(page);
	await expect(sessionRow(page, HISTORY)).toHaveCount(1, { timeout: 15_000 });
	await sessionRow(page, HISTORY).click();
	await expect(page.getByTestId("msg-usage")).toHaveCount(2);
}

const stat = (line: Locator, name: string) => line.locator(`[data-stat="${name}"]`);

test("a finished turn says when it finished, how long it took and what it used", async ({ page }) => {
	await openHistory(page);
	const line = page.getByTestId("msg-usage").first();
	// Two requests, added up: the turn started with the first and ended with the last.
	await expect(line).toHaveAttribute("data-requests", "2");
	await expect(stat(line, "model")).toHaveText("claude-haiku-5-5");
	await expect(stat(line, "finished")).toHaveText("10:49:50");
	await expect(stat(line, "finished")).toHaveAttribute("datetime", "2026-01-09T10:49:50.000Z");
	await expect(stat(line, "took")).toHaveText("took 5m 6s");
	await expect(stat(line, "in")).toHaveText("in 790");
	await expect(stat(line, "out")).toHaveText("out 3.3k");
	await expect(stat(line, "cache")).toHaveText("cache 403k");
	// The turn's first token is its first request's; its speed is all the output over all the time spent writing it.
	await expect(stat(line, "ttft")).toHaveText("first token 1.4s");
	await expect(stat(line, "speed")).toHaveText("98 tokens/s");
	await expect(stat(line, "cost")).toHaveText("$0.10");
});

test("what omp did not record of a turn is left out, not guessed", async ({ page }) => {
	await openHistory(page);
	const line = page.getByTestId("msg-usage").last();
	await expect(line).toHaveAttribute("data-requests", "1");
	// The saved entry says when it ended, and the message when it began.
	await expect(stat(line, "finished")).toHaveText("10:51:04");
	await expect(stat(line, "took")).toHaveText("took 3.5s");
	await expect(stat(line, "in")).toHaveText("in 15");
	await expect(stat(line, "out")).toHaveText("out 20");
	await expect(stat(line, "cost")).toHaveText("$0.0004");
	// No cache was read, and nothing timed the request: no first token, no speed.
	for (const missing of ["cache", "ttft", "speed"]) await expect(stat(line, missing), missing).toHaveCount(0);
});

test("hovering the line lists each request with its own timing", async ({ page }) => {
	await openHistory(page);
	await page.getByTestId("msg-usage").first().hover();
	const tip = page.getByRole("tooltip");
	await expect(tip).toContainText("2 requests");
	await expect(tip).toContainText("#1 in 4 · out 78 · cache read 12,020 · cache write 367");
	await expect(tip).toContainText("2.0s · first token 1.4s · 38 tokens/s");
	await expect(tip).toContainText("#2 in 12 · out 3,200 · cache read 391,000 · cache write 407");
	await expect(tip).toContainText("31.4s · first token 900ms · 102 tokens/s");
});

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the line wraps inside the screen: every figure is on it, none is cut off", async ({ page }) => {
		await openHistory(page);
		const line = page.getByTestId("msg-usage").first();
		for (const name of ["finished", "took", "in", "out", "cache", "ttft", "speed", "cost"]) {
			await expect(stat(line, name), name).toBeVisible();
			const box = await boxOf(stat(line, name));
			expect(box.x, `${name} starts on screen`).toBeGreaterThanOrEqual(0);
			expect(box.x + box.width, `${name} ends on screen`).toBeLessThanOrEqual(390);
		}
		// It takes a few short lines, not a column.
		expect((await boxOf(line)).height).toBeLessThan(72);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways scroll").toBe(
			true,
		);
	});
});

test("a running turn counts up and fills in as its requests end; saved, the line under it shows the same figures", async ({
	page,
}) => {
	ownSession(0x62, LIVE);
	// Auto-titling would send a prompt to the model when the pushed turn ends.
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, LIVE, "turn-stats-probe");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	const live = page.getByTestId("turn-stats-live");

	// The turn omp would have saved: a prompt, and one request with every timing it records.
	const real = tap.replies("get_entries").at(-1) as { leafId?: string } | undefined;
	const sent = at(12, 0, 0);
	const final = {
		role: "assistant",
		content: [{ type: "text", text: "Checked." }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-5-5",
		usage: usage({ input: 4, output: 78, cacheRead: 12020, cacheWrite: 367, cost: 0.000233 }),
		stopReason: "stop",
		timestamp: sent + 500,
		duration: 2028.125,
		ttft: 1361.871,
		completedAt: sent + 500 + 2028,
	};
	const saved = [
		user("inj-user", real?.leafId ?? null, sent, "Check it"),
		assistant("inj-asst", "inj-user", sent + 500 + 2028, final),
	];
	// The page asks for the new entries when a message ends: hand it these, once, and the same leaf after that.
	let served = false;
	tap.answer("get_entries", () => {
		const entries = served ? [] : saved;
		served = true;
		return { ok: true, data: { entries, leafId: "inj-asst" } };
	});

	frame({ type: "agent_start" });
	await expect(stat(live, "running")).toHaveText(/^running \d+s$/);
	await expect(stat(live, "in")).toHaveCount(0);

	// The page saw the first token arrive; omp reports a request's own figures only when it ends.
	frame({ type: "message_start", messageId: "m1", message: { role: "assistant", content: [] } });
	frame({
		type: "message_update",
		messageId: "m1",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Checking…" },
	});
	await expect(stat(live, "ttft")).toHaveText(/^first token (\d+ms|\d+\.\ds)$/);
	await expect(stat(live, "in")).toHaveCount(0);

	frame({ type: "message_end", messageId: "m1", message: final });
	await expect(stat(live, "in")).toHaveText("in 371");
	await expect(stat(live, "out")).toHaveText("out 78");
	await expect(stat(live, "cache")).toHaveText("cache 12k");
	await expect(stat(live, "ttft")).toHaveText("first token 1.4s");
	await expect(stat(live, "speed")).toHaveText("38 tokens/s");
	// The clock goes on ticking.
	await expect(stat(live, "running")).toHaveText(/^running [1-9]\d*s$/, { timeout: 10_000 });

	frame({ type: "agent_end" });
	await expect(live).toHaveCount(0);
	const line = page.getByTestId("msg-usage").last();
	// The injected turn is on another day than the browser's: it names the day too (the format is tested on its own).
	await expect(stat(line, "finished")).toHaveText(/12:00:02$/);
	await expect(stat(line, "took")).toHaveText("took 2.0s");
	await expect(stat(line, "in")).toHaveText("in 371");
	await expect(stat(line, "out")).toHaveText("out 78");
	await expect(stat(line, "cache")).toHaveText("cache 12k");
	await expect(stat(line, "ttft")).toHaveText("first token 1.4s");
	await expect(stat(line, "speed")).toHaveText("38 tokens/s");
});

test("a page that opens in the middle of a turn shows its figures but not a made-up clock", async ({ page }) => {
	const title = `${LIVE} (late)`;
	ownSession(0x63, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "turn-stats-late");
	const real = tap.replies("get_entries").at(-1) as { leafId?: string } | undefined;
	const sent = at(12, 30, 0);
	const request = {
		role: "assistant",
		content: [{ type: "text", text: "Half way." }],
		model: "claude-haiku-5-5",
		usage: usage({ input: 6, output: 100, cacheRead: 2000, cacheWrite: 50, cost: 0.001 }),
		stopReason: "toolUse",
		timestamp: sent + 200,
		duration: 4000,
		ttft: 800,
		completedAt: sent + 4200,
	};
	tap.answer("get_entries", () => ({
		ok: true,
		data: {
			entries: [
				user("late-user", real?.leafId ?? null, sent, "Go"),
				assistant("late-asst", "late-user", sent + 4200, request),
			],
			leafId: "late-asst",
		},
	}));
	// omp's own state says a turn is running; `agent_start` never reached this page, and a request ended and was saved.
	tap.answer("get_state", () => ({
		ok: true,
		data: {
			isStreaming: true,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			interruptMode: "immediate",
			messageCount: 4,
			queuedMessageCount: 0,
		},
	}));
	tap.push({ t: "frame", liveId, frame: { type: "message_end", messageId: "m9", message: request } });
	tap.push({ t: "frame", liveId, frame: { type: "model_changed" } });
	const live = page.getByTestId("turn-stats-live");
	await expect(stat(live, "in")).toHaveText("in 56");
	await expect(stat(live, "out")).toHaveText("out 100");
	await expect(stat(live, "ttft")).toHaveText("first token 800ms");
	await expect(stat(live, "speed")).toHaveText("25 tokens/s");
	await expect(stat(live, "running")).toHaveCount(0);
});
