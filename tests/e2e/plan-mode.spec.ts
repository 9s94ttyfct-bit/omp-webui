import { type Msg, type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Read-only plan mode (`--plan-yolo`) in the chat header. omp tells the page nothing of it and has no command to enter or
 * leave it, so the header shows it for a conversation whose omp was started with the flag until omp's hidden
 * `plan-yolo-handoff` entry says the plan was approved, and `/plan` points at New chat. No model is called: the chat
 * is opened with a `!command`, and the handoff is the entries answer the page gets.
 */

const HANDOFF = {
	type: "custom_message",
	id: "handoff1",
	parentId: null,
	timestamp: "2026-01-05T10:00:00.000Z",
	customType: "plan-yolo-handoff",
	display: false,
	content: "hidden",
};

/**
 * Send `!echo probe` from the new-chat page. A message sent before the page has its omp process is refused and stays in the
 * box, so it is sent again until the box has taken it.
 */
async function sendProbe(page: Page, probe: string): Promise<void> {
	const composer = page.getByTestId("composer");
	await expect(async () => {
		await composer.fill(`!echo ${probe}`);
		await composer.press("Enter");
		await expect(composer).toHaveValue("", { timeout: 1500 });
	}).toPass();
	await expect(page.getByText(probe, { exact: true })).toBeVisible({ timeout: 30_000 });
}

/** A new chat started with the `--plan-yolo` option checked, opened on a `!command` (it needs the process, not a model). */
async function planChat(page: Page, probe: string): Promise<{ tap: SocketTap; liveId: string }> {
	const tap = await tapSocket(page);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto("/");
	await page.getByRole("button", { name: /^(Options|选项)/ }).click();
	await page.getByTestId("flag-form").locator('[data-flag="--plan-yolo"]').check();
	const opened = () => tap.sent.findLast((m): m is Msg => m.t === "open")?.target;
	await expect.poll(() => opened()?.args).toEqual(["--plan-yolo"]);
	await sendProbe(page, probe);
	const bash = tap.sent.findLast((m) => m.t === "rpc" && m.command?.type === "bash");
	if (typeof bash?.liveId !== "string") throw new Error("the page did not run the command");
	return { tap, liveId: bash.liveId };
}

test("a --plan-yolo chat shows Plan mode in its header until omp's handoff entry arrives", async ({ page }) => {
	const { tap, liveId } = await planChat(page, "plan-chip-probe");
	const badge = page.getByTestId("plan-badge");
	await expect(badge).toBeVisible();
	await expect(badge).toContainText("Plan mode");
	await expect(badge).toHaveAttribute("title", /--plan-yolo/);
	await expect(badge).toHaveAttribute("title", /cannot switch plan mode on or off/);

	// Other hidden entries do not end it.
	tap.answer("get_entries", () => ({
		ok: true,
		data: { entries: [{ ...HANDOFF, id: "digest1", customType: "system-prompt-digest" }], leafId: "digest1" },
	}));
	tap.push({ t: "frame", liveId, frame: { type: "turn_end" } });
	await expect.poll(() => tap.commands("get_entries").length).toBeGreaterThan(1);
	await expect(badge).toBeVisible();

	// The plan is approved: omp writes its handoff entry.
	tap.answer("get_entries", (command) => ({
		ok: true,
		data:
			command.since === "handoff1" ? { entries: [], leafId: "handoff1" } : { entries: [HANDOFF], leafId: "handoff1" },
	}));
	tap.push({ t: "frame", liveId, frame: { type: "turn_end" } });
	await expect(badge).toHaveCount(0);
});

test("a chat started without --plan-yolo shows no Plan mode", async ({ page }) => {
	const tap = await tapSocket(page);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect.poll(() => tap.sent.some((m) => m.t === "open")).toBe(true);
	await sendProbe(page, "no-plan-probe");
	await expect(page.getByTestId("chat-title")).toBeVisible();
	await expect(page.getByTestId("plan-badge")).toHaveCount(0);
});

test("/plan is held back with where plan mode lives, and New chat takes you there", async ({ page }) => {
	await planChat(page, "plan-slash-probe");
	const composer = page.getByTestId("composer");
	await composer.fill("/plan");
	await composer.press("Enter");
	const notice = page.getByTestId("slash-unknown");
	await expect(notice).toBeVisible();
	await expect(notice).toContainText("--plan-yolo");
	await expect(notice.getByTestId("slash-equivalent")).toHaveText("New chat");
	await notice.getByTestId("slash-equivalent").click();
	await expect(page.getByTestId("cwd-picker")).toBeVisible();
});

test("the badge and the /plan hint are in Chinese with the interface in Chinese", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	await planChat(page, "plan-zh-probe");
	const badge = page.getByTestId("plan-badge");
	await expect(badge).toContainText("计划模式");
	await expect(badge).toHaveAttribute("title", /--plan-yolo/);
	const composer = page.getByTestId("composer");
	await composer.fill("/plan");
	await composer.press("Enter");
	await expect(page.getByTestId("slash-unknown")).toContainText("无法开启或退出计划模式");
});
