import { appendFileSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { appReady } from "../support/live.ts";
import {
	answerText,
	type LongConversation,
	type LongTurns,
	longPrompt,
	promptText,
	writeLongConversation,
	writeLongTurns,
} from "../support/long-history.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * What the page shows of the whole conversation while it holds a window that stops short of its end (#590): a search hit,
 * or the stretch left after the far end was let go. The header's cost is the file's, the composer says the model the
 * conversation ends with, no Retry is offered for a failure that is only where the window stops, and the turn the reader
 * is in is not let go when the page above it joins; and on an older branch of the file (the newest branch is another one) the
 * figures are still the whole file's and the composer still shows what omp would resume with. No model call: the
 * conversations are files.
 */

const NEEDLE = "zephyr-needle";
const NEEDLE_TURN = 3;
const COST = "01a00000-0000-7000-8000-00000000fea1";
const TRIMMED = "01a00000-0000-7000-8000-00000000fea4";
const MODEL = "01a00000-0000-7000-8000-00000000fed1";
const RETRY = "01a00000-0000-7000-8000-00000000fec1";
const GIANT = "01a00000-0000-7000-8000-00000000fee1";
const BRANCHED = "01a00000-0000-7000-8000-00000000feb1";
const BRANCH_NEEDLE_TURN = 200;

const made: { file: string }[] = [];
let cost: LongConversation;
let trimmed: LongConversation;
let model: LongConversation;
let retry: LongConversation;
let giant: LongTurns;
let branched: LongConversation;

const withNeedle = (turn: number) => (t: number) =>
	t === turn ? `Where is the ${NEEDLE} in turn ${t}?` : promptText(t);

test.beforeAll(() => {
	const dir = process.env.OMPW_E2E_AGENT_DIR as string;
	const write = (id: string, title: string, turns: number, prompt?: (t: number) => string) => {
		const c = writeLongConversation(dir, { id, turns, title, prompt });
		made.push(c);
		return c;
	};
	cost = write(COST, "Far cost", 300, withNeedle(NEEDLE_TURN));
	trimmed = write(TRIMMED, "Far trimmed", 700);
	// The last hundred turns were answered by another model: a hit before the change must not show the older one.
	model = write(MODEL, "Far model", 300, withNeedle(NEEDLE_TURN));
	writeFileSync(
		model.file,
		readFileSync(model.file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const entry = JSON.parse(line);
				const turn = /^a(\d+)[xy]$/.exec(entry.id)?.[1];
				if (turn !== undefined && Number(turn) >= 200) entry.message.model = "claude-opus-9-9";
				return JSON.stringify(entry);
			})
			.join("\n")
			.concat("\n"),
	);
	// Every turn ends in a failure (a stopped reply): wherever a window stops, the message it stops at is one.
	retry = write(RETRY, "Far retry", 300, withNeedle(150));
	writeFileSync(retry.file, readFileSync(retry.file, "utf8").replaceAll('"stopReason":"stop"', '"stopReason":"error"'));
	giant = writeLongTurns(dir, { id: GIANT, steps: [20, 20, 20, 700, 3, 3, 3], title: "Far giant" });
	made.push(giant);
	// The conversation went on from turn 99 on another branch, newer, that switched to another model: the file's last entry is
	// on it, and the turns of the first branch (the hit is among them) are the older branch.
	branched = write(BRANCHED, "Far branched", 300, withNeedle(BRANCH_NEEDLE_TURN));
	const later = (minute: number) => new Date(Date.UTC(2026, 0, 9, 0, minute)).toISOString();
	const spent = { input: 5, output: 7, cacheRead: 100, cacheWrite: 10, totalTokens: 122, cost: { total: 0.0001 } };
	const branch = [
		{
			type: "model_change",
			id: "mcB",
			parentId: "a99y",
			timestamp: later(1),
			model: "anthropic/claude-opus-9-9",
			role: "default",
		},
		{
			type: "message",
			id: "ub0",
			parentId: "mcB",
			timestamp: later(2),
			message: {
				role: "user",
				content: [{ type: "text", text: "Branch prompt" }],
				attribution: "user",
				timestamp: Date.parse(later(2)),
			},
		},
		{
			type: "message",
			id: "ab0",
			parentId: "ub0",
			timestamp: later(3),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Branch answer" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-9-9",
				usage: spent,
				stopReason: "stop",
				timestamp: Date.parse(later(3)),
			},
		},
	];
	appendFileSync(branched.file, branch.map((l) => `${JSON.stringify(l)}\n`).join(""));
});
test.afterAll(() => {
	for (const c of made) rmSync(c.file, { force: true });
});

