import { writeSimpleSession } from "../support/fixtures.ts";
import { ownSession, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Slash commands the page cannot run in omp stay out of the model's context, and what omp prints for the ones
 * it does run is text. Prompts that must not reach the model are answered at the socket; no model call is made.
 */

test("/context prints plain text, without the terminal's escape sequences", async ({ page }) => {
	ownSession(0xd6, "Slash context probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await startLive(page, tap, "Slash context probe", "slash-context-probe");

	const composer = page.getByTestId("composer");
	await composer.fill("/context");
	await composer.press("Enter");
	const output = page.getByTestId("command-output").last();
	await expect(output).toContainText("Context window");
	await expect(output).toContainText("System prompt");
	expect(await output.textContent()).not.toContain("\u001b");
	expect(tap.commands("prompt").map((c) => c.message)).toEqual(["/context"]);
});

test("an unknown /name is held back with its web counterpart, and Send to model anyway sends it", async ({ page }) => {
	ownSession(0xd7, "Slash unknown probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	tap.answer("prompt", (c) => (c.message === "/clear" ? { ok: true, data: { agentInvoked: false } } : undefined));
	await page.goto("/");
	await startLive(page, tap, "Slash unknown probe", "slash-unknown-probe");

	const composer = page.getByTestId("composer");
	const notice = page.getByTestId("slash-unknown");
	await composer.fill("/clear");
	await composer.press("Enter");
	await expect(notice).toBeVisible();
	await expect(notice).toContainText("/clear");
	await expect(notice.getByTestId("slash-equivalent")).toHaveText("New chat");
	// Nothing was sent, and the draft is still there to fix or to send anyway.
	expect(tap.commands("prompt")).toHaveLength(0);
	await expect(composer).toHaveValue("/clear");

	// Changing the text is a different message: the notice goes.
	await composer.fill("/clear now");
	await expect(notice).toHaveCount(0);
	await composer.fill("/clear");
	await composer.press("Enter");
	await expect(notice).toBeVisible();
	// Esc closes it without sending or stopping anything.
	await composer.press("Escape");
	await expect(notice).toHaveCount(0);
	await expect(composer).toHaveValue("/clear");

	await composer.press("Enter");
	await notice.getByTestId("slash-send-anyway").click();
	await expect.poll(() => tap.commands("prompt").map((c) => c.message)).toEqual(["/clear"]);
	await expect(notice).toHaveCount(0);
	await expect(composer).toHaveValue("");
});

test("a held-back command with a web counterpart takes you there", async ({ page }) => {
	ownSession(0xd8, "Slash counterpart probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await startLive(page, tap, "Slash counterpart probe", "slash-counterpart-probe");

	const composer = page.getByTestId("composer");
	await composer.fill("/new");
	await composer.press("Enter");
	await page.getByTestId("slash-equivalent").click();
	await expect(page.getByTestId("cwd-picker")).toBeVisible();
	expect(tap.commands("prompt")).toHaveLength(0);
});

test("a path or a sentence that starts with a slash is not a command: it is sent as it is", async ({ page }) => {
	ownSession(0xd9, "Slash path probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	tap.answer("prompt", () => ({ ok: true, data: { agentInvoked: false } }));
	await page.goto("/");
	await startLive(page, tap, "Slash path probe", "slash-path-probe");

	const composer = page.getByTestId("composer");
	await composer.fill("/tmp/ompw-fixture-project/src/main.ts fails to compile");
	await composer.press("Enter");
	await expect
		.poll(() => tap.commands("prompt").map((c) => c.message))
		.toEqual(["/tmp/ompw-fixture-project/src/main.ts fails to compile"]);
	await expect(page.getByTestId("slash-unknown")).toHaveCount(0);
});

test("a conversation without a process holds terminal-only commands back too, without starting omp", async ({
	page,
}) => {
	// A conversation of its own, opened straight from its URL: the new-chat page at `/` starts a process of its own,
	// and a shared fixture may have one another spec started; either's requests could arrive while this is measured.
	const file = writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xf4, "Slash no-process probe");
	const tap = await tapSocket(page);
	await page.goto(`/#/s/${encodeURIComponent(file)}`);
	await expect(page.getByTestId("msg-user")).toHaveCount(1);
	expect(tap.sent.filter((m) => m.t === "open")).toHaveLength(0);
	const before = tap.sent.length;
	const composer = page.getByTestId("composer");
	await composer.fill("/tree");
	await composer.press("Enter");
	await expect(page.getByTestId("slash-unknown")).toContainText("/tree");
	await expect(page.getByTestId("slash-equivalent")).toHaveText("Open side panel");
	expect(tap.sent.slice(before).filter((m) => m.t === "open" || m.t === "rpc")).toHaveLength(0);
});
