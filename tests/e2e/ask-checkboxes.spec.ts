import { ownSession, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A group of checkboxes in omp's `ask` form, asked over RPC: omp asks the same `select` after each pick, with the count in
 * its title and "Done selecting" last, but sends no ticks (`lib/ask-checks.ts`). The page shows them itself: what the form
 * ticks to begin with, then each pick toggled. The frames are pushed: no model is called.
 */

const FORM = `<form>
<fieldset><legend>Show what</legend>
<label><input type="checkbox" name="show" value="cpu" checked> CPU</label>
<label><input type="checkbox" name="show" value="net"> Network</label>
<label><input type="checkbox" name="show" value="disk"> Disk</label>
</fieldset>
</form>`;
const OPTIONS = ["CPU", "Network", "Disk", "Other (type your own)", "✔ Done selecting"];

test("a checkbox question shows which options are ticked, and each pick changes it", async ({ page }) => {
	ownSession(0x5f10, "Ask checkboxes");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Ask checkboxes", "ask-checkboxes-1");
	tap.push({
		t: "frame",
		liveId,
		frame: { type: "tool_execution_start", toolCallId: "ask-1", toolName: "ask", args: { html: FORM } },
	});
	const ask = (id: string, count: number) =>
		tap.push({
			t: "frame",
			liveId,
			frame: {
				type: "extension_ui_request",
				id,
				method: "select",
				title: count ? `(${count} selected) Show what` : "Show what",
				options: OPTIONS,
			},
		});
	const request = page.getByTestId("ui-request");
	const option = (name: string) => request.getByRole("button", { name });
	const ticked = () => request.locator('button[aria-pressed="true"]');

	// The form ticks CPU to begin with.
	ask("q-1", 1);
	await expect(ticked()).toHaveText(["CPU"]);
	await expect(option("Network")).toHaveAttribute("aria-pressed", "false");
	await expect(option("✔ Done selecting")).not.toHaveAttribute("aria-pressed");

	// Between a pick and omp asking again the card stays where it is, the pick already shown: the page does not jump.
	// (Measured once the card's own fade-in, which rises 4 px, has ended.)
	await request.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
	const before = await request.boundingBox();
	await option("Network").click();
	await expect.poll(() => tap.sent.some((m) => JSON.stringify(m).includes('"value":"Network"'))).toBe(true);
	await expect(ticked()).toHaveText(["CPU", "Network"]);
	await expect(option("Disk"), "answered: not to be answered twice").toBeDisabled();
	expect((await request.boundingBox())?.y, "the card has not moved").toBe(before?.y);
	ask("q-2", 2);
	await expect(option("Disk")).toBeEnabled();
	await expect(ticked()).toHaveText(["CPU", "Network"]);
	expect((await request.boundingBox())?.y).toBe(before?.y);

	// A second pick of a ticked option unticks it, as omp does.
	await option("CPU").click();
	await expect(ticked()).toHaveText(["Network"]);
	ask("q-3", 1);
	await expect(option("Disk")).toBeEnabled();
	await expect(ticked()).toHaveText(["Network"]);

	// omp slow to ask again (a remote page through the tunnel, a busy computer): the card still waits for it, unmoved.
	await option("Disk").click();
	await page.waitForTimeout(2500);
	await expect(ticked()).toHaveText(["Network", "Disk"]);
	expect((await request.boundingBox())?.y).toBe(before?.y);
	ask("q-4", 2);
	await expect(option("Disk")).toBeEnabled();

	// Done ends the question: the card goes at once, nothing held.
	await option("✔ Done selecting").click();
	await expect(request).toHaveCount(0);
});

test("a held checkbox question goes when the ask call ends", async ({ page }) => {
	ownSession(0x5f11, "Ask checkboxes held");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Ask checkboxes held", "ask-checkboxes-2");
	tap.push({
		t: "frame",
		liveId,
		frame: { type: "tool_execution_start", toolCallId: "ask-2", toolName: "ask", args: { html: FORM } },
	});
	tap.push({
		t: "frame",
		liveId,
		frame: {
			type: "extension_ui_request",
			id: "h-1",
			method: "select",
			title: "(1 selected) Show what",
			options: OPTIONS,
		},
	});
	const request = page.getByTestId("ui-request");
	await request.getByRole("button", { name: "Disk" }).click();
	await page.waitForTimeout(500);
	await expect(request).toHaveCount(1);
	// omp ended the call instead of asking again (cancelled, or stopped): the held card goes with it.
	tap.push({
		t: "frame",
		liveId,
		frame: { type: "tool_execution_end", toolCallId: "ask-2", toolName: "ask", result: {} },
	});
	await expect(request).toHaveCount(0);
});
