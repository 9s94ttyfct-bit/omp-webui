import { expect, type Page, test } from "./fixtures.ts";

/**
 * A file dropped outside the composer must not navigate the window to it (in the macOS app that replaced the UI with
 * the file, with no way back): the page refuses such drops, and the composer still takes its own. The events are
 * dispatched on the document, as the browser does for a drag from the Finder; nothing is sent to any model.
 */

/** Dispatch a drag event carrying a file at the element `selector` matches; resolves with whether it was refused. */
function dragAt(page: Page, selector: string, type: "dragover" | "drop", withFile = true): Promise<boolean> {
	return page.evaluate(
		([sel, kind, file]) => {
			const target = document.querySelector(sel);
			if (!target) throw new Error(`no ${sel}`);
			const data = new DataTransfer();
			if (file) data.items.add(new File(["x"], "dropped.txt", { type: "text/plain" }));
			else data.setData("text/plain", "just text");
			const event = new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: data });
			target.dispatchEvent(event);
			return event.defaultPrevented;
		},
		[selector, type, withFile] as const,
	);
}

test("dragover and drop on the page body are refused, so the browser does not open the file", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByTestId("composer")).toBeVisible();
	expect(await dragAt(page, "body", "dragover")).toBe(true);
	expect(await dragAt(page, "body", "drop")).toBe(true);
	// Over other parts of the UI too.
	expect(await dragAt(page, "#root", "drop")).toBe(true);
});

test("a file dropped on a text field is refused; text dragged into one is left alone", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByTestId("composer")).toBeVisible();
	await page.evaluate(() => {
		const input = document.createElement("input");
		input.id = "probe-field";
		document.body.append(input);
	});
	expect(await dragAt(page, "#probe-field", "drop", true)).toBe(true);
	expect(await dragAt(page, "#probe-field", "drop", false)).toBe(false);
});

test("the composer still takes a dropped image (after the choice between attaching it and its path)", async ({
	page,
}) => {
	await page.goto("/");
	const composer = page.getByTestId("composer");
	await expect(composer).toBeVisible();
	await page.evaluate(() => {
		const card = document.querySelector('[data-testid="composer"]')?.closest(".rounded-2xl");
		if (!card) throw new Error("no composer card");
		const data = new DataTransfer();
		const png = Uint8Array.from(
			atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
			(c) => c.charCodeAt(0),
		);
		data.items.add(new File([png], "pixel.png", { type: "image/png" }));
		card.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
	});
	await expect(page.getByTestId("drop-choice")).toContainText("pixel.png");
	await page.getByTestId("drop-attach").click();
	await expect(page.getByRole("img", { name: "pixel.png" })).toBeVisible();
});
