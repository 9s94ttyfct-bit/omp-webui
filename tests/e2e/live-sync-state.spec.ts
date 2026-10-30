import { setTimeout as sleep } from "node:timers/promises";
import { sessionRow } from "../support/live.ts";
import * as omp from "../support/omp-frames.ts";
import { topTab } from "../support/panel.ts";
import { other, runningTurn, SIDES, type Side, show, startWorld, type World } from "../support/two-pages.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * What the Mac app's own window and a page through Cloudflare Access show of what omp says once or a person does on one
 * page (see live-sync.spec.ts): a compaction, an extension's status line, a `!command` that runs (with its Stop), the working
 * time of a turn, a todo list edited, a rename, an archived conversation, a loved model, the dialogs of every kind, Stop and
 * Pause, and what stays a page's own (a draft). Each is driven from each side (#587).
 */

let world: World;
test.beforeAll(async () => {
	world = await startWorld();
});
test.afterAll(async () => {
	await world?.stop();
});

const request = (page: Page) => page.getByTestId("ui-request");

/** The seconds of working time a page shows (`Working time` and `1m 05s`, or `5s`). */
async function worked(page: Page): Promise<number> {
	const text = await page.getByTestId("status-time").first().innerText();
	const m = /(?:(\d+)m\s*)?(\d+)s/.exec(text);
	if (!m) throw new Error(`no working time in ${JSON.stringify(text)}`);
	return Number(m[1] ?? 0) * 60 + Number(m[2]);
}

let n = 100;
const next = () => n++;

