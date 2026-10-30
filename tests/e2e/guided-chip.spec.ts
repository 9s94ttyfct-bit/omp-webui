import { writeGuidedSession } from "../support/guided-session.ts";
import { sessionRow } from "../support/live.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A conversation that began as a guided goal (shared/guided-goal.ts): its first message is the web UI's instructions to
 * omp, which the chat shows as a compact chip in the interface language, and which must not name the conversation.
 * The conversations are saved files, so no model is called.
 */

const agentDir = () => process.env.OMPW_E2E_AGENT_DIR as string;
const EDIT = { en: "Edit (creates a branch)", zh: "编辑（创建分支）" };

test("the first message is a chip with the idea, the instructions are behind a disclosure and it cannot be edited", async ({
	page,
}) => {
	writeGuidedSession(agentDir(), 0xc0, {
		rough: "make the tests faster",
		language: "English",
		answer: "Under a second",
	});
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto("/");
	// The sidebar names the conversation by what the user said, not by the instructions.
	const row = sessionRow(page, "make the tests faster");
	await expect(row).toHaveCount(1);
	await expect(row).not.toContainText("Help me define a goal");
	await row.click();

	await expect(page.getByTestId("interview-chip")).toBeVisible();
	await expect(page.getByTestId("interview-title")).toHaveText("Guided goal setup · make the tests faster");
	// The instructions are a click away, not on screen.
	const instructions = page.getByTestId("interview-instructions");
	await expect(instructions).toBeHidden();
	await expect(page.getByText("one focused question at a time")).toBeHidden();
	const toggle = page.getByTestId("interview-instructions-toggle");
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(instructions).toContainText("Guided goal setup: interview me first");
	await toggle.click();
	await expect(instructions).toBeHidden();

	// An ordinary message can be edited into a branch; the instructions cannot.
	const [first, answer] = [page.getByTestId("msg-user").nth(0), page.getByTestId("msg-user").nth(1)];
	await expect(answer).toContainText("Under a second");
	await expect(answer.getByRole("button", { name: EDIT.en })).toHaveCount(1);
	await expect(first.getByRole("button", { name: EDIT.en })).toHaveCount(0);
});

test("in Chinese the chip and the name of a conversation without an idea are Chinese too", async ({ page }) => {
	writeGuidedSession(agentDir(), 0xc1, { rough: "让测试更快", language: "Simplified Chinese", answer: "一秒以内" });
	writeGuidedSession(agentDir(), 0xc2, { rough: "", language: "Simplified Chinese", answer: "发布说明" });
	await page.addInitScript(() => {
		localStorage.setItem("ompw.lang", "zh-CN");
		localStorage.setItem("ompw.autoTitle", "off");
	});
	await page.goto("/");

	// No idea given: the conversation is named by a label, in the language the interview was held in.
	await expect(sessionRow(page, "引导式目标设定")).toHaveCount(1);
	await expect(sessionRow(page, "Help me define a goal")).toHaveCount(0);
	const row = sessionRow(page, "让测试更快");
	await expect(row).toHaveCount(1);
	await row.click();

	await expect(page.getByTestId("interview-title")).toHaveText("引导式目标设定 · 让测试更快");
	await expect(page.getByText("Help me define a goal")).toBeHidden();
	const toggle = page.getByTestId("interview-instructions-toggle");
	await expect(toggle).toHaveAccessibleName("发给 omp 的说明");
	await toggle.click();
	await expect(page.getByTestId("interview-instructions")).toContainText("interview me first");
	await expect(page.getByTestId("msg-user").nth(0).getByRole("button", { name: EDIT.zh })).toHaveCount(0);
	await expect(page.getByTestId("msg-user").nth(1).getByRole("button", { name: EDIT.zh })).toHaveCount(1);
});

test("a guided setup without an idea is just the label", async ({ page }) => {
	writeGuidedSession(agentDir(), 0xc3, { rough: "", language: "English", answer: "Write the release notes" });
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto("/");
	const row = sessionRow(page, "Guided goal setup");
	await expect(row).toHaveCount(1);
	await row.click();
	await expect(page.getByTestId("interview-title")).toHaveText("Guided goal setup");
});
