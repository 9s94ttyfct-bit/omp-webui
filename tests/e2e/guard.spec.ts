import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import {
	GUARD_LOG_DIR,
	GUARD_LOG_FILE,
	type GuardConfig,
	type GuardDecision,
	newDecisionId,
} from "../../shared/guard.ts";
import { en } from "../../web/src/i18n/guard.ts";
import { zh } from "../../web/src/i18n/zh-CN/guard.ts";
import { zh as panelZh } from "../../web/src/i18n/zh-CN/panel.ts";
import { FIXTURE_BUCKET, FIXTURE_CWD, writeSimpleSession } from "../support/fixtures.ts";
import { panelEn, presetsEn } from "../support/i18n-en.ts";
import { sessionRow, startLive } from "../support/live.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * "Guard dangerous commands" (#609), as the page shows it: Settings › Safety (the three modes, the reviewer, the switch),
 * the log of decisions, the verdict on a tool card and the notice that no reviewer could be reached. The gate itself, which
 * decides inside omp, is tested with the real omp elsewhere; here no model is called. The decisions are written to the
 * decisions file the gates append to, as a gate does: the real server follows that file and tells the page, and the page
 * asks the server for the ones decided before it opened a conversation.
 */

const root = () => process.env.OMPW_E2E_ROOT as string;
const guardFile = () => join(root(), "guard.json");
const logFile = () => join(root(), "data", GUARD_LOG_DIR, GUARD_LOG_FILE);
const POST = { "x-omp-webui": "1" };

/** `{name}` in a string of the app's words, filled in. */
const fill = (text: string, values: Record<string, string>): string =>
	text.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");

/** What `GET /api/guard` says. */
const served = async (page: Page): Promise<GuardConfig> =>
	((await (await page.request.get("/api/guard")).json()) as { config: GuardConfig }).config;
/** What the settings file holds. */
const kept = (): GuardConfig => JSON.parse(readFileSync(guardFile(), "utf8")) as GuardConfig;

const setConfig = (page: Page, config: Partial<GuardConfig>) =>
	page.request.post("/api/guard", { data: config, headers: POST });

// A worker's server is shared by the specs that run after this one: the guard goes back to off, as the harness starts it.
test.beforeEach(async ({ page }) => {
	await setConfig(page, { mode: "reviewer", reviewer: "", askWhenUnavailable: true, askWhenDenied: true });
});
test.afterEach(async ({ page }) => {
	await setConfig(page, { mode: "off", reviewer: "", askWhenUnavailable: true, askWhenDenied: true });
});

let seq = 0;

/** A decision as a gate writes it. */
function decision(over: Partial<GuardDecision> = {}): GuardDecision {
	// Ascending, whatever the clock does between two calls: the log lists newest first.
	const at = Date.now() + ++seq;
	return {
		id: newDecisionId(at),
		at,
		session: "01a00000-0000-7000-8000-000000609999",
		file: "",
		agent: "main",
		subagent: false,
		toolCallId: "",
		tool: "bash",
		kinds: ["privilege"],
		cwd: FIXTURE_CWD,
		intent: "",
		detail: "sudo true",
		mode: "reviewer",
		verdict: "allow",
		by: "reviewer",
		reason: "Looks routine.",
		model: "anthropic/claude-haiku-5-5",
		tried: ["anthropic/claude-haiku-5-5"],
		usage: { input: 410, output: 32, cacheRead: 0, cacheWrite: 0, cost: 0.0012, requests: 1 },
		ms: 1800,
		...over,
	};
}

/** Write decisions to the file the gates append to: the server hears of them within a second. */
function decided(...ds: GuardDecision[]): void {
	mkdirSync(dirname(logFile()), { recursive: true });
	appendFileSync(logFile(), `${ds.map((d) => JSON.stringify(d)).join("\n")}\n`);
}

async function openSettings(page: Page, lang = "en"): Promise<void> {
	await page.addInitScript((l) => localStorage.setItem("ompw.lang", l), lang);
	await page.goto("/#/settings/safety");
}

const card = (page: Page) => page.getByTestId("guard-settings");

// ------------------------------------------------------------------ the setting

