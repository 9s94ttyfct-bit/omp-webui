import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeRegistry, makeWorld, realOmp, startFakeRegistry, type World } from "../support/fake-install.ts";
import { sessionRow } from "../support/live.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Keeping omp up to date (#184): a notice when a newer release exists (version, release notes, Update), an update
 * that waits while a conversation is working, the "Update omp automatically" setting, and the warnings about a
 * version outside the range this web UI supports — before updating and when the installed omp already is.
 * The registry is a local server the web UI is pointed at the way a user's own config would, the installed omp a
 * Homebrew-shaped launcher whose `omp update` moves it to the version the spec names; the machine's own omp,
 * registry and package managers are never touched.
 */

test.skip(realOmp() === null, "needs an omp on this machine for the launcher to hand its commands to");

interface Run {
	world: World;
	server: TestServer;
	registry: FakeRegistry;
	url: string;
	stop(): Promise<void>;
}

/** A server whose omp is `installed`, and whose registry (and build service) says `latest` is the newest release. */
async function serve(installed: string, latest: string, update = latest): Promise<Run> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-world-"));
	const world = makeWorld(dir, { version: installed, installed: true });
	world.state.setUpdateTo(update);
	const registry = await startFakeRegistry(latest);
	const server = await startTestServer(0, {
		PATH: world.path,
		OMP_BIN: "omp",
		npm_config_registry: registry.url,
		PI_BUILD_URL: registry.url,
		// Looks for a release on its own, soon after it starts.
		OMP_WEBUI_UPDATE_CHECK: "on",
	});
	return {
		world,
		server,
		registry,
		url: `${server.url}/?token=${server.accessToken}`,
		async stop() {
			await server.stop();
			await registry.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

async function meta(run: Run): Promise<{ ompVersion: string }> {
	const res = await fetch(`${run.server.url}/api/meta`, { headers: { "x-omp-webui-token": run.server.accessToken } });
	return res.json();
}

const notice = (page: Page) => page.getByTestId("omp-notice");

/** Conversations of the server as it lists them: each with whether it is working. */
async function lives(run: Run): Promise<{ busy: boolean; exited: boolean }[]> {
	const res = await fetch(`${run.server.url}/api/lives`, { headers: { "x-omp-webui-token": run.server.accessToken } });
	return res.json();
}

/**
 * Open a conversation and give its omp a command that keeps it working until the returned function is called, and
 * prints `marker` then. Returns once the server counts the conversation as working: the command is sent after the
 * conversation is opened and its omp started, so until then there is nothing for an update to wait for, however
 * much the page already shows.
 */
async function startBusy(page: Page, run: Run, marker: string): Promise<() => void> {
	const gate = join(run.world.dir, "let-busy-end");
	await sessionRow(page, "Fixture alpha: zebra protocol").click();
	const composer = page.getByTestId("composer");
	await composer.fill(`!while [ ! -e ${gate} ]; do sleep 0.2; done; echo ${marker}`);
	await composer.press("Enter");
	await expect
		.poll(async () => (await lives(run)).filter((l) => l.busy && !l.exited).length, { timeout: 30_000 })
		.toBe(1);
	return () => writeFileSync(gate, "");
}

test("a newer release is announced with its version and release notes, and Update runs omp's own update", async ({
	page,
}) => {
	const run = await serve("18.12.0", "18.13.0");
	try {
		await page.goto(run.url);
		await expect(notice(page)).toHaveAttribute("data-kind", "update");
		await expect(notice(page)).toContainText("omp 18.13.0 is available — you have 18.12.0.");
		await expect(page.getByTestId("omp-release-notes")).toHaveAttribute(
			"href",
			"https://github.com/can1357/oh-my-pi/releases/tag/v18.13.0",
		);
		// The look-up went where the user's config says: the package's `latest`.
		expect(run.registry.hits).toContain("/@oh-my-pi%2fpi-coding-agent/latest");
		expect(run.world.state.updateCalls()).toEqual([]);

		await page.getByTestId("omp-update").click();
		await expect(notice(page)).toHaveAttribute("data-kind", "done");
		await expect(notice(page)).toContainText("omp is now 18.13.0.");
		// `omp update` ran once, for the omp that was found (its directory first on PATH).
		const calls = run.world.state.updateCalls();
		expect(calls).toHaveLength(1);
		expect(calls[0].startsWith(`update PATH=${join(run.world.prefix, "bin")}:`)).toBe(true);
		expect((await meta(run)).ompVersion).toBe("18.13.0");
		// The sidebar's footer follows without a reload.
		await expect(page.getByText("omp 18.13.0 · webui")).toBeVisible();

		await page.getByTestId("omp-update-done-dismiss").click();
		await expect(notice(page)).toHaveCount(0);
		await page.reload();
		await expect(page.getByTestId("cwd-picker")).toBeVisible();
		await expect(notice(page)).toHaveCount(0);
	} finally {
		await run.stop();
	}
});

test("Later puts a release away until there is a newer one; Settings looks for one on request", async ({ page }) => {
	const run = await serve("18.12.0", "18.13.0");
	try {
		await page.goto(run.url);
		await expect(notice(page)).toHaveAttribute("data-kind", "update");
		await page.getByTestId("omp-notice-dismiss").click();
		await expect(notice(page)).toHaveCount(0);
		await page.reload();
		await expect(page.getByTestId("cwd-picker")).toBeVisible();
		await expect(notice(page)).toHaveCount(0);

		await page.getByRole("complementary").getByRole("button", { name: "Settings" }).click();
		await page.locator('[data-testid="settings-page-tab"][data-page="app"]').click();
		const settings = page.getByTestId("omp-settings");
		await expect(settings).toContainText("Installed: omp 18.12.0");
		await expect(page.getByTestId("omp-install-method")).toHaveAttribute("data-method", "homebrew");
		await expect(page.getByTestId("omp-install-method")).toContainText("brew upgrade can1357/tap/omp");
		await expect(page.getByTestId("omp-latest")).toContainText("omp 18.13.0 is available.");

		// A newer release than the one put away: the notice is back.
		run.registry.setLatest("18.14.0");
		await page.getByTestId("omp-check").click();
		await expect(page.getByTestId("omp-latest")).toContainText("omp 18.14.0 is available.");
		await expect(notice(page)).toContainText("omp 18.14.0 is available");

		// A registry that is down leaves what was known and says why it could not look.
		run.registry.setDown(true);
		await page.getByTestId("omp-check").click();
		await expect(page.getByTestId("omp-check-error")).toContainText("HTTP 503");
		await expect(page.getByTestId("omp-latest")).toContainText("omp 18.14.0 is available.");
	} finally {
		await run.stop();
	}
});

test("an update waits while a conversation is working, and can be cancelled", async ({ page }) => {
	const run = await serve("18.12.0", "18.13.0");
	try {
		await page.goto(run.url);
		const letBusyEnd = await startBusy(page, run, "busy-over");
		await expect(page.getByTestId("omp-notice")).toHaveAttribute("data-kind", "update");

		// Update while it works: nothing runs, and the notice says what it waits for.
		await page.getByTestId("omp-update").click();
		await expect(notice(page)).toHaveAttribute("data-kind", "waiting");
		await expect(notice(page)).toContainText("Waiting for 1 conversation to finish before updating omp…");
		expect(run.world.state.updateCalls()).toEqual([]);

		// Cancel: back to the offer, and the update never runs on its own.
		await page.getByTestId("omp-update-cancel").click();
		await expect(notice(page)).toHaveAttribute("data-kind", "update");

		// Ask again: this time it waits until the conversation is idle, then goes ahead.
		await page.getByTestId("omp-update").click();
		await expect(notice(page)).toHaveAttribute("data-kind", "waiting");
		letBusyEnd();
		await expect(page.getByText("busy-over", { exact: true })).toBeVisible({ timeout: 30_000 });
		await expect(notice(page)).toHaveAttribute("data-kind", "done", { timeout: 30_000 });
		expect(run.world.state.updateCalls()).toHaveLength(1);
		expect((await meta(run)).ompVersion).toBe("18.13.0");
	} finally {
		await run.stop();
	}
});

test("an update a paused conversation holds says so, and Update anyway goes ahead without it", async ({ page }) => {
	const run = await serve("18.12.0", "18.13.0");
	try {
		await page.goto(run.url);
		await startBusy(page, run, "never-printed-while-paused");
		await page.getByTestId("pause").click();
		await expect(page.getByTestId("paused-banner")).toBeVisible();

		await page.getByTestId("omp-update").click();
		await expect(notice(page)).toHaveAttribute("data-kind", "waiting");
		await expect(notice(page)).toContainText("Waiting to update omp: 1 paused.");
		await expect(notice(page)).toContainText("a conversation that stays open keeps running the old omp");
		expect(run.world.state.updateCalls()).toEqual([]);

		// Nothing is working, so only the user can say go on: the old omp stays in the paused conversation.
		await page.getByTestId("omp-update-anyway").click();
		await expect(notice(page)).toHaveAttribute("data-kind", "done", { timeout: 30_000 });
		expect(run.world.state.updateCalls()).toHaveLength(1);
		expect((await meta(run)).ompVersion).toBe("18.13.0");
		await expect(page.getByTestId("paused-banner")).toBeVisible();
	} finally {
		await run.stop();
	}
});

test("an automatic update a paused conversation holds says what it waits for, in the notice and in Settings", async ({
	page,
}) => {
	const run = await serve("18.12.0", "18.13.0");
	try {
		await page.goto(run.url);
		await startBusy(page, run, "never-printed-while-paused");
		await page.getByTestId("pause").click();
		await expect(page.getByTestId("paused-banner")).toBeVisible();

		await page.getByRole("complementary").getByRole("button", { name: "Settings" }).click();
		await page.locator('[data-testid="settings-page-tab"][data-page="app"]').click();
		await page.getByTestId("auto-update-omp").check();
		await expect(page.getByTestId("auto-update-waiting")).toContainText("Automatic update is waiting for: 1 paused.");
		await expect(notice(page)).toHaveAttribute("data-kind", "update");
		await expect(page.getByTestId("omp-auto-waiting")).toContainText("Automatic update is waiting for: 1 paused.");
		// It skips the paused conversation instead of waiting on it: no update was started.
		expect(run.world.state.updateCalls()).toEqual([]);
		expect(
			(
				await (
					await fetch(`${run.server.url}/api/omp`, { headers: { "x-omp-webui-token": run.server.accessToken } })
				).json()
			).state.job,
		).toBeNull();
	} finally {
		await run.stop();
	}
});

test("'Update omp automatically' is off by default and, once on, updates by itself when nothing is working", async ({
	page,
}) => {
	const run = await serve("18.12.0", "18.13.0");
	try {
		await page.goto(run.url);
		await page.getByRole("complementary").getByRole("button", { name: "Settings" }).click();
		await page.locator('[data-testid="settings-page-tab"][data-page="app"]').click();
		const toggle = page.getByTestId("auto-update-omp");
		await expect(toggle).not.toBeChecked();
		await expect(page.getByTestId("omp-latest")).toContainText("omp 18.13.0 is available.");
		expect(run.world.state.updateCalls()).toEqual([]);

		await toggle.check();
		// No click on Update: the server starts it, the page shows it, and it ends.
		await expect(notice(page)).toHaveAttribute("data-kind", "done", { timeout: 30_000 });
		expect(run.world.state.updateCalls()).toHaveLength(1);
		await expect(page.getByTestId("omp-installed-version")).toHaveText("Installed: omp 18.13.0");

		// The choice is kept: after a reload, and after the server restarts.
		await page.reload();
		await expect(page.getByTestId("auto-update-omp")).toBeChecked();
		await run.server.restart();
		await page.reload();
		await expect(page.getByTestId("auto-update-omp")).toBeChecked();
	} finally {
		await run.stop();
	}
});

test("a release outside the supported range asks first, and warns again once installed", async ({ page }) => {
	const run = await serve("18.12.0", "19.0.0");
	try {
		await page.goto(run.url);
		await expect(notice(page)).toHaveAttribute("data-kind", "update-outside");
		await expect(notice(page)).toContainText(
			"omp 19.0.0 is available, but this omp-webui is made for omp >=18.11.0 <19.0.0.",
		);
		await expect(page.getByTestId("omp-update")).toHaveText("Update anyway");

		// Asked before anything runs; Cancel leaves everything as it was.
		await page.getByTestId("omp-update").click();
		await expect(page.getByRole("dialog")).toContainText("Update to an untested omp?");
		await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		expect(run.world.state.updateCalls()).toEqual([]);

		await page.getByTestId("omp-update").click();
		await page.getByTestId("confirm-outside-compat").click();
		await expect(notice(page)).toHaveAttribute("data-kind", "done", { timeout: 30_000 });
		expect(run.world.state.updateCalls()).toHaveLength(1);

		// After the update the installed omp is outside the range: the warning comes with the next page load too.
		await page.getByTestId("omp-update-done-dismiss").click();
		await expect(notice(page)).toHaveAttribute("data-kind", "compat");
		await expect(notice(page)).toContainText(
			"omp 19.0.0 is newer than this omp-webui is made for (>=18.11.0 <19.0.0).",
		);
		await page.getByTestId("omp-notice-dismiss").click();
		await expect(notice(page)).toHaveCount(0);
		await page.reload();
		await expect(page.getByTestId("cwd-picker")).toBeVisible();
		await expect(notice(page)).toHaveCount(0);
		await page.getByRole("complementary").getByRole("button", { name: "Settings" }).click();
		await page.locator('[data-testid="settings-page-tab"][data-page="app"]').click();
		await expect(page.getByTestId("omp-compat")).toHaveAttribute("data-verdict", "newer");
	} finally {
		await run.stop();
	}
});

test("on start, an installed omp outside the supported range is warned about", async ({ page }) => {
	const newer = await serve("19.2.0", "19.2.0");
	try {
		await page.goto(newer.url);
		await expect(notice(page)).toHaveAttribute("data-kind", "compat");
		await expect(notice(page)).toContainText("omp 19.2.0 is newer than this omp-webui is made for");
	} finally {
		// The page leaves the server before it stops: a page still on it fails the chunks it is loading and loads itself
		// again (`reloadOnce`), and the error page of that reload would cut short the next `goto`.
		await page.goto("about:blank");
		await newer.stop();
	}

	// An older one gets the same warning, and the update that fixes it.
	const older = await serve("18.9.0", "18.13.0");
	try {
		await page.goto(older.url);
		await expect(notice(page)).toHaveAttribute("data-kind", "compat");
		await expect(notice(page)).toContainText("omp 18.9.0 is older than this omp-webui supports");
		await page.getByTestId("omp-update").click();
		await expect(notice(page)).toHaveAttribute("data-kind", "done", { timeout: 30_000 });
	} finally {
		await older.stop();
	}
});

test("a failed update says why and can be tried again", async ({ page }) => {
	const run = await serve("18.12.0", "18.13.0");
	try {
		run.world.state.failUpdates(true);
		await page.goto(run.url);
		await page.getByTestId("omp-update").click();
		await expect(notice(page)).toHaveAttribute("data-kind", "failed");
		await expect(notice(page)).toContainText("the release server is down");
		await expect((await meta(run)).ompVersion).toBe("18.12.0");

		run.world.state.failUpdates(false);
		await page.getByTestId("omp-update-retry").click();
		await expect(notice(page)).toHaveAttribute("data-kind", "done", { timeout: 30_000 });
	} finally {
		await run.stop();
	}
});

test("an answer to Update that is read after the update has already failed does not put the notice back to running", async ({
	page,
}) => {
	const run = await serve("18.12.0", "18.13.0");
	try {
		run.world.state.failUpdates(true);
		// The answer to the request that starts an update is the state of that moment: `running`. An update that fails at
		// once is `failed` on the socket before the page reads it. Hold the answer until the page has been told, then let
		// it through: reading it must not undo what the page knows.
		const failedShown = Promise.withResolvers<void>();
		await page.route("**/api/omp/update", async (route) => {
			const answer = await route.fetch();
			await failedShown.promise;
			await route.fulfill({ response: answer });
		});
		await page.goto(run.url);
		const answered = page.waitForResponse((r) => r.url().endsWith("/api/omp/update"));
		await page.getByTestId("omp-update").click();
		await expect(notice(page)).toHaveAttribute("data-kind", "failed");
		await expect(notice(page)).toContainText("the release server is down");
		failedShown.resolve();
		await answered;
		// The page has the answer; two frames on, it has acted on it.
		await page.evaluate(() => {
			const { promise, resolve } = Promise.withResolvers<void>();
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			return promise;
		});
		await expect(notice(page)).toHaveAttribute("data-kind", "failed");
		await expect(page.getByTestId("omp-update-retry")).toBeVisible();
	} finally {
		await run.stop();
	}
});
