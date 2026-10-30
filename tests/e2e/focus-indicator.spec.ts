import { FIXTURE } from "../support/fixtures.ts";
import { focusCue } from "../support/style.ts";
import { expect, type Locator, test } from "./fixtures.ts";

/**
 * The default focus ring sits in a CSS layer: a control keeps its own shape (the round Send button), and can swap the
 * ring for another cue (the composer card). Whatever it does, a control must show focus somehow (no model call).
 */

test("Send stays round when Tab brings focus to it, and the ring is drawn", async ({ page }) => {
	await page.goto("/");
	const composer = page.getByTestId("composer");
	await composer.fill("hello");
	const send = page.getByTestId("send");
	for (let i = 0; i < 12 && !(await send.evaluate((el) => el === document.activeElement)); i++)
		await page.keyboard.press("Tab");
	await expect(send).toBeFocused();
	const look = await send.evaluate((el) => {
		const s = getComputedStyle(el);
		return {
			radius: Number.parseFloat(s.borderTopLeftRadius),
			height: el.getBoundingClientRect().height,
			outline: `${s.outlineStyle} ${s.outlineWidth}`,
		};
	});
	// A circle: the radius is at least half the button. (The old global rule forced 6px.)
	expect(look.radius).toBeGreaterThanOrEqual(look.height / 2);
	expect(look.outline).toBe("solid 2px");
});

test("the composer shows focus on its card, not as a box around the textarea", async ({ page }) => {
	await page.goto("/");
	await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important}" });
	const composer = page.getByTestId("composer");
	const card = composer.locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
	const read = (el: Locator) =>
		el.evaluate((e) => {
			const s = getComputedStyle(e);
			return { outline: s.outlineStyle, border: s.borderTopColor, shadow: s.boxShadow };
		});
	const accent = await page.evaluate(() => {
		const probe = document.createElement("span");
		probe.style.color = "var(--accent)";
		document.body.append(probe);
		const c = getComputedStyle(probe).color;
		probe.remove();
		return c;
	});

	const idle = await read(card);
	await composer.focus();
	expect((await read(composer)).outline).toBe("none");
	const focused = await read(card);
	expect(focused.border).toBe(accent);
	expect(focused.shadow).not.toBe(idle.shadow);
	await composer.blur();
	expect(await read(card)).toEqual(idle);
});

test("every control still shows some focus cue", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByTestId("goal-mode")).toBeVisible({ timeout: 60_000 });
	await page.getByTestId("composer").fill("hello"); // enables Send

	const missing: string[] = [];
	const check = async (name: string, target: Locator) => {
		const cue = await focusCue(page, target);
		if (!cue || cue === "NOT FOCUSABLE") missing.push(`${name}: ${cue ?? "no cue"}`);
	};

	// New chat and the sidebar.
	await check("composer", page.getByTestId("composer"));
	await check("attach", page.getByRole("button", { name: "Attach files" }));
	await check("model picker", page.getByTestId("model-picker"));
	await check("thinking select", page.getByTestId("thinking-picker"));
	await check("goal toggle", page.getByTestId("goal-mode"));
	await check("send", page.getByTestId("send"));
	await check("folder", page.getByTestId("cwd-picker"));
	await check("options", page.getByRole("button", { name: /^Options/ }));
	await check("sidebar filter", page.getByTestId("session-filter"));
	await check("project list", page.getByLabel("Project"));
	await check("new chat", page.getByTestId("new-chat"));
	await check("session row", page.getByTestId("session-item").first());
	await check("session menu", page.getByTestId("session-menu").first());
	await check("settings nav", page.getByRole("button", { name: "Settings", exact: true }));

	// Search.
	await page.keyboard.press("ControlOrMeta+k");
	await expect(page.getByTestId("palette-input")).toBeVisible();
	await check("palette input", page.getByTestId("palette-input"));
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("palette-input")).toHaveCount(0);

	// Commands page.
	await page.getByRole("button", { name: "Commands & terminal" }).click();
	await expect(page.getByTestId("cli-page")).toBeVisible();
	await check("command filter", page.getByLabel("Filter commands"));
	await check("command line", page.getByTestId("cli-line"));
	await check("run", page.getByTestId("cli-run"));

	// Settings page.
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(page.getByTestId("settings-page")).toBeVisible();
	await check("language", page.getByTestId("language"));
	await check("theme radio", page.getByRole("radio").first());
	await page.locator('[data-testid="settings-page-tab"][data-page="chats"]').click();
	await check("auto-title", page.getByTestId("auto-title"));

	// A conversation: its composer and the rename dialog.
	await page.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle }).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
	await check("chat composer", page.getByTestId("composer"));
	await page.locator('[data-testid="session-item"]', { hasText: FIXTURE.betaTitle }).hover();
	await page.getByRole("button", { name: `Actions for ${FIXTURE.betaTitle}` }).click();
	await page.getByRole("menuitem", { name: "Rename" }).click();
	await check("rename input", page.getByTestId("rename-input"));

	expect(missing).toEqual([]);
});

test("forced-colors mode draws an outline even on fields whose cue is a border", async ({ page }) => {
	await page.emulateMedia({ forcedColors: "active" });
	await page.goto("/");
	const filter = page.getByTestId("session-filter");
	await filter.focus();
	expect(
		await filter.evaluate((el) => `${getComputedStyle(el).outlineStyle} ${getComputedStyle(el).outlineWidth}`),
	).toBe("solid 2px");
});
