import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "../support/fixtures.ts";
import { appReady } from "../support/live.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A conversation of hundreds of turns is tens of thousands of elements; opening it must show the latest messages
 * and leave the rest to "Show earlier messages". No model call: the conversation is a file.
 */

const TURNS = 60;
const SESSION_ID = "01a00000-0000-7000-8000-00000000fe02";
let file: string;

const at = (minute: number) => new Date(Date.UTC(2026, 0, 8, 0, minute)).toISOString();
const usage = { input: 5, output: 7, cacheRead: 100, cacheWrite: 10, totalTokens: 122, cost: { total: 0.0001 } };

/** Turn t: a prompt, an assistant step that runs a tool, its result, and the answer (a list and a code block). */
function turn(t: number, parent: string | null): { lines: Record<string, unknown>[]; last: string } {
	const m = t * 4;
	const prompt =
		t === 3 ? `Where is the zephyr-needle in turn ${t}?` : `Long conversation turn ${t}: what does item ${t} do?`;
	const lines = [
		{
			type: "message",
			id: `u${t}`,
			parentId: parent,
			timestamp: at(m),
			message: {
				role: "user",
				content: [{ type: "text", text: prompt }],
				attribution: "user",
				timestamp: Date.parse(at(m)),
			},
		},
		{
			type: "message",
			id: `a${t}x`,
			parentId: `u${t}`,
			timestamp: at(m + 1),
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: `Looking at item ${t}.` },
					{ type: "toolCall", id: `call${t}`, name: "bash", arguments: { command: `echo item ${t}`, i: `Check ${t}` } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-5-5",
				usage,
				stopReason: "toolUse",
				timestamp: Date.parse(at(m + 1)),
			},
		},
		{
			type: "message",
			id: `r${t}`,
			parentId: `a${t}x`,
			timestamp: at(m + 2),
			message: {
				role: "toolResult",
				toolCallId: `call${t}`,
				toolName: "bash",
				content: [{ type: "text", text: `item ${t}\n` }],
				isError: false,
				timestamp: Date.parse(at(m + 2)),
			},
		},
		{
			type: "message",
			id: `a${t}y`,
			parentId: `r${t}`,
			timestamp: at(m + 3),
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: `Answer ${t}: item ${t} is fine.\n\n- first point about ${t}\n- second point about ${t}\n\n\`\`\`ts\nexport const answer${t}: number = ${t};\n\`\`\`\n`,
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-5-5",
				usage,
				stopReason: "stop",
				timestamp: Date.parse(at(m + 3)),
			},
		},
	];
	return { lines, last: `a${t}y` };
}

test.beforeAll(() => {
	file = join(
		process.env.OMPW_E2E_AGENT_DIR as string,
		"sessions",
		FIXTURE_BUCKET,
		`2026-01-08T00-00-00-000Z_${SESSION_ID}.jsonl`,
	);
	const lines: Record<string, unknown>[] = [
		{ type: "session", version: 3, id: SESSION_ID, timestamp: at(0), cwd: FIXTURE_CWD },
	];
	let parent: string | null = null;
	for (let t = 0; t < TURNS; t++) {
		const made = turn(t, parent);
		lines.push(...made.lines);
		parent = made.last;
	}
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
});
test.afterAll(() => rmSync(file, { force: true }));

const openUrl = () => `/#/s/${encodeURIComponent(realpathSync(file))}`;
const answer = (t: number) => `Answer ${t}: item ${t} is fine.`;

test("a long conversation opens on its latest messages, with a small page", async ({ page }) => {
	await page.goto(openUrl());
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answer(TURNS - 1))).toBeVisible();
	// The latest messages are there, the first are not, and the way to them is.
	await expect(transcript.getByText(answer(TURNS - 10))).toHaveCount(1);
	await expect(transcript.getByText("Long conversation turn 0:")).toHaveCount(0);
	await expect(page.getByTestId("show-earlier")).toContainText(/Show earlier messages \(\d+\)/);
	const elements = await transcript.evaluate((el) => el.getElementsByTagName("*").length);
	// Every message of this conversation would be about six thousand elements.
	expect(elements).toBeLessThan(2500);
});

test("Show earlier messages adds earlier ones above without moving what is being read, until none are left", async ({
	page,
}) => {
	await page.goto(openUrl());
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answer(TURNS - 1))).toBeVisible();
	await transcript.evaluate((el) => {
		el.scrollTop = 0;
	});
	// The page follows the bottom until a scroll event tells it the reader has left: that event comes a frame after the
	// scrolling, and the way back to the bottom shows once it has. Until then a render would take the reader down.
	await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeVisible();
	const more = page.getByTestId("show-earlier");
	await expect(more).toBeVisible();

	// The first message on screen, and where it sits in the window. A row slides in for 180 ms when it mounts
	// (`fade-in`, a 4 px translate that any box read meanwhile includes) and this is read a few dozen ms after the
	// page mounted, so wait for the message to arrive: what must not move is the layout, not the slide.
	const shown = page.getByTestId("msg-user").first();
	await shown.evaluate(async (el) => {
		await Promise.all(el.getAnimations().map((a) => a.finished));
	});
	const entry = await shown.getAttribute("data-entry-id");
	const top = async () => (await page.locator(`[data-entry-id="${entry}"]`).boundingBox())?.y ?? Number.NaN;
	const before = await top();
	const countBefore = await page.getByTestId("msg-user").count();

	await more.click();
	await expect.poll(() => page.getByTestId("msg-user").count()).toBeGreaterThan(countBefore);
	// What was on screen stays where it was; the new messages are above it.
	expect(Math.abs((await top()) - before)).toBeLessThan(3);
	expect(await transcript.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

	// Keep going: the first message of the conversation comes, and the button goes.
	while (await more.isVisible()) await more.click();
	await expect(transcript.getByText("Long conversation turn 0:")).toHaveCount(1);
	await expect(page.getByTestId("msg-user")).toHaveCount(TURNS);
});

test("Go to the first message shows the start of a long conversation in one click, and the latest is one click back", async ({
	page,
}) => {
	await page.goto(openUrl());
	const transcript = page.getByTestId("transcript");
	await expect(transcript.getByText(answer(TURNS - 1))).toBeVisible();
	await page.getByTestId("show-first").click();
	// The first messages are drawn from the top of the view, not the ones the reader was at.
	const first = transcript.getByText("Long conversation turn 0:");
	await expect(first).toBeInViewport();
	expect(await transcript.evaluate((el) => el.scrollTop)).toBe(0);
	await expect(page.getByTestId("show-earlier")).toHaveCount(0);
	await expect(page.getByTestId("show-first")).toHaveCount(0);
	// A window of its own, as a search hit gets: the rest is Show later messages, and the latest is the arrow.
	await expect(page.getByTestId("show-later")).toContainText(/Show later messages \(\d+\)/);
	await expect(transcript.getByText(answer(TURNS - 1))).toHaveCount(0);
	await page.getByRole("button", { name: "Scroll to bottom" }).click();
	await expect(transcript.getByText(answer(TURNS - 1))).toBeVisible();
});

test("a search hit among the earlier messages is shown, scrolled to and highlighted", async ({ page }) => {
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill("zephyr-needle");
	await page.getByTestId("search-hit").first().click();
	const target = page.locator('[data-entry-id="u3"]');
	await expect(target).toHaveAttribute("data-focused", "true");
	await expect(target).toBeInViewport();
	await expect(page.getByTestId("chat-title")).toBeVisible();
	// The messages around it are there to scroll through.
	await expect(page.getByTestId("transcript").getByText(answer(2))).toHaveCount(1);
});