const urlOf = (c: { file: string }) => `/#/s/${encodeURIComponent(realpathSync(c.file))}`;

async function openHit(page: Page, title: string) {
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill(NEEDLE);
	const hit = page.getByTestId("search-hit").filter({ hasText: title }).first();
	await expect(hit).toContainText(NEEDLE);
	await hit.click();
}

test("the header's cost at a hit far from the end is the whole file's, once its figures came", async ({ page }) => {
	await page.goto(urlOf(cost));
	await expect(page.getByTestId("transcript").getByText(answerText(299))).toBeVisible();
	const chip = page.getByTestId("session-cost");
	await expect(chip).toContainText("0.06");
	await expect(chip).not.toHaveAttribute("data-partial", "");
	const stats = page.waitForResponse((r) => r.url().includes("view=stats") && r.ok(), { timeout: 30_000 });
	await openHit(page, "Far cost");
	await expect(page.locator(`[data-entry-id="u${NEEDLE_TURN}"]`)).toHaveAttribute("data-focused", "true");
	await stats;
	// A window of forty entries costs a fraction of the file: the chip is the file's, not the window's.
	await expect.poll(async () => Number(await chip.getAttribute("data-cost")), { timeout: 15_000 }).toBeCloseTo(0.06, 3);
	await expect(chip).not.toHaveAttribute("data-partial", "");
});

test("the header's cost is the whole file's after the far end was let go", async ({ page }) => {
	test.setTimeout(180_000);
	await page.goto(urlOf(trimmed));
	await expect(page.getByTestId("transcript").getByText(answerText(699))).toBeVisible();
	await expect(page.getByTestId("session-cost")).toContainText("0.14");
	await page.getByTestId("show-first").click();
	await expect(page.getByTestId("show-earlier")).toHaveCount(0, { timeout: 60_000 });
	await expect(page.getByTestId("transcript").getByText(promptText(0))).toBeVisible();
	const chip = page.getByTestId("session-cost");
	await expect.poll(async () => Number(await chip.getAttribute("data-cost")), { timeout: 15_000 }).toBeCloseTo(0.14, 3);
});

test("the composer at a hit before the model changed shows the model the conversation ends with", async ({ page }) => {
	await page.goto(urlOf(model));
	await expect(page.getByTestId("transcript").getByText(answerText(299))).toBeVisible();
	await expect(page.getByTestId("model-picker")).toContainText("opus");
	await openHit(page, "Far model");
	await expect(page.locator(`[data-entry-id="u${NEEDLE_TURN}"]`)).toHaveAttribute("data-focused", "true");
	await expect(page.getByTestId("model-picker")).toContainText("opus");
});

test("Retry is the end of the conversation's, not of a window that stops at a failed turn", async ({ page }) => {
	await page.goto(urlOf(retry));
	await expect(page.getByTestId("transcript").getByText(answerText(299))).toBeVisible();
	await expect(page.getByTestId("retry-button")).toHaveCount(1);
	await page.route(/view=after/, () => {});
	await openHit(page, "Far retry");
	await expect(page.locator('[data-entry-id="u150"]')).toHaveAttribute("data-focused", "true");
	await page.waitForTimeout(1500);
	// Reveal what is held below the hit, up to the window's last message.
	const later = page.getByTestId("show-later");
	for (
		let i = 0;
		i < 20 && /Show later/.test((await later.textContent({ timeout: 3000 }).catch(() => "")) ?? "");
		i++
	) {
		await later.click();
		await page.waitForTimeout(150);
	}
	await page.waitForTimeout(500);
	expect(await page.getByTestId("retry-button").count(), "Retry offered mid-conversation").toBe(0);
});

