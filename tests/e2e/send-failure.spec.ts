import { attachPicked } from "../support/drop-files.ts";
import { FIXTURE } from "../support/fixtures.ts";
import { expect, type Page, test } from "./fixtures.ts";

/** A rejected send keeps the draft and attachments (the server's `prompt` reply is forced to fail; no model call). */

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

async function failPrompts(page: Page) {
	await page.routeWebSocket(/\/ws$/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.t === "rpc" && msg.command?.type === "prompt") {
				ws.send(JSON.stringify({ t: "reply", req: msg.req, ok: false, error: "forced prompt failure" }));
				return;
			}
			server.send(raw);
		});
		server.onMessage((raw) => ws.send(raw));
	});
}

async function draft(page: Page, text: string) {
	await page.getByTestId("composer").fill(text);
	await attachPicked(page, { name: "dot.png", mimeType: "image/png", buffer: PNG_1X1 });
	await expect(page.getByRole("img", { name: "dot.png" })).toBeVisible();
	await page.getByTestId("send").click();
	await expect(page.getByText("forced prompt failure")).toBeVisible();
	await expect(page.getByTestId("composer")).toHaveValue(text);
	await expect(page.getByRole("img", { name: "dot.png" })).toBeVisible();
}

test("a failed send in a new chat keeps the draft and stays on the new-chat page", async ({ page }) => {
	await failPrompts(page);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	await draft(page, "keep me (new chat)");
	await expect(page.getByTestId("cwd-picker")).toBeVisible();
});

test("a failed send in an existing conversation keeps the draft", async ({ page }) => {
	await failPrompts(page);
	await page.goto("/");
	await page.getByText(FIXTURE.alphaTitle).click();
	await draft(page, "keep me (existing chat)");
});
