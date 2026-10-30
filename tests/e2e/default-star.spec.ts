import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withYaml } from "../support/config-yml.ts";
import { unfoldAdvanced } from "../support/controls.ts";
import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { rpcState } from "../support/rpc-state.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A row's star in the session controls is filled when what the conversation uses already is omp's default for new
 * conversations (the configuration as omp resolves it for the folder, without the process's own values), and hollow when
 * it differs (#610). Hollow is the one that saves something when pressed; a filled one says it is the default and saves
 * nothing. No model call is made: the controls only need a process.
 */

let configFile: string;
let original = "";
test.beforeAll(() => {
	configFile = join(process.env.OMPW_E2E_AGENT_DIR as string, "config.yml");
	original = readFileSync(configFile, "utf8");
});
test.beforeEach(() => writeFileSync(configFile, original));
test.afterEach(() => writeFileSync(configFile, original));

/** A Claude model as omp describes it: its API is what puts it in the family whose tier fast mode is. */
const CLAUDE = {
	id: "claude-opus-5-5",
	name: "Opus 5.5",
	provider: "anthropic",
	api: "anthropic-messages",
	contextWindow: 1_000_000,
};

const panel = (page: Page) => page.getByTestId("session-controls-panel");
const star = (page: Page, row: string) => panel(page).getByTestId(`${row}-set-default`);
const filled = (page: Page, row: string) => expect(star(page, row), row).toHaveAttribute("aria-pressed", "true");
const hollow = (page: Page, row: string) => expect(star(page, row), row).toHaveAttribute("aria-pressed", "false");

/** A page of its own on the shared server, with the page's socket tapped before it loads. */
async function openPage(page: Page, title: string, lang = "en", theme = "light") {
	const next = await page.context().newPage();
	await next.addInitScript(
		({ l, th }) => {
			localStorage.setItem("ompw.autoTitle", "off");
			localStorage.setItem("ompw.lang", l);
			localStorage.setItem("ompw.theme", th);
		},
		{ l: lang, th: theme },
	);
	const tap = await tapSocket(next);
	await next.goto("/");
	await expect(sessionRow(next, title)).toHaveCount(1, { timeout: 15_000 });
	return { page: next, tap };
}

/** The open panel of a conversation. `state`: what the page's omp answers to `get_state` when the spec says what it reports. */
async function openPanel(page: Page, n: number, title: string, state?: Record<string, unknown>, lang = "en") {
	ownSession(n, title);
	const only = await openPage(page, title, lang);
	await startLive(only.page, only.tap, title, `default-star-${n}-up`);
	const answer = (extra: Record<string, unknown>) =>
		only.tap.answer("get_state", () => ({ ok: true, data: rpcState(extra) }));
	if (state) {
		answer(state);
		await only.page.reload();
		await sessionRow(only.page, title).click();
	}
	await only.page.getByTestId("session-controls").click();
	await expect(panel(only.page)).toBeVisible({ timeout: 60_000 });
	await unfoldAdvanced(only.page);
	return { ...only, answer };
}

test("a star is filled while the row is omp's default, hollow when it differs, and flips with a choice and with the star", async ({
	page,
}) => {
	const p = await openPanel(page, 0xd1, "Star flips");
	const row = panel(p.page).getByTestId("steering-mode");
	let saves = 0;
	p.page.on("request", (r) => {
		if (r.url().endsWith("/api/controls/default")) saves++;
	});

	// Nothing was changed: what the conversation uses is what omp starts with, for every row omp reports.
	await expect(row.getByRole("radio", { name: "One at a time" })).toBeChecked();
	await filled(p.page, "steering-mode");
	await expect(star(p.page, "steering-mode")).toHaveAccessibleName(
		"“Steering delivery” is already omp's default for new conversations; nothing to save",
	);

	// A choice of this conversation's differs from the default: hollow, and it says what pressing it does.
	await row.getByText("All", { exact: true }).click();
	await expect(row.getByRole("radio", { name: "All" })).toBeChecked();
	await hollow(p.page, "steering-mode");
	await expect(star(p.page, "steering-mode")).toHaveAccessibleName("Set “Steering delivery” as default");
	// The other rows are not touched by it.
	await filled(p.page, "follow-up-mode");

	// Back to the default: filled again.
	await row.getByText("One at a time", { exact: true }).click();
	await filled(p.page, "steering-mode");

	// Make it differ, then press the star: omp's default is now that, and the star is filled.
	await row.getByText("All", { exact: true }).click();
	await hollow(p.page, "steering-mode");
	await star(p.page, "steering-mode").click();
	await expect(
		p.page.getByTestId("toast").filter({ hasText: "Steering delivery is now All by default" }),
	).toBeVisible();
	await expect.poll(() => readFileSync(configFile, "utf8"), { timeout: 15_000 }).toMatch(/steeringMode: all/);
	await filled(p.page, "steering-mode");
	expect(saves).toBe(1);

	// A filled star saves nothing.
	const before = readFileSync(configFile, "utf8");
	await star(p.page, "steering-mode").click();
	await p.page.waitForTimeout(1000);
	expect(saves).toBe(1);
	expect(readFileSync(configFile, "utf8")).toBe(before);
	await filled(p.page, "steering-mode");
});

test("a star follows a change of omp's configuration elsewhere, and a value changed on another page", async ({
	page,
}) => {
	const p = await openPanel(page, 0xd2, "Star follows", { steeringMode: "all", followUpMode: "one-at-a-time" });
	// The page's omp says All; the default is One at a time.
	await hollow(p.page, "steering-mode");
	await filled(p.page, "follow-up-mode");

	// The configuration changes (a terminal's `omp config set`): the default is now what the conversation has.
	writeFileSync(configFile, withYaml(original, "steeringMode: all"));
	await filled(p.page, "steering-mode");
	writeFileSync(configFile, original);
	await hollow(p.page, "steering-mode");

	// Another page changes the conversation's value; this one is told and shows it.
	const liveId = p.tap.sent.findLast((m) => m.t === "rpc")?.liveId as string;
	p.answer({ steeringMode: "one-at-a-time", followUpMode: "all" });
	p.tap.push({ t: "frame", liveId, frame: { type: "settings_changed" } });
	await filled(p.page, "steering-mode");
	await hollow(p.page, "follow-up-mode");
});

test("fast mode is the default by the tier the configuration has for the model's family: On for a fast tier, Off for any other", async ({
	page,
}) => {
	// What omp accepts as a family's tier differs (Claude has only priority; flex is OpenAI's and Google's), so each case
	// is a model of its family with a tier omp reads there. `shown`: what the conversation uses.
	const OPENAI = { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai", contextWindow: 400_000 };
	const GOOGLE = { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "google", contextWindow: 1_000_000 };
	const cases: {
		model: Record<string, unknown>;
		family: string;
		tier: string | null;
		shown: boolean;
		filled: boolean;
	}[] = [
		{ model: CLAUDE, family: "anthropic", tier: "priority", shown: true, filled: true },
		{ model: CLAUDE, family: "anthropic", tier: "priority", shown: false, filled: false },
		{ model: CLAUDE, family: "anthropic", tier: null, shown: false, filled: true },
		{ model: CLAUDE, family: "anthropic", tier: null, shown: true, filled: false },
		{ model: OPENAI, family: "openai", tier: "priority", shown: true, filled: true },
		{ model: OPENAI, family: "openai", tier: "ultrafast", shown: true, filled: true },
		{ model: OPENAI, family: "openai", tier: "ultrafast", shown: false, filled: false },
		{ model: OPENAI, family: "openai", tier: "flex", shown: false, filled: true },
		{ model: OPENAI, family: "openai", tier: "flex", shown: true, filled: false },
		{ model: OPENAI, family: "openai", tier: "scale", shown: false, filled: true },
		{ model: OPENAI, family: "openai", tier: "default", shown: false, filled: true },
		{ model: OPENAI, family: "openai", tier: "none", shown: false, filled: true },
		{ model: GOOGLE, family: "google", tier: "flex", shown: false, filled: true },
		{ model: GOOGLE, family: "google", tier: "priority", shown: true, filled: true },
	];
	// Each case starts a conversation's omp and waits for its star: about 9 s on a CI runner (4 s of it the start), so the
	// fourteen of them took longer than the default 120 s and the last one was cut off mid-wait, not wrong.
	test.setTimeout(cases.length * 20_000);
	let n = 0xd30;
	for (const c of cases) {
		const what = `${c.family} ${c.tier ?? "no tier"}, ${c.shown ? "On" : "Off"}`;
		writeFileSync(configFile, c.tier ? `${original}\ntier:\n  ${c.family}: ${c.tier}\n` : original);
		const p = await openPanel(page, n, `Star fast ${n}`, { fastModeEnabled: c.shown, model: c.model });
		n++;
		await expect(
			panel(p.page)
				.getByTestId("fast-mode")
				.getByRole("radio", { name: c.shown ? "On" : "Off" }),
			what,
		).toBeChecked();
		await expect(star(p.page, "fast-mode"), what).toHaveAttribute("aria-pressed", c.filled ? "true" : "false");
		await p.page.close();
	}
});

test("fast mode's star flips as the row is switched, both ways round, with Claude's tier as the default", async ({
	page,
}) => {
	let n = 0xd60;
	for (const { tier, start, other } of [
		{ tier: "priority", start: "On", other: "Off" },
		{ tier: "none", start: "Off", other: "On" },
	]) {
		writeFileSync(configFile, withYaml(original, `tier:\n  anthropic: ${tier}`));
		const title = `Star fast flip ${n}`;
		const p = await openPanel(page, n++, title, { fastModeEnabled: start === "On", model: CLAUDE });
		// What omp reports follows what the page asks: the row is switched here, as `/fast` would.
		let on = start === "On";
		p.tap.answer("get_state", () => ({ ok: true, data: rpcState({ fastModeEnabled: on, model: CLAUDE }) }));
		p.tap.answer("set_fast_mode", (command) => {
			on = command.enabled === true;
			return { ok: true, data: { enabled: on } };
		});
		const row = panel(p.page).getByTestId("fast-mode");
		await expect(row.getByRole("radio", { name: start })).toBeChecked();
		await expect(star(p.page, "fast-mode"), `${tier}: ${start}`).toHaveAttribute("aria-pressed", "true");

		await row.getByText(other, { exact: true }).click();
		await expect(row.getByRole("radio", { name: other })).toBeChecked();
		await expect(star(p.page, "fast-mode"), `${tier}: ${other}`).toHaveAttribute("aria-pressed", "false");

		await row.getByText(start, { exact: true }).click();
		await expect(row.getByRole("radio", { name: start })).toBeChecked();
		await expect(star(p.page, "fast-mode"), `${tier}: ${start} again`).toHaveAttribute("aria-pressed", "true");
		await p.page.close();
	}
});

test("the stars are in Chinese, and a filled one is not told by colour alone", async ({ page }) => {
	const p = await openPanel(page, 0xd4, "Star zh", undefined, "zh-CN");
	await filled(p.page, "steering-mode");
	await expect(star(p.page, "steering-mode")).toHaveAccessibleName(
		"“引导消息投递”已经是 omp 给新对话的默认值，无需保存",
	);
	await panel(p.page).getByTestId("steering-mode").getByText("全部", { exact: true }).click();
	await hollow(p.page, "steering-mode");
	await expect(star(p.page, "steering-mode")).toHaveAccessibleName("将“引导消息投递”设为默认");
});
