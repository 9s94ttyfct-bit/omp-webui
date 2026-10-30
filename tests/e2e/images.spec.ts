import { attachPicked } from "../support/drop-files.ts";
import { appReady } from "../support/live.ts";
import { expect, type Page, test } from "./fixtures.ts";

/** Image attachments reach omp and persisted images render (real omp + Claude Haiku 5.5). */

test.skip(!process.env.OMPW_E2E_HAS_TOKEN, "needs an Anthropic token (omp token anthropic)");

/** A PNG with a large word on it, drawn in the browser. */
async function wordPng(page: Page, word: string): Promise<Buffer> {
	const dataUrl = await page.evaluate((w) => {
		const c = document.createElement("canvas");
		c.width = 480;
		c.height = 200;
		const g = c.getContext("2d") as CanvasRenderingContext2D;
		g.fillStyle = "#ffffff";
		g.fillRect(0, 0, c.width, c.height);
		g.fillStyle = "#000000";
		g.font = "bold 96px sans-serif";
		g.fillText(w, 30, 135);
		return c.toDataURL("image/png");
	}, word);
	return Buffer.from(dataUrl.split(",")[1], "base64");
}

test("an attached image is sent to the model and shown after reload", async ({ page }) => {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText(/haiku/i, { timeout: 60_000 });
	const png = await wordPng(page, "PIZZA");

	// Attach, remove, attach again.
	await attachPicked(page, { name: "word.png", mimeType: "image/png", buffer: png });
	await expect(page.getByRole("img", { name: "word.png" })).toBeVisible();
	await page.getByRole("button", { name: "Remove word.png" }).click();
	await expect(page.getByRole("img", { name: "word.png" })).toHaveCount(0);
	await attachPicked(page, { name: "word.png", mimeType: "image/png", buffer: png });

	await page
		.getByTestId("composer")
		.fill("What single word is written in the attached image? Reply with just that word.");
	await page.getByTestId("send").click();
	await expect(page.getByTestId("msg-assistant").last()).toContainText(/pizza/i, { timeout: 90_000 });
	await expect(page.getByRole("img", { name: "word.png" })).toHaveCount(0);

	// The persisted transcript stores the image (possibly as a blob ref) and still renders it.
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill("written in the attached image");
	await page.getByTestId("search-hit").first().click();
	const shown = page.getByTestId("msg-user").first().getByRole("img", { name: "Attachment" });
	await expect(shown).toBeVisible();
	await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100);
});
