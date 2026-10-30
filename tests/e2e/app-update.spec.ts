import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREF, type PrefsSnapshot } from "../../shared/prefs.ts";
import type { UpdateSnapshot } from "../../shared/update.ts";
import { realOmp } from "../support/fake-install.ts";
import { type FakeReleases, RELEASE_BODY, startFakeReleases } from "../support/fake-releases.ts";
import { sessionRow } from "../support/live.ts";
import { buildInstallers, type Installers, startUpdateServer, type UpdateServer } from "../support/update-world.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The app's own updates (#571), from the page: Settings › Updates and the sidebar's line about a newer release. The
 * server is the real one, pointed at a stand-in for GitHub (`tests/support/fake-releases.ts`); the installers are real disk
 * images signed with throwaway certificates (`update-fixtures.ts`), so what the page says about a refused install is what
 * the real checks said. A server that is no app (`notApp`) is where everything that needs no install is looked at; one
 * that is an app (a copy of the signed stand-in, and a separate process as its shell) is where installs run. An install
 * that goes through stops at the handover: the shell is asked to quit (it leaves a file), and the helper that would swap the
 * copy in is killed before it can.
 */

const VERSION = "9.0.0";
const TAG = `v${VERSION}`;
const DOWNLOAD = `/download/omp-webui-${TAG}.dmg`;
const LATEST = "/repos/9s94ttyfct-bit/omp-webui/releases/latest";

const card = (page: Page) => page.getByTestId("update-settings");
/** Settings, on the App page (where the Updates card is). */
async function openSettings(page: Page): Promise<void> {
	await page.getByRole("complementary").getByRole("button", { name: "Settings" }).click();
	await page.locator('[data-testid="settings-page-tab"][data-page="app"]').click();
}

async function snapshot(run: UpdateServer): Promise<UpdateSnapshot> {
	return (await run.api("/api/update")).json();
}

async function prefs(run: UpdateServer): Promise<PrefsSnapshot> {
	return (await run.api("/api/prefs")).json();
}

/** Open the app and Settings, with the Updates card in front. */
async function openCard(page: Page, run: UpdateServer): Promise<void> {
	await page.goto(run.url);
	await openSettings(page);
	await expect(card(page)).toBeVisible();
}

// ------------------------------------------------------------------ a copy that is no app: what can be seen without installing

