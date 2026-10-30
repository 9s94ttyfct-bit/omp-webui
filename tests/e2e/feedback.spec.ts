import { appReady } from "../support/live.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The Feedback dialog: reachable from Settings, the command palette and the keyboard shortcuts page (not from the sidebar,
 * #660); guides a bug or a
 * feature, previews a sanitized issue, and opens GitHub's new-issue page prefilled (GitHub itself is stubbed).
 */

const ISSUES_NEW = "https://github.com/9s94ttyfct-bit/omp-webui/issues/new";

async function stubGitHub(page: Page) {
	await page
		.context()
		.route("https://github.com/**", (route) =>
			route.fulfill({ body: "<title>stub</title>", contentType: "text/html" }),
		);
}

async function openFromSidebar(page: Page) {
	// Send feedback is a card of Settings (#660), not a button of the sidebar.
	await page.goto("/#/settings/app");
	await page.getByTestId("settings-feedback").click();
	const dialog = page.getByRole("dialog", { name: "Send feedback" });
	await expect(dialog).toBeVisible();
	return dialog;
}

test("a bug report is guided, previewed with secrets removed, and opens a prefilled GitHub issue", async ({ page }) => {
	await stubGitHub(page);
	const meta: { home: string; user: string; serverVersion: string; ompVersion: string } = await (
		await page.request.get("/api/meta")
	).json();
	const dialog = await openFromSidebar(page);

	// Nothing to preview until the summary and what happened are filled in.
	const preview = dialog.getByTestId("feedback-preview-button");
	await expect(preview).toBeDisabled();
	await dialog.getByTestId("feedback-summary").fill("Sidebar loses the selection");
	await expect(preview).toBeDisabled();
	await dialog
		.getByTestId("feedback-happened")
		.fill(
			`After archiving, the list reset. Log: ${meta.home}/work/app.log token=hunter2hunter2 mail jane@example.com shell ${meta.user}@mac`,
		);
	await dialog.getByTestId("feedback-steps").fill("1. Select two\n2. Archive");
	await dialog.getByTestId("feedback-expected").fill("The selection stays");
	await dialog.getByTestId("feedback-actual").fill("It resets & scrolls to top");
	await expect(preview).toBeEnabled();
	await preview.click();

	const body = dialog.getByTestId("feedback-body");
	await expect(dialog.getByTestId("feedback-title")).toHaveText("Bug: Sidebar loses the selection");
	await expect(dialog.getByTestId("feedback-labels")).toHaveText("bug");
	await expect(body).toContainText("### What happened");
	await expect(body).toContainText("### Steps to reproduce");
	await expect(body).toContainText("### What I expected");
	await expect(body).toContainText("### What actually happened");
	await expect(body).toContainText("### Diagnostics");
	await expect(body).toContainText(`web UI: ${meta.serverVersion}`);
	await expect(body).toContainText(`omp: ${meta.ompVersion}`);
	await expect(body).toContainText(/OS: .+\(.+\)/);
	await expect(body).toContainText("Mode: full");
	await expect(body).toContainText(/Browser: .*Chrome/);
	// What the user typed is cleaned: no token, no address, no home folder.
	await expect(body).toContainText("~/work/app.log");
	await expect(body).toContainText("[email]");
	for (const leaked of ["hunter2", "jane@example.com", meta.home]) await expect(body).not.toContainText(leaked);
	// (A user name too short or too common to hunt down, like `root` on CI, stays.)
	if (meta.user.length >= 3 && meta.user !== "root") await expect(body).toContainText("[user]@mac");

	const open = dialog.getByTestId("feedback-open");
	const href = (await open.getAttribute("href")) ?? "";
	expect(href.startsWith(`${ISSUES_NEW}?`)).toBe(true);
	const [popup] = await Promise.all([page.waitForEvent("popup"), open.click()]);
	await popup.waitForLoadState();
	const url = new URL(popup.url());
	expect(`${url.origin}${url.pathname}`).toBe(ISSUES_NEW);
	expect(url.searchParams.get("title")).toBe("Bug: Sidebar loses the selection");
	expect(url.searchParams.get("labels")).toBe("bug");
	const sent = url.searchParams.get("body") ?? "";
	expect(sent).toContain(
		"### What happened\n\nAfter archiving, the list reset. Log: ~/work/app.log token=[redacted] mail [email]",
	);
	expect(sent).toContain("### Steps to reproduce\n\n1. Select two\n2. Archive");
	expect(sent).toContain("It resets & scrolls to top");
	expect(sent).toContain(`web UI: ${meta.serverVersion}`);
	for (const leaked of ["hunter2", "jane@example.com", meta.home]) expect(popup.url() + sent).not.toContain(leaked);
	// The draft is spent: the dialog closes and the next report starts empty.
	await expect(dialog).toBeHidden();
	await page.getByTestId("settings-feedback").click();
	await expect(page.getByTestId("feedback-summary")).toHaveValue("");
});