test("the card shows the three choices, Reviewer model first chosen, and each change is sent at once and kept", async ({
	page,
}) => {
	await openSettings(page);
	await expect(card(page)).toBeVisible();
	await expect(card(page)).toContainText(en.title);
	await expect(card(page)).toContainText(en.guardTitle);
	await expect(page.getByTestId("guard-mode-reviewer")).toBeChecked();
	await expect(page.getByTestId("guard-mode-off")).not.toBeChecked();
	await expect(page.getByTestId("guard-mode-ask")).not.toBeChecked();
	await expect(page.getByTestId("guard-reviewer")).toBeVisible();
	await expect(page.getByTestId("guard-ask-unavailable")).toHaveAttribute("aria-checked", "true");

	// Ask me: no reviewer to choose.
	await page.getByTestId("guard-mode-ask").check();
	await expect(page.getByTestId("guard-status")).toHaveAttribute("data-state", "saved");
	await expect(page.getByTestId("guard-reviewer")).toHaveCount(0);
	await expect(page.getByTestId("guard-ask-unavailable")).toHaveCount(0);
	expect((await served(page)).mode).toBe("ask");
	expect(kept().mode).toBe("ask");

	// Off: none either.
	await page.getByTestId("guard-mode-off").check();
	await expect(page.getByTestId("guard-mode-off")).toBeChecked();
	await expect(page.getByTestId("guard-reviewer")).toHaveCount(0);
	expect((await served(page)).mode).toBe("off");
	expect(kept().mode).toBe("off");

	// Back to the reviewer: name one by typing it, then take it back to automatic.
	await page.getByTestId("guard-mode-reviewer").check();
	const picker = page.getByTestId("guard-reviewer");
	await expect(picker).toHaveAccessibleName(`${en.reviewerLabel}: ${en.reviewerBlank}`);
	await picker.click();
	await page.getByPlaceholder(presetsEn.searchModels).fill("anthropic/claude-haiku-5-5,openai/gpt-5-mini");
	await page
		.getByRole("option", { name: fill(presetsEn.useCustom, { value: "anthropic/claude-haiku-5-5,openai/gpt-5-mini" }) })
		.click();
	await expect(picker).toContainText("anthropic/claude-haiku-5-5,openai/gpt-5-mini");
	await expect.poll(async () => (await served(page)).reviewer).toBe("anthropic/claude-haiku-5-5,openai/gpt-5-mini");
	expect(kept().reviewer).toBe("anthropic/claude-haiku-5-5,openai/gpt-5-mini");

	await page.getByTestId("guard-ask-unavailable").click();
	await expect(page.getByTestId("guard-ask-unavailable")).toHaveAttribute("aria-checked", "false");
	await expect.poll(async () => (await served(page)).askWhenUnavailable).toBe(false);
	await page.getByTestId("guard-ask-denied").click();
	await expect(page.getByTestId("guard-ask-denied")).toHaveAttribute("aria-checked", "false");
	await expect.poll(async () => (await served(page)).askWhenDenied).toBe(false);
	expect(kept()).toEqual({
		mode: "reviewer",
		reviewer: "anthropic/claude-haiku-5-5,openai/gpt-5-mini",
		askWhenUnavailable: false,
		askWhenDenied: false,
	});

	// What was chosen is there after a reload.
	await page.reload();
	await expect(page.getByTestId("guard-mode-reviewer")).toBeChecked();
	await expect(page.getByTestId("guard-reviewer")).toContainText("anthropic/claude-haiku-5-5,openai/gpt-5-mini");
	await expect(page.getByTestId("guard-ask-unavailable")).toHaveAttribute("aria-checked", "false");
	await expect(page.getByTestId("guard-ask-denied")).toHaveAttribute("aria-checked", "false");

	// Automatic again: the explicit blank choice.
	await page.getByTestId("guard-reviewer").click();
	await page.getByTestId("guard-reviewer-blank").click();
	await expect(page.getByTestId("guard-reviewer")).toContainText(en.reviewerBlank);
	await expect.poll(async () => (await served(page)).reviewer).toBe("");
	expect(kept().reviewer).toBe("");
});

test("a change the server refuses is said, and the card stays as the server has it", async ({ page }) => {
	await openSettings(page);
	await expect(page.getByTestId("guard-mode-reviewer")).toBeChecked();
	await page.route("**/api/guard", async (route) => {
		if (route.request().method() === "POST")
			return route.fulfill({ status: 400, json: { error: "The reviewer is not a model name" } });
		return route.continue();
	});
	await page.getByTestId("guard-mode-ask").click();
	await expect(page.getByTestId("guard-error")).toContainText(
		fill(en.saveFailed, { error: "The reviewer is not a model name" }),
	);
	await expect(page.getByTestId("guard-mode-reviewer")).toBeChecked();
	expect((await served(page)).mode).toBe("reviewer");
});

test("a change made in another tab arrives on this one", async ({ page, context }) => {
	await openSettings(page);
	await expect(page.getByTestId("guard-mode-reviewer")).toBeChecked();
	const other = await context.newPage();
	await other.goto("/#/settings/safety");
	await expect(other.getByTestId("guard-mode-reviewer")).toBeChecked();
	await other.getByTestId("guard-mode-ask").check();
	await expect(page.getByTestId("guard-mode-ask")).toBeChecked();
	await expect(page.getByTestId("guard-reviewer")).toHaveCount(0);
});

