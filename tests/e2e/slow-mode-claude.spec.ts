import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withYaml } from "../support/config-yml.ts";
import { unfoldAdvanced } from "../support/controls.ts";
import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { rpcState } from "../support/rpc-state.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A conversation can run models of more than one provider (`/model`, a preset, a fallback, a subagent). omp's `get_state`
 * speaks of the active model only, so the panel shows the active model's slow mode from it (the provider's flex tier, this
 * conversation's) and, when a Claude model is one the user has set up, Claude's own slow mode as a row of its own, read
 * from and written to omp's global configuration (`providers.anthropic.slowMode`), which it is whatever the active model
 * is. A provider's flex setting that is not the active one's is not shown: omp has no way to ask for it, and a value
 * shown could be stale (#597). No model call is made: the controls only need a process.
 */

let configFile: string;
let original = "";
test.beforeAll(() => {
	configFile = join(process.env.OMPW_E2E_AGENT_DIR as string, "config.yml");
	original = readFileSync(configFile, "utf8");
});
test.beforeEach(() => writeFileSync(configFile, original));
test.afterEach(() => writeFileSync(configFile, original));

const OPENAI = { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai", contextWindow: 400_000 };
const panel = (page: Page) => page.getByTestId("session-controls-panel");

/** The open panel of a conversation whose omp answers `get_state` with `state`. */
async function panelWith(page: Page, n: number, title: string, state: Record<string, unknown>, lang = "en") {
	ownSession(n, title);
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
	await startLive(next, tap, title, `slow-claude-${n}-up`);
	tap.answer("get_state", () => ({
		ok: true,
		data: rpcState({ slowModeSupported: true, slowModeEnabled: false, ...state }),
	}));
	await next.reload();
	await sessionRow(next, title).click();
	await next.getByTestId("session-controls").click();
	await expect(panel(next)).toBeVisible({ timeout: 60_000 });
	await unfoldAdvanced(next);
	return { page: next, tap };
}

test("with an OpenAI model active, the flex row is the conversation's and Claude's slow mode is a row of its own, global", async ({
	page,
}) => {
	const p = await panelWith(page, 0xc1, "Slow Claude beside flex", { slowModeScope: "session", model: OPENAI });
	const flex = panel(p.page).getByTestId("slow-mode");
	const claude = panel(p.page).getByTestId("claude-slow-mode");
	await expect(flex.locator("legend")).toHaveText("Slow mode (cheaper flex tier)");
	await expect(claude.locator("legend")).toHaveText("Claude slow mode (low priority at the limit)");
	await expect(claude.getByRole("radio", { name: "Off" })).toBeChecked();
	// Each says its own scope, and nothing of the other's.
	await expect(panel(p.page).getByTestId("slow-mode-note")).toContainText("this conversation only");
	await expect(panel(p.page).getByTestId("claude-slow-mode-note")).toContainText("every conversation");
	await expect(panel(p.page).getByTestId("claude-slow-mode-note")).not.toContainText(/flex|this conversation only/i);

	// Turning it on writes omp's global setting, which is not the active model's.
	await claude.getByText("On", { exact: true }).click();
	await expect(claude.getByRole("radio", { name: "On" })).toBeChecked();
	await expect.poll(() => readFileSync(configFile, "utf8"), { timeout: 15_000 }).toMatch(/slowMode: auto/);
	// The flex row is untouched: it is this conversation's.
	await expect(flex.getByRole("radio", { name: "Off" })).toBeChecked();

	// Each row explains only its own.
	await panel(p.page).getByTestId("claude-slow-mode-info").click();
	const claudeHelp = panel(p.page).getByTestId("claude-slow-mode-help");
	await expect(claudeHelp).toContainText("usage limit resets");
	await expect(claudeHelp).not.toContainText(/flex|this conversation only|OpenAI|Google/i);
	await panel(p.page).getByTestId("slow-mode-info").click();
	const flexHelp = panel(p.page).getByTestId("slow-mode-help");
	await expect(flexHelp).toContainText("flex tier: a cheaper way of processing a request");
	// What a provider that is not the active one has is not claimed or shown, but said where it lives.
	await expect(flexHelp).toContainText("Each provider keeps its own flex setting here");
	await expect(flexHelp).toContainText("subagents included");
	await expect(flexHelp).not.toContainText(/Claude|usage limit|low priority|config\.yml/i);
});

test("with a Claude model active there is one slow mode row: Claude's, with no second row for the same setting", async ({
	page,
}) => {
	const p = await panelWith(page, 0xc2, "Slow Claude active", { slowModeScope: "global" });
	await expect(panel(p.page).getByTestId("slow-mode").locator("legend")).toHaveText(
		"Slow mode (low priority at the limit)",
	);
	// Give the configuration a moment to be read, then the one row is all there is.
	await expect(panel(p.page).getByTestId("auto-retry").getByRole("radio", { name: "On" })).toBeChecked();
	await expect(panel(p.page).getByTestId("claude-slow-mode")).toHaveCount(0);
});

test("a conversation that has no Claude model set up has no Claude slow mode row", async ({ page }) => {
	writeFileSync(configFile, "modelRoles:\n  default: openai/gpt-6-astra\n  smol: openai/gpt-6-astra\n");
	const p = await panelWith(page, 0xc3, "Slow no Claude", { slowModeScope: "session", model: OPENAI });
	await expect(panel(p.page).getByTestId("slow-mode")).toBeVisible();
	await expect(panel(p.page).getByTestId("auto-retry").getByRole("radio", { name: "On" })).toBeChecked();
	await expect(panel(p.page).getByTestId("claude-slow-mode")).toHaveCount(0);
});

test("Claude's slow mode row is there in Chinese too, and shows what the configuration says", async ({ page }) => {
	writeFileSync(configFile, withYaml(original, "providers:\n  anthropic:\n    slowMode: auto"));
	const p = await panelWith(page, 0xc4, "Slow Claude zh", { slowModeScope: "session", model: OPENAI }, "zh-CN");
	const claude = panel(p.page).getByTestId("claude-slow-mode");
	await expect(claude.locator("legend")).toHaveText("Claude 慢速模式（到上限时低优先级）");
	await expect(claude.getByRole("radio", { name: "开" })).toBeChecked();
	await expect(panel(p.page).getByTestId("claude-slow-mode-note")).toContainText("所有对话");
	await panel(p.page).getByTestId("slow-mode-info").click();
	await expect(panel(p.page).getByTestId("slow-mode-help")).toContainText("每个服务商在这里各有自己的弹性设置");
});
