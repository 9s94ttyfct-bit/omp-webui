import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { en } from "../../web/src/i18n/guidance.ts";
import { zh } from "../../web/src/i18n/zh-CN/guidance.ts";
import { writeFakeOmp } from "../support/fake-omp.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { openSidebar, sessionRow } from "../support/live.ts";
import { topTab } from "../support/panel.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { removeTrackedTempDirs, tempDir } from "../support/temp-dirs.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The guidance conflict check (v0.13.0) as the person meets it in a conversation's Guidance tab: a save that finds
 * conflicts with the folder's AGENTS.md shows them for review, each change applied (by keyboard too) or skipped, Apply all,
 * a check that could not be made, the switch in Settings that turns it off, and the panel on a phone. The server is this
 * spec's own, with a fake omp whose print mode (what the check asks its model through) answers what the spec scripts, by a
 * word in the guidance. No model is called. `OMPW_GUIDANCE_CONFLICT_SHOTS`: a folder the screenshots are written to.
 */

const SHOTS = process.env.OMPW_GUIDANCE_CONFLICT_SHOTS;
const TITLE = "Guidance conflict review";
const AGENTS = "# Project rules\nAlways reply in Chinese.\nRun the tests before you commit.\n";
const FOUND = "## Rules\nReply in English. E2E-FOUND\nNever run the tests.";

const answer = JSON.stringify({
	conflicts: [
		{
			guidance: "Reply in English.",
			source: "f1",
			other: "Always reply in Chinese.",
			why: "The guidance and AGENTS.md ask for different reply languages.",
			change: { target: "guidance", find: "Reply in English. E2E-FOUND", replace: "Reply in Chinese. E2E-FOUND" },
		},
		{
			guidance: "Never run the tests.",
			source: "f1",
			other: "Run the tests before you commit.",
			why: "One forbids what the other asks for.",
			change: { target: "source", find: "Run the tests before you commit.", replace: "Run the tests when asked to." },
		},
	],
});

// Tall enough for the Guidance tab and its review to be seen together beside the other pane.
test.use({ viewport: { width: 1400, height: 1300 } });

let s: TestServer;
let project = "";
let log = "";

const agentsFile = () => join(project, "AGENTS.md");
/** How many times the check asked its model. */
const asked = (): number => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);

test.beforeAll(async () => {
	const dir = tempDir("ompw-gconf-");
	log = join(dir, "print.jsonl");
	project = join(dir, "project");
	mkdirSync(join(project, ".git"), { recursive: true });
	const fake = writeFakeOmp(dir, {
		models: [{ provider: "fake", id: "checker", cost: { output: 1 } }],
		settings: { modelRoles: { smol: "fake/checker" } },
		review: {
			log,
			delayMs: 300,
			answers: [
				{ when: "E2E-FOUND", text: answer },
				{ when: "E2E-GARBAGE", text: "I had a look and they mostly agree." },
				{ when: "## Rules", text: '{"conflicts":[]}' },
			],
		},
	});
	s = await startTestServer(0, { OMP_BIN: fake }, { login: false });
	writeSimpleSession(s.agentDir, 0xc3, TITLE, undefined, project);
});

test.afterAll(async () => {
	await s?.stop();
	removeTrackedTempDirs();
});

test.beforeEach(async () => {
	writeFileSync(agentsFile(), AGENTS);
	// The conversation starts every test without guidance, and the check on.
	const headers = { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" };
	await fetch(`${s.url}/api/prefs`, {
		method: "POST",
		headers,
		body: JSON.stringify({ changes: { "ompw.guidanceCheck": null } }),
	});
});

/** The conversation's Guidance tab, its guidance turned off first. */
async function openGuidance(page: Page, lang: "en" | "zh-CN" = "en") {
	await page.addInitScript((l) => {
		localStorage.setItem("ompw.lang", l);
		localStorage.setItem("ompw.autoTitle", "off");
		localStorage.removeItem("ompw.guidanceCheck");
	}, lang);
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	await openSidebar(page);
	const row = sessionRow(page, TITLE);
	await expect(row).toHaveCount(1, { timeout: 15_000 });
	await row.click();
	await expect(page.getByTestId("chat-title")).toBeVisible({ timeout: 30_000 });
	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Guidance|模型指引/).click();
	const editor = page.getByTestId("guidance-editor");
	await expect(editor.getByTestId("guidance-text")).toBeVisible({ timeout: 30_000 });
	// None: the box starts empty (a previous test's text is not carried over).
	if ((await editor.getByTestId("guidance-text").inputValue()) !== "") {
		await editor.getByTestId("guidance-text").fill("");
		await editor.getByTestId("guidance-save").click();
		await expect(editor.getByTestId("guidance-text")).toHaveValue("");
	}
	return editor;
}

