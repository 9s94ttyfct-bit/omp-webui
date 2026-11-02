import { chromium } from "@playwright/test";
import { newChatIn } from "../support/new-chat.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A conversation's agent browses in the built-in browser (docs/agents/browser.md): its omp is pointed at the
 * conversation's own CDP endpoint, so a page it opens is that conversation's page, listed in its Browser tab and in no
 * other conversation's. Needs a model.
 */

let server: TestServer;

test.describe("with a model", () => {
	test.skip(!process.env.OMPW_E2E_HAS_TOKEN, "needs an Anthropic token (omp token anthropic)");

	test.beforeAll(async () => {
		// The browser Playwright installed stands in for an installed Chrome for Testing.
		server = await startTestServer(0, { OMPW_BROWSER_EXECUTABLE: chromium.executablePath() });
	});
	test.afterAll(async () => {
		await server?.stop();
	});

	/** The titles of `owner`'s pages, as the Browser tab's socket lists them. */
	const titlesOf = (page: Page, owner: string): Promise<string[]> =>
		page.evaluate(
			(owner) =>
				new Promise<string[]>((resolve, reject) => {
					const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws/browser`);
					const timer = setTimeout(() => reject(new Error("no page list")), 15_000);
					ws.onopen = () => ws.send(JSON.stringify({ t: "watch", owner, targetId: null, panel: { w: 800, h: 600 } }));
					ws.onmessage = (e) => {
						if (typeof e.data !== "string") return;
						const m = JSON.parse(e.data) as { t: string; owner?: string; pages?: { title: string }[] };
						if (m.t !== "pages" || m.owner !== owner) return;
						clearTimeout(timer);
						ws.close();
						resolve((m.pages ?? []).map((p) => p.title));
					};
				}),
			owner,
		);

	test("the agent's page is its conversation's, and no other conversation's", async ({ page }) => {
		await page.goto(newChatIn(server.work, `${server.url}/?token=${server.accessToken}`));
		await expect(page.getByTestId("model-picker")).toContainText(/haiku/i, { timeout: 60_000 });
		await page
			.getByTestId("composer")
			.fill(
				"Use your browser tool to open data:text/html,<title>ompw-agent</title><h1>hello</h1> and read its title. Reply with the title only.",
			);
		await page.getByTestId("send").click();
		await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 180_000 });

		const lives = (await page.evaluate(() => fetch("/api/lives").then((r) => r.json()))) as {
			exited: boolean;
			sessionFile: string | null;
		}[];
		const file = lives.find((l) => !l.exited && l.sessionFile)?.sessionFile as string;
		expect(file).toBeTruthy();
		await expect.poll(() => titlesOf(page, file), { timeout: 30_000 }).toContain("ompw-agent");
		expect(await titlesOf(page, server.fixtures.alpha)).not.toContain("ompw-agent");
	});
});
