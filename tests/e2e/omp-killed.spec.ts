import { rmSync } from "node:fs";
import { writeSimpleSession } from "../support/fixtures.ts";
import { sessionRow, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * An omp that a signal ended (the system's out-of-memory killer, a crash) is shown as that: which signal, not an exit
 * with a code omp never had. The omp is a real one, started by a `!command` (no model call) and killed from outside.
 */

test("an omp that is killed says which signal ended it", async ({ page, e2eServer }) => {
	const title = "Killed omp probe";
	const file = writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xa9, title);
	try {
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		const tap = await tapSocket(page);
		await page.goto("/");
		const liveId = await startLive(page, tap, title, "killed-omp-up");

		const res = await fetch(`${e2eServer.url}/api/lives`, { headers: { "x-omp-webui-token": e2eServer.accessToken } });
		const lives = (await res.json()) as { liveId: string; pid: number | null }[];
		const pid = lives.find((l) => l.liveId === liveId)?.pid;
		expect(pid).toBeGreaterThan(0);
		process.kill(pid as number, "SIGKILL");

		await expect(page.getByTestId("exit-notice")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText("The omp process ended on its own.")).toBeVisible();
		await expect(page.getByText("Killed by SIGKILL.")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText(/exited \(code/)).toHaveCount(0);
	} finally {
		rmSync(file, { force: true });
	}
});

test("an omp killed in a conversation the page came back to (its process still running) says so, and keeps what it showed (#397)", async ({
	page,
	e2eServer,
}) => {
	const title = "Came-back killed probe";
	const elsewhere = "Came-back elsewhere";
	const files = [
		writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xaa, title),
		writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xab, elsewhere),
	];
	try {
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		const tap = await tapSocket(page);
		await page.goto("/");
		const liveId = await startLive(page, tap, title, "came-back-killed-up");

		// Another conversation, then back from the list: the view is by file now, and the page listens to the process again.
		await sessionRow(page, elsewhere).click();
		await expect(page.getByTestId("chat-title")).toContainText(elsewhere);
		const attaches = () => tap.sent.filter((m) => m.t === "attach" && m.liveId === liveId).length;
		const before = attaches();
		await sessionRow(page, title).click();
		await expect(page.getByTestId("chat-title")).toContainText(title);
		await expect.poll(attaches, { timeout: 15_000 }).toBeGreaterThan(before);

		const res = await fetch(`${e2eServer.url}/api/lives`, { headers: { "x-omp-webui-token": e2eServer.accessToken } });
		const lives = (await res.json()) as { liveId: string; pid: number | null }[];
		const pid = lives.find((l) => l.liveId === liveId)?.pid;
		expect(pid).toBeGreaterThan(0);
		process.kill(pid as number, "SIGKILL");

		await expect(page.getByTestId("exit-notice")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText("Killed by SIGKILL.")).toBeVisible({ timeout: 15_000 });
		// What the process showed (here what its command printed) stays on screen with it.
		await expect(page.getByText("came-back-killed-up", { exact: true })).toBeVisible();
	} finally {
		for (const file of files) rmSync(file, { force: true });
	}
});
