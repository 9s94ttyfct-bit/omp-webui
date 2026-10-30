import { execFileSync } from "node:child_process";
import { expect, type Page, test } from "./fixtures.ts";

/** One-click pause freezes omp and what it runs; Resume continues it (no model call). */

interface Live {
	liveId: string;
	pid: number | null;
	pausedAt: number | null;
}

/** The omp process and its descendants with `ps` STAT ("T" = stopped) and command. */
function tree(rootPid: number): { stat: string; command: string }[] {
	const ps = execFileSync("ps", ["-A", "-o", "pid=,ppid=,stat=,command="]).toString();
	const rows = ps
		.trim()
		.split("\n")
		.map((l) => {
			const [pid, ppid, stat, ...cmd] = l.trim().split(/\s+/);
			return { pid, ppid, stat, command: cmd.join(" ") };
		});
	const pids = new Set([String(rootPid)]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const r of rows) {
			if (!pids.has(r.ppid) || pids.has(r.pid)) continue;
			pids.add(r.pid);
			grew = true;
		}
	}
	return rows.filter((r) => pids.has(r.pid));
}
const states = (rootPid: number) => tree(rootPid).map((r) => r.stat);

async function lives(page: Page): Promise<Live[]> {
	return (await page.request.get("/api/lives")).json();
}

test("Pause freezes a running command and every process under omp; Resume continues it", async ({ page }) => {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	const composer = page.getByTestId("composer");
	// An external program (omp's built-in shell runs `sleep` in-process; /bin/sleep is a child process).
	await composer.fill("!/bin/sleep 3 && echo pause-$((20+3))");
	await composer.press("Enter");

	// Pause once omp has started the external program, so there is a child to freeze.
	// (Other specs' omp processes may be alive on the shared server: find the one running it.)
	let live: Live | undefined;
	await expect
		.poll(
			async () => {
				live = (await lives(page)).find((l) => l.pid && tree(l.pid).some((p) => p.command === "/bin/sleep 3"));
				return Boolean(live);
			},
			{ timeout: 10_000 },
		)
		.toBe(true);
	if (!live?.pid) throw new Error("no omp process running the command");

	await page.getByTestId("pause").click();
	const banner = page.getByTestId("paused-banner");
	await expect(banner).toBeVisible();
	await expect(banner).toContainText("Paused");
	await expect(page.getByTestId("stop")).toHaveCount(0);

	const frozen = states(live.pid as number);
	// omp and the external sleep it started are both stopped.
	expect(frozen.length).toBeGreaterThanOrEqual(2);
	expect(frozen.every((s) => s.startsWith("T"))).toBe(true);

	// Past the command's own 3 s: still nothing, because the sleep is frozen too.
	await page.waitForTimeout(4000);
	await expect(page.getByText("pause-23")).toHaveCount(0);

	await banner.getByRole("button", { name: "Resume" }).click();
	await expect(banner).toHaveCount(0);
	expect(states(live.pid as number).some((s) => s.startsWith("T"))).toBe(false);
	await expect(page.getByText("pause-23")).toBeVisible({ timeout: 15_000 });
});

test("Pause works on a model turn and Resume finishes it (Claude Haiku 5.5)", async ({ page }) => {
	test.skip(!process.env.OMPW_E2E_HAS_TOKEN, "needs an Anthropic token (omp token anthropic)");
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText(/haiku/i, { timeout: 60_000 });
	const composer = page.getByTestId("composer");
	await composer.fill("Use the bash tool to run `sleep 2`, then reply with exactly: RESUMED-OK");
	await composer.press("Enter");
	await page.getByTestId("pause").click();
	await expect(page.getByTestId("paused-banner")).toBeVisible();
	await page.getByTestId("paused-banner").getByRole("button", { name: "Resume" }).click();
	await expect(page.getByTestId("msg-assistant").last()).toContainText("RESUMED-OK", { timeout: 90_000 });
});
