import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { LiveInfo } from "../../shared/protocol.ts";
import type { Question } from "../../shared/unattended.ts";
import { en } from "../../web/src/i18n/questions.ts";
import { zh } from "../../web/src/i18n/zh-CN/questions.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { openSidebar, startLive } from "../support/live.ts";
import { panelTab } from "../support/panel.ts";
import { choose } from "../support/select.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Unattended mode (#646) as a person meets it: the switch beside the message box (and in New chat), the Questions entry in the
 * sidebar with its count, the page where each question opens to its context and is answered, Settings (the default for new
 * conversations, and what the agent is told), in English and in Chinese, on a desktop and on a phone. No model is called to
 * file a question (that is `tests/contract/unattended*.test.ts`, against the real omp): the list is the server's own file, written
 * here, which the server reads again as it changes. An answer is a real message to a real conversation.
 */

const root = () => process.env.OMPW_E2E_ROOT as string;
const agentDir = () => process.env.OMPW_E2E_AGENT_DIR as string;
const questionsFile = () => join(root(), "data", "questions.json");
const post = { "x-omp-webui": "1" };

let revision = 1_000;
let counter = 0;

/** What the list holds: written whole, as the server writes it (`server/omp/unattended/questions.ts`). */
function writeList(questions: Question[]): void {
	writeFileSync(questionsFile(), JSON.stringify({ rev: ++revision, questions }), { mode: 0o600 });
}

/** The questions a conversation filed, open, the first the oldest. */
function asked(session: string, title: string, asks: Partial<Question>[]): Question[] {
	return asks.map((a, i) => ({
		id: `qe2e${++counter}`,
		session,
		title,
		source: "tool",
		question: `Question ${i + 1}?`,
		context: "",
		options: [],
		askedAt: Date.now() - (asks.length - i) * 60_000,
		state: "open",
		...a,
	}));
}

function seed(session: string, title: string, asks: Partial<Question>[]): Question[] {
	const questions = asked(session, title, asks);
	writeList(questions);
	return questions;
}

/** A conversation of the spec's own: its title, and the key the server names it by. */
function conversation(n: number, title: string): { file: string; key: string; title: string } {
	const file = writeSimpleSession(agentDir(), n, title);
	return { file, key: realpathSync(file), title };
}

const text = (lang: "en" | "zh-CN") => (lang === "en" ? en : zh);

const asLang = async (page: Page, lang: "en" | "zh-CN"): Promise<void> => {
	await page.addInitScript((l) => localStorage.setItem("ompw.lang", l), lang);
};

/** The server's own info for `liveId`, as every page is told it (`tests/e2e/sleep-note.spec.ts` reads it the same way). */
async function liveInfo(page: Page, liveId: string): Promise<LiveInfo> {
	const lives = (await (await page.request.get("/api/lives")).json()) as LiveInfo[];
	const found = lives.find((l) => l.liveId === liveId);
	if (!found) throw new Error(`the server does not list ${liveId}`);
	return found;
}

/** The conversation's Questions tab in the right panel (#693): its name, then the open count when there is one. */
const questionsTab = (page: Page) => panelTab(page, /^(Questions|问题)/);

/** Every conversation's questions: the page, from the palette's Go to (the bars no longer list it, #693). */
async function openQuestionsPage(page: Page): Promise<void> {
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-go-questions").click();
	await expect(page.getByTestId("questions-page")).toBeVisible();
}

/** axe over one region: every rule it has, not only the colours. */
async function axeClean(page: Page, selector: string): Promise<void> {
	const { violations } = await new AxeBuilder({ page }).include(selector).analyze();
	expect(
		violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
		`axe on ${selector}`,
	).toEqual([]);
}

test.afterEach(async ({ page }) => {
	// The worker's server is shared with the specs that run after this one: no questions, the shipped instruction, none by default.
	writeFileSync(questionsFile(), JSON.stringify({ rev: ++revision, questions: [] }), { mode: 0o600 });
	const headers = { ...post, "content-type": "application/json" };
	await page.request.post("/api/unattended", { headers, data: { instruction: null } });
	await page.request.post("/api/prefs", { headers, data: { changes: { "ompw.unattended": null } } });
});