async function shot(page: Page, name: string) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test("a save that conflicts with AGENTS.md: the review shows both statements and a diff, and only an applied change is written", async ({
	page,
}) => {
	const editor = await openGuidance(page);
	const before = asked();
	await editor.getByTestId("guidance-text").fill(FOUND);
	await editor.getByTestId("guidance-save").click();
	const panel = editor.getByTestId("guidance-conflicts");
	await expect(panel).toBeVisible();
	await expect(panel).toHaveAttribute("data-state", "found", { timeout: 30_000 });
	await expect(panel.getByTestId("guidance-conflicts-status")).toHaveText(en.conflictFound.replace("{n}", "2"));
	const items = panel.getByTestId("guidance-conflict");
	await expect(items).toHaveCount(2);
	await expect(items.nth(0)).toContainText("“Reply in English.”");
	await expect(items.nth(0)).toContainText("“Always reply in Chinese.”");
	await expect(items.nth(0)).toContainText(en.conflictChangeGuidance);
	await expect(items.nth(0).getByTestId("guidance-conflict-diff")).toContainText("Reply in Chinese. E2E-FOUND");
	await expect(items.nth(1)).toContainText(en.conflictChangeFile.replace("{file}", ""));
	await expect(items.nth(1).getByTestId("guidance-conflict-diff")).toContainText("Run the tests when asked to.");
	expect(asked()).toBe(before + 1);
	// Nothing outside the guidance is written by the check.
	expect(readFileSync(agentsFile(), "utf8")).toBe(AGENTS);
	await panel.scrollIntoViewIfNeeded();
	await shot(page, "conflicts-2");

	// Skip the first, apply the second from the keyboard: the file changes, the guidance does not.
	await items.nth(0).getByTestId("guidance-conflict-skip").click();
	await expect(items.nth(0)).toHaveAttribute("data-status", "skipped");
	const apply = items.nth(1).getByRole("button", { name: en.conflictApplyLabel.replace("{i}", "2") });
	await apply.focus();
	await page.keyboard.press("Enter");
	await expect(items.nth(1)).toHaveAttribute("data-status", "applied");
	expect(readFileSync(agentsFile(), "utf8")).toBe(
		"# Project rules\nAlways reply in Chinese.\nRun the tests when asked to.\n",
	);
	await expect(editor.getByTestId("guidance-text")).toHaveValue(FOUND);
	// Closed with its button; applying asked no other check.
	await panel.getByTestId("guidance-conflicts-close").click();
	await expect(panel).toHaveCount(0);
	expect(asked()).toBe(before + 1);
});

test("Apply all: the guidance becomes the conversation's own changed text and AGENTS.md is changed, each once", async ({
	page,
}) => {
	const editor = await openGuidance(page);
	const text = `${FOUND}\nKeep diffs small.`;
	await editor.getByTestId("guidance-text").fill(text);
	await editor.getByTestId("guidance-save").click();
	const panel = editor.getByTestId("guidance-conflicts");
	await expect(panel).toHaveAttribute("data-state", "found", { timeout: 30_000 });
	await panel.getByTestId("guidance-conflicts-apply-all").click();
	const items = panel.getByTestId("guidance-conflict");
	await expect(items.nth(0)).toHaveAttribute("data-status", "applied");
	await expect(items.nth(1)).toHaveAttribute("data-status", "applied");
	await expect(editor.getByTestId("guidance-text")).toHaveValue(text.replace("Reply in English.", "Reply in Chinese."));
	expect(readFileSync(agentsFile(), "utf8")).toBe(
		"# Project rules\nAlways reply in Chinese.\nRun the tests when asked to.\n",
	);
	await expect(panel.getByTestId("guidance-conflicts-apply-all")).toHaveCount(0);
	await panel.scrollIntoViewIfNeeded();
	await shot(page, "applied");
	// Checked again, the (scripted) model names the same conflicts, but its proposals no longer fit what they change: they
	// are dropped rather than guessed at, and nothing is offered to apply.
	await panel.getByTestId("guidance-conflicts-retry").click();
	await expect(panel.getByTestId("guidance-conflict").nth(0)).toHaveAttribute("data-status", "pending", {
		timeout: 30_000,
	});
	await expect(panel).toHaveAttribute("data-state", "found");
	await expect(panel.getByTestId("guidance-conflict-apply")).toHaveCount(0);
	await expect(panel.getByTestId("guidance-conflict").nth(0)).toContainText(en.conflictNoChange);
});

