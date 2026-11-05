import AxeBuilder from "@axe-core/playwright";
import { newChatIn } from "../support/new-chat.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * The message box's list of slash commands as a screen reader meets it: the box says it completes from a list, which
 * list, and which entry Tab or Enter would insert, while the keyboard stays in the box; an entry pressed (as a screen
 * reader or a switch presses it) is inserted. The command list is answered locally; no model call.
 */

test("the box names the open list and its highlighted command; an entry pressed is inserted", async ({ page }) => {
	const tap = await tapSocket(page);
	tap.answer("get_available_commands", () => ({
		ok: true,
		data: {
			commands: [
				{ name: "security", description: "Plan and run security scans", source: "builtin" },
				{ name: "session", description: "Show the session", source: "builtin" },
			],
		},
	}));
	await page.goto(newChatIn(process.env.OMPW_E2E_WORK as string));
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	const box = page.getByTestId("composer");
	await expect(box).toHaveAttribute("aria-autocomplete", "list");
	await expect(box).not.toHaveAttribute("aria-controls");
	await box.fill("/se");
	const list = page.getByTestId("slash-menu");
	const options = list.getByRole("option");
	await expect(options).toHaveCount(2);
	await expect(box).toHaveAttribute("aria-controls", (await list.getAttribute("id")) ?? "no id");
	const first = (await options.nth(0).getAttribute("id")) ?? "no id";
	const second = (await options.nth(1).getAttribute("id")) ?? "no id";
	expect(first).not.toBe(second);
	await expect(box).toHaveAttribute("aria-activedescendant", first);
	await box.press("ArrowDown");
	await expect(box).toHaveAttribute("aria-activedescendant", second);
	await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
	// The entries are not stops of their own: Tab inserts the highlighted one, and focus stays in the box.
	await expect(options.nth(0)).toHaveAttribute("tabindex", "-1");
	const violations = (
		await new AxeBuilder({ page }).include('[data-testid="composer"]').include('[data-testid="slash-menu"]').analyze()
	).violations;
	expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

	// Pressed rather than clicked with a mouse (no mousedown first): the entry is inserted all the same.
	await options.nth(0).press("Enter");
	await expect(box).toHaveValue(/^\/security/);
	await expect(list).toHaveCount(0);
	await expect(box).not.toHaveAttribute("aria-activedescendant");
});