test("on a page that came through the tunnel there is no Safety section, and nothing is asked of /api/guard", async ({
	page,
}) => {
	const asked: string[] = [];
	page.on("request", (r) => {
		if (new URL(r.url()).pathname.startsWith("/api/guard")) asked.push(r.url());
	});
	await page.route("**/api/meta", async (route) => {
		const real = await (await route.fetch()).json();
		return route.fulfill({ json: { ...real, remote: true } });
	});
	await page.goto("/#/settings/safety");
	await expect(page.getByTestId("settings-page")).toBeVisible();
	await expect(page.getByTestId("approval-settings")).toBeVisible();
	await expect(card(page)).toHaveCount(0);
	expect(asked).toEqual([]);
});

// ------------------------------------------------------------------ the log

test("the log is closed until asked for, lists the decisions newest first, shows the exact call as text, and follows live", async ({
	page,
}) => {
	const tag = `LOG-${Date.now()}`;
	const hostile = `echo ${tag} <img src=x onerror="window.__guardHtml=1"> <b>bold</b>`;
	decided(
		decision({ detail: `first ${tag}`, tool: "bash", reason: `Routine ${tag}` }),
		decision({
			detail: hostile,
			verdict: "deny",
			reason: `Writes <script>window.__guardHtml=1</script> outside the project ${tag}`,
			kinds: ["write_outside", "shell_out"],
			intent: "clean up",
			usage: { input: 12_500, output: 40, cacheRead: 0, cacheWrite: 0, cost: 0.0345, requests: 1 },
		}),
	);
	await openSettings(page);
	await expect(page.getByTestId("guard-log")).toHaveCount(0);
	await page.getByTestId("guard-open-page").click();
	await expect(page.getByTestId("guard-log")).toBeVisible();
	const mine = page.getByTestId("guard-log-row").filter({ hasText: tag });
	await expect(mine).toHaveCount(2);

	// Newest first, with what the person needs to judge it.
	const denied = mine.nth(0);
	await expect(denied).toHaveAttribute("data-verdict", "deny");
	await expect(denied.getByTestId("guard-log-chip")).toHaveText(en.chipDenied);
	await expect(denied).toContainText("bash");
	await expect(denied).toContainText(en.logAgentMain);
	await expect(denied).toContainText(panelEn.reqRisk_write_outside);
	await expect(denied).toContainText(panelEn.reqRisk_shell_out);
	await expect(denied).toContainText("anthropic/claude-haiku-5-5");
	await expect(denied).toContainText("12.5k in");
	await expect(denied).toContainText("$0.03");
	await expect(denied).toContainText("1.8 s");
	await expect(denied).toContainText(`<script>window.__guardHtml=1</script>`);
	await expect(mine.nth(1).getByTestId("guard-log-chip")).toHaveText(en.chipAllowed);

	// The exact call: its own box, as text.
	await expect(denied.getByTestId("guard-log-call")).toHaveCount(0);
	await denied.getByTestId("guard-log-call-toggle").click();
	await expect(denied.getByTestId("guard-log-call")).toHaveText(hostile);
	await expect(denied).toContainText(fill(en.logIntent, { intent: "clean up" }));
	expect(await page.evaluate(() => Reflect.get(window, "__guardHtml"))).toBeUndefined();
	await expect(page.getByTestId("guard-log").locator("img, script, b")).toHaveCount(0);

	// A decision made while the log is open is its first row.
	const liveTag = `${tag}-live`;
	decided(
		decision({
			detail: `live ${liveTag}`,
			reason: `Decided by you ${liveTag}`,
			by: "person",
			verdict: "allow",
			model: undefined,
			usage: undefined,
		}),
	);
	const live = page.getByTestId("guard-log-row").filter({ hasText: liveTag });
	await expect(live).toHaveCount(1, { timeout: 15_000 });
	await expect(live.getByTestId("guard-log-chip")).toHaveText(en.chipYouAllowed);
	await expect(page.getByTestId("guard-log-row").first()).toContainText(liveTag);

	// The Settings card keeps a link and a line, not the log.
	await page.getByTestId("guard-page-settings").click();
	await expect(page.getByTestId("guard-log")).toHaveCount(0);
	await expect(page.getByTestId("guard-summary-line")).toBeVisible();
});

test("a log with nothing in it says so", async ({ page }) => {
	await page.route("**/api/guard/log**", (route) => route.fulfill({ json: { decisions: [], total: 0 } }));
	await openSettings(page);
	await page.getByTestId("guard-open-page").click();
	await expect(page.getByTestId("guard-log-empty")).toHaveText(en.logEmpty);
	// One message, not that and a count of nothing above it.
	await expect(page.getByTestId("guard-log-count")).toHaveText("");
});

// ------------------------------------------------------------------ the tool card

const SESSION_ID = "01a00000-0000-7000-8000-000000609001";
const PROMPT = "Guard fixture: what was decided about my commands";
const ANSWER = "Guard fixture answered.";
const stamp = (minute: number) => new Date(Date.UTC(2026, 0, 8, 10, minute)).toISOString();
const CALLS = ["guard_allow", "guard_deny", "guard_unavailable", "guard_person"] as const;