for (const lang of ["en", "zh-CN"] as const) {
	const s = text(lang);

	test(`the conversation's tab counts what waits, the page shows each question with its context, and an answer settles it (${lang})`, async ({
		page,
	}) => {
		const mine = conversation(0x72, `Unattended list ${lang}`);
		const [first] = seed(mine.key, mine.title, [
			{
				question: "Which database should the service use?",
				context: "Postgres is installed here; SQLite is simpler to ship.",
				meanwhile: "Wrote the schema both ways.",
				options: [{ label: "Postgres", description: "what is installed" }, { label: "SQLite" }],
				recommended: 0,
			},
			{ question: "Which port?", source: "ask" },
		]);
		await asLang(page, lang);
		await page.goto(`/#/s/${encodeURIComponent(mine.key)}`);
		await page.getByTestId("toggle-panel").click();
		// The count is the tab's, from the first look: after its name, "Questions 2"; it opens the page of every conversation's.
		await expect(questionsTab(page)).toContainText("2", { timeout: 30_000 });
		await questionsTab(page).click();
		await expect(page.getByTestId("questions-tab").getByTestId("question-row")).toHaveCount(2);
		await page.getByTestId("questions-open-page").click();
		await expect(page.getByTestId("questions-page")).toBeVisible();
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(s.pageTitle);
		const groups = page.getByTestId("questions-group");
		await expect(groups).toHaveCount(1);
		await expect(groups.getByRole("heading", { level: 2 })).toHaveText(mine.title);
		const rows = page.getByTestId("question-row");
		await expect(rows).toHaveCount(2);

		// A question opens to what the agent found and did meanwhile, with its options and a box for words.
		const row = rows.filter({ hasText: first.question });
		await row.getByRole("button", { name: new RegExp(first.question) }).click();
		await expect(row).toContainText(first.context);
		await expect(row).toContainText(first.meanwhile ?? "");
		await expect(row.getByTestId("question-option")).toHaveCount(2);
		await expect(row).toContainText(s.recommended);
		await expect(row).toContainText("what is installed");
		await axeClean(page, '[data-testid="questions-page"]');

		// Nothing is sent without an answer; one option and a note make one.
		const send = row.getByTestId("question-answer-send");
		await expect(send).toBeDisabled();
		await row.getByTestId("question-option").first().check();
		await row.getByTestId("question-text").fill("with pgvector");
		await expect(send).toBeEnabled();
		// Queued behind the turn unless the person steers it in (#703); an idle conversation takes it either way.
		await expect(row.getByTestId("question-delivery-followUp")).toBeChecked();
		await row.getByTestId("question-delivery-steer").check();
		const posted = page.waitForRequest((r) => r.url().endsWith("/api/questions/answer"));
		await send.click();
		expect((await posted).postDataJSON()).toMatchObject({ id: first.id, delivery: "steer" });
		await expect(rows).toHaveCount(1);
		await expect(page.getByTestId("questions-tab-open")).toContainText("1");

		// It is in Done, with what was answered, and the conversation got a message that says so.
		await page.getByTestId("questions-tab-done").click();
		const done = page.getByTestId("question-row");
		await expect(done).toHaveCount(1);
		await done.getByRole("button", { name: new RegExp(first.question) }).click();
		await expect(done.getByTestId("question-answer")).toContainText("Postgres");
		await expect(done.getByTestId("question-answer")).toContainText("with pgvector");
		const list = (await (await page.request.get("/api/questions")).json()) as { questions: Question[] };
		expect(list.questions.find((q) => q.id === first.id)).toMatchObject({
			state: "answered",
			answer: { options: ["Postgres"], text: "with pgvector" },
		});
		await page.goto(`/#/s/${encodeURIComponent(mine.key)}`);
		// In the transcript (the other language's run answered this conversation too, and a steer waits in its queue while
		// a turn runs).
		await expect(
			page.getByTestId("transcript").getByText(`Answer to your question "${first.question}":`).first(),
		).toBeVisible({ timeout: 60_000 });
	});

	test(`a question can be dismissed, and the filter keeps to one conversation (${lang})`, async ({ page }) => {
		const a = conversation(0x73, `Unattended A ${lang}`);
		const b = conversation(0x74, `Unattended B ${lang}`);
		writeList([
			...asked(a.key, a.title, [{ question: "A asks?" }]),
			...asked(b.key, b.title, [{ question: "B asks?" }]),
		]);
		await asLang(page, lang);
		await page.goto("/#/questions");
		await expect(page.getByTestId("question-row")).toHaveCount(2, { timeout: 30_000 });
		await choose(page.getByTestId("questions-scope"), { label: b.title });
		await expect(page.getByTestId("question-row")).toHaveCount(1);
		const row = page.getByTestId("question-row");
		await row.getByRole("button", { name: /B asks\?/ }).click();
		await row.getByTestId("question-dismiss").click();
		await expect(page.getByTestId("question-row")).toHaveCount(0);
		await page.getByTestId("questions-tab-done").click();
		await expect(page.getByTestId("question-row")).toHaveCount(1);
		await expect(page.getByTestId("question-row")).toHaveAttribute("data-state", "dismissed");
		await expect(page.getByTestId("question-row").getByText(s.stateDismissed)).toBeVisible();
	});

	test(`the switch beside the message box turns one conversation unattended, and the chip opens its questions (${lang})`, async ({
		page,
	}) => {
		const mine = conversation(0x75, `Unattended switch ${lang}`);
		await asLang(page, lang);
		const tap = await tapSocket(page);
		await page.goto("/");
		await openSidebar(page);
		const liveId = await startLive(page, tap, mine.title, "unattended-switch-probe");
		const toggle = page.getByTestId("unattended-toggle");
		await expect(toggle).toBeVisible({ timeout: 30_000 });
		await expect(toggle).toHaveAttribute("role", "switch");
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		await expect(toggle).toHaveAccessibleName(s.toggleLabel);
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		const kept = async () =>
			(await (await page.request.get(`/api/unattended/session?live=${liveId}`)).json()) as {
				on: boolean;
				unattended: { live: boolean } | null;
			};
		// The process carries the instruction (its extension said so), and the choice is kept with the conversation.
		await expect.poll(async () => (await kept()).unattended?.live).toBe(true);
		expect(
			(
				(await (await page.request.get(`/api/unattended/session?file=${encodeURIComponent(mine.key)}`)).json()) as {
					on: boolean;
				}
			).on,
		).toBe(true);
		await axeClean(page, '[data-testid="composer-footer"]');

		// Questions it has waiting are a chip in the footer; the chip opens the conversation's Questions tab (#693).
		seed(mine.key, mine.title, [{ question: "Chip question?" }, { question: "Another?" }]);
		await page.reload();
		const chip = page.getByTestId("unattended-chip");
		await expect(chip).toContainText(lang === "en" ? "2 open" : "2 个待回答", { timeout: 30_000 });
		await chip.click();
		const tab = page.getByTestId("questions-tab");
		await expect(tab).toBeVisible();
		await expect(tab.getByTestId("question-row")).toHaveCount(2);
		await axeClean(page, '[data-testid="questions-tab"]');
		// Its button opens the page, scoped to this conversation.
		await tab.getByTestId("questions-open-page").click();
		await expect(page.getByTestId("questions-page")).toBeVisible();
		await expect(page.getByTestId("questions-scope")).toHaveAttribute("data-value", mine.key);
		await expect(page.getByTestId("question-row")).toHaveCount(2);

		// Back to the conversation, the switch is still on; turned off, the questions stay in the list.
		await page.goto(`/#/s/${encodeURIComponent(mine.key)}`);
		await expect(page.getByTestId("unattended-toggle")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
		await page.getByTestId("unattended-toggle").click();
		await expect(page.getByTestId("unattended-toggle")).toHaveAttribute("aria-checked", "false");
		await expect.poll(async () => (await kept()).unattended).toBeNull();
		await expect(page.getByTestId("unattended-chip")).toBeVisible();
	});
}

test("New chat's switch is off until it is turned on, and what it says is what the next process starts with", async ({
	page,
}) => {
	const tap = await tapSocket(page);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	const toggle = page.getByTestId("unattended-toggle");
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	const opens = () => tap.sent.filter((m) => m.t === "open");
	expect(opens()[0]?.target?.unattended).toBe(false);
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	// A process started after the pick is started with it.
	await page.getByRole("button", { name: /^Options/ }).click();
	const field = page.locator('[data-flag="--append-system-prompt"]');
	await field.fill("kept");
	await field.press("Enter");
	await expect.poll(() => opens().length).toBe(2);
	expect(opens()[1]?.target?.unattended).toBe(true);
	await expect(page.getByTestId("unattended-toggle")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
});

for (const lang of ["en", "zh-CN"] as const) {
	const s = text(lang);

	test(`Settings: the default for new conversations, and what the agent is told, edited and restored (${lang})`, async ({
		page,
	}) => {
		const tap = await tapSocket(page);
		await asLang(page, lang);
		await page.goto("/#/settings/safety");
		const card = page.getByTestId("unattended-settings");
		await expect(card).toBeVisible({ timeout: 60_000 });
		await expect(card).toContainText(s.settingsTitle);
		const instruction = card.getByTestId("unattended-instruction");
		await expect(instruction).toContainText("The person is away", { timeout: 30_000 });
		await expect(card.getByTestId("unattended-instruction-state")).toHaveText(s.instructionShipped);
		await expect(card.getByTestId("unattended-save")).toBeDisabled();
		await expect(card.getByTestId("unattended-restore")).toBeDisabled();

		await instruction.fill("CUSTOM-E2E-INSTRUCTION: file everything.");
		await card.getByTestId("unattended-save").click();
		await expect(card.getByTestId("unattended-instruction-state")).toHaveText(s.instructionEdited);
		await expect(card).toContainText(s.saved);
		const stored = JSON.parse(readFileSync(join(root(), "data", "unattended.json"), "utf8")) as { instruction: string };
		expect(stored.instruction).toBe("CUSTOM-E2E-INSTRUCTION: file everything.");
		await axeClean(page, '[data-testid="unattended-settings"]');
		await card.getByTestId("unattended-restore").click();
		await expect(card.getByTestId("unattended-instruction-state")).toHaveText(s.instructionShipped);
		await expect(instruction).toContainText("The person is away");

		// The default: a conversation started from New chat begins unattended, its switch on.
		await card.getByTestId("unattended-default").check();
		await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
		await page.goto("/");
		await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByTestId("unattended-toggle")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
		expect(tap.sent.findLast((m) => m.t === "open")?.target?.unattended).toBe(true);
	});
}

test("a question that could not be kept is a warning row in the conversation, and the Questions page says so under it", async ({
	page,
}) => {
	const mine = conversation(0x77, "Unattended lost question");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	const liveId = await startLive(page, tap, mine.title, "unattended-dropped-probe");
	// The process's own state, as the server tells every page (`LiveInfo.questionDropped`; its contract is
	// tests/contract/unattended.test.ts): no model is called here.
	tap.push({
		t: "live",
		info: {
			...(await liveInfo(page, liveId)),
			questionDropped: { why: "full", question: "The sixty-first?", at: Date.now() },
		},
	});
	const note = page.getByTestId("question-dropped-note");
	await expect(note).toBeVisible();
	await expect(note).toHaveAttribute("data-why", "full");
	await expect(note).toContainText("A question was not kept: the list is full");
	await expect(page.getByTestId("question-dropped-question")).toContainText("The sixty-first?");

	// The list says which conversation lost some, from what the server keeps of them (no page has to have been open).
	await page.route("**/api/questions", async (route) => {
		const real = (await (await route.fetch()).json()) as Record<string, unknown>;
		return route.fulfill({
			json: {
				...real,
				dropped: [{ seq: 1, session: mine.key, why: "full", question: "The sixty-first?", at: Date.now() }],
			},
		});
	});
	seed(mine.key, mine.title, [{ question: "Still here?" }]);
	await page.goto("/#/questions");
	const line = page.getByTestId("questions-dropped");
	await expect(line).toBeVisible({ timeout: 30_000 });
	await expect(line).toHaveAttribute("data-count", "1");
	await expect(line).toContainText("A question was not kept: this conversation has 60 open already.");
});

test("on a phone: the page opens from the palette, a question opens and is answered, and the switch is in reach", async ({
	browser,
	e2eServer,
	workerStorageState,
}) => {
	const mine = conversation(0x76, "Unattended phone");
	seed(mine.key, mine.title, [
		{
			question: "Phone question?",
			context: "Asked while you were away.",
			options: [{ label: "Yes" }, { label: "No" }],
		},
	]);
	const context = await browser.newContext({
		baseURL: e2eServer.url,
		storageState: workerStorageState,
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
		locale: "en-US",
	});
	const page = await context.newPage();
	try {
		await page.goto("/");
		await openQuestionsPage(page);
		const row = page.getByTestId("question-row");
		await row.getByRole("button", { name: /Phone question\?/ }).click();
		await expect(row).toContainText("Asked while you were away.");
		await axeClean(page, '[data-testid="questions-page"]');
		// Nothing runs off the screen sideways.
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		expect(overflow).toBeLessThanOrEqual(0);
		const option = row.getByTestId("question-option").first();
		const box = await option.locator("xpath=ancestor::label").boundingBox();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
		await option.check();
		await row.getByTestId("question-answer-send").click();
		await expect(page.getByTestId("question-row")).toHaveCount(0);
		// Nothing waits any more: the page's Open says so.
		await expect(page.getByTestId("questions-tab-open")).toContainText("(0)");
	} finally {
		await context.close();
	}
});
