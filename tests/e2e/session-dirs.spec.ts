import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A conversation started with `--profile` or `--session-dir` keeps its transcript in another folder. The server
 * remembers the folder it has started omp with, so that such a conversation is listed in the sidebar and can be
 * reopened. No model call: what the options form sends is what this checks.
 */

const FLAG = "--session-dir";
const PROFILE = "--profile";

/** The `open` requests the page sent: each one starts an omp process. */
const opens = (tap: SocketTap) => tap.sent.filter((m) => m.t === "open");

test("the options that keep a conversation's transcript in another folder are offered again", async ({ page }) => {
	// New chat's own folder: left to itself it takes the most recent conversation's, which an earlier spec of the worker
	// may have removed (resume-folder's, git-status's), and New chat then shows that error instead of the model picker.
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	await page.getByRole("button", { name: /^Options/ }).click();
	const form = page.getByTestId("flag-form");
	await expect(form).toBeVisible();
	// Both are options of a new conversation, with a value of their own.
	await expect(form.locator(`[data-flag="${FLAG}"]`)).toHaveCount(1);
	await expect(form.locator(`[data-flag="${PROFILE}"]`)).toHaveCount(1);
});

test("a conversation started with --session-dir is started with it", async ({ page }) => {
	const tap = await tapSocket(page);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	await page.getByRole("button", { name: /^Options/ }).click();
	const field = page.locator(`[data-flag="${FLAG}"]`);
	await field.fill("/tmp/ompw-e2e-sessions");
	await field.press("Enter");
	// The process is started with the flag, so that its transcript lands in that folder.
	await expect.poll(() => opens(tap).length).toBeGreaterThan(1);
	expect(opens(tap).at(-1)?.target?.args).toContain(`${FLAG}=/tmp/ompw-e2e-sessions`);
});