/** A conversation with four tool calls (their ids are what the decisions name), then the answer. */
function writeSession(agentDir: string): string {
	const dir = join(agentDir, "sessions", FIXTURE_BUCKET);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-01-08T10-00-00-000Z_${SESSION_ID}.jsonl`);
	const entries: Record<string, unknown>[] = [
		{ type: "session", version: 3, id: SESSION_ID, timestamp: stamp(0), cwd: FIXTURE_CWD },
		{
			type: "message",
			id: "e0000001",
			parentId: null,
			timestamp: stamp(1),
			message: {
				role: "user",
				content: [{ type: "text", text: PROMPT }],
				attribution: "user",
				timestamp: Date.parse(stamp(1)),
			},
		},
	];
	let parent = "e0000001";
	for (const [i, toolCallId] of CALLS.entries()) {
		const call = `e00000${i}a`;
		const result = `e00000${i}b`;
		entries.push(
			{
				type: "message",
				id: call,
				parentId: parent,
				timestamp: stamp(2 + i),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: `step ${toolCallId}` } }],
					provider: "anthropic",
					model: "claude-haiku-5-5",
					stopReason: "toolUse",
					timestamp: Date.parse(stamp(2 + i)),
				},
			},
			{
				type: "message",
				id: result,
				parentId: call,
				timestamp: stamp(2 + i),
				message: {
					role: "toolResult",
					toolCallId,
					toolName: "bash",
					content: [{ type: "text", text: `ran ${i}` }],
					isError: false,
					timestamp: Date.parse(stamp(2 + i)),
				},
			},
		);
		parent = result;
	}
	entries.push({
		type: "message",
		id: "e0000010",
		parentId: parent,
		timestamp: stamp(9),
		message: {
			role: "assistant",
			content: [{ type: "text", text: ANSWER }],
			provider: "anthropic",
			model: "claude-haiku-5-5",
			stopReason: "stop",
			timestamp: Date.parse(stamp(9)),
		},
	});
	writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	// The path omp names in a decision is the canonical one (the temp folder of a Mac is behind a link).
	return realpathSync(file);
}

const verdictOf = (page: Page, toolCallId: string) =>
	page
		.getByTestId("tool-card")
		.filter({ hasText: `step ${toolCallId}` })
		.getByTestId("guard-verdict");

async function openFixtureChat(page: Page): Promise<void> {
	await page.goto("/");
	await page.getByRole("complementary").getByText(PROMPT).click();
	await expect(page.getByText(ANSWER)).toBeVisible();
	await page.getByTestId("work-summary").click();
	await expect(page.getByTestId("tool-card")).toHaveCount(CALLS.length);
}

test("a tool card says what the guard decided: heard live, and read back after a reload", async ({ page }) => {
	const file = writeSession(process.env.OMPW_E2E_AGENT_DIR as string);
	try {
		// Two decided before the page opens the conversation: they come from the server's record of the session.
		decided(
			decision({ session: SESSION_ID, file, toolCallId: "guard_allow", reason: "A routine command." }),
			decision({
				session: SESSION_ID,
				file,
				toolCallId: "guard_deny",
				verdict: "deny",
				reason: "It deletes files outside the project.",
				usage: { input: 300, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.02, requests: 1 },
				ms: 1000,
			}),
		);
		await openFixtureChat(page);
		const allowed = verdictOf(page, "guard_allow");
		await expect(allowed).toHaveText("Reviewer allowed · claude-haiku-5-5 · $0.0012 · 1.8 s");
		await expect(allowed).toHaveAttribute("data-verdict", "allow");
		const denied = verdictOf(page, "guard_deny");
		await expect(denied).toHaveText(
			"Reviewer denied: It deletes files outside the project. · claude-haiku-5-5 · $0.02 · 1.0 s",
		);
		await expect(denied).toHaveAttribute("data-verdict", "deny");
		await expect(verdictOf(page, "guard_unavailable")).toHaveCount(0);

		// Two decided while the page is on it: pushed over the socket.
		decided(
			decision({
				session: SESSION_ID,
				file,
				toolCallId: "guard_unavailable",
				verdict: "unavailable",
				reason: "The reviewer timed out.",
				model: "anthropic/claude-haiku-5-5",
				usage: undefined,
				ms: 0,
			}),
			decision({
				session: SESSION_ID,
				file,
				toolCallId: "guard_person",
				by: "person",
				verdict: "deny",
				reason: "Refused by you.",
				model: undefined,
				usage: undefined,
				mode: "ask",
			}),
		);
		const unavailable = verdictOf(page, "guard_unavailable");
		await expect(unavailable).toHaveText(`${en.cardUnavailable} · claude-haiku-5-5`, { timeout: 15_000 });
		await expect(unavailable).toHaveAttribute("data-verdict", "unavailable");
		const person = verdictOf(page, "guard_person");
		await expect(person).toHaveText(en.cardYouDenied);
		await expect(person).toHaveAttribute("data-by", "person");

		// After a reload the same four are read back from the server.
		await page.reload();
		await page.getByRole("complementary").getByText(PROMPT).click();
		await page.getByTestId("work-summary").click();
		await expect(page.getByTestId("guard-verdict")).toHaveCount(CALLS.length);
		await expect(verdictOf(page, "guard_allow")).toHaveText("Reviewer allowed · claude-haiku-5-5 · $0.0012 · 1.8 s");
		await expect(verdictOf(page, "guard_unavailable")).toHaveAttribute("data-verdict", "unavailable");
		await expect(verdictOf(page, "guard_person")).toHaveText(en.cardYouDenied);

		// A call the guard allowed on its own word, and one it refused, say so.
		decided(
			decision({
				session: SESSION_ID,
				file,
				toolCallId: "guard_person",
				by: "person",
				verdict: "allow",
				mode: "ask",
				reason: "",
			}),
		);
		await expect(verdictOf(page, "guard_person")).toHaveText(en.cardYouAllowed, { timeout: 15_000 });

		// On a phone the line wraps; the cost and time that end it stay together, never "· 1.8 s" on a line of its own.
		await page.setViewportSize({ width: 300, height: 700 });
		const tail = verdictOf(page, "guard_allow").locator(".whitespace-nowrap");
		await expect(tail).toHaveText("$0.0012 · 1.8 s");
		// The tail is drawn as one rectangle per text run: they are all on one line.
		const tops = await tail.evaluate((el) => [...new Set([...el.getClientRects()].map((r) => Math.round(r.top)))]);
		expect(tops, "the tail is on one line").toHaveLength(1);
	} finally {
		rmSync(file, { force: true });
	}
});

test("a guard's own refusal says who refused", async ({ page }) => {
	const file = writeSession(process.env.OMPW_E2E_AGENT_DIR as string);
	try {
		decided(
			decision({
				session: SESSION_ID,
				file,
				toolCallId: "guard_deny",
				by: "guard",
				verdict: "deny",
				model: undefined,
				usage: undefined,
				reason: "It names the guard's own files.",
			}),
		);
		await openFixtureChat(page);
		await expect(verdictOf(page, "guard_deny")).toHaveText(
			fill(en.cardGuardRefused, { reason: "It names the guard's own files." }),
		);
	} finally {
		rmSync(file, { force: true });
	}
});

// ------------------------------------------------------------------ no reviewer could be reached

let own = 0;

/** Open a conversation of the spec's own, and say which file it is (what the decisions made in it name). */
async function openOwnChat(page: Page): Promise<string> {
	const title = `Guard notice ${++own}`;
	const file = realpathSync(writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0x609 + own, title));
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto("/");
	await expect(sessionRow(page, title)).toHaveCount(1, { timeout: 15_000 });
	await sessionRow(page, title).click();
	await expect(page.getByTestId("transcript")).toBeVisible();
	return file;
}

const notice = (page: Page) => page.getByTestId("guard-unavailable-notice");
const unreachable = (file: string, reason: string) =>
	decision({ file, verdict: "unavailable", reason, usage: undefined, ms: 0 });

test("when no reviewer can be reached a notice says so, can be dismissed, and goes when the next decision comes", async ({
	page,
}) => {
	const file = await openOwnChat(page);
	await expect(notice(page)).toHaveCount(0);
	decided(unreachable(file, "Every reviewer timed out <b>x</b>."));
	await expect(notice(page)).toBeVisible({ timeout: 15_000 });
	await expect(notice(page)).toContainText(en.noticeTitle);
	await expect(notice(page)).toContainText("Every reviewer timed out <b>x</b>.");
	await expect(notice(page).locator("b")).toHaveCount(0);

	// Dismissed.
	await page.getByTestId("guard-notice-dismiss").click();
	await expect(notice(page)).toHaveCount(0);

	// Again, until the next decision: a reviewer's verdict ends it...
	decided(unreachable(file, "Still no reviewer."));
	await expect(notice(page)).toBeVisible({ timeout: 15_000 });
	decided(decision({ file, verdict: "allow" }));
	await expect(notice(page)).toHaveCount(0, { timeout: 15_000 });

	// ...and so does a decision of any other kind, such as the guard's own refusal or the person's answer.
	decided(unreachable(file, "No reviewer once more."));
	await expect(notice(page)).toBeVisible({ timeout: 15_000 });
	decided(decision({ file, by: "person", verdict: "deny", mode: "ask", model: undefined, usage: undefined }));
	await expect(notice(page)).toHaveCount(0, { timeout: 15_000 });
});

test("the notice belongs to its conversation: another one does not show it, and a subagent's decision is its conversation's", async ({
	page,
}) => {
	const otherTitle = `Guard other ${own + 1}`;
	const other = realpathSync(writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0x6f0 + own, otherTitle));
	const here = await openOwnChat(page);
	decided(unreachable(other, "Nobody for the other one."));
	await expect(notice(page)).toHaveCount(0);

	// A subagent's file is beside its conversation's, in a folder named for it: the notice is the conversation's. The other
	// one's was heard first (the log is read in order): it is not what is drawn here.
	const subagent = join(here.replace(/\.jsonl$/, ""), "0-Worker.jsonl");
	decided(unreachable(subagent, "The subagent has nobody."));
	await expect(notice(page)).toBeVisible({ timeout: 15_000 });
	await expect(notice(page)).toContainText("The subagent has nobody.");
	await expect(notice(page)).not.toContainText("Nobody for the other one.");

	// The conversation's own next decision ends it.
	decided(decision({ file: here, verdict: "deny", by: "guard", model: undefined, usage: undefined }));
	await expect(notice(page)).toHaveCount(0, { timeout: 15_000 });

	// The other conversation has its notice when it is opened, and the first one's decision did not end it.
	await sessionRow(page, otherTitle).click();
	await expect(notice(page)).toBeVisible();
	await expect(notice(page)).toContainText("Nobody for the other one.");
	await sessionRow(page, `Guard notice ${own}`).click();
	await expect(notice(page)).toHaveCount(0);
});

test("a mode change takes the notice of every conversation away", async ({ page }) => {
	const file = await openOwnChat(page);
	decided(unreachable(file, "No reviewer."));
	await expect(notice(page)).toBeVisible({ timeout: 15_000 });
	expect((await setConfig(page, { mode: "ask", reviewer: "", askWhenUnavailable: true })).ok()).toBe(true);
	await expect(notice(page)).toHaveCount(0, { timeout: 15_000 });
});

test("the verdicts of a conversation are asked for by its transcript file, not by a session", async ({ page }) => {
	const asked: string[] = [];
	page.on("request", (r) => {
		if (new URL(r.url()).pathname === "/api/guard/decisions") asked.push(new URL(r.url()).search);
	});
	const file = await openOwnChat(page);
	await expect.poll(() => asked.length).toBeGreaterThan(0);
	expect(asked).toContain(`?file=${encodeURIComponent(file)}`);
	expect(asked.filter((q) => q.startsWith("?session="))).toEqual([]);
});

test("Ask me instead switches the mode and clears the notice; the link opens Settings › Safety", async ({ page }) => {
	const file = await openOwnChat(page);
	decided(unreachable(file, "No reviewer."));
	await expect(notice(page)).toBeVisible({ timeout: 15_000 });

	await page.getByTestId("guard-ask-instead").click();
	await expect(notice(page)).toHaveCount(0);
	await expect.poll(async () => (await served(page)).mode).toBe("ask");
	expect(kept().mode).toBe("ask");

	// The same notice again (the mode is Ask me now, but a refusal of the gate says what it says), and its link.
	decided(unreachable(file, "No reviewer again."));
	await expect(notice(page)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("guard-notice-settings").click();
	await expect(page.locator('[data-testid="settings-page-tab"][data-page="safety"]')).toHaveAttribute(
		"aria-current",
		"page",
	);
	await expect(card(page)).toBeVisible();
	await expect(page.getByTestId("guard-mode-ask")).toBeChecked();
	// Changing the mode in Settings takes the notice away with it.
	await page.getByTestId("guard-mode-reviewer").check();
	await expect(page.getByTestId("guard-mode-reviewer")).toBeChecked();
	await page.goBack();
	await expect(notice(page)).toHaveCount(0);
});

// ------------------------------------------------------------------ a conversation the guard does not cover

let uncovered = 0;

/**
 * A conversation whose omp runs, and the means to say what the server says of a process that runs without the gate
 * (`LiveInfo.ungated`: set for a process the server took over, or started without the check; no model is needed).
 * `ungate(kind)` says it now and in every later `live` frame of that process; a process started again is not touched.
 * `say(over)` adds fields to what the process's `live` frames say from now on (paused, asking), the way the server would.
 */
async function ungatedChat(page: Page): Promise<{
	tap: SocketTap;
	liveId: string;
	ungate: (kind: "inherited" | "chosen") => void;
	say: (over: Record<string, unknown>) => void;
}> {
	const title = `Guard uncovered ${++uncovered}`;
	writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0x6a0 + uncovered, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	let ungated: "inherited" | "chosen" | null = null;
	let theirs = "";
	let over: Record<string, unknown> = {};
	const infos = new Map<string, Record<string, unknown>>();
	tap.rewrite((msg) => {
		if (msg.t !== "live") return msg;
		const info = msg.info as Record<string, unknown>;
		infos.set(String(info.liveId), info);
		return ungated && info.liveId === theirs ? { ...msg, info: { ...info, ...over, ungated } } : msg;
	});
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `guard-uncovered-${uncovered}`);
	theirs = liveId;
	return {
		tap,
		liveId,
		ungate: (kind) => {
			ungated = kind;
			tap.push({ t: "live", info: { ...infos.get(liveId), ...over, ungated: kind } });
		},
		say: (next) => {
			over = { ...over, ...next };
			tap.push({ t: "live", info: { ...infos.get(liveId), ...over, ungated } });
		},
	};
}

const ungatedNotice = (page: Page) => page.getByTestId("guard-ungated-notice");

test("a conversation the server took over says it is not covered, ends its idle process, opens again with one click, and the notice goes", async ({
	page,
}) => {
	const { tap, liveId, ungate } = await ungatedChat(page);
	await expect(ungatedNotice(page)).toHaveCount(0);
	ungate("inherited");
	await expect(ungatedNotice(page)).toBeVisible();
	await expect(ungatedNotice(page).locator("p")).toHaveText(en.ungatedInherited);
	await expect(page.getByTestId("guard-ungated-settings")).toHaveCount(0);
	// Idle: nothing to wait for, so the button is there to press and says nothing against it.
	await expect(page.getByTestId("guard-ungated-reopen")).toBeEnabled();
	await expect(page.getByTestId("guard-ungated-reopen-why")).toHaveCount(0);

	// One click: the idle process is ended with the restart (which the server refuses unless it is idle), and the
	// conversation's file is resumed in another, which the server starts with the gate. `close` is never sent.
	const before = tap.sent.length;
	const restarted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/controls/restart");
	await page.getByTestId("guard-ungated-reopen").click();
	const answer = await restarted;
	expect(answer.status()).toBe(200);
	expect(JSON.parse(answer.request().postData() ?? "{}")).toMatchObject({ live: liveId });
	await expect
		.poll(() => tap.sent.slice(before).filter((m) => m.t === "open" && m.target?.kind === "resume").length)
		.toBe(1);
	expect(tap.sent.slice(before).filter((m) => m.t === "close" && m.liveId === liveId)).toEqual([]);
	await expect(ungatedNotice(page)).toHaveCount(0, { timeout: 30_000 });
	await expect(page.getByTestId("transcript")).toBeVisible();
});

test("Open it again is disabled, with the reason, while the conversation works, is paused, asks or waits to retry: nothing is ended", async ({
	page,
}) => {
	const { tap, liveId, ungate, say } = await ungatedChat(page);
	const restarts: string[] = [];
	page.on("request", (r) => {
		if (new URL(r.url()).pathname === "/api/controls/restart") restarts.push(r.url());
	});
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	ungate("inherited");
	const open = page.getByTestId("guard-ungated-reopen");
	const why = page.getByTestId("guard-ungated-reopen-why");
	await expect(open).toBeEnabled();

	/** The button waits, the reason is said, and a click (forced: it is disabled) sends nothing. */
	const waits = async () => {
		await expect(open).toBeDisabled();
		await expect(why).toHaveText(en.ungatedReopenBusy);
		await open.click({ force: true });
	};
	/** Idle again: the button is back and the reason gone. */
	const idle = async () => {
		await expect(open).toBeEnabled();
		await expect(why).toHaveCount(0);
	};

	// Working.
	frame({ type: "agent_start" });
	await waits();
	frame({ type: "agent_end", messages: [] });
	await idle();

	// Paused.
	say({ pausedAt: Date.now() });
	await waits();
	say({ pausedAt: null });
	await idle();

	// Asking: a dialog or an approval waits for the person (the page hears it as the dialog's frame, and the answer ends it).
	frame({
		type: "extension_ui_request",
		id: "ungated-ask-1",
		method: "select",
		title: "Allow tool: bash\nCommand: echo hi",
		options: ["Approve", "Deny"],
	});
	await waits();
	await page.getByTestId("ui-request").getByRole("button", { name: "Deny" }).click();
	await idle();

	// Waiting out a retry (a usage limit's wait is one).
	frame({
		type: "auto_retry_start",
		attempt: 1,
		maxAttempts: 3,
		delayMs: 3_600_000,
		errorMessage: "429 usage limit reached",
	});
	await waits();
	frame({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
	await idle();

	// Nothing was ended, by either way: no restart asked of the server, and the process was never closed.
	expect(restarts).toEqual([]);
	expect(tap.sent.filter((m) => m.t === "close" && m.liveId === liveId)).toEqual([]);
	await expect(ungatedNotice(page)).toBeVisible();
});

test("the notice about an uncovered conversation can be dismissed, and is only there while the guard is on", async ({
	page,
}) => {
	const { ungate } = await ungatedChat(page);
	ungate("inherited");
	await expect(ungatedNotice(page)).toBeVisible();

	// Off: nothing is looked at anyway. On again: the notice is back.
	await setConfig(page, { mode: "off", reviewer: "", askWhenUnavailable: true });
	await expect(ungatedNotice(page)).toHaveCount(0);
	await setConfig(page, { mode: "ask", reviewer: "", askWhenUnavailable: true });
	await expect(ungatedNotice(page)).toBeVisible();

	await page.getByTestId("guard-ungated-dismiss").click();
	await expect(ungatedNotice(page)).toHaveCount(0);
	// Told again (every frame of the process says so), it stays away.
	ungate("inherited");
	await setConfig(page, { mode: "reviewer", reviewer: "", askWhenUnavailable: true });
	await expect(page.getByTestId("composer")).toBeVisible();
	await expect(ungatedNotice(page)).toHaveCount(0);
});

test("a conversation started without the check says its turns are refused, with a way to Settings but none to open it again", async ({
	page,
}) => {
	const { ungate } = await ungatedChat(page);
	ungate("chosen");
	await expect(ungatedNotice(page)).toBeVisible();
	await expect(ungatedNotice(page)).toHaveAttribute("data-kind", "chosen");
	await expect(ungatedNotice(page).locator("p")).toHaveText(en.ungatedChosen);
	await expect(page.getByTestId("guard-ungated-reopen")).toHaveCount(0);
	await page.getByTestId("guard-ungated-settings").click();
	await expect(page.locator('[data-testid="settings-page-tab"][data-page="safety"]')).toHaveAttribute(
		"aria-current",
		"page",
	);
	await expect(card(page)).toBeVisible();
});

test("zh-CN: the notice about an uncovered conversation is in Chinese", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	const { ungate, say } = await ungatedChat(page);
	ungate("inherited");
	await expect(ungatedNotice(page).locator("p")).toHaveText(zh.ungatedInherited);
	await expect(page.getByTestId("guard-ungated-reopen")).toHaveText(zh.ungatedReopen);
	expect(await ungatedNotice(page).innerText()).not.toContain("会话");
	say({ pausedAt: Date.now() });
	await expect(page.getByTestId("guard-ungated-reopen-why")).toHaveText(zh.ungatedReopenBusy);
	expect(zh.ungatedReopenBusy).not.toContain("会话");
});

// ------------------------------------------------------------------ the words

for (const [lang, words] of [
	["en", en],
	["zh-CN", zh],
] as const) {
	test(`${lang}: the card, its log and a verdict are in the page's language, and the card passes axe`, async ({
		page,
	}) => {
		const tag = `WORDS-${lang}-${Date.now()}`;
		decided(decision({ reason: tag, kinds: ["privilege"] }));
		await openSettings(page, lang);
		await expect(card(page)).toContainText(words.title);
		await expect(card(page)).toContainText(words.guardTitle);
		await expect(card(page)).toContainText(words.modeOff);
		await expect(card(page)).toContainText(words.modeReviewer);
		await expect(card(page)).toContainText(words.modeAsk);
		await expect(card(page)).toContainText(words.reviewerBlank);
		await expect(card(page)).toContainText(words.askUnavailable);
		await expect(page.getByTestId("guard-note")).toHaveText(words.note);
		await expect(page.getByTestId("guard-open-page")).toHaveText(words.settingsOpenPage);
		if (lang === "zh-CN") {
			expect(await card(page).innerText()).not.toContain("会话");
			expect(await card(page).innerText()).not.toMatch(/Guard dangerous|Reviewer model/);
		}
		const results = await new AxeBuilder({ page }).include('[data-testid="guard-settings"]').analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
		// The log is on the Guard page now, in the page's language too.
		await page.getByTestId("guard-open-page").click();
		const row = page.getByTestId("guard-log-row").filter({ hasText: tag });
		await row.getByTestId("guard-log-call-toggle").click();
		await expect(row.getByTestId("guard-log-chip")).toHaveText(words.chipAllowed);
		await expect(row).toContainText(lang === "en" ? panelEn.reqRisk_privilege : panelZh.reqRisk_privilege);
	});
}

test("zh-CN: the notice and the verdict on a card are in Chinese", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	const file = await openOwnChat(page);
	decided(unreachable(file, "Timed out."));
	await expect(notice(page)).toContainText(zh.noticeTitle, { timeout: 15_000 });
	await expect(page.getByTestId("guard-ask-instead")).toHaveText(zh.noticeAsk);
	expect(await notice(page).innerText()).not.toContain("会话");
});

test("the Chinese pack has every string of the English one, with the same parameters, and says 对话, never 会话", () => {
	const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
	expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
	for (const key of Object.keys(en) as (keyof typeof en)[]) {
		expect(zh[key].trim(), key).not.toBe("");
		expect(placeholders(zh[key]), key).toEqual(placeholders(en[key]));
		expect(zh[key], key).not.toContain("会话");
	}
	expect(panelZh.reqRisk_shell_out).not.toBe("");
	expect(panelZh.reqRisk_shell_out).not.toContain("会话");
});
