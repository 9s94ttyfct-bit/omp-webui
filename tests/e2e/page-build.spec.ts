import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A tab left open across an update is the old build against the new server (#273): the page knows the version it was
 * built as, the server's `hello` names its own, and a difference is told with a Reload button. The server here is the
 * build's own, so the other version is made up on the way (`rewrite`). No model is called.
 */

test("a server of another version than the page's code is told, named in the sidebar, and Reload loads the page again", async ({
	page,
}) => {
	const tap = await tapSocket(page);
	tap.rewrite((msg) => (msg.t === "hello" ? { ...msg, serverVersion: "999.0.0" } : msg));
	// What the new server says of itself on `/api/meta` too: the page reads its sidebar line from there.
	await page.route("**/api/meta", async (route) => {
		const meta = (await (await route.fetch()).json()) as Record<string, unknown>;
		await route.fulfill({ json: { ...meta, serverVersion: "999.0.0" } });
	});
	await page.goto("/");
	const toast = page.getByTestId("toast").filter({ hasText: "this page still runs" });
	await expect(toast).toContainText("the server runs 999.0.0");
	await expect(page.getByTestId("app-versions")).toContainText(/webui 999\.0\.0 \(page \d+\.\d+\.\d+\S*\)/);
	await page.evaluate(() => {
		(window as unknown as { loadedOnce: boolean }).loadedOnce = true;
	});
	await toast.getByTestId("toast-action").click();
	await expect
		.poll(() => page.evaluate(() => (window as unknown as { loadedOnce?: boolean }).loadedOnce ?? false))
		.toBe(false);
});

test("a server of the page's own version says nothing", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByTestId("app-versions")).toContainText("webui");
	await expect(page.getByTestId("app-versions")).not.toContainText("page ");
	await expect(page.getByTestId("toast").filter({ hasText: "this page still runs" })).toHaveCount(0);
});
