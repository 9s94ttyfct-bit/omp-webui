import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { rpcState } from "../support/rpc-state.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The session panel (#716): the settings changed most are shown, the rest are folded under Advanced, and the panel fits a
 * 1280×800 window without a scroll while it is folded. The fold says when one of the folded settings is not omp's
 * default, and stays as the person left it. No model call: the controls only need a process.
 */

const panel = (page: Page) => page.getByTestId("session-controls-panel");
const fold = (page: Page) => panel(page).getByTestId("session-controls-advanced");
const FOLDED = ["auto-retry", "steering-mode", "follow-up-mode", "interrupt-mode", "cache-warming"];

/** A page of its own whose Advanced fold starts closed, with the conversation's process running and omp's state as `state`. */
async function openPanel(page: Page, title: string, state: Record<string, unknown> = {}) {
	const next = await page.context().newPage();
	await next.setViewportSize({ width: 1280, height: 800 });
	await next.addInitScript(() => {
		localStorage.setItem("ompw.autoTitle", "off");
		localStorage.setItem("ompw.controlsAdvanced", "off");
	});
	const tap = await tapSocket(next);
	await next.goto("/");
	await expect(sessionRow(next, title)).toHaveCount(1, { timeout: 15_000 });
	await startLive(next, tap, title, `fold-${title.length}-up`);
	tap.answer("get_state", () => ({ ok: true, data: rpcState(state) }));
	await next.reload();
	await sessionRow(next, title).click();
	await next.getByTestId("session-controls").click();
	await expect(panel(next)).toBeVisible({ timeout: 60_000 });
	return next;
}

test("folded, the panel shows the common settings, fits a 1280×800 window without a scroll, and Advanced holds the rest", async ({
	page,
}) => {
	ownSession(0x7160, "Panel fold 716");
	const p = await openPanel(page, "Panel fold 716");
	// It opens on its first setting, not the title's info button, whose tooltip would open with it and take the first Esc.
	await expect(p.getByRole("tooltip")).toHaveCount(0);
	await expect(panel(p).getByTestId("auto-compaction").getByRole("radio").first()).toBeFocused();
	await expect(fold(p)).toHaveAttribute("aria-expanded", "false");
	for (const row of ["auto-compaction", "fast-mode"]) await expect(panel(p).getByTestId(row)).toBeVisible();
	await expect(panel(p).getByTestId("compact-now")).toBeVisible();
	for (const row of FOLDED) await expect(panel(p).getByTestId(row)).toHaveCount(0);
	// Measured once all of it is in: the guard and Full/Light sections load after the rows, and omp's compaction setting
	// is read after them (its "Reading…" line is gone then). Measured before, a panel that overflows would pass.
	await expect(panel(p).getByTestId("session-guard")).toBeVisible();
	await expect(panel(p).getByTestId("session-mode")).toBeVisible();
	await expect(panel(p).getByTestId("compact-at-loading")).toHaveCount(0, { timeout: 15_000 });
	const fits = await panel(p).evaluate((el) => el.scrollHeight <= el.clientHeight);
	expect(fits, "no scroll inside the panel").toBe(true);
	// What the panel, the guard and Full/Light are for is still there, under their info buttons.
	for (const id of ["session-controls-note", "session-guard", "session-mode"]) {
		await panel(p).getByTestId(`${id}-info`).click();
		await expect(panel(p).getByTestId(id === "session-controls-note" ? id : `${id}-help`)).toBeVisible();
		await panel(p).getByTestId(`${id}-info`).click();
	}

	await fold(p).click();
	await expect(fold(p)).toHaveAttribute("aria-expanded", "true");
	for (const row of FOLDED) await expect(panel(p).getByTestId(row)).toBeVisible();
	// An explanation still opens from a folded row.
	await panel(p).getByTestId("cache-warming-info").click();
	await expect(panel(p).getByTestId("cache-warming-help")).toBeVisible();

	// Closed and opened again, it is as it was left.
	await p.keyboard.press("Escape");
	await expect(panel(p)).toBeHidden();
	await p.getByTestId("session-controls").click();
	await expect(fold(p)).toHaveAttribute("aria-expanded", "true");
});

test("the fold says one of its settings is not omp's default, and says nothing while they all are", async ({
	page,
}) => {
	ownSession(0x7161, "Panel fold default 716");
	const same = await openPanel(page, "Panel fold default 716");
	await expect(fold(same)).toBeVisible();
	await expect(fold(same).getByTestId("session-controls-advanced-changed")).toHaveCount(0);

	ownSession(0x7162, "Panel fold changed 716");
	const changed = await openPanel(page, "Panel fold changed 716", { steeringMode: "all" });
	await expect(fold(changed).getByTestId("session-controls-advanced-changed")).toBeVisible();
});