test("a feature request asks for the problem first and can go without diagnostics; the palette opens it", async ({
	page,
}) => {
	await stubGitHub(page);
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill("feedback");
	await page.getByTestId("palette-feedback").click();
	const dialog = page.getByRole("dialog", { name: "Send feedback" });
	await expect(dialog).toBeVisible();

	await dialog.getByTestId("feedback-kind-feature").check({ force: true });
	await expect(dialog.getByTestId("feedback-happened")).toHaveCount(0);
	await dialog.getByTestId("feedback-summary").fill("Export as PDF");
	await expect(dialog.getByTestId("feedback-preview-button")).toBeDisabled();
	await dialog.getByTestId("feedback-problem").fill("I cannot share a conversation with someone without omp.");
	await dialog.getByTestId("feedback-solution").fill("An Export as PDF button.");
	await dialog.getByTestId("feedback-diagnostics").uncheck();
	await dialog.getByTestId("feedback-preview-button").click();

	await expect(dialog.getByTestId("feedback-title")).toHaveText("Feature: Export as PDF");
	await expect(dialog.getByTestId("feedback-labels")).toHaveText("enhancement");
	const body = dialog.getByTestId("feedback-body");
	await expect(body).toContainText("### The problem this solves");
	await expect(body).toContainText("### What I would like");
	await expect(body).not.toContainText("Diagnostics");

	// Back to the form keeps what was written.
	await dialog.getByTestId("feedback-back").click();
	await expect(dialog.getByTestId("feedback-summary")).toHaveValue("Export as PDF");
	await dialog.getByTestId("feedback-preview-button").click();

	const [popup] = await Promise.all([page.waitForEvent("popup"), dialog.getByTestId("feedback-open").click()]);
	await popup.waitForLoadState();
	const url = new URL(popup.url());
	expect(url.searchParams.get("labels")).toBe("enhancement");
	expect(url.searchParams.get("title")).toBe("Feature: Export as PDF");
	expect(url.searchParams.get("body")).toBe(
		"### The problem this solves\n\nI cannot share a conversation with someone without omp.\n\n### What I would like\n\nAn Export as PDF button.",
	);
});

test("the shortcuts page leads to the feedback dialog", async ({ page }) => {
	await page.goto("/");
	await page.locator("body").click({ position: { x: 600, y: 10 } });
	await page.keyboard.press("?");
	const card = page.getByTestId("shortcuts-settings");
	await expect(card).toBeVisible();
	await card.getByTestId("help-feedback").scrollIntoViewIfNeeded();
	await card.getByTestId("help-feedback").click();
	await expect(page.getByRole("dialog", { name: "Send feedback" })).toBeVisible();
	// The page stays: the dialog opened over Settings, which is where the card is.
	await expect(card).toBeVisible();
});

