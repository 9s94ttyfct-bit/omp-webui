import { FIXTURE } from "../support/fixtures.ts";
import { endAllLives } from "../support/lives.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A connection can be dead without saying so (a path that drops what it carries, a server that stopped answering), and
 * a reply can be lost on a connection that is fine (see issue #282). The page used to wait for either for good, with
 * Send disabled and "Working…" under the composer. It now gives up on a connection that does not answer, and on a
 * request that is not answered, and says so. No model call: what would reach omp is swallowed on the way.
 */

/**
 * Proxies the app's WebSocket so a test can make it swallow what either side says (without closing anything), or
 * refuse the connections the page makes next.
 */
async function wire(page: Page) {
	const state = {
		dead: false,
		refuse: false,
		swallowPrompts: false,
		/** A prompt is acknowledged as the server does once omp has it, and not answered until `answerHeld`. */
		holdPrompts: false,
		/** The page's request for the prompt that is held, and what answers it. */
		answerHeld: () => {},
	};
	await page.routeWebSocket(/\/ws$/, (ws) => {
		if (state.refuse) {
			void ws.close();
			return;
		}
		const server = ws.connectToServer();
		ws.onMessage((raw) => {
			if (state.dead) return;
			const msg = JSON.parse(String(raw));
			// Never reaches omp, so nothing calls a model; and nobody answers it.
			if (state.swallowPrompts && msg.t === "rpc" && msg.command?.type === "prompt") return;
			if (state.holdPrompts && msg.t === "rpc" && msg.command?.type === "prompt") {
				// What omp does with a prompt behind a compaction: the server has it in omp's hands at once (only when asked to
				// say so, as the page does), omp answers when the compaction is over.
				if (msg.ack === true) ws.send(JSON.stringify({ t: "ack", req: msg.req }));
				state.answerHeld = () =>
					ws.send(JSON.stringify({ t: "reply", req: msg.req, ok: true, data: { agentInvoked: true } }));
				return;
			}
			server.send(raw);
		});
		server.onMessage((raw) => {
			if (!state.dead) ws.send(raw);
		});
	});
	return state;
}

async function openAlpha(page: Page) {
	await page.goto("/");
	await page.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle }).click();
	await expect(page.getByTestId("composer")).toBeVisible();
}
// A page that shows a conversation listens to the process that runs it, so a process the test before left running would
// answer the commands these tests time: each starts on a conversation that nothing runs.
test.beforeEach(async ({ e2eServer }) => {
	await endAllLives(e2eServer);
});

test("a reply that never comes ends in an error, the draft comes back and Send works again", async ({ page }) => {
	const sock = await wire(page);
	await openAlpha(page);
	sock.swallowPrompts = true;
	const composer = page.getByTestId("composer");
	await composer.fill("hello?");
	await composer.press("Enter");
	await expect(page.getByText(/Working…/)).toBeVisible();
	await expect(page.getByTestId("send")).toBeDisabled();
	// 45 s without an answer to a message omp answers at once.
	await expect(page.getByText(/Send failed: No answer from the server/)).toBeVisible({ timeout: 70_000 });
	await expect(page.getByText(/Working…/)).toHaveCount(0);
	await expect(composer).toHaveValue("hello?");
	await expect(page.getByTestId("send")).toBeEnabled();
});

test("a message omp holds (behind a compaction) is not reported as failed once the server has handed it over", async ({
	page,
}) => {
	// Minutes pass without the page waiting for them.
	await page.clock.install();
	const sock = await wire(page);
	await openAlpha(page);
	// omp is running on the conversation first (a `!command` calls no model): starting it is a request of its own.
	const composer = page.getByTestId("composer");
	await composer.fill("!echo omp-is-up");
	await composer.press("Enter");
	await expect(page.getByText("omp-is-up", { exact: true })).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText(/Working…/)).toHaveCount(0);
	sock.holdPrompts = true;
	await composer.fill("sent while it compacts");
	await composer.press("Enter");
	await expect(page.getByText(/Working…/)).toBeVisible();
	// The old bound (45 s) is far behind, and so is the quiet that makes the page ask the connection something.
	await page.clock.fastForward(5 * 60_000);
	await expect(page.getByText(/Send failed/)).toHaveCount(0);
	await expect(page.getByText(/Working…/)).toBeVisible();
	await expect(page.getByText("Reconnecting to the omp-webui server")).toHaveCount(0);
	// omp has finished compacting and takes the message.
	sock.answerHeld();
	await expect(page.getByText(/Working…/)).toHaveCount(0);
	await expect(composer).toHaveValue("");
	await expect(page.getByTestId("send")).toBeDisabled();
});

test("a connection that drops everything is given up on, what waited on it fails, and it is made again when the way is back", async ({
	page,
}) => {
	const sock = await wire(page);
	await openAlpha(page);
	const banner = page.getByText("Reconnecting to the omp-webui server");
	await expect(banner).toHaveCount(0);

	// The connection stops carrying anything, and the ones the page makes next are refused.
	sock.dead = true;
	sock.refuse = true;
	const composer = page.getByTestId("composer");
	await composer.fill("!echo back-$((40+2))");
	await composer.press("Enter");
	await expect(page.getByText(/Working…/)).toBeVisible();
	// Nothing has come in for 20 s: the page asks, and gives up on the connection ten seconds after. What waited on it
	// fails (the draft comes back), and the page says it is reconnecting.
	await expect(page.getByText(/Send failed: Connection lost/)).toBeVisible({ timeout: 60_000 });
	await expect(banner).toBeVisible();
	await expect(composer).toHaveValue("!echo back-$((40+2))");
	await expect(page.getByText(/Working…/)).toHaveCount(0);
	// While it is gone the box still takes text, but Send is grey and the box says why; Enter sends nothing (C9).
	await expect(page.getByTestId("send")).toBeDisabled();
	await expect(page.getByTestId("composer-offline")).toHaveText("Can be sent once the page has reconnected");
	await composer.press("Enter");
	await expect(composer).toHaveValue("!echo back-$((40+2))");
	await expect(page.getByText(/Working…/)).toHaveCount(0);

	sock.dead = false;
	sock.refuse = false;
	await expect(banner).toHaveCount(0, { timeout: 60_000 });
	await expect(page.getByTestId("composer-offline")).toHaveCount(0);
	await expect(page.getByTestId("send")).toBeEnabled();
	await composer.press("Enter");
	await expect(page.getByText("back-42")).toBeVisible({ timeout: 30_000 });
});