test("a check that could not be made: the guidance is saved, the panel says so and offers to check again", async ({
	page,
}) => {
	const editor = await openGuidance(page);
	const text = "## Model guidance\nE2E-GARBAGE: at most 2 subagents at a time.";
	await editor.getByTestId("guidance-text").fill(text);
	await editor.getByTestId("guidance-save").click();
	const panel = editor.getByTestId("guidance-conflicts");
	await expect(panel).toHaveAttribute("data-state", "failed", { timeout: 30_000 });
	await expect(panel.getByTestId("guidance-conflicts-status")).toHaveText(
		en.conflictFailed.replace("{reason}", en.conflictReasonMalformed),
	);
	await expect(panel.getByTestId("guidance-conflicts-retry")).toBeVisible();
	// Saved all the same: the box holds it and Save has nothing to do.
	await expect(editor.getByTestId("guidance-text")).toHaveValue(text);
	await expect(editor.getByTestId("guidance-save")).toHaveAttribute("aria-disabled", "true");
	await panel.getByTestId("guidance-conflicts-retry").scrollIntoViewIfNeeded();
	await shot(page, "couldnt-check");
});

test("turned off in Settings: a save checks nothing, and the tab's button says why", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto(`${s.url}/?token=${s.accessToken}#/settings/models`);
	const toggle = page.getByTestId("guidance-check-toggle");
	await expect(toggle).toBeChecked({ timeout: 30_000 });
	await expect(page.getByTestId("guidance-check-setting")).toContainText(en.conflictSetting);
	await toggle.uncheck();
	await expect(toggle).not.toBeChecked();
	await expect
		.poll(async () => {
			const res = await fetch(`${s.url}/api/prefs`, { headers: { "x-omp-webui-token": s.accessToken } });
			return ((await res.json()) as { values: Record<string, string | null> }).values["ompw.guidanceCheck"];
		})
		.toBe("off");

	await page.goto(`${s.url}/?token=${s.accessToken}`);
	await openSidebar(page);
	await sessionRow(page, TITLE).click();
	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Guidance/).click();
	const editor = page.getByTestId("guidance-editor");
	const before = asked();
	await editor.getByTestId("guidance-text").fill(`${FOUND}\nOff.`);
	await editor.getByTestId("guidance-save").click();
	await expect(editor.getByTestId("guidance-text")).toHaveValue(`${FOUND}\nOff.`);
	await expect(editor.getByTestId("guidance-save")).toHaveAttribute("aria-disabled", "true");
	await expect(editor.getByTestId("guidance-conflicts")).toHaveCount(0);
	await expect(editor.getByTestId("guidance-check")).toHaveAttribute("title", en.conflictCheckOff);
	expect(asked()).toBe(before);
});

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

	test("the review fits the width, reads in Chinese, and its buttons can be tapped", async ({ page }) => {
		const editor = await openGuidance(page, "zh-CN");
		await editor.getByTestId("guidance-text").fill(`${FOUND}\nOn a phone.`);
		await editor.getByTestId("guidance-save").tap();
		const panel = editor.getByTestId("guidance-conflicts");
		await expect(panel).toHaveAttribute("data-state", "found", { timeout: 30_000 });
		await expect(panel.getByTestId("guidance-conflicts-status")).toHaveText(zh.conflictFound.replace("{n}", "2"));
		await expect(panel.getByRole("heading", { name: zh.conflictTitle })).toBeVisible();
		const box = await panel.boundingBox();
		expect(box).not.toBeNull();
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
		const wide = await panel.evaluate((el) => el.scrollWidth - el.clientWidth);
		expect(wide).toBeLessThanOrEqual(0);
		await panel.scrollIntoViewIfNeeded();
		await shot(page, "phone");
		await panel.getByTestId("guidance-conflict").nth(0).getByTestId("guidance-conflict-skip").tap();
		await expect(panel.getByTestId("guidance-conflict").nth(0)).toHaveAttribute("data-status", "skipped");
	});
});