test("text too long for a link is cut with a note, and the link stays within the limit", async ({ page }) => {
	await stubGitHub(page);
	const dialog = await openFromSidebar(page);
	await dialog.getByTestId("feedback-summary").fill("Huge log");
	await dialog.getByTestId("feedback-happened").fill("error line\n".repeat(2000));
	await dialog.getByTestId("feedback-preview-button").click();
	await expect(dialog.getByTestId("feedback-truncated")).toContainText("too long for a link");
	const [popup] = await Promise.all([page.waitForEvent("popup"), dialog.getByTestId("feedback-open").click()]);
	await popup.waitForLoadState();
	expect(popup.url().length).toBeLessThanOrEqual(7000);
	expect(new URL(popup.url()).searchParams.get("body")).toContain("paste it here to replace this cut one");
});

test("a long Chinese report is cut for the link, but Copy and Open put all of it on the clipboard and Open keeps the form", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await stubGitHub(page);
	const dialog = await openFromSidebar(page);
	const sentence = "归档之后列表被重置，滚动位置也丢了。";
	const report = `${sentence.repeat(150)}结尾`;
	await dialog.getByTestId("feedback-summary").fill("很长的中文报告");
	await dialog.getByTestId("feedback-happened").fill(report);
	await dialog.getByTestId("feedback-steps").fill("1. 打开\n2. 归档");
	await dialog.getByTestId("feedback-preview-button").click();
	await expect(dialog.getByTestId("feedback-truncated")).toContainText("too long for a link");
	// The cut body says where the rest is.
	await expect(dialog.getByTestId("feedback-body")).toContainText("copied to your clipboard");
	await expect(dialog.getByTestId("feedback-body")).not.toContainText("结尾");

	const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
	const whole = (text: string) => {
		expect(text.startsWith("Bug: 很长的中文报告\n\n### What happened\n\n")).toBe(true);
		expect(text).toContain(`${report}\n\n### Steps to reproduce\n\n1. 打开\n2. 归档`);
		expect(text).toContain("### Diagnostics");
		expect(text).toMatch(/Browser: .*Chrome/);
	};

	await dialog.getByTestId("feedback-copy").click();
	await expect(dialog.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
	whole(await clipboard());

	await page.evaluate(() => navigator.clipboard.writeText("something else"));
	const [popup] = await Promise.all([page.waitForEvent("popup"), dialog.getByTestId("feedback-open").click()]);
	await popup.waitForLoadState();
	expect(popup.url().length).toBeLessThanOrEqual(7000);
	expect(new URL(popup.url()).searchParams.get("body")).not.toContain("结尾");
	whole(await clipboard());
	// Nothing was cleared: the dialog is still there with the preview, and going back finds the text.
	await expect(dialog.getByTestId("feedback-preview")).toBeVisible();
	await dialog.getByTestId("feedback-back").click();
	await expect(dialog.getByTestId("feedback-happened")).toHaveValue(report);
	await expect(dialog.getByTestId("feedback-summary")).toHaveValue("很长的中文报告");
});

test("the summary takes as many characters as fit the title after its prefix, and kinds switch without cutting it", async ({
	page,
}) => {
	const dialog = await openFromSidebar(page);
	const summary = dialog.getByTestId("feedback-summary");
	await summary.fill("x".repeat(200));
	await expect(summary).toHaveValue("x".repeat(115));
	await dialog.getByTestId("feedback-happened").fill("it broke");
	await dialog.getByTestId("feedback-preview-button").click();
	await expect(dialog.getByTestId("feedback-title")).toHaveText(`Bug: ${"x".repeat(115)}`);
	await dialog.getByTestId("feedback-back").click();
	await dialog.getByTestId("feedback-kind-feature").check({ force: true });
	await expect(summary).toHaveValue("x".repeat(111));
	await dialog.getByTestId("feedback-problem").fill("a problem");
	await dialog.getByTestId("feedback-preview-button").click();
	await expect(dialog.getByTestId("feedback-title")).toHaveText(`Feature: ${"x".repeat(111)}`);
});

test("the dialog is usable on a phone and in the dark theme", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 780 });
	await page.addInitScript(() => localStorage.setItem("ompw.theme", "dark"));
	await page.goto("/#/settings/app");
	await page.getByTestId("settings-feedback").click();
	const dialog = page.getByRole("dialog", { name: "Send feedback" });
	await expect(dialog).toBeVisible();
	const box = await dialog.boundingBox();
	expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
});
