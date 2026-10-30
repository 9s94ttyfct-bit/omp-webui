import { type Box, boxOf, viewportOf } from "../support/geometry.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Pages other than a chat (no model call) on a narrow screen: the commands page stacks its list above the rest
 * instead of squeezing both side by side, and no page puts text or an icon under the button that shows the sidebar.
 */

/** No text and no icon of the page (`pageTestId`) sits under the floating sidebar button. */
async function expectClearOfToggle(page: Page, pageTestId: string) {
	const toggle = await boxOf(page.getByRole("button", { name: "Show sidebar" }));
	const under = await page.getByTestId(pageTestId).evaluate((root, t: Box) => {
		const hits: string[] = [];
		for (const node of root.querySelectorAll("*")) {
			const tag = node.tagName.toLowerCase();
			if (tag !== "svg" && node.closest("svg")) continue;
			const content = tag === "svg" || (node.childElementCount === 0 && (node.textContent ?? "").trim() !== "");
			if (!content) continue;
			const r = node.getBoundingClientRect();
			if (r.width && r.height && r.left < t.x + t.width && t.x < r.right && r.top < t.y + t.height && t.y < r.bottom)
				hits.push(`${tag} "${(node.textContent ?? "").trim().slice(0, 30)}"`);
		}
		return hits;
	}, toggle);
	expect(under, "page content under the sidebar button").toEqual([]);
}

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the commands list is folded behind a row above the rest; Run and the command line fit the screen", async ({
		page,
	}) => {
		await page.goto("/#/cli");
		const toggle = page.getByTestId("cli-commands-toggle");
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		await expect(page.getByTestId("cli-command").first()).toBeHidden();
		expect((await boxOf(page.getByTestId("cli-line"))).width, "the command line").toBeGreaterThanOrEqual(200);
		await expect(page.getByTestId("cli-line")).toBeInViewport({ ratio: 1 });
		await expect(page.getByTestId("cli-run")).toBeInViewport({ ratio: 1 });
	});

	test("opened, the list is as wide as the screen with every row whole: the page scrolls, not a strip inside it", async ({
		page,
	}) => {
		await page.goto("/#/cli");
		await page.getByTestId("cli-commands-toggle").click();
		await expect(page.getByTestId("cli-commands-toggle")).toHaveAttribute("aria-expanded", "true");
		await expect(page.getByTestId("cli-command").first()).toBeVisible();
		const { width } = viewportOf(page);
		const nav = page.getByRole("navigation", { name: "Commands" });
		expect((await boxOf(nav)).width).toBeGreaterThanOrEqual(width - 1);
		expect(
			await nav.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
			"the list has no scroller of its own",
		).toBe(true);
		// The last row can be reached by scrolling the page, and is not cut.
		const last = page.getByTestId("cli-command").last();
		await last.scrollIntoViewIfNeeded();
		await expect(last).toBeInViewport({ ratio: 1 });
	});

	test("opening a command folds the list; its help, the command line and Run are on the same screen", async ({
		page,
	}) => {
		await page.goto("/#/cli");
		await page.getByTestId("cli-commands-toggle").click();
		await page.locator('[data-testid="cli-command"][data-command="auth"]').click();
		await expect(page.getByRole("heading", { name: "omp auth" })).toBeVisible();
		await expect(page.getByTestId("cli-commands-toggle")).toHaveAttribute("aria-expanded", "false");
		await expect(page.getByTestId("cli-command").first()).toBeHidden();
		await expect(page.getByTestId("cli-line")).toBeInViewport({ ratio: 1 });
		await expect(page.getByTestId("cli-run")).toBeInViewport({ ratio: 1 });
		expect((await boxOf(page.getByTestId("cli-line"))).width).toBeGreaterThanOrEqual(200);
	});

	test("running a command brings its output into view when it was below the screen", async ({ page }) => {
		// A short window: the output starts below the command line, and its first lines are under the fold.
		await page.setViewportSize({ width: 390, height: 460 });
		await page.goto("/#/cli");
		const scroller = page.getByTestId("cli-page");
		await expect(page.getByTestId("cli-run")).toBeVisible();
		expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
		await page.getByTestId("cli-line").fill("--version");
		await page.getByTestId("cli-run").click();
		await expect(page.getByTestId("cli-output").locator(".xterm")).toBeVisible();
		// The page has scrolled to the output, and the lines at its top are on screen.
		await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
		await expect(page.getByTestId("cli-output").getByRole("button", { name: /Copy output/ })).toBeInViewport({
			ratio: 1,
		});
	});

	test("nothing on the commands page sits under the sidebar button, with its list folded or open", async ({ page }) => {
		await page.goto("/#/cli");
		await expect(page.getByTestId("cli-commands-toggle")).toBeVisible();
		await expectClearOfToggle(page, "cli-page");
		await page.getByTestId("cli-commands-toggle").click();
		await expect(page.getByTestId("cli-command").first()).toBeVisible();
		await expectClearOfToggle(page, "cli-page");
	});

	test("nothing on the usage page sits under the sidebar button", async ({ page }) => {
		await page.goto("/#/usage");
		await expect(page.getByRole("heading", { name: /Usage/ })).toBeVisible();
		await expectClearOfToggle(page, "usage-page");
	});

	test("nothing on the settings pages sits under the sidebar button", async ({ page }) => {
		await page.goto("/#/settings/look");
		await expect(page.getByRole("heading", { name: /Settings/ })).toBeVisible();
		for (const id of ["look", "chats", "models", "safety", "app"]) {
			await page.locator(`[data-testid="settings-page-tab"][data-page="${id}"]`).click();
			await expect(page.locator(`[data-settings-page="${id}"]`)).not.toHaveClass(/hidden/);
			await expectClearOfToggle(page, "settings-page");
		}
	});
});

test.describe("narrow desktop window with the sidebar hidden", () => {
	test.use({ viewport: { width: 1000, height: 800 } });

	test("the usage page, which fills the window at this width, starts below the sidebar button", async ({ page }) => {
		await page.goto("/#/usage");
		await expect(page.getByRole("heading", { name: /Usage/ })).toBeVisible();
		await page.getByRole("button", { name: "Hide sidebar" }).click();
		await expectClearOfToggle(page, "usage-page");
	});
});