test.describe("a release that is newer, on a copy that cannot install", () => {
	let fake: FakeReleases;
	let run: UpdateServer;
	test.beforeAll(async () => {
		fake = await startFakeReleases();
		fake.publish({ tag: TAG, dmg: join(import.meta.dirname, "../../package.json") });
		run = await startUpdateServer({ fake });
	});
	test.afterAll(async () => {
		await run.stop();
		await fake.stop();
	});

	test("the sidebar says so without asking, and a click opens Settings at the card", async ({ page }) => {
		const asked: string[] = [];
		page.on("request", (r) => asked.push(new URL(r.url()).pathname));
		await page.goto(run.url);
		const indicator = page.getByTestId("update-indicator");
		await expect(indicator).toHaveText(`Update available · v${VERSION}`);
		// The first page learns it from the socket: it never asks, and nothing is polled.
		await page.waitForLoadState("networkidle");
		expect(asked.filter((p) => p.startsWith("/api/update"))).toEqual([]);

		await indicator.click();
		await expect(page.locator('[data-testid="settings-page-tab"][data-page="app"]')).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(card(page)).toBeInViewport();
		await expect(page.getByTestId("update-latest")).toHaveText(`v${VERSION} is available`);
		expect(asked.filter((p) => p.startsWith("/api/update"))).toEqual(["/api/update"]);
	});

	test("the card names both versions, when it looked, and links to the release", async ({ page }) => {
		await openCard(page, run);
		await expect(page.getByTestId("update-installed")).toHaveText(/^Installed version: v\d+\.\d+\.\d+/);
		await expect(page.getByTestId("update-latest")).toHaveAttribute("data-newer", "true");
		await expect(page.getByTestId("update-checked")).toContainText("Last checked");
		await expect(page.getByTestId("update-release-link")).toHaveAttribute(
			"href",
			`https://github.com/9s94ttyfct-bit/omp-webui/releases/tag/${TAG}`,
		);
	});

	test("this copy cannot install: the button is off and the hint says why", async ({ page }) => {
		await openCard(page, run);
		await expect(page.getByTestId("update-install")).toBeDisabled();
		const hint = page.getByTestId("update-blocked");
		await expect(hint).toHaveAttribute("data-reason", "notApp");
		await expect(hint).toContainText("Updates install only in the macOS app");
		// Not a click that is let through: the server was never asked to install.
		expect((await snapshot(run)).state.job).toBeNull();
	});

	test("the release notes are in the interface language, and the install steps of the release page never show", async ({
		page,
	}) => {
		await openCard(page, run);
		const notes = page.getByTestId("update-notes");
		await expect(notes).toContainText("The app updates itself from GitHub Releases.");
		await expect(notes).not.toContainText("应用可以");
		await expect(notes).not.toContainText("Install the macOS app");
		await expect(notes).not.toContainText("omp-webui-vX.Y.Z.dmg");
		// The body the fake publishes has them, so that this fails if the server stops cutting them.
		expect(RELEASE_BODY).toContain("Install the macOS app");

		try {
			// The language is chosen on the Look page; the notes are on the App page.
			await page.locator('[data-testid="settings-page-tab"][data-page="look"]').click();
			await page.getByTestId("language").selectOption("zh-CN");
			await expect(notes).toContainText("应用可以从 GitHub Releases 自行更新。");
			await expect(notes).not.toContainText("updates itself");
			await expect(notes).not.toContainText("安装 macOS 应用");
			await expect(notes).not.toContainText("下载");
			await expect(page.getByTestId("update-latest")).toHaveText(`有新版本 v${VERSION}`);
		} finally {
			await page.locator('[data-testid="settings-page-tab"][data-page="look"]').click();
			await page.getByTestId("language").selectOption("en");
		}
	});

	test("automatic checks are on until unticked, and the choice goes through the preferences", async ({ page }) => {
		await openCard(page, run);
		const auto = page.getByTestId("update-auto");
		await expect(auto).toBeChecked();
		await auto.uncheck();
		await expect.poll(async () => (await prefs(run)).values[PREF.appUpdateCheck]).toBe("off");
		await page.reload();
		await openSettings(page);
		await expect(page.getByTestId("update-auto")).not.toBeChecked();
		await page.getByTestId("update-auto").check();
		await expect.poll(async () => (await prefs(run)).values[PREF.appUpdateCheck]).toBe("on");
	});

	test("Check now looks even when automatic checks are off, and says when it did", async ({ page }) => {
		await openCard(page, run);
		const before = await snapshot(run);
		await page.getByTestId("update-auto").uncheck();
		await expect.poll(async () => (await prefs(run)).values[PREF.appUpdateCheck]).toBe("off");
		const checked = Promise.withResolvers<void>();
		page.on("request", (r) => {
			if (r.method() === "POST" && r.url().endsWith("/api/update/check")) checked.resolve();
		});
		await page.getByTestId("update-check").click();
		await checked.promise;
		await expect(page.getByTestId("update-check")).toBeEnabled();
		expect((await snapshot(run)).state.rev).toBeGreaterThan(before.state.rev);
		await page.getByTestId("update-auto").check();
		await expect.poll(async () => (await prefs(run)).values[PREF.appUpdateCheck]).toBe("on");
	});

	test("a page that came in through the tunnel is told the card is not for it, and asks for nothing", async ({
		page,
	}) => {
		const asked: string[] = [];
		page.on("request", (r) => asked.push(new URL(r.url()).pathname));
		await page.route("**/api/meta", async (route) => {
			const real = await (await route.fetch()).json();
			return route.fulfill({ json: { ...real, remote: true } });
		});
		await page.goto(run.url);
		await openSettings(page);
		await expect(page.getByTestId("update-refused")).toContainText("not available on a remote page");
		await expect(page.getByTestId("update-check")).toHaveCount(0);
		await expect(page.getByTestId("update-install")).toHaveCount(0);
		await page.waitForLoadState("networkidle");
		expect(asked.filter((p) => p.startsWith("/api/update"))).toEqual([]);
	});
});

test("a release without its installer yet says so and offers no install", async ({ page }) => {
	const fake = await startFakeReleases();
	fake.publish({ tag: TAG });
	const run = await startUpdateServer({ fake });
	try {
		await openCard(page, run);
		await expect(page.getByTestId("update-latest")).toHaveText(`v${VERSION} is available`);
		await expect(page.getByTestId("update-no-asset")).toContainText(
			`v${VERSION} is published but its installer is not attached yet. Check again in a few minutes.`,
		);
		await expect(page.getByTestId("update-install")).toHaveCount(0);
	} finally {
		await run.stop();
		await fake.stop();
	}
});

