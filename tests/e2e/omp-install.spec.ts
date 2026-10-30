import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { PALETTES } from "../../shared/prefs.ts";
import { makeWorld, placeBrewOmp, realOmp, type World } from "../support/fake-install.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A computer without omp (#185): the first-run screen offers install methods with the exact command each runs,
 * runs the one chosen with its output as it comes and says what went wrong when it fails, and then the
 * first-time setup — sign in, default model, permission mode — ends in a new chat. The server runs with a PATH of
 * its own that holds fake `brew` and `curl`, and an isolated HOME: no real installer, package manager or
 * network, and never the omp of this machine except as what the installed launcher hands its commands to.
 */

test.skip(realOmp() === null, "needs an omp on this machine for the launcher to hand its commands to");

interface Run {
	world: World;
	server: TestServer;
	url: string;
	stop(): Promise<void>;
}

/** A server in a world without omp (and, by default, with the fake installers). */
async function serve(options: { installers?: boolean } = {}): Promise<Run> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-world-"));
	const world = makeWorld(dir, { version: "18.12.1", installers: options.installers ?? true });
	const server = await startTestServer(0, { PATH: world.path, OMP_BIN: "omp" });
	return {
		world,
		server,
		url: `${server.url}/?token=${server.accessToken}`,
		async stop() {
			await server.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

async function api<T>(run: Run, path: string): Promise<T> {
	const res = await fetch(`${run.server.url}${path}`, { headers: { "x-omp-webui-token": run.server.accessToken } });
	return res.json();
}

/** Two providers, one signed in, and a list of models: the real ones depend on the machine's credentials and the omp release. */
async function fakeCatalog(page: Page) {
	const tap = await tapSocket(page);
	tap.answer("get_login_providers", () => ({
		ok: true,
		data: {
			providers: [
				{ id: "anthropic", name: "Anthropic (Claude Pro/Max)", available: true, authenticated: true },
				{ id: "acme", name: "Acme AI", available: true, authenticated: false },
			],
		},
	}));
	const models = Array.from({ length: 5 }, (_, i) => ({ provider: "acme", id: `m-${i}`, name: `Acme model ${i}` }));
	await page.route("**/api/models*", (route) => route.fulfill({ json: models }));
	return tap;
}

test("without omp, the screen offers each way to install it with the command it runs", async ({ page }) => {
	const run = await serve();
	try {
		await page.goto(run.url);
		await expect(page.getByRole("heading", { name: "Install omp to get started" })).toBeVisible();
		// No omp, so nothing of the app: no sidebar, no composer.
		await expect(page.getByTestId("first-run")).toBeVisible();
		await expect(page.getByTestId("session-item")).toHaveCount(0);
		// Where it looked: the PATH it was given, and where omp's own installers put it.
		await expect(page.getByTestId("omp-searched")).toContainText(run.world.toolbin);
		await expect(page.getByTestId("omp-searched")).toContainText(join(run.server.home, ".local", "bin"));

		// The commands are the ones omp documents.
		await expect(page.getByTestId("install-command-homebrew")).toHaveText("brew install can1357/tap/omp");
		await expect(page.getByTestId("install-command-installer")).toHaveText(
			"curl -fsSL https://omp.sh/install | sh -s -- --binary",
		);
		await expect(page.getByTestId("install-command-bun")).toHaveText("bun install -g @oh-my-pi/pi-coding-agent");
		// Homebrew is there, so it is the one to try; nothing runs until Install is pressed.
		await expect(page.getByTestId("install-option-homebrew")).toContainText("Recommended");
		await expect(page.getByTestId("install-option-homebrew").getByRole("radio")).toBeChecked();
		expect(existsSync(run.world.brewLog)).toBe(false);
	} finally {
		await run.stop();
	}
});

test("a choice whose program is missing says so and cannot be installed", async ({ page }) => {
	const run = await serve({ installers: false });
	try {
		await page.goto(run.url);
		const homebrew = page.getByTestId("install-option-homebrew");
		await expect(homebrew).toContainText("Needs brew, which isn't installed on this computer.");
		await expect(homebrew.getByRole("radio")).toBeDisabled();
		await expect(page.getByTestId("install-option-installer")).toContainText("Needs curl");
		// Only Bun can run here (it is the server's own runtime): nothing is recommended, so nothing is chosen.
		await expect(page.getByTestId("install-option-bun").getByRole("radio")).toBeEnabled();
		await expect(page.getByTestId("install-start")).toBeDisabled();
		await page.getByTestId("install-option-bun").getByRole("radio").check();
		await expect(page.getByTestId("install-start")).toBeEnabled();
		// The command of a choice that cannot run stays readable to copy (WCAG AA) in every look: only its name is dimmed.
		const low: string[] = [];
		for (const palette of PALETTES) {
			for (const dark of [false, true]) {
				await page.evaluate(
					([id, on]) => {
						document.documentElement.dataset.palette = id as string;
						document.documentElement.classList.toggle("dark", on as boolean);
					},
					[palette, dark],
				);
				const { violations } = await new AxeBuilder({ page })
					.include('[data-testid^="install-command-"]')
					.withRules(["color-contrast"])
					.analyze();
				for (const v of violations)
					for (const n of v.nodes) low.push(`${palette} ${dark ? "dark" : "light"}: ${n.target}`);
			}
		}
		expect(low).toEqual([]);
	} finally {
		await run.stop();
	}
});

for (const width of [375, 420, 520]) {
	test(`the first-run screen fits its card, with every Copy button on screen, at ${width} px`, async ({ page }) => {
		const run = await serve();
		try {
			await page.setViewportSize({ width, height: 800 });
			await page.goto(run.url);
			const card = page.getByTestId("first-run").locator("> div");
			const options = page.getByTestId("first-run").locator("fieldset");
			await expect(options).toBeVisible();
			const cardBox = await card.boundingBox();
			const optionsBox = await options.boundingBox();
			if (!cardBox || !optionsBox) throw new Error("nothing laid out");
			// The card is no wider than the window, and the options (a fieldset) no wider than the card.
			expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(width);
			expect(optionsBox.x + optionsBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
			for (const id of ["homebrew", "installer", "bun"]) {
				const option = page.getByTestId(`install-option-${id}`);
				const optionBox = await option.boundingBox();
				const copy = await option.getByRole("button", { name: /^Copy:/ }).boundingBox();
				const command = await page.getByTestId(`install-command-${id}`).boundingBox();
				if (!optionBox || !copy || !command) throw new Error(`${id} is not laid out`);
				expect(copy.x + copy.width).toBeLessThanOrEqual(width);
				expect(copy.x + copy.width).toBeLessThanOrEqual(optionBox.x + optionBox.width + 0.5);
				// The command is inside its option, wrapped rather than cut.
				expect(command.x + command.width).toBeLessThanOrEqual(optionBox.x + optionBox.width + 0.5);
			}
		} finally {
			await run.stop();
		}
	});
}

test("on a phone the label of a command is above it, no command breaks inside a word, and the places looked in are folded", async ({
	page,
}) => {
	const run = await serve();
	try {
		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(run.url);
		await expect(page.getByTestId("first-run")).toBeVisible();
		// A line says where omp was looked for; the list of paths is one tap away, not a wall of text.
		const searched = page.getByTestId("omp-searched");
		await expect(searched.locator("li").first()).toBeHidden();
		await searched.locator("summary").click();
		await expect(searched.locator("li").first()).toBeVisible();
		for (const id of ["homebrew", "installer", "bun"]) {
			const option = page.getByTestId(`install-option-${id}`);
			const label = await option.getByText("Runs", { exact: true }).boundingBox();
			const command = await page.getByTestId(`install-command-${id}`).boundingBox();
			if (!label || !command) throw new Error(`${id} is not laid out`);
			expect(label.y + label.height, `${id}: the label is above its command, not beside it`).toBeLessThanOrEqual(
				command.y,
			);
			// A line may break where the command has a space or a slash, never between two letters of a word.
			const broken = await page.getByTestId(`install-command-${id}`).evaluate((el) => {
				const text = el.firstChild;
				if (!(text instanceof Text)) return ["no text"];
				const tops: number[] = [];
				for (let i = 0; i < text.length; i++) {
					const range = document.createRange();
					range.setStart(text, i);
					range.setEnd(text, i + 1);
					tops.push(range.getBoundingClientRect().top);
				}
				const inWord = (ch: string) => /[A-Za-z0-9]/.test(ch);
				const cuts: string[] = [];
				for (let i = 1; i < text.length; i++) {
					const before = text.data[i - 1] ?? "";
					const after = text.data[i] ?? "";
					if ((tops[i] ?? 0) > (tops[i - 1] ?? 0) + 2 && inWord(before) && inWord(after))
						cuts.push(`${before}|${after} at ${i}`);
				}
				return cuts;
			});
			expect(broken, `${id}: ${await page.getByTestId(`install-command-${id}`).innerText()}`).toEqual([]);
		}
	} finally {
		await run.stop();
	}
});

test("installing with Homebrew shows the install as it runs, then the setup, which ends in a new chat", async ({
	page,
}) => {
	const run = await serve();
	try {
		await fakeCatalog(page);
		await page.goto(run.url);
		await page.getByTestId("install-start").click();

		// Live output of the command that is running.
		await expect(page.getByTestId("install-job")).toHaveAttribute("data-state", "running");
		await expect(page.getByTestId("install-log")).toContainText("==> Fetching can1357/tap/omp");
		await expect(page.getByTestId("install-log")).toContainText("==> Installing omp");

		// omp was installed and found: the setup takes over, from its first step.
		await expect(page.getByTestId("onboarding")).toBeVisible();
		expect(readFileSync(run.world.brewLog, "utf8")).toContain("brew install can1357/tap/omp");
		await expect(page.getByTestId("setup-step")).toContainText("Step 1 of 4");
		// A live region says which step it is; focus is not moved at first load, where nothing was pressed.
		await expect(page.getByTestId("setup-step")).toHaveAttribute("role", "status");
		const rolesBefore = (await api<{ roles: Record<string, string> }>(run, "/api/model-config")).roles;
		await expect(page.getByTestId("setup-account")).toContainText("Anthropic (Claude Pro/Max)");
		await expect(page.getByTestId("setup-signed-in")).toBeVisible();
		// Skipping is offered while there is something left to skip.
		await expect(page.getByTestId("setup-skip")).toBeVisible();
		await page.getByTestId("setup-next").click();

		// The default model, from the models omp lists.
		await expect(page.getByTestId("setup-step")).toContainText("Step 2 of 4");
		await expect(page.locator('[data-testid="setup-model"] h2')).toBeFocused();
		await page.getByTestId("setup-model-select").click();
		await page.getByRole("option", { name: "Acme model 3" }).click();
		await page.getByTestId("setup-next").click();

		// The permission mode.
		await expect(page.getByTestId("setup-approval")).toBeVisible();
		await expect(page.locator('[data-testid="setup-approval"] h2')).toBeFocused();
		await page.getByTestId("setup-approval-always-ask").check();
		await page.getByTestId("setup-next").click();
		// Continue removed the button that had focus: it is on the new step's heading, not on the page.

		await expect(page.locator('[data-testid="setup-done"] h2')).toBeFocused();
		await expect(page.getByTestId("setup-done")).toContainText("Default model: Acme model 3");
		await expect(page.getByTestId("setup-done")).toContainText("Permissions: Ask every time");
		// Nothing is left to skip: the one way on is Start chatting.
		await expect(page.getByTestId("setup-skip")).toHaveCount(0);
		await page.getByTestId("setup-finish").click();

		// The new-chat page, with the app around it, and what was chosen is what omp and the web UI keep.
		await expect(page.getByTestId("cwd-picker")).toBeVisible();
		await expect(page.getByTestId("onboarding")).toHaveCount(0);
		await expect(page.getByTestId("first-run")).toHaveCount(0);
		expect(await api<{ mode: string }>(run, "/api/approval")).toMatchObject({ mode: "always-ask" });
		// Only `default` changed: the other roles omp had (smol, slow, …) are still there.
		const after = (await api<{ roles: Record<string, string> }>(run, "/api/model-config")).roles;
		expect(after.default).toBe("acme/m-3");
		expect(after).toEqual({ ...rolesBefore, default: "acme/m-3" });

		// And it stays finished.
		await page.reload();
		await expect(page.getByTestId("cwd-picker")).toBeVisible();
		await expect(page.getByTestId("onboarding")).toHaveCount(0);
	} finally {
		await run.stop();
	}
});

test("closing the window half way through the setup resumes it", async ({ page }) => {
	const run = await serve();
	try {
		await fakeCatalog(page);
		await page.goto(run.url);
		await page.getByTestId("install-start").click();
		await expect(page.getByTestId("onboarding")).toBeVisible();
		await page.getByTestId("setup-next").click();
		await expect(page.getByTestId("setup-step")).toContainText("Step 2 of 4");

		await page.reload();
		await expect(page.getByTestId("onboarding")).toBeVisible();
		await expect(page.getByTestId("setup-step")).toContainText("Step 1 of 4");
	} finally {
		await run.stop();
	}
});

test("a failed install says why, keeps its output, and the next try can succeed", async ({ page }) => {
	const run = await serve();
	// `brew install` fails for as long as this file exists.
	mkdirSync(run.world.prefix, { recursive: true });
	writeFileSync(join(run.world.prefix, ".fail"), "");
	try {
		await fakeCatalog(page);
		await page.goto(run.url);
		await page.getByTestId("install-start").click();
		await expect(page.getByTestId("install-failed")).toBeVisible();
		await expect(page.getByTestId("install-failed")).toContainText("The install didn't finish");
		await expect(page.getByTestId("install-failed")).toContainText("exited with code 1");
		await expect(page.getByTestId("install-failed")).toContainText("simulated install failure");
		// What it printed before it failed stays on screen.
		await expect(page.getByTestId("install-log")).toContainText("==> Fetching can1357/tap/omp");
		await expect(page.getByTestId("first-run")).toBeVisible();

		// Try again: the choices are back, and with the cause gone the install goes through.
		rmSync(join(run.world.prefix, ".fail"));
		await page.getByTestId("install-retry").click();
		await expect(page.getByTestId("install-start")).toBeVisible();
		await page.getByTestId("install-start").click();
		await expect(page.getByTestId("onboarding")).toBeVisible();
	} finally {
		await run.stop();
	}
});

test("omp's own installer leaves omp where PATH does not reach, and it is found there; the setup can be skipped", async ({
	page,
}) => {
	const run = await serve();
	try {
		await fakeCatalog(page);
		await page.goto(run.url);
		await page.getByTestId("install-option-installer").getByRole("radio").check();
		await page.getByTestId("install-start").click();
		await expect(page.getByTestId("install-log")).toContainText("Downloading omp-fake");
		await expect(page.getByTestId("onboarding")).toBeVisible();
		expect(readFileSync(run.world.curlLog, "utf8")).toContain("https://omp.sh/install");
		const state = await api<{ state: { status: string; bin: string } }>(run, "/api/omp");
		expect(state.state.status).toBe("ready");
		expect(state.state.bin).toBe(join(run.server.home, ".local", "bin", "omp"));

		await page.getByTestId("setup-skip").click();
		await expect(page.getByTestId("cwd-picker")).toBeVisible();
		await page.reload();
		await expect(page.getByTestId("cwd-picker")).toBeVisible();
		await expect(page.getByTestId("onboarding")).toHaveCount(0);
	} finally {
		await run.stop();
	}
});

test("an installer whose download fails reports curl's own message, not that omp was not found", async ({ page }) => {
	const run = await serve();
	// The fake `curl` cannot resolve the host (exit 6) for as long as this file exists.
	const unreachable = `${run.world.template}.unreachable`;
	writeFileSync(unreachable, "");
	try {
		await fakeCatalog(page);
		await page.goto(run.url);
		await page.getByTestId("install-option-installer").getByRole("radio").check();
		await page.getByTestId("install-start").click();
		const failed = page.getByTestId("install-failed");
		await expect(failed).toContainText("exited with code 6");
		await expect(failed).toContainText("curl: (6) Could not resolve host: omp.sh");
		await expect(failed).not.toContainText("was not found afterwards");

		// Back online, the same choice installs.
		rmSync(unreachable);
		await page.getByTestId("install-retry").click();
		await page.getByTestId("install-option-installer").getByRole("radio").check();
		await page.getByTestId("install-start").click();
		await expect(page.getByTestId("onboarding")).toBeVisible();
	} finally {
		await run.stop();
	}
});

test("omp installed by hand while the screen is open is found by looking again, without the setup", async ({
	page,
}) => {
	const run = await serve();
	try {
		await page.goto(run.url);
		await expect(page.getByTestId("first-run")).toBeVisible();
		await page.getByTestId("install-recheck").click();
		await expect(page.getByTestId("install-not-found")).toHaveText("omp still wasn't found.");

		// Installed in a terminal: a launcher in a Homebrew layout on PATH.
		placeBrewOmp(run.world.prefix, run.world.template, "18.12.1");
		await page.getByTestId("install-recheck").click();
		await expect(page.getByTestId("cwd-picker")).toBeVisible();
		await expect(page.getByTestId("first-run")).toHaveCount(0);
		// The user did the install, so there is no first-time setup to walk through.
		await expect(page.getByTestId("onboarding")).toHaveCount(0);
		expect((await api<{ ompVersion: string }>(run, "/api/meta")).ompVersion).toBe("18.12.1");
	} finally {
		await run.stop();
	}
});

test("an omp that does not run is reported with what it said, and can be installed again", async ({ page }) => {
	const run = await serve();
	try {
		mkdirSync(join(run.world.prefix, "bin"), { recursive: true });
		const bin = join(run.world.prefix, "bin", "omp");
		writeFileSync(bin, "#!/bin/sh\necho 'dyld: Library not loaded: libfake.dylib' >&2\nexit 1\n");
		chmodSync(bin, 0o755);
		await run.server.restart();
		await page.goto(run.url);
		await expect(page.getByRole("heading", { name: "omp doesn't start" })).toBeVisible();
		await expect(page.getByTestId("omp-broken")).toContainText("Library not loaded: libfake.dylib");
		await expect(page.getByTestId("omp-broken")).toContainText(bin);
		await expect(page.getByTestId("install-command-homebrew")).toBeVisible();
	} finally {
		await run.stop();
	}
});