for (const acting of SIDES) {
	const watching: Side = other(acting);

	for (const kind of ["confirm", "input", "editor", "ask"] as const) {
		test(`a ${kind} dialog is on both pages and answered on the ${acting} page is gone from the ${watching} page`, async ({
			browser,
		}) => {
			const title = `Dialog ${kind} on ${acting}`;
			const { pages, liveId } = await runningTurn(world, browser, next(), title, watching);
			try {
				const frame =
					kind === "confirm"
						? omp.confirm("d1", "Continue?", "Really go on")
						: kind === "ask"
							? omp.ask("d1", [{ id: "color", question: "Which colour?", options: ["Red", "Blue"] }])
							: omp.input("d1", "Name it", kind);
				await world.emit(liveId, frame);
				for (const side of SIDES) await expect(request(pages[side])).toHaveAttribute("data-method", kind);
				const box = request(pages[acting]);
				if (kind === "confirm") await box.getByRole("button", { name: "Allow" }).click();
				else if (kind === "ask") {
					await box.getByRole("radio", { name: "Blue" }).check();
					await box.getByRole("button", { name: /^Submit/ }).click();
				} else {
					await box.getByLabel("Response").fill("Aurora");
					await box.getByRole("button", { name: "Submit" }).click();
				}
				for (const side of SIDES) await expect(request(pages[side])).toHaveCount(0);
				expect(world.received().filter((c) => c.type === "extension_ui_response")).toHaveLength(1);
			} finally {
				await pages.close();
			}
		});
	}

	test(`Stop on the ${watching} page ends the turn of the ${acting} page, with its queue, on both`, async ({
		browser,
	}) => {
		const title = `Stopped from ${watching}`;
		const { pages, liveId } = await runningTurn(world, browser, next(), title, acting);
		try {
			await world.emit(liveId, omp.messageStart("m1"), ...omp.block("m1", "text", 0, ["Half an answer"]));
			for (const side of SIDES) await expect(pages[side].getByText("Half an answer")).toBeVisible();
			await pages[acting].getByTestId("composer").fill("Queued behind");
			await pages[acting].getByTestId("composer").press("Enter");
			for (const side of SIDES) await expect(pages[side].getByTestId("queue-chip")).toContainText("Queued behind");
			await pages[watching].getByTestId("stop").click();
			for (const side of SIDES) {
				await expect(pages[side].getByTestId("stop")).toHaveCount(0);
				await expect(pages[side].getByTestId("queue-chip")).toHaveCount(0);
			}
			expect(world.received().some((c) => c.type === "abort_and_restore_queue" || c.type === "abort")).toBe(true);
		} finally {
			await pages.close();
		}
	});

	test(`a conversation paused on the ${acting} page shows the paused banner on the ${watching} page, and resumed there it is running on both`, async ({
		browser,
	}) => {
		const title = `Banner paused on ${acting}`;
		const { pages } = await runningTurn(world, browser, next(), title, acting);
		try {
			await pages[acting].getByTestId("pause").click();
			for (const side of SIDES) await expect(pages[side].getByTestId("paused-banner")).toBeVisible();
			await pages[watching].getByTestId("paused-resume").click();
			for (const side of SIDES) {
				await expect(pages[side].getByTestId("paused-banner")).toHaveCount(0);
				await expect(pages[side].getByTestId("stop")).toBeVisible();
			}
		} finally {
			await pages.close();
		}
	});

	test(`a compaction omp starts is on both pages, and on a ${watching} page that opens the conversation meanwhile`, async ({
		browser,
	}) => {
		const title = `Compacting from ${acting}`;
		const { pages, liveId } = await runningTurn(world, browser, next(), title, acting);
		try {
			await world.emit(liveId, omp.compactionStart());
			for (const side of SIDES) await expect(pages[side].getByTestId("compaction-line")).toBeVisible();
			await pages[watching].reload();
			await show(pages[watching], title);
			await expect(pages[watching].getByTestId("compaction-line")).toBeVisible();
			await world.emit(liveId, omp.compactionEnd());
			for (const side of SIDES) await expect(pages[side].getByTestId("compaction-line")).toHaveCount(0);
			for (const side of SIDES) await expect(pages[side].getByTestId("compaction-outcome")).toBeVisible();
		} finally {
			await pages.close();
		}
	});

	test(`a !command the ${acting} page runs is running on the ${watching} page too, and Stop there ends it`, async ({
		browser,
	}) => {
		const title = `Bash from ${acting}`;
		const file = world.seed(next(), title);
		const pages = await world.open(browser);
		try {
			await show(pages.local, title);
			await show(pages.remote, title);
			await pages[acting].getByTestId("composer").fill("!sleep 20");
			await pages[acting].getByTestId("composer").press("Enter");
			await world.liveOf(file);
			for (const side of SIDES) await expect(pages[side].getByTestId("pending-command")).toBeVisible();
			await pages[watching].getByTestId("pending-stop").click();
			for (const side of SIDES) await expect(pages[side].getByTestId("pending-command")).toHaveCount(0);
		} finally {
			await pages.close();
		}
	});

	test(`a status an extension sets is on both pages, and on a ${watching} page that opens the conversation after`, async ({
		browser,
	}) => {
		const title = `Status from ${acting}`;
		const { pages, liveId } = await runningTurn(world, browser, next(), title, acting);
		try {
			await world.emit(liveId, omp.status("lint", "Lint: 3 warnings"));
			for (const side of SIDES) await expect(pages[side].getByText("Lint: 3 warnings")).toBeVisible();
			await pages[watching].reload();
			await show(pages[watching], title);
			await expect(pages[watching].getByText("Lint: 3 warnings")).toBeVisible();
		} finally {
			await pages.close();
		}
	});

	test(`a conversation renamed on the ${acting} page has the new name on the ${watching} page`, async ({ browser }) => {
		const title = `Renamed from ${acting}`;
		world.seed(next(), title);
		const pages = await world.open(browser);
		try {
			await show(pages.local, title);
			await show(pages.remote, title);
			await sessionRow(pages[acting], title).hover();
			await pages[acting].getByRole("button", { name: `Actions for ${title}` }).click();
			await pages[acting].getByRole("menuitem", { name: "Rename" }).click();
			await pages[acting].getByTestId("rename-input").fill(`${title} again`);
			await pages[acting].getByRole("button", { name: "Save" }).click();
			for (const side of SIDES) {
				await expect(sessionRow(pages[side], `${title} again`)).toBeVisible();
				await expect(pages[side].getByTestId("chat-title")).toContainText(`${title} again`);
			}
		} finally {
			await pages.close();
		}
	});

	test(`a conversation archived on the ${acting} page leaves the ${watching} page's list`, async ({ browser }) => {
		const title = `Archived from ${acting}`;
		world.seed(next(), title);
		const pages = await world.open(browser);
		try {
			await expect(sessionRow(pages.local, title)).toBeVisible();
			await expect(sessionRow(pages.remote, title)).toBeVisible();
			await sessionRow(pages[acting], title).hover();
			await pages[acting].getByRole("button", { name: `Actions for ${title}` }).click();
			await pages[acting].getByRole("menuitem", { name: "Archive" }).click();
			for (const side of SIDES) await expect(sessionRow(pages[side], title)).toHaveCount(0);
		} finally {
			await pages.close();
		}
	});

	test(`a turn's clock on the ${watching} page, opened on the conversation after a while, reads what it reads on the ${acting} page`, async ({
		browser,
	}) => {
		const title = `Clock from ${acting}`;
		const file = world.seed(next(), title);
		const pages = await world.open(browser);
		try {
			await show(pages[acting], title);
			await pages[acting].getByTestId("composer").fill(`Go ${title}`);
			await pages[acting].getByTestId("composer").press("Enter");
			await world.turnOf(file);
			await sleep(4000);
			await show(pages[watching], title);
			// Both pages count the turn from when it began: the page that opened late has no moment of its own to count from.
			await expect
				.poll(async () => Math.abs((await worked(pages[acting])) - (await worked(pages[watching]))), {
					message: "the two pages' working times",
				})
				.toBeLessThanOrEqual(2);
			expect(await worked(pages[watching])).toBeGreaterThanOrEqual(4);
		} finally {
			await pages.close();
		}
	});

	test(`a todo list edited on the ${acting} page is the list on the ${watching} page, with no reload`, async ({
		browser,
	}) => {
		const title = `Todos edited on ${acting}`;
		const { pages } = await runningTurn(world, browser, next(), title, acting);
		try {
			for (const side of SIDES) {
				await pages[side].getByTestId("toggle-panel").click();
				await topTab(pages[side], /^Todos/).click();
				await expect(pages[side].getByText("No todos")).toBeVisible();
			}
			const panel = pages[acting].getByRole("tabpanel", { name: /Todos/ });
			await panel.getByTestId("todo-add-task").click();
			const field = panel.getByTestId("todo-entry").getByLabel("New task");
			await field.fill("Write the notes");
			await field.press("Enter");
			for (const side of SIDES) {
				const tasks = pages[side].getByRole("tabpanel", { name: /Todos/ }).getByTestId("todo-task");
				await expect(tasks).toHaveCount(1);
				await expect(tasks).toContainText("Write the notes");
			}
		} finally {
			await pages.close();
		}
	});

	test(`a usage-limit wait is on a ${watching} page that opens the conversation meanwhile, and Retry now on it ends the wait on both`, async ({
		browser,
	}) => {
		const title = `Usage wait from ${acting}`;
		const { pages, liveId } = await runningTurn(world, browser, next(), title, acting);
		try {
			// `0x80000`: the provider's usage limit, the one wait that has Retry now from its first second.
			await world.emit(liveId, omp.retryStart(1, 3, 3_600_000, "You have hit your usage limit", 0x80000));
			for (const side of SIDES) await expect(pages[side].getByTestId("retry-wait")).toBeVisible();
			await pages[watching].reload();
			await show(pages[watching], title);
			await expect(pages[watching].getByTestId("retry-wait")).toBeVisible();
			await pages[watching].getByTestId("retry-now").click();
			for (const side of SIDES) await expect(pages[side].getByTestId("retry-wait")).toHaveCount(0, { timeout: 20_000 });
		} finally {
			await pages.close();
		}
	});

	test(`the usage limit omp reports is on a ${watching} page that opens the conversation after it`, async ({
		browser,
	}) => {
		const title = `Quota from ${acting}`;
		const { pages, liveId } = await runningTurn(world, browser, next(), title, acting);
		try {
			await world.state(liveId, { usageLimit: { stage: "low_priority" } });
			await pages[watching].reload();
			await show(pages[watching], title);
			await expect(pages[watching].getByTestId("status-usage-limit")).toBeVisible();
		} finally {
			await world.state(liveId, { usageLimit: undefined });
			await pages.close();
		}
	});

	test(`what is typed in the ${acting} page's message box stays in it: a draft is a page's own`, async ({
		browser,
	}) => {
		const title = `Draft on ${acting}`;
		const { pages, liveId } = await runningTurn(world, browser, next(), title, acting);
		try {
			await pages[acting].getByTestId("composer").fill("not sent yet");
			// Whatever the conversation does meanwhile, the other page's box is its own.
			await world.emit(liveId, omp.messageStart("m1"), ...omp.block("m1", "text", 0, ["Moving on"]));
			for (const side of SIDES) await expect(pages[side].getByText("Moving on")).toBeVisible();
			await expect(pages[watching].getByTestId("composer")).toHaveValue("");
			await expect(pages[acting].getByTestId("composer")).toHaveValue("not sent yet");
		} finally {
			await pages.close();
		}
	});
}

