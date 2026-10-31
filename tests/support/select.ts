import { expect, type Locator } from "@playwright/test";

/**
 * The app's selects (`Select`, web/src/components/Select.tsx) are its own listbox on a computer and the system's
 * `<select>` on a touch screen. These drive either: a spec says what it chooses, not which control it got. The value
 * chosen is `data-value` on both (`expect(select).toHaveAttribute("data-value", "high")`).
 */

/** One choice of a select, as the page offers it. */
export type SelectOption = { value: string; text: string; disabled: boolean };

/** Whether the select is the system's `<select>` here (a touch screen) rather than the app's own listbox. */
const isNative = (select: Locator) => select.evaluate((el) => el instanceof HTMLSelectElement);

/** Chooses an option of one of the app's selects, by its value or by its text (`{ label }`). */
export async function choose(
	select: Locator,
	option: string | { label: string },
	options: { timeout?: number } = {},
): Promise<void> {
	await expect(select).toBeVisible(options);
	if (await isNative(select)) {
		await select.selectOption(option, options);
		return;
	}
	await select.click(options);
	// The open list: there is one at a time.
	const list = select.page().getByRole("listbox");
	const item =
		typeof option === "string"
			? list.locator(`[role="option"][data-value=${JSON.stringify(option)}]`)
			: list.getByRole("option", { name: option.label, exact: true });
	await item.click(options);
	await expect(list).toHaveCount(0);
}

/** Every option of a select in its order, read from its list (opened and closed again) or from its `<option>`s. */
export async function readOptions(select: Locator): Promise<SelectOption[]> {
	if (await isNative(select))
		return select.locator("option").evaluateAll((els) =>
			els.map((el) => {
				const option = el as HTMLOptionElement;
				return { value: option.value, text: option.text.trim(), disabled: option.disabled };
			}),
		);
	await select.click();
	const list = select.page().getByRole("listbox");
	await expect(list).toBeVisible();
	const read = await list.getByRole("option").evaluateAll((els) =>
		els.map((el) => ({
			value: (el as HTMLElement).dataset.value ?? "",
			text: el.textContent?.trim() ?? "",
			disabled: el.hasAttribute("data-disabled"),
		})),
	);
	await select.page().keyboard.press("Escape");
	await expect(list).toHaveCount(0);
	return read;
}

/** The words a select shows for what is chosen. */
export function shownText(select: Locator): Promise<string> {
	return select.evaluate((el) =>
		el instanceof HTMLSelectElement ? (el.selectedOptions[0]?.text ?? "") : (el.textContent ?? ""),
	);
}
