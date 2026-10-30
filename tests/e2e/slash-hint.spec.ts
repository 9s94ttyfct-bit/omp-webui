import { tapSocket } from "../support/socket-tap.ts";
import { devices, expect, test } from "./fixtures.ts";

/**
 * A command whose argument list is longer than the row (omp's /security lists eleven subcommands): on a phone the list
 * ends in an ellipsis and its description still has room, instead of the arguments running out of the menu and the
 * description being cut away. The command list is answered locally; no model call.
 */

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 15"];
test.use({ ...phone });

const HINT = "<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>";

test("a long argument list ends in an ellipsis and leaves room for the description", async ({ page }) => {
	const tap = await tapSocket(page);
	tap.answer("get_available_commands", () => ({
		ok: true,
		data: {
			commands: [
				{
					name: "security",
					description: "Plan, run and compare security scans",
					source: "builtin",
					input: { hint: HINT },
				},
			],
		},
	}));
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	await page.getByTestId("composer").fill("/secur");
	const row = page.getByTestId("slash-menu").getByRole("option", { name: /security/ });
	await expect(row).toBeVisible();
	const hint = row.getByText(HINT);
	const description = row.getByText("Plan, run and compare security scans");
	// The hint is cut with an ellipsis inside the row; the description is drawn, inside the row too.
	await expect(hint).toHaveCSS("text-overflow", "ellipsis");
	const [rowBox, hintBox, descBox] = await Promise.all([
		row.boundingBox(),
		hint.boundingBox(),
		description.boundingBox(),
	]);
	if (!rowBox || !hintBox || !descBox) throw new Error("the row is not laid out");
	expect(hintBox.x + hintBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
	expect(descBox.width).toBeGreaterThan(40);
	expect(descBox.x + descBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
});
