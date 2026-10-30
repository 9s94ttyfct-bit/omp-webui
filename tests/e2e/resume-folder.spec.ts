import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_CWD, writeSimpleSession } from "../support/fixtures.ts";
import { sessionRow } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A conversation whose folder is gone is not opened in omp's own sessions directory: the page says which folder it was and
 * asks for another before omp starts, and omp's tools run in the one chosen. The conversation is a saved file, no model.
 */

/** A saved conversation that ran in `gone`, opened and given a command to run (which is what resumes it). */
async function openGone(page: Page, n: number, title: string, gone: string) {
	const file = writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, n, title);
	writeFileSync(file, readFileSync(file, "utf8").replace(`"cwd":"${FIXTURE_CWD}"`, `"cwd":${JSON.stringify(gone)}`));
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	const resumes = () => tap.sent.filter((m) => m.t === "open" && m.target?.kind === "resume");
	await page.goto("/");
	await expect(sessionRow(page, title)).toHaveCount(1, { timeout: 15_000 });
	await sessionRow(page, title).click();
	await page.getByTestId("composer").fill("!pwd");
	await page.getByTestId("composer").press("Enter");
	return { tap, resumes, dialog: page.getByRole("dialog", { name: "Choose a folder to continue in" }) };
}

test("a conversation whose folder is gone asks where to continue, and omp runs in the folder chosen", async ({
	page,
}) => {
	const gone = join(process.env.OMPW_E2E_ROOT as string, "deleted-project", "src");
	const { tap, resumes, dialog } = await openGone(page, 0xf1, "Gone folder probe", gone);

	// Nothing has started: the dialog says what happened and what choosing a folder means.
	await expect(dialog).toContainText(`${gone}, which no longer exists`);
	await expect(dialog).toContainText("omp runs its tools");
	expect(resumes()).toHaveLength(1);

	const work = process.env.OMPW_E2E_WORK as string;
	await dialog.getByLabel("Path").fill(work);
	await dialog.getByRole("button", { name: "Go", exact: true }).click();
	await dialog.getByRole("button", { name: "Use this folder" }).click();

	// The conversation opens in that folder, and the command it was given ran there.
	await expect.poll(() => resumes().length).toBe(2);
	expect(tap.sent.findLast((m) => m.t === "open")?.target).toMatchObject({ kind: "resume", folder: work });
	await expect(page.getByText(work, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
	await expect(dialog).toHaveCount(0);
});

test("backing out of the folder dialog starts nothing", async ({ page }) => {
	const gone = join(process.env.OMPW_E2E_ROOT as string, "deleted-project-2");
	const { resumes, dialog } = await openGone(page, 0xf2, "Gone folder backed out", gone);
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByTestId("toast").filter({ hasText: "Resume cancelled" })).toBeVisible();
	const lives = (await (await page.request.get("/api/lives")).json()) as { sessionFile?: string }[];
	expect(lives.some((l) => l.sessionFile?.includes("0000000099f2"))).toBe(false);
	expect(resumes()).toHaveLength(1);
});
