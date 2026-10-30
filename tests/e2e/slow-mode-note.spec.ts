import { unfoldAdvanced } from "../support/controls.ts";
import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { rpcState } from "../support/rpc-state.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Slow mode in the session controls is omp's own global setting, not this conversation's: `set_slow_mode` writes omp's
 * `config.yml` (`providers.anthropic.slowMode`), so it reaches every conversation. The panel says so on that row
 * (#476). Its flex tier is the conversation's own. The row names, notes and explains only the mechanism the active model
 * has (#597): Claude's low-priority lane at the usage limit (scope `global`), or the provider's flex tier (scope
 * `session`), and follows the model when it changes. The note follows what omp reports (`slowModeScope`), so it is not
 * claimed where omp does not say it. No model call is made: the controls only need a process.
 */

const panel = (page: Page) => page.getByTestId("session-controls-panel");
const note = (page: Page, row: string) => panel(page).getByTestId(`${row}-note`);

/** A page of its own on the shared server, with the page's socket tapped before it loads. */
async function openPage(page: Page, title: string, lang = "en") {
	const next = await page.context().newPage();
	await next.addInitScript(
		({ l }) => {
			localStorage.setItem("ompw.autoTitle", "off");
			localStorage.setItem("ompw.lang", l);
		},
		{ l: lang },
	);
	const tap = await tapSocket(next);
	await next.goto("/");
	await expect(sessionRow(next, title)).toHaveCount(1, { timeout: 15_000 });
	return { page: next, tap };
}

/** The panel of the open conversation. */
async function openPanel(page: Page) {
	await page.getByTestId("session-controls").click();
	await expect(panel(page)).toBeVisible({ timeout: 60_000 });
	await unfoldAdvanced(page);
}

test("the Slow mode row says its value is omp's global setting, and the panel's own note does not claim otherwise", async ({
	page,
}) => {
	ownSession(0xe1, "Slow mode global");
	const only = await openPage(page, "Slow mode global");
	await startLive(only.page, only.tap, "Slow mode global", "slow-mode-global-up");
	// What omp reports: its slow mode is a global setting.
	only.tap.answer("get_state", () => ({
		ok: true,
		data: rpcState({ slowModeSupported: true, slowModeEnabled: false, slowModeScope: "global" }),
	}));
	await only.page.reload();
	await sessionRow(only.page, "Slow mode global").click();
	await openPanel(only.page);

	// The row says where its value lives.
	await expect(note(only.page, "slow-mode")).toContainText(/global setting/i);
	await expect(note(only.page, "slow-mode")).toContainText(/every conversation/i);
	// The panel's own note (under the title's info button, #716) no longer claims that all of them are the process's only.
	await panel(only.page).getByTestId("session-controls-note-info").click();
	await expect(panel(only.page).getByTestId("session-controls-note")).toContainText(
		/Runtime settings for this omp process\./,
	);
	await expect(panel(only.page)).not.toContainText("for this omp process only");
	// No other row claims to be global.
	for (const row of ["auto-compaction", "auto-retry", "steering-mode", "follow-up-mode", "interrupt-mode", "fast-mode"])
		await expect(panel(only.page).getByTestId(`${row}-note`)).toHaveCount(0);
});

test("the Slow mode row says it in Chinese too", async ({ page }) => {
	ownSession(0xe2, "Slow mode global zh");
	const only = await openPage(page, "Slow mode global zh", "zh-CN");
	await startLive(only.page, only.tap, "Slow mode global zh", "slow-mode-global-zh-up");
	only.tap.answer("get_state", () => ({
		ok: true,
		data: rpcState({ slowModeSupported: true, slowModeEnabled: false, slowModeScope: "global" }),
	}));
	await only.page.reload();
	await sessionRow(only.page, "Slow mode global zh").click();
	await openPanel(only.page);

	await expect(note(only.page, "slow-mode")).toContainText("全局设置");
	await expect(note(only.page, "slow-mode")).toContainText("所有对话");
	await expect(panel(only.page)).not.toContainText("仅限此 omp 进程");
});

test("an omp that does not say where its slow mode lives gets no claim about it", async ({ page }) => {
	ownSession(0xe3, "Slow mode scope unknown");
	const only = await openPage(page, "Slow mode scope unknown");
	await startLive(only.page, only.tap, "Slow mode scope unknown", "slow-mode-scope-unknown-up");
	// An omp that offers slow mode but does not say what scope it has: the panel must not claim one.
	only.tap.answer("get_state", () => ({
		ok: true,
		data: rpcState({ slowModeSupported: true, slowModeEnabled: false }),
	}));
	await only.page.reload();
	await sessionRow(only.page, "Slow mode scope unknown").click();
	await openPanel(only.page);

	await expect(panel(only.page).getByTestId("slow-mode")).toBeVisible();
	await expect(note(only.page, "slow-mode")).toHaveCount(0);
});

const OPENAI = { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai", contextWindow: 400_000 };

/** The open panel of a conversation whose omp answers `get_state` with `state` (the model is Claude unless it says). */
async function panelWith(page: Page, n: number, title: string, state: Record<string, unknown>, lang = "en") {
	ownSession(n, title);
	const only = await openPage(page, title, lang);
	await startLive(only.page, only.tap, title, `slow-help-${n}-up`);
	const answer = (extra: Record<string, unknown>) =>
		only.tap.answer("get_state", () => ({
			ok: true,
			data: rpcState({ slowModeSupported: true, slowModeEnabled: false, ...extra }),
		}));
	answer(state);
	await only.page.reload();
	await sessionRow(only.page, title).click();
	await openPanel(only.page);
	return { ...only, answer };
}

const aboutSlow = async (page: Page, label: string, lang = "en") => {
	const button = panel(page).getByTestId("slow-mode-info");
	await expect(button).toHaveAccessibleName(lang === "en" ? `About “${label}”` : `关于“${label}”`);
	await button.click();
	return panel(page).getByTestId("slow-mode-help");
};

test("an omp whose slow mode is its own says it is this conversation's, and says nothing of Claude's limit", async ({
	page,
}) => {
	const p = await panelWith(page, 0xe4, "Slow mode session scope", {
		slowModeScope: "session",
		model: OPENAI,
	});
	const row = panel(p.page).getByTestId("slow-mode");
	await expect(row.locator("legend")).toHaveText("Slow mode (cheaper flex tier)");
	await expect(note(p.page, "slow-mode")).toContainText("this conversation only");
	await expect(note(p.page, "slow-mode")).toContainText("flex tier");
	await expect(note(p.page, "slow-mode")).not.toContainText(
		/global|every conversation|config\.yml|usage limit|Claude/i,
	);

	const text = await aboutSlow(p.page, "Slow mode (cheaper flex tier)");
	// What flex is, in plain words, and where it lives.
	await expect(text).toContainText("flex tier: a cheaper way of processing a request");
	await expect(text).toContainText("for work that can wait");
	await expect(text).toContainText("this conversation only");
	// Nothing of the other mechanism.
	await expect(text).not.toContainText(/Claude|usage limit|low priority|config\.yml|every conversation|session limit/i);
});

test("a Claude model's slow mode is explained as the low-priority lane at the usage limit, for every conversation, and not as flex", async ({
	page,
}) => {
	const p = await panelWith(page, 0xe5, "Slow mode claude help", { slowModeScope: "global" });
	const row = panel(p.page).getByTestId("slow-mode");
	await expect(row.locator("legend")).toHaveText("Slow mode (low priority at the limit)");
	await expect(note(p.page, "slow-mode")).toContainText("every conversation");
	await expect(note(p.page, "slow-mode")).not.toContainText(/flex|this conversation only/i);

	const text = await aboutSlow(p.page, "Slow mode (low priority at the limit)");
	await expect(text).toContainText("usage limit resets");
	await expect(text).toContainText("low priority");
	await expect(text).toContainText("every conversation");
	await expect(text).toContainText("config.yml");
	await expect(text).not.toContainText(/flex|this conversation only|OpenAI|Google/i);
});

test("the explanation follows the model: an open one changes with it, and is still open", async ({ page }) => {
	const p = await panelWith(page, 0xe6, "Slow mode follows model", { slowModeScope: "global" });
	const text = await aboutSlow(p.page, "Slow mode (low priority at the limit)");
	await expect(text).toContainText("usage limit resets");

	// The conversation moves to an OpenAI model: omp's state now says so, and the page is told the model changed.
	const liveId = p.tap.sent.findLast((m) => m.t === "rpc")?.liveId as string;
	p.answer({ slowModeScope: "session", model: OPENAI });
	p.tap.push({ t: "frame", liveId, frame: { type: "model_changed" } });
	await expect(panel(p.page).getByTestId("slow-mode").locator("legend")).toHaveText("Slow mode (cheaper flex tier)");
	await expect(panel(p.page).getByTestId("slow-mode-info")).toHaveAttribute("aria-expanded", "true");
	await expect(text).toContainText("flex tier");
	await expect(text).not.toContainText(/usage limit|Claude|low priority/i);
});

test("both slow modes are explained in Chinese, each on its own", async ({ page }) => {
	const flex = await panelWith(page, 0xe7, "Slow mode flex zh", { slowModeScope: "session", model: OPENAI }, "zh-CN");
	await expect(note(flex.page, "slow-mode")).toContainText("当前对话");
	const flexText = await aboutSlow(flex.page, "慢速模式（更便宜的弹性档位）", "zh-CN");
	await expect(flexText).toContainText("弹性（flex）档位");
	await expect(flexText).toContainText("只作用于当前对话");
	await expect(flexText).not.toContainText(/Claude|用量上限|低优先级|config\.yml|所有对话|会话/);
	await flex.page.close();

	const claude = await panelWith(page, 0xe8, "Slow mode claude zh", { slowModeScope: "global" }, "zh-CN");
	const claudeText = await aboutSlow(claude.page, "慢速模式（到上限时低优先级）", "zh-CN");
	await expect(claudeText).toContainText("用量上限");
	await expect(claudeText).toContainText("低优先级");
	await expect(claudeText).toContainText("所有对话");
	await expect(claudeText).not.toContainText(/弹性|flex|只作用于当前对话|会话/);
});
