import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * New chat starts omp for the folder and the options in advance. An option's value is part of what that process is
 * started with, but it only matters from the first message: typing one must not start (and kill) a process per pause
 * (#436: nine processes for `tabs only`). The value is applied when the field is left or Enter is pressed. No model call.
 */

const FLAG = "--append-system-prompt";

/** The `open` requests the page sent: each one starts an omp process. */
const opens = (tap: SocketTap) => tap.sent.filter((m) => m.t === "open");

test("typing an option's value starts no omp until the field is left or Enter is pressed", async ({ page }) => {
	const tap = await tapSocket(page);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	expect(opens(tap)).toHaveLength(1);

	await page.getByRole("button", { name: /^Options/ }).click();
	const field = page.locator(`[data-flag="${FLAG}"]`);
	await field.click();
	// Every pause is longer than the 250 ms the warm-up waits before it starts a process.
	await field.pressSequentially("tabs only", { delay: 380 });
	await expect(field).toHaveValue("tabs only");
	expect(opens(tap)).toHaveLength(1);

	// Enter applies it: one new process, started with the option.
	await field.press("Enter");
	await expect.poll(() => opens(tap).length).toBe(2);
	expect(opens(tap)[1]?.target?.args).toEqual([`${FLAG}=tabs only`]);
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });

	// Leaving the field applies an edit as well; an edit that changes nothing starts nothing.
	await field.fill("spaces");
	await page.getByRole("button", { name: /^Options/ }).focus();
	await expect.poll(() => opens(tap).length).toBe(3);
	expect(opens(tap)[2]?.target?.args).toEqual([`${FLAG}=spaces`]);
	await field.focus();
	await page.getByRole("button", { name: /^Options/ }).focus();
	await page.waitForTimeout(800);
	expect(opens(tap)).toHaveLength(3);
});

test("a value typed and not yet applied is applied when focus moves to another field", async ({ page }) => {
	const tap = await tapSocket(page);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	await page.getByRole("button", { name: /^Options/ }).click();
	const field = page.locator(`[data-flag="${FLAG}"]`);
	await field.fill("kept");
	// Clicking elsewhere (here: the filter box) leaves the field, which applies the value.
	await page.getByPlaceholder("Filter…").click();
	await expect.poll(() => opens(tap).length).toBe(2);
	expect(opens(tap)[1]?.target?.args).toEqual([`${FLAG}=kept`]);
});