/** The older branch of the branched conversation: the hit is on it; then the pages below it, to the end of that branch. */
async function openOlderBranchEnd(page: Page) {
	await openHit(page, "Far branched");
	await expect(page.locator(`[data-entry-id="u${BRANCH_NEEDLE_TURN}"]`)).toHaveAttribute("data-focused", "true");
	const later = page.getByTestId("show-later");
	for (let i = 0; i < 60 && (await later.count()) > 0; i++) {
		await later.click().catch(() => {});
		await page.waitForTimeout(200);
	}
	await expect(later).toHaveCount(0);
	await expect(page.getByTestId("transcript").getByText(answerText(299))).toBeVisible();
}

test("the header's cost on an older branch is the whole file's, at a hit and at the branch's end", async ({ page }) => {
	await openHit(page, "Far branched");
	await expect(page.locator(`[data-entry-id="u${BRANCH_NEEDLE_TURN}"]`)).toHaveAttribute("data-focused", "true");
	const chip = page.getByTestId("session-cost");
	await expect.poll(async () => Number(await chip.getAttribute("data-cost")), { timeout: 15_000 }).toBeCloseTo(0.06, 3);
	await expect(chip).not.toHaveAttribute("data-partial", "");
	// The window reaches the leaf of the branch, which is not the file's last entry: the figures are still the file's.
	await openOlderBranchEnd(page);
	await expect.poll(async () => Number(await chip.getAttribute("data-cost")), { timeout: 15_000 }).toBeCloseTo(0.06, 3);
	await expect(chip).not.toHaveAttribute("data-partial", "");
});

test("the composer on an older branch shows the model of the file's last entry, which omp resumes with", async ({
	page,
}) => {
	await openHit(page, "Far branched");
	await expect(page.locator(`[data-entry-id="u${BRANCH_NEEDLE_TURN}"]`)).toHaveAttribute("data-focused", "true");
	await expect(page.getByTestId("model-picker")).toContainText("opus");
	await openOlderBranchEnd(page);
	await expect(page.getByTestId("model-picker")).toContainText("opus");
});

test("the long turn a reader is going up through is not let go when the page above it joins", async ({ page }) => {
	test.setTimeout(180_000);
	const before = { count: 0 };
	page.on("request", (r) => {
		const u = new URL(r.url());
		if (u.pathname === "/api/family" && u.searchParams.get("view") === "before") before.count++;
	});
	await page.goto(urlOf(giant));
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText("Long run 6 is done.")).toBeVisible();
	await transcript.hover();
	await page.mouse.wheel(0, -40);
	let insideTurn = false;
	let vanishedAt = -1;
	for (let round = 0; round < 600; round++) {
		await page.mouse.wheel(0, -500);
		await page.waitForTimeout(250);
		// One look at the page, not three: pages keep joining while the reader goes up, and three counts made one after another
		// can see the turn's prompt before the page above came and the turn before it after, a turn that never went.
		const { hasPrompt, hasSteps, hasOlder } = await page.evaluate(() => ({
			hasPrompt: document.querySelector('[data-entry-id="u3"]') !== null,
			hasSteps: document.querySelector('[data-segment^="s3_"]') !== null,
			hasOlder: document.querySelector('[data-entry-id="u2"]') !== null,
		}));
		if (hasPrompt || hasSteps) insideTurn = true;
		if (hasOlder && !hasPrompt && insideTurn && vanishedAt < 0) vanishedAt = before.count;
		if (hasOlder && round > 20 && before.count > 0) break;
	}
	expect(insideTurn, "the reader was inside the long turn").toBe(true);
	expect(vanishedAt, "the long turn disappeared while the reader went up out of it").toBe(-1);
	expect(longPrompt(3)).toContain("Long run 3");
});
