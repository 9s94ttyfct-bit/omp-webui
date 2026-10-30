import { boxOf } from "../support/geometry.ts";
import { openSidebar, ownSession, startLive } from "../support/live.ts";
import { rpcState } from "../support/rpc-state.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The rest of what the TUI's status line and chat say that the web UI dropped: the usage-limit stage and fast mode
 * (from `get_state`), info notices, and the reason, the action and the outcome of an automatic compaction. State is
 * answered to the page and frames are pushed through the socket tap, so no model call is made.
 */

const inSeconds = (hours: number) => Math.floor(Date.now() / 1000) + hours * 3600;
/** `03:30 PM` in the browser's locale (en-US here). */
const TIME = String.raw`\d{1,2}:\d{2}\s?(?:AM|PM)`;

interface Running {
	tap: SocketTap;
	frame: (f: Record<string, unknown>) => void;
	/** Answer `get_state` with this state, and make the page read it (a slash command's output does that). */
	setState: (extra: Record<string, unknown>) => void;
}

async function open(page: Page, n: number, probe: string): Promise<Running> {
	const title = `Parity status probe ${probe}`;
	ownSession(n, title);
	// Auto-titling would send a prompt to the model when a pushed turn ends.
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	const liveId = await startLive(page, tap, title, `parity-probe-${probe}`);
	tap.answer("get_state", () => ({ ok: true, data: rpcState() }));
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	const setState = (extra: Record<string, unknown>) => {
		tap.answer("get_state", () => ({ ok: true, data: rpcState(extra) }));
		frame({ type: "command_output", text: "ok" });
	};
	return { tap, frame, setState };
}

const status = (page: Page, id: string) => page.getByTestId("chat-status").getByTestId(id);

test("the usage-limit stage shows as a warning chip in omp's words, and goes with the limit", async ({ page }) => {
	const { setState } = await open(page, 0x36, "limit");
	await expect(page.getByTestId("status-usage-limit")).toHaveCount(0);

	setState({ usageLimit: { stage: "low_priority", resetsAtSec: inSeconds(3), allowanceLeftPercent: 62 } });
	const chip = status(page, "status-usage-limit");
	await expect(chip).toHaveAttribute("data-stage", "low_priority");
	await expect(chip).toHaveText(new RegExp(`^Usage limit: low priority until ${TIME} · 62% left$`));
	// A warning, not decoration: it is in the warning colour.
	await expect(chip).toHaveClass(/text-warning/);

	setState({ usageLimit: { stage: "low_priority", resetsAtSec: inSeconds(3) } });
	await expect(chip).toHaveText(new RegExp(`^Usage limit: low priority until ${TIME}$`));

	setState({ usageLimit: { stage: "wrap_up", resetsAtSec: inSeconds(2) } });
	await expect(chip).toHaveAttribute("data-stage", "wrap_up");
	await expect(chip).toHaveText(new RegExp(`^Usage limit: limit reached · wrapping up · resets ${TIME}$`));

	setState({ usageLimit: { stage: "wrap_up", extraUsage: true } });
	await expect(chip).toHaveText("Usage limit: limit reached · wrap-up, then extra usage");

	// omp leaves the field out once the account is within its limit.
	setState({});
	await expect(page.getByTestId("status-usage-limit")).toHaveCount(0);
});

test("a reset more than a day away names the weekday", async ({ page }) => {
	const { setState } = await open(page, 0x37, "weekday");
	setState({ usageLimit: { stage: "low_priority", resetsAtSec: inSeconds(72) } });
	await expect(status(page, "status-usage-limit")).toHaveText(
		new RegExp(`^Usage limit: low priority until (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ${TIME}$`),
	);
});

test("fast mode shows a lightning bolt only while it is in effect", async ({ page }) => {
	const { setState } = await open(page, 0x38, "fast");
	await expect(page.getByTestId("status-fast")).toHaveCount(0);
	setState({ fastModeEnabled: true, fastModeActive: true });
	await expect(status(page, "status-fast")).toHaveText("Fast mode");
	await expect(status(page, "status-fast")).toHaveAttribute("title", "Fast mode");
	await expect(status(page, "status-model")).toContainText("Opus 5.5");
	// Selected, but the provider refused the fast tier: not in effect.
	setState({ fastModeEnabled: true, fastModeActive: false });
	await expect(page.getByTestId("status-fast")).toHaveCount(0);
});

