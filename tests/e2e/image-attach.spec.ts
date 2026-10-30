import { attachPicked } from "../support/drop-files.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Attaching images in the composer: big pictures are shrunk, and ones that cannot fit are refused with a
 * toast instead of being queued for a message the socket would not carry (no model call; nothing is sent).
 */

const MB = 1024 * 1024;

/** A gradient PNG drawn in the browser: large in pixels, small in bytes. */
async function gradientPng(page: Page, width: number, height: number): Promise<Buffer> {
	const dataUrl = await page.evaluate(
		([w, h]) => {
			const c = document.createElement("canvas");
			c.width = w;
			c.height = h;
			const g = c.getContext("2d") as CanvasRenderingContext2D;
			const fill = g.createLinearGradient(0, 0, w, 0);
			fill.addColorStop(0, "#3b82f6");
			fill.addColorStop(1, "#ec4899");
			g.fillStyle = fill;
			g.fillRect(0, 0, w, h);
			return c.toDataURL("image/png");
		},
		[width, height],
	);
	return Buffer.from(dataUrl.split(",")[1], "base64");
}

test("a photo wider than 2560 px is attached scaled down, as JPEG", async ({ page }) => {
	await page.goto("/");
	const png = await gradientPng(page, 3000, 1500);
	await attachPicked(page, { name: "wide.png", mimeType: "image/png", buffer: png });
	const chip = page.getByRole("img", { name: "wide.png" });
	await expect(chip).toBeVisible();
	await expect(chip).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
	await expect.poll(() => chip.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2560);
});

test("a file over the per-image limit is refused with a toast and not attached", async ({ page }) => {
	await page.goto("/");
	await attachPicked(page, { name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(9 * MB) });
	const toast = page.getByTestId("toast").filter({ hasText: "huge.png" });
	await expect(toast).toContainText("too large");
	await expect(toast).toContainText("9 MB");
	await expect(toast).toContainText("8 MB");
	await expect(page.getByRole("img", { name: "huge.png" })).toHaveCount(0);
});

test("images beyond the per-message total are refused one by one", async ({ page }) => {
	await page.goto("/");
	const file = (n: number) => ({ name: `img${n}.png`, mimeType: "image/png", buffer: Buffer.alloc(7 * MB) });
	await attachPicked(page, [file(1), file(2), file(3)]);
	await expect(page.getByRole("img", { name: "img1.png" })).toBeVisible();
	await expect(page.getByRole("img", { name: "img2.png" })).toBeVisible();
	const toast = page.getByTestId("toast").filter({ hasText: "img3.png" });
	await expect(toast).toContainText("Not attached");
	await expect(toast).toContainText("21 MB");
	await expect(toast).toContainText("20 MB");
	await expect(page.getByRole("img", { name: "img3.png" })).toHaveCount(0);

	// What is already attached counts: a further image that would pass the total is refused too.
	await attachPicked(page, { ...file(4), buffer: Buffer.alloc(7 * MB) });
	await expect(page.getByTestId("toast").filter({ hasText: "img4.png" })).toContainText("Not attached");
	await expect(page.getByRole("img", { name: "img4.png" })).toHaveCount(0);
});