test("a model loved on the app's page is loved on the page through the tunnel, and the other way round, with no reload", async ({
	browser,
}) => {
	const title = "Loved models";
	world.seed(next(), title);
	const pages = await world.open(browser);
	try {
		/** The heart of the model whose name has `name` in it, whether it is filled (`pressed`) or not. */
		const heart = (page: Page, name: string, pressed: boolean) =>
			page.locator(`[data-testid="model-love"][aria-pressed="${pressed}"][aria-label*="${name}"]`);
		for (const side of SIDES) {
			await show(pages[side], title);
			await pages[side].getByTestId("model-picker").click();
		}
		// Both pickers stay open while the other page loves: what changes in them is the server's word, not a reload.
		for (const [acting, name] of [
			["local", "Sonnet 5.5"],
			["remote", "Haiku 5.5"],
		] as const) {
			// The picker's list scrolls: the heart may start below its fold, and a click needs it in view.
			const target = heart(pages[acting], name, false).first();
			await target.scrollIntoViewIfNeeded();
			await target.click({ force: true });
			for (const side of SIDES) await expect(heart(pages[side], name, true)).toHaveCount(1);
		}
		for (const side of SIDES) {
			await expect(pages[side].locator('[data-testid="model-love"][aria-pressed="true"]')).toHaveCount(2);
		}
	} finally {
		await pages.close();
	}
});

