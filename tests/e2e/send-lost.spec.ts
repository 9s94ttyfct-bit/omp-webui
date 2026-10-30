import { ownSession, sessionRow } from "../support/live.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A message the server has handed to omp is not "not sent" when the connection ends before omp answers (#361): omp may
 * hold a prompt for minutes (behind a compaction, a handoff), and the page must not give the draft back for a second send.
 * The server's acknowledgement is pushed by hand and the prompt itself never reaches omp, so no model is called.
 */

const TITLE = "Lost ack probe";

test("a prompt acknowledged by the server and then cut off by the connection ending is not reported as failed", async ({
	page,
}) => {
	ownSession(0xe1, TITLE);
	let connections = 0;
	let dropped = false;
	await page.routeWebSocket(/\/ws$/, (ws) => {
		connections++;
		const server = ws.connectToServer();
		ws.onMessage((raw) => {
			const msg = JSON.parse(String(raw));
			if (!dropped && msg.t === "rpc" && msg.command?.type === "prompt") {
				dropped = true;
				// The server took it to omp, and the connection ended before omp answered.
				ws.send(JSON.stringify({ t: "ack", req: msg.req }));
				void server.close();
				void ws.close();
				return;
			}
			server.send(raw);
		});
		server.onMessage((raw) => ws.send(raw));
	});
	await page.goto("/");
	await sessionRow(page, TITLE).click();
	const composer = page.getByTestId("composer");
	await composer.fill("held behind a compaction");
	await page.getByTestId("send").click();

	// The page came back on a second connection, and attached again.
	await expect.poll(() => connections).toBeGreaterThanOrEqual(2);
	await expect(page.getByTestId("send")).toBeVisible();
	// The message is omp's now: the draft is not put back in the composer for a second send, and nothing says it failed.
	await expect(composer).toHaveValue("");
	await expect(page.getByText("Send failed")).toHaveCount(0);
});
