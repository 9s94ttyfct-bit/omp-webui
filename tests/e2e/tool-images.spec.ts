import { rmSync } from "node:fs";
import { ownSession, startLive } from "../support/live.ts";
import { Chain, solidPng, storeBlob, writeRenderSession } from "../support/render-fixtures.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Locator, test } from "./fixtures.ts";

/**
 * A tool's images (a `read` of a PNG, a screenshot) show in its card as thumbnails that open full size, as in the
 * terminal. Saved results keep large images as `blob:sha256:` references; live ones carry base64.
 */

const agentDir = () => process.env.OMPW_E2E_AGENT_DIR as string;
const naturalWidth = (img: Locator) => img.evaluate((i: HTMLImageElement) => i.naturalWidth);

test("a saved result's image is counted on the collapsed card, a thumbnail when opened, and opens full size", async ({
	page,
}) => {
	const prompt = "Image probe: read the saved screenshot";
	const blob = storeBlob(agentDir(), solidPng(640, 400, [30, 120, 220]));
	const chain = new Chain("im01");
	chain.user(prompt);
	chain.assistant([{ type: "toolCall", id: "toolu_img_saved", name: "read", arguments: { path: "/tmp/shot.png" } }]);
	chain.toolResult("toolu_img_saved", "read", [
		{ type: "text", text: "Read image file [image/png]" },
		{ type: "image", data: blob, mimeType: "image/png" },
	]);
	chain.assistant([{ type: "text", text: "The screenshot is blue." }]);
	const file = writeRenderSession(agentDir(), "01a00000-0000-7000-8000-00000000b140", chain.entries);
	try {
		await page.goto("/");
		await page.getByRole("complementary").getByText(prompt).click();
		const card = page.getByTestId("tool-card");
		await expect(card).toHaveCount(1);
		await expect(card.getByTestId("tool-image-count")).toHaveText("1 image");
		await expect(card.getByTestId("tool-image")).toHaveCount(0);

		await card.locator("button[aria-expanded]").first().click();
		const thumb = card.getByTestId("tool-image").locator("img");
		await expect(thumb).toBeVisible();
		await expect.poll(() => naturalWidth(thumb)).toBe(640);
		// The text the tool said stays next to it.
		await expect(card).toContainText("Read image file [image/png]");

		await card.getByTestId("tool-image").click();
		const full = page.getByTestId("tool-image-full");
		await expect(full).toBeVisible();
		await expect.poll(() => naturalWidth(full)).toBe(640);
		const [small, big] = [await thumb.boundingBox(), await full.boundingBox()];
		expect(big?.height ?? 0).toBeGreaterThan(small?.height ?? Number.POSITIVE_INFINITY);
		await page.keyboard.press("Escape");
		await expect(full).toHaveCount(0);
	} finally {
		rmSync(file, { force: true });
	}
});

test("a live result's base64 image shows the same way, and a result with no image has no badge", async ({ page }) => {
	ownSession(0xb0, "Live image probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Live image probe", "live-image-probe");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });

	const call = (id: string, path: string) => ({ type: "toolCall", id, name: "read", arguments: { path } });
	frame({
		type: "message_start",
		messageId: "m-live-img",
		message: {
			role: "assistant",
			content: [call("toolu_live_img", "/tmp/live.png"), call("toolu_live_txt", "/tmp/note.txt")],
		},
	});
	for (const [id, path] of [
		["toolu_live_img", "/tmp/live.png"],
		["toolu_live_txt", "/tmp/note.txt"],
	]) {
		frame({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path } });
	}
	const png = solidPng(120, 80, [220, 60, 60]).toString("base64");
	frame({
		type: "tool_execution_end",
		toolCallId: "toolu_live_img",
		toolName: "read",
		isError: false,
		result: {
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: png, mimeType: "image/png" },
			],
		},
	});
	frame({
		type: "tool_execution_end",
		toolCallId: "toolu_live_txt",
		toolName: "read",
		isError: false,
		result: { content: [{ type: "text", text: "just text" }] },
	});

	const withImage = page.locator('[data-testid="tool-card"]', { hasText: "/tmp/live.png" });
	await expect(withImage.getByTestId("tool-image-count")).toHaveText("1 image");
	await withImage.locator("button[aria-expanded]").first().click();
	const thumb = withImage.getByTestId("tool-image").locator("img");
	await expect.poll(() => naturalWidth(thumb)).toBe(120);

	const plain = page.locator('[data-testid="tool-card"]', { hasText: "/tmp/note.txt" });
	await expect(plain).toBeVisible();
	await expect(plain.getByTestId("tool-image-count")).toHaveCount(0);
});
