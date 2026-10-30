import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveListing } from "../../shared/protocol.ts";
import { FIXTURE_CWD, writeSimpleSession } from "../support/fixtures.ts";
import { sessionRow } from "../support/live.ts";
import { endAllLives } from "../support/lives.ts";
import { connect, request } from "../support/ws.ts";
import { expect, test } from "./fixtures.ts";

/** Each Playwright process owns both its browser credentials and the server those credentials unlock. */
test("the worker's API, files and browser all address its isolated server", async ({
	page,
	request,
	baseURL,
	e2eServer,
}) => {
	expect(baseURL).toBe(e2eServer.url);
	expect(process.env.OMPW_E2E_URL).toBe(e2eServer.url);
	expect(process.env.OMPW_E2E_AGENT_DIR).toBe(e2eServer.agentDir);
	expect(process.env.OMPW_E2E_HOME).toBe(e2eServer.home);
	expect(process.env.OMPW_E2E_WORK).toBe(e2eServer.work);
	const auth = JSON.parse(readFileSync(join(e2eServer.root, "auth.json"), "utf8"));
	expect(auth.cookies[0].value).toBe(e2eServer.accessToken);
	expect(auth.origins[0].origin).toBe(e2eServer.url);
	expect((await request.get("/api/sessions")).ok()).toBe(true);
	expect(
		(await request.get("/api/sessions", { headers: { cookie: "", "x-omp-webui-token": "wrong-worker" } })).status(),
	).toBe(401);
	await page.goto("/");
	await expect(page.getByTestId("new-chat")).toBeVisible();
	expect(new URL(page.url()).origin).toBe(e2eServer.url);
});

test("worker reporter colors cannot change omp's machine-readable settings", async ({ request }) => {
	expect(await (await request.get("/api/approval")).json()).toMatchObject({ omp: "yolo" });
	expect(typeof (await (await request.get("/api/usage-reset-wait")).json()).omp).toBe("boolean");
});

/** The server of a worker holds the conversations of every spec that ran before: a row is named by its whole title (#553). */
test("a conversation's row is found by its whole title, not by a title that contains it", async ({ page }) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	writeSimpleSession(agentDir, 0x3e, "Isolation probe");
	writeSimpleSession(agentDir, 0x3f, "Paused isolation probe");
	await page.goto("/");
	await expect(sessionRow(page, "Paused isolation probe")).toHaveCount(1, { timeout: 15_000 });
	await expect(sessionRow(page, "Isolation probe")).toHaveCount(1);
	await expect(sessionRow(page, "Isolation probe")).toHaveAttribute("data-file", /00000000993e\.jsonl$/);
});

/** A spec that starts omp does not end it, and the next file of the worker must not find it on its fixture file (#552). */
test("endAllLives ends every omp process the server holds and returns once they are gone", async ({
	e2eServer,
	request: api,
}) => {
	const running = async () =>
		((await (await api.get("/api/lives")).json()) as LiveListing[]).filter((l) => !l.exited).map((l) => l.liveId);
	const ws = await connect(e2eServer);
	try {
		const first = await request<{ liveId: string }>(ws, { t: "open", target: { kind: "new", cwd: e2eServer.work } });
		const second = await request<{ liveId: string }>(ws, { t: "open", target: { kind: "new", cwd: FIXTURE_CWD } });
		expect(await running()).toEqual(expect.arrayContaining([first.liveId, second.liveId]));

		await endAllLives(e2eServer);
		expect(await running()).toEqual([]);
	} finally {
		ws.close();
	}
});
