import { rmSync } from "node:fs";
import { ownSession, startLive } from "../support/live.ts";
import { NOTES_PROMPT, writeNotesSession } from "../support/render-fixtures.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * The records omp writes about itself read as the terminal shows them: an advisor card that stays on screen when a
 * turn folds its steps, rule rows titled by their rule, fallback warnings, typed background-job, supervised-process
 * and IRC rows. Saved ones come from a synthetic session in omp 18.12's entry shapes; live ones from frames pushed
 * through the socket tap. No model call.
 */

const agentDir = () => process.env.OMPW_E2E_AGENT_DIR as string;
let file = "";
test.beforeAll(() => {
	file = writeNotesSession(agentDir());
});
test.afterAll(() => rmSync(file, { force: true }));

test("a folded turn keeps its advisor card and fallback in view and says it has blockers", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("complementary").getByText(NOTES_PROMPT).click();
	const turn = page.getByTestId("agent-turn");
	await expect(turn.getByText("FINAL-ANSWER: done.")).toBeVisible();
	await expect(page.getByTestId("work-summary")).toBeVisible();
	await expect(page.getByTestId("work-blockers")).toContainText("1 advisor blocker");

	// The steps are folded away: the tool calls and the plain records between them.
	await expect(page.getByTestId("tool-card")).toHaveCount(0);
	for (const id of ["rule-note", "job-note", "daemon-note", "irc-card"])
		await expect(page.getByTestId(id)).toHaveCount(0);

	// What the reader must not miss stays.
	const card = page.getByTestId("advisor-card");
	await expect(card).toBeVisible();
	await expect(card).toHaveAttribute("data-severity", "blocker");
	await expect(card.getByTestId("advisor-badge")).toHaveText(["1 blocker", "2 concerns", "1 nit", "1 note"]);
	await expect(card.getByTestId("advisor-note")).toHaveCount(3);
	await expect(card.getByTestId("advisor-note").first()).toContainText("ADVISOR-BLOCKER-TEXT: pin the spelling.");
	await expect(card.getByTestId("advisor-more")).toHaveText("+2 more");
	await card.getByTestId("advisor-more").click();
	await expect(card.getByTestId("advisor-note")).toHaveCount(5);
	await expect(card.getByTestId("advisor-more")).toHaveText("Show fewer");
	await card.getByTestId("advisor-more").click();
	await expect(card.getByTestId("advisor-note")).toHaveCount(3);

	const fallback = page.getByTestId("fallback-note");
	await expect(fallback).toContainText("Switched to fallback model anthropic/claude-opus-5-5");
	await expect(turn).not.toContainText("<advisory");
});

test("opened, the same turn shows rules, jobs, processes and IRC as typed rows, with none of omp's wrapper text", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("complementary").getByText(NOTES_PROMPT).click();
	await page.getByTestId("work-summary").click();
	const turn = page.getByTestId("agent-turn");

	const ruleRow = page.getByTestId("rule-note");
	await expect(ruleRow).toContainText("Rule applied: ts-set-map");
	await expect(ruleRow).not.toContainText("system-reminder");
	await expect(ruleRow).not.toContainText("RULE-BODY-TEXT");
	await ruleRow.getByRole("button").click();
	await expect(ruleRow).toContainText("RULE-BODY-TEXT: use Record for static tables.");
	await expect(ruleRow).not.toContainText("User-defined rule matched");

	const job = page.getByTestId("job-note");
	const jobLine = job.getByTestId("job-line");
	await expect(jobLine).toContainText("Background job completed");
	await expect(jobLine).toContainText("[eval]");
	await expect(jobLine).toContainText("bg_1");
	await expect(jobLine).toContainText("(10.0s)");
	await expect(jobLine).toContainText("count penguin rows");
	await expect(job).not.toContainText("JOB-RESULT-TEXT");
	await job.getByRole("button", { name: "Result" }).click();
	await expect(job.getByTestId("job-result")).toHaveText("JOB-RESULT-TEXT");

	const daemon = page.getByTestId("daemon-line");
	await expect(daemon).toContainText("Supervised process failed");
	await expect(daemon).toContainText("xcode-copy");
	await expect(daemon).toContainText("(exit 1)");
	await expect(daemon).toContainText("(2.5s)");

	const irc = page.getByTestId("irc-card");
	await expect(irc).toContainText("IRC from Main");
	await expect(irc).toContainText("IRC-BODY-TEXT please integrate main.");

	for (const wrapper of [
		"<system-notice>",
		"<system-reminder",
		"<irc>",
		"<advisory",
		"Incoming IRC message",
		"Resume your work",
	])
		await expect(turn, wrapper).not.toContainText(wrapper);
});

test("the typed rows speak Chinese when the interface does", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	await page.goto("/");
	await page.getByRole("complementary").getByText(NOTES_PROMPT).click();
	await expect(page.getByTestId("work-blockers")).toContainText("1 个顾问阻断项");
	await expect(page.getByTestId("fallback-note")).toContainText("已切换到备用模型 anthropic/claude-opus-5-5");
	await expect(page.getByTestId("advisor-badge").first()).toHaveText("1 个阻断项");
	await page.getByTestId("work-summary").click();
	await expect(page.getByTestId("rule-note")).toContainText("已应用规则：ts-set-map");
	await expect(page.getByTestId("job-line")).toContainText("后台任务已完成");
	await expect(page.getByTestId("irc-card")).toContainText("来自 Main 的 IRC 消息");
});