test.describe("in Chinese", () => {
	test("the limit and fast mode are worded in Chinese", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
		const { setState } = await open(page, 0x39, "zh");
		setState({
			fastModeActive: true,
			usageLimit: { stage: "low_priority", resetsAtSec: inSeconds(3), allowanceLeftPercent: 62 },
		});
		await expect(status(page, "status-usage-limit")).toContainText("低优先级，至");
		await expect(status(page, "status-usage-limit")).toContainText("剩余 62%");
		await expect(status(page, "status-fast")).toHaveText("快速模式");
	});
});

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the limit and fast mode stay on the line and the line fits the screen", async ({ page }) => {
		const { setState } = await open(page, 0x3a, "phone");
		setState({
			fastModeActive: true,
			usageLimit: { stage: "wrap_up", extraUsage: true },
		});
		await expect(status(page, "status-usage-limit")).toBeVisible();
		await expect(status(page, "status-fast")).toBeVisible();
		const box = await boxOf(page.getByTestId("chat-status"));
		expect(box.x + box.width).toBeLessThanOrEqual(390);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways scroll").toBe(
			true,
		);
	});
});

test("info notices are shown, with their source; the tool bookkeeping is not", async ({ page }) => {
	const { frame } = await open(page, 0x3b, "notice");
	frame({
		type: "notice",
		level: "info",
		message: "Claude session limit reset — low priority ended.",
		source: "usage",
	});
	const toast = page.getByTestId("toast").filter({ hasText: "Claude session limit reset" });
	await expect(toast).toHaveText(/usage: Claude session limit reset — low priority ended\./);
	await expect(toast).toHaveAttribute("data-level", "info");
	frame({ type: "notice", level: "warning", message: "Memory retention failed", source: "Hindsight" });
	await expect(page.getByTestId("toast").filter({ hasText: "Hindsight: Memory retention failed" })).toHaveAttribute(
		"data-level",
		"warning",
	);
	frame({ type: "notice", level: "info", message: "xd://: mounted mcp__a_x, mcp__a_y", source: "xdev" });
	// A frame is handled in order: this one was handled once the next toast is up.
	frame({ type: "notice", level: "info", message: "after the bookkeeping" });
	await expect(page.getByTestId("toast").filter({ hasText: "after the bookkeeping" })).toBeVisible();
	await expect(page.getByTestId("toast").filter({ hasText: "mounted" })).toHaveCount(0);
});

test("compaction names its reason and action, and says how it ended", async ({ page }) => {
	const { frame } = await open(page, 0x3c, "compaction");
	const progress = page.getByTestId("compaction-line");
	const outcome = page.getByTestId("compaction-outcome");

	frame({ type: "auto_compaction_start", reason: "overflow", action: "handoff" });
	await expect(progress).toHaveText("The context overflowed. Handing off to a fresh context…");
	// Cancelled, as the TUI says: a note, which can be dismissed.
	frame({ type: "auto_compaction_end", action: "handoff", aborted: true, willRetry: false });
	await expect(progress).toHaveCount(0);
	await expect(outcome).toHaveText("Handoff cancelled");
	await expect(outcome).toHaveAttribute("data-kind", "cancelled");
	await outcome.getByTestId("compaction-outcome-dismiss").click();
	await expect(outcome).toHaveCount(0);

	// An ordinary threshold goes unsaid; the compaction itself is a completed outcome with the size it started from.
	frame({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
	await expect(progress).toHaveText("Compacting the conversation…");
	frame({
		type: "auto_compaction_end",
		action: "context-full",
		aborted: false,
		willRetry: false,
		result: { summary: "s", firstKeptEntryId: "e1", tokensBefore: 183_000 },
	});
	await expect(outcome).toHaveText("Compaction complete · the context was 183k tokens");
	await expect(outcome).toHaveAttribute("data-kind", "completed");

	// A new compaction replaces the outcome; a failure stays until it is dismissed.
	frame({ type: "auto_compaction_start", reason: "idle", action: "remote" });
	await expect(outcome).toHaveCount(0);
	await expect(progress).toHaveText("The conversation was idle. Compacting the conversation on the server…");
	frame({
		type: "auto_compaction_end",
		action: "remote",
		aborted: false,
		willRetry: false,
		errorMessage: "the model is unavailable",
	});
	await expect(outcome).toHaveText("Server compaction failed: the model is unavailable");
	await expect(outcome).toHaveAttribute("data-kind", "failed");

	// A handoff that went through says so.
	frame({ type: "auto_compaction_start", reason: "incomplete", action: "handoff" });
	await expect(progress).toHaveText("The last response was cut off. Handing off to a fresh context…");
	frame({ type: "auto_compaction_end", action: "handoff", aborted: false, willRetry: false });
	await expect(outcome).toHaveText("Handoff complete");
});

test("without a named action the line is the plain Compacting…", async ({ page }) => {
	const { frame } = await open(page, 0x3d, "plain");
	frame({ type: "auto_compaction_start" });
	await expect(page.getByTestId("compaction-line")).toHaveText("Compacting context…");
});
