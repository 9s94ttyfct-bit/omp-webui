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

	await option("Network").click();
	await expect.poll(() => tap.sent.some((m) => JSON.stringify(m).includes('"value":"Network"'))).toBe(true);
	ask("q-2", 2);
	await expect(ticked()).toHaveText(["CPU", "Network"]);

	// A second pick of a ticked option unticks it, as omp does.
	await option("CPU").click();
	ask("q-3", 1);
	await expect(ticked()).toHaveText(["Network"]);
});