test("rules, fallbacks and IRC messages announced while omp works appear as rows, in order, and merge where omp does", async ({
	page,
}) => {
	ownSession(0xb1, "Live notes probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Live notes probe", "live-notes-probe");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });

	// Rules that arrive one after another are one row, listing both.
	frame({
		type: "ttsr_triggered",
		rules: [{ name: "ts-set-map", description: "Prefer Record for static tables.", content: "long" }],
	});
	const rules = page.getByTestId("rule-note");
	await expect(rules).toHaveCount(1);
	await expect(rules).toContainText("Rule applied: ts-set-map");
	frame({
		type: "ttsr_triggered",
		rules: [{ name: "ts-no-tiny-functions", content: "Inline functions that only wrap one expression." }],
	});
	await expect(rules).toContainText("2 rules applied: ts-set-map, ts-no-tiny-functions");
	await expect(rules).toHaveCount(1);
	await rules.getByRole("button").click();
	await expect(rules).toContainText("Prefer Record for static tables.");
	await expect(rules).toContainText("Inline functions that only wrap one expression.");

	// A fallback shows what omp moved from and to, why, and that it worked.
	frame({
		type: "retry_fallback_applied",
		from: "anthropic/claude-opus-5-5",
		to: "anthropic/claude-sonnet-5-5",
		role: "default",
		reason: "Provider overloaded (529). Switching to the fallback.",
	});
	const fallback = page.getByTestId("fallback-note");
	await expect(fallback).toContainText("Fallback: anthropic/claude-opus-5-5 → anthropic/claude-sonnet-5-5");
	await expect(fallback.getByTestId("fallback-reason")).toHaveText(
		"Provider overloaded (529). Switching to the fallback.",
	);
	frame({ type: "retry_fallback_succeeded", model: "anthropic/claude-sonnet-5-5", role: "default" });
	await expect(page.getByTestId("fallback-ok")).toHaveText("Fallback succeeded on anthropic/claude-sonnet-5-5");

	// IRC messages omp relays are cards, once each however often they are announced.
	const relay = {
		role: "custom",
		customType: "irc:relay",
		content: "[IRC `Scout` → `Main`]\nRELAY-BODY-TEXT",
		details: { from: "Scout", to: "Main", body: "RELAY-BODY-TEXT: found the leak." },
		display: true,
		attribution: "agent",
		timestamp: 1_790_000_000_000,
	};
	frame({ type: "irc_message", message: relay });
	frame({ type: "irc_message", message: relay });
	const irc = page.getByTestId("irc-card");
	await expect(irc).toHaveCount(1);
	await expect(irc).toContainText("IRC Scout → Main");
	await expect(irc).toContainText("RELAY-BODY-TEXT: found the leak.");
	await expect(irc).not.toContainText("[IRC `Scout`");

	// Rows keep the order things happened in.
	const order = await page
		.getByTestId("agent-turn")
		.last()
		.evaluate((turn) =>
			["rule-note", "fallback-note", "fallback-ok", "irc-card"].map((id) => {
				const el = turn.querySelector(`[data-testid="${id}"]`);
				return el ? Array.from(turn.querySelectorAll("[data-testid]")).indexOf(el) : -1;
			}),
		);
	expect(order.every((n) => n >= 0)).toBe(true);
	expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("an advisor card streamed live is a card, and a message omp keeps to itself is not a row", async ({ page }) => {
	ownSession(0xb2, "Live advisor probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Live advisor probe", "live-advisor-probe");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });

	frame({
		type: "message_start",
		messageId: "m-advisor",
		message: {
			role: "custom",
			customType: "advisor",
			content: '<advisory severity="concern" guidance="weigh, don\'t blindly obey">\nLIVE-ADVISOR-TEXT\n</advisory>',
			details: { notes: [{ note: "LIVE-ADVISOR-TEXT: mind the cache.", severity: "concern" }] },
			display: true,
			attribution: "agent",
			timestamp: 1_790_000_000_001,
		},
	});
	frame({
		type: "message_start",
		messageId: "m-hidden",
		message: {
			role: "custom",
			customType: "ttsr-injection",
			content: "HIDDEN-INJECTION-TEXT",
			display: false,
			details: { rules: ["ts-set-map"] },
			attribution: "agent",
			timestamp: 1_790_000_000_002,
		},
	});
	const card = page.getByTestId("advisor-card");
	await expect(card).toContainText("LIVE-ADVISOR-TEXT: mind the cache.");
	await expect(card).toContainText("1 concern");
	await expect(page.getByTestId("agent-turn").last()).not.toContainText("<advisory");
	await expect(page.getByText("HIDDEN-INJECTION-TEXT")).toHaveCount(0);
	await expect(page.getByText("ttsr-injection")).toHaveCount(0);
});