for (const acting of SIDES) {
	const watching: Side = other(acting);
	test(`a model preset chosen on the ${acting} page is the preset the ${watching} page names, with no reload`, async ({
		browser,
	}) => {
		const title = `Preset from ${acting}`;
		const haiku = "anthropic/claude-haiku-5-5";
		const sonnet = "anthropic/claude-sonnet-5-5";
		const headers = {
			"x-omp-webui-token": world.server.accessToken,
			"x-omp-webui": "1",
			"content-type": "application/json",
		};
		const save = (name: string, roles: Record<string, string>) =>
			fetch(`${world.server.url}/api/model-config/preset/save`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name, roles, defaultThinkingLevel: "high", agentModelOverrides: {}, overwrite: true }),
			});
		const roles = (main: string) => ({ default: main, smol: haiku, slow: haiku, tiny: haiku, commit: haiku });
		for (const [name, main] of [
			["quick", `${haiku}:low`],
			["deep", `${sonnet}:high`],
		] as const) {
			const saved = await save(name, roles(main));
			expect(saved.ok, `saving ${name}: ${await saved.text()}`).toBe(true);
		}
		const { pages } = await runningTurn(world, browser, next(), title, acting);
		try {
			await pages[acting].getByTestId("preset-picker").click();
			await pages[acting].getByTestId("preset-menu").locator('[data-preset="deep"]').click();
			for (const side of SIDES) await expect(pages[side].getByTestId("preset-label")).toHaveText("deep");
			await pages[watching].getByTestId("preset-picker").click();
			await pages[watching].getByTestId("preset-menu").locator('[data-preset="quick"]').click();
			for (const side of SIDES) await expect(pages[side].getByTestId("preset-label")).toHaveText("quick");
		} finally {
			await pages.close();
		}
	});
}
