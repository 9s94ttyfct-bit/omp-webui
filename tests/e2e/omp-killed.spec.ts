import { rmSync } from "node:fs";
import { writeSimpleSession } from "../support/fixtures.ts";
import { startLive } from "../support/live.ts";
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