test("no reachable release is a quiet line, and nothing asks again by itself", async ({ page }) => {
	const fake = await startFakeReleases();
	fake.answer(404);
	const run = await startUpdateServer({ fake });
	try {
		const posts: string[] = [];
		page.on("request", (r) => r.method() === "POST" && posts.push(new URL(r.url()).pathname));
		await page.goto(run.url);
		await openSettings(page);
		const line = page.getByTestId("update-no-release");
		await expect(line).toHaveText("No release is reachable right now.");
		// Neutral, not a warning or an error: no alert, no warning line, no indicator.
		await expect(page.getByTestId("update-check-failed")).toHaveCount(0);
		await expect(card(page).getByRole("alert")).toHaveCount(0);
		await expect(page.getByTestId("update-indicator")).toHaveCount(0);
		await expect(page.getByTestId("update-latest")).toContainText("not known yet");
		// The 404 is an answer, so the card says when it was given, and never "Not checked yet" beside "No release is reachable".
		await expect(page.getByTestId("update-checked")).toContainText("Last checked");
		await expect(page.getByTestId("update-checked")).not.toContainText("Not checked yet");
		// The server's own first look has happened (that is what the line is of); nothing looks again by itself, and the
		// page asked for the state once and never told the server to look.
		await page.waitForLoadState("networkidle");
		expect(fake.count(LATEST)).toBe(1);
		expect(posts.filter((p) => p.startsWith("/api/update"))).toEqual([]);
		// Check now asks again, and a user who clicked it gets the same line, still without an error.
		await page.getByTestId("update-check").click();
		await expect(page.getByTestId("update-check")).toBeEnabled();
		await expect(line).toBeVisible();
	} finally {
		await run.stop();
		await fake.stop();
	}
});

test("a spent rate limit is a warning with the time the app looks again", async ({ page }) => {
	const fake = await startFakeReleases();
	const reset = Math.floor(Date.now() / 1000) + 3600;
	fake.answer(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) });
	const run = await startUpdateServer({ fake });
	try {
		await openCard(page, run);
		const line = page.getByTestId("update-check-failed");
		await expect(line).toHaveAttribute("data-code", "rateLimited");
		await expect(line).toContainText("GitHub's request limit is used up. The app looks again at");
		await expect(line).toContainText(new Date(reset * 1000).toLocaleTimeString("en-US"));
		// Check now while limited asks nothing of GitHub, and the line stays.
		const lookups = fake.count(LATEST);
		await page.getByTestId("update-check").click();
		await expect(page.getByTestId("update-check")).toBeEnabled();
		await expect(line).toBeVisible();
		expect(fake.count(LATEST)).toBe(lookups);
	} finally {
		await run.stop();
		await fake.stop();
	}
});

test("GitHub out of reach is a warning that says so", async ({ page }) => {
	// An address nothing listens at: a port that was free a moment ago.
	const probe = createServer();
	const listening = Promise.withResolvers<void>();
	probe.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = probe.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const closed = Promise.withResolvers<void>();
	probe.close(() => closed.resolve());
	await closed.promise;
	const fake = await startFakeReleases();
	const run = await startUpdateServer({ fake, env: { OMP_WEBUI_APP_UPDATE_API: `http://127.0.0.1:${port}` } });
	try {
		await openCard(page, run);
		const line = page.getByTestId("update-check-failed");
		await expect(line).toHaveAttribute("data-code", "offline");
		await expect(line).toContainText("GitHub could not be reached");
		await expect(page.getByTestId("update-no-release")).toHaveCount(0);
	} finally {
		await run.stop();
		await fake.stop();
	}
});

// ------------------------------------------------------------------ a copy that is an app: installs

test.describe("installing", () => {
	let installers: Installers;
	test.beforeAll(() => {
		test.setTimeout(240_000);
		installers = buildInstallers("good", "tampered", "otherSigner", "wrongVersion");
	});
	test.afterAll(() => installers.dispose());

	const dmgOf = (variant: "good" | "tampered" | "otherSigner" | "wrongVersion"): string => {
		const installer = installers.manifest.installers[variant];
		if (!installer) throw new Error(`no ${variant} installer`);
		return installer.dmg;
	};

	/** A server that can install, the fake serving `variant` as the release. */
	async function serve(variant: "good" | "tampered" | "otherSigner" | "wrongVersion") {
		const fake = await startFakeReleases();
		fake.publish({ tag: TAG, dmg: dmgOf(variant) });
		const run = await startUpdateServer({ fake, running: installers.manifest.running });
		return {
			fake,
			run,
			async stop() {
				await run.stop();
				await fake.stop();
			},
		};
	}

	test("a download shows its progress, then hands over: Restarting, no buttons, and the shell is asked to quit", async ({
		page,
	}) => {
		const { fake, run, stop } = await serve("good");
		try {
			// Slow enough to watch: ten chunks, 400 ms apart.
			fake.throttle(Math.ceil(statSync(dmgOf("good")).size / 10), 400);
			await openCard(page, run);
			const install = page.getByTestId("update-install");
			await expect(install).toBeEnabled();
			await expect(page.getByTestId("update-blocked")).toHaveCount(0);
			await install.click();

			const progress = page.getByTestId("update-progress");
			await expect(progress).toHaveAttribute("data-phase", "downloading");
			await expect(page.getByTestId("update-cancel")).toBeVisible();
			const bar = progress.getByRole("progressbar");
			const percent = async () => Number(await bar.getAttribute("aria-valuenow"));
			await expect.poll(percent).toBeGreaterThan(0);
			const first = await percent();
			expect(first).toBeLessThan(100);
			// It moves: the bar is not set once and left.
			await expect.poll(percent, { timeout: 20_000 }).toBeGreaterThan(first);
			// Received out of the whole, in the unit of the whole (the stand-in installer is a few KB; a real one is MB).
			await expect(page.getByTestId("update-progress-text")).toHaveText(/^\d+(\.\d)? \/ \d+(\.\d)? (KB|MB)$/);
			// An install under way is not offered again.
			await expect(install).toHaveCount(0);

			await expect(progress).toHaveAttribute("data-phase", "handover", { timeout: 60_000 });
			await expect(progress).toContainText("Restarting to finish the update…");
			await expect(page.getByTestId("update-cancel")).toHaveCount(0);
			await expect(progress.getByRole("button")).toHaveCount(0);
			await expect(install).toHaveCount(0);
			// What the server did: asked the shell to quit, and started the helper that waits for it.
			await expect.poll(() => (run.flag ? existsSync(run.flag) : false)).toBe(true);
			expect(run.helperPid()).not.toBeNull();
			expect(fake.count(DOWNLOAD)).toBe(1);
			// Nothing was swapped: the shell has not quit, so the copy that runs is the copy that was there.
			expect(readdirSync(run.installDir as string).sort()).toContain("omp-webui.app");
		} finally {
			await stop();
		}
	});

	test("Cancel stops a download: no failure, and the install is offered again", async ({ page }) => {
		const { fake, run, stop } = await serve("good");
		try {
			// Twenty chunks, half a second apart: far longer than the click takes.
			fake.throttle(Math.ceil(statSync(dmgOf("good")).size / 20), 500);
			await openCard(page, run);
			await page.getByTestId("update-install").click();
			const bar = page.getByTestId("update-progress").getByRole("progressbar");
			await expect.poll(async () => Number(await bar.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
			await page.getByTestId("update-cancel").click();
			await expect(page.getByTestId("update-progress")).toHaveCount(0);
			await expect(page.getByTestId("update-failed")).toHaveCount(0);
			await expect(page.getByTestId("update-install")).toBeEnabled();
			const { state } = await snapshot(run);
			expect(state.job).toBeNull();
			expect(state.failed).toBeNull();
			// Nothing was handed over, and the download left nothing next to the app.
			expect(run.flag && existsSync(run.flag)).toBe(false);
			expect(run.helperPid()).toBeNull();
			expect(readdirSync(run.installDir as string)).toEqual(["omp-webui.app"]);
		} finally {
			await stop();
		}
	});

	const REFUSED = [
		{
			variant: "tampered",
			code: "signature",
			says: "macOS refused the new app's signature, so it was not installed",
		},
		{
			variant: "otherSigner",
			code: "requirement",
			says: /signed by another certificate \([0-9a-f]{12}…\) than the one running now \([0-9a-f]{12}…\), so it was not installed/,
		},
		{
			variant: "wrongVersion",
			code: "version",
			says: `The app in the installer is v9.0.1, but the release is ${TAG}, so it was not installed.`,
		},
	] as const;

	for (const { variant, code, says } of REFUSED) {
		test(`an installer that fails the checks (${variant}) says what was wrong, with its values, and installs nothing`, async ({
			page,
		}) => {
			const { run, stop } = await serve(variant);
			try {
				await openCard(page, run);
				await page.getByTestId("update-install").click();
				const failed = page.getByTestId("update-failed");
				await expect(failed).toHaveAttribute("data-code", code, { timeout: 60_000 });
				await expect(failed).toContainText("The update was not installed");
				await expect(failed).toContainText(says);
				// A warning, and the install offered again: the release is still the newest.
				await expect(page.getByTestId("update-progress")).toHaveCount(0);
				await expect(page.getByTestId("update-install")).toBeEnabled();
				// The server's copy of the failure is what the page shows, and nothing was put in place or left behind.
				const { state } = await snapshot(run);
				expect(state.failed?.code).toBe(code);
				expect(state.job).toBeNull();
				expect(readdirSync(run.installDir as string)).toEqual(["omp-webui.app"]);
				expect(run.flag && existsSync(run.flag)).toBe(false);

				await page.getByTestId("update-dismiss").click();
				await expect(failed).toHaveCount(0);
				expect((await snapshot(run)).state.failed).toBeNull();
			} finally {
				await stop();
			}
		});
	}

	test("Try again installs the release once its good installer is published", async ({ page }) => {
		const { fake, run, stop } = await serve("tampered");
		try {
			await openCard(page, run);
			await page.getByTestId("update-install").click();
			await expect(page.getByTestId("update-failed")).toHaveAttribute("data-code", "signature", { timeout: 60_000 });

			// The same tag, with an installer that is right. The server looks again once its minimum gap has passed.
			fake.publish({ tag: TAG, dmg: dmgOf("good") });
			const lookups = fake.count(LATEST);
			await expect
				.poll(
					async () => {
						await page.getByTestId("update-check").click();
						await expect(page.getByTestId("update-check")).toBeEnabled();
						return fake.count(LATEST);
					},
					{ timeout: 40_000, intervals: [1500] },
				)
				.toBeGreaterThan(lookups);

			await page.getByTestId("update-retry").click();
			// The failure goes as soon as the new install starts, and the install runs to the handover.
			await expect(page.getByTestId("update-failed")).toHaveCount(0);
			await expect(page.getByTestId("update-progress")).toHaveAttribute("data-phase", "handover", {
				timeout: 60_000,
			});
			await expect.poll(() => (run.flag ? existsSync(run.flag) : false)).toBe(true);
			expect(fake.count(DOWNLOAD)).toBe(2);
		} finally {
			await stop();
		}
	});

	test.describe("conversations that are replying", () => {
		test.skip(realOmp() === null, "needs an omp on this machine to run a conversation");

		test("installing asks first; Cancel keeps everything, Update anyway starts", async ({ page }) => {
			const { fake, run, stop } = await serve("good");
			const dir = mkdtempSync(join(tmpdir(), "ompw-upd-busy-"));
			const gate = join(dir, "let-busy-end");
			try {
				const bodies: unknown[] = [];
				page.on("request", (r) => {
					if (r.method() === "POST" && r.url().endsWith("/api/update/install")) bodies.push(r.postDataJSON());
				});
				await page.goto(run.url);
				// A conversation that works until the gate opens; the server counts it once its omp has started the command.
				await sessionRow(page, "Fixture alpha: zebra protocol").click();
				const composer = page.getByTestId("composer");
				await composer.fill(`!while [ ! -e ${gate} ]; do sleep 0.2; done; echo busy-over`);
				await composer.press("Enter");
				const busy = async () => {
					const lives: { busy: boolean; exited: boolean }[] = await (await run.api("/api/lives")).json();
					return lives.filter((l) => l.busy && !l.exited).length;
				};
				await expect.poll(busy, { timeout: 30_000 }).toBe(1);

				await openSettings(page);
				await page.getByTestId("update-install").click();
				const dialog = page.getByTestId("update-confirm-replying");
				await expect(dialog).toContainText("1 conversation is replying; updating stops it. Update anyway?");

				// Cancel: nothing started, the conversation still works, and the card is as it was.
				await dialog.getByRole("button", { name: "Cancel" }).click();
				await expect(dialog).toHaveCount(0);
				expect((await snapshot(run)).state.job).toBeNull();
				expect(fake.count(DOWNLOAD)).toBe(0);
				expect(await busy()).toBe(1);
				await expect(page.getByTestId("update-install")).toBeEnabled();
				expect(bodies).toEqual([{ tag: TAG }]);

				// Update anyway: the install starts, with the user's word for it.
				await page.getByTestId("update-install").click();
				await page.getByTestId("update-confirm-anyway").click();
				await expect(page.getByTestId("update-progress")).toBeVisible();
				await expect(page.getByTestId("update-progress")).toHaveAttribute("data-phase", "handover", {
					timeout: 60_000,
				});
				expect(bodies).toEqual([{ tag: TAG }, { tag: TAG }, { tag: TAG, anyway: true }]);
				expect(fake.count(DOWNLOAD)).toBe(1);
			} finally {
				writeFileSync(gate, "");
				await stop();
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
