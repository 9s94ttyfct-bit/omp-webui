import { realpathSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { writeChatSession } from "../support/chat-session.ts";
import { startLive } from "../support/live.ts";
import { COUNT_RENDERS, countRendersOf, rendersCounted } from "../support/render-count.ts";
import { type Msg, tapSocket } from "../support/socket-tap.ts";
import { writeTranscript } from "../support/subagent-fixtures.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * A subagent's live view full screen (#573): in the window, over the conversation, as a route of its own; and popped
 * out into a window of its own. No model call: omp's subagent frames are pushed to the page by hand and its
 * `get_subagent_messages` is answered by the spec; two of the subagents are only on disk (finished).
 */

type Frame = Record<string, unknown>;

const lifecycle = (id: string, status: string, extra: Frame = {}): Frame => ({
	type: "subagent_lifecycle",
	payload: { id, agent: "explore", agentSource: "bundled", index: 0, status, ...extra },
});
const progress = (id: string, p: Frame, extra: Frame = {}): Frame => ({
	type: "subagent_progress",
	payload: {
		index: 0,
		agent: "explore",
		agentSource: "bundled",
		task: id,
		progress: { id, status: "running", ...p },
		...extra,
	},
});
const event = (id: string, ev: Frame): Frame => ({ type: "subagent_event", payload: { id, event: ev } });

const text = (t: string) => [{ type: "text", text: t }];
const assistant = (content: unknown[], timestamp: number) => ({
	role: "assistant",
	content,
	provider: "anthropic",
	model: "claude-haiku-5-5",
	timestamp,
});
const record = (id: string, message: Frame) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-01-07T01:00:00.000Z",
	message,
});

/** Each record takes 100 bytes of the pretend transcript, so offsets are easy to read. */
const BYTES = 100;

/** A conversation long enough to scroll, with two finished subagents on disk and one the spec runs by hand. */
async function open(page: Page, n: number, options: { countRenders?: boolean } = {}) {
	const title = `Full screen probe ${n.toString(16)}`;
	const turns = Array.from({ length: 40 }, (_, i) => ({
		prompt: `Question ${i}`,
		reply: `Answer ${i}. ${"The quick brown fox jumps over the lazy dog. ".repeat(6)}`,
	}));
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	// The address names the file as the server lists it, symlinks resolved (the temp directory is one on a Mac).
	const file = realpathSync(writeChatSession(agentDir, { n, title, turns }));
	const artifacts = file.replace(/\.jsonl$/, "");
	writeTranscript(join(artifacts, "Alpha.jsonl"), [5]);
	writeTranscript(join(artifacts, "Beta.jsonl"), [6]);
	if (options.countRenders) await page.addInitScript(COUNT_RENDERS);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `full-screen-probe-${n}`);

	// What omp says of the subagent it runs: Gamma. The others are not its to answer for (they are on disk).
	const transcripts: Record<string, unknown[]> = {
		Gamma: [
			record("u1", { role: "user", content: text("Find the config files"), attribution: "user", timestamp: 1 }),
			record("a1", assistant(text("I will search the tree."), 2)),
		],
	};
	tap.answer("get_subagent_messages", (c) => {
		const records = transcripts[String(c.subagentId)];
		if (!records) return { ok: false, error: `Unknown subagent ${String(c.subagentId)}` };
		const from = Math.min(Number(c.fromByte ?? 0), records.length * BYTES);
		return {
			ok: true,
			data: {
				sessionFile: `/virtual/${String(c.subagentId)}.jsonl`,
				fromByte: from,
				nextByte: records.length * BYTES,
				reset: false,
				entries: records
					.map((r, i) => ({ ...(r as Frame), parentId: i ? (records[i - 1] as Frame).id : null }))
					.slice(from / BYTES),
				messages: [],
			},
		};
	});
	const frame = (f: Frame) => tap.push({ t: "frame", liveId, frame: f } as Msg);
	frame(lifecycle("Gamma", "started", { description: "Find config files" }));
	frame(progress("Gamma", { durationMs: 3000, resolvedModel: "claude-haiku-5-5" }));
	return { tap, liveId, file, frame, transcripts, title };
}

const full = (page: Page) => page.getByTestId("subagent-full");
const detail = (page: Page) => page.getByTestId("subagent-full-detail");
const nameOf = (page: Page) => full(page).getByTestId("subagent-full-name");
const hash = (page: Page) => page.evaluate(() => location.hash);
const historyLength = (page: Page) => page.evaluate(() => history.length);
const focusedIn = (page: Page, root: string) =>
	page.evaluate((id) => document.activeElement?.closest(`[data-testid="${id}"]`) !== null, root);

/** The Agents tab open on the subagent (the panel's own live view), and the way into the full screen from it. */
async function viewInPanel(page: Page, id: string) {
	const panel = page.getByTestId("right-panel");
	if (!(await panel.isVisible())) await page.getByTestId("toggle-panel").click();
	await page.locator(`[data-testid="subagent-item"][data-agent-id="${id}"]`).click();
	await expect(page.getByTestId("subagent-detail")).toHaveAttribute("data-agent-id", id);
}
const enter = (page: Page) => page.getByTestId("subagent-full-enter");
/** Into the full screen with the pointer moved off whatever it landed on (a tooltip under it would take the first Escape). */
async function intoFull(page: Page) {
	await enter(page).click();
	await expect(full(page)).toBeVisible();
	await page.mouse.move(700, 500);
}

test("the full screen covers the window, and leaving it brings everything back as it was", async ({ page }) => {
	const { file } = await open(page, 0x12);
	await viewInPanel(page, "Gamma");

	// What the person was in the middle of: a draft, a place in the long conversation, the panel on this subagent.
	const composer = page.getByTestId("composer");
	await composer.fill("half a thought");
	const transcript = page.getByTestId("transcript");
	await transcript.evaluate((el) => {
		el.scrollTop = 900;
	});
	await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBeGreaterThan(800);
	const place = await transcript.evaluate((el) => el.scrollTop);

	await enter(page).click();
	await expect(full(page)).toBeVisible();
	await expect(nameOf(page)).toHaveText("Gamma");
	await expect(detail(page)).toContainText("Find the config files");
	await expect(detail(page)).toContainText("I will search the tree.");
	expect(await hash(page)).toBe(`#/s/${encodeURIComponent(file)}/agent/Gamma`);

	// Sidebar, conversation and panel are out of sight, and out of reach of Tab and screen readers.
	await expect(page.getByTestId("session-list")).toBeHidden();
	await expect(transcript).toBeHidden();
	await expect(composer).toBeHidden();
	await expect(page.getByTestId("right-panel")).toBeHidden();
	await expect(page.getByRole("complementary")).toHaveCount(0);

	await full(page).getByTestId("subagent-full-exit").click();
	await expect(full(page)).toHaveCount(0);
	expect(await hash(page)).toBe(`#/s/${encodeURIComponent(file)}`);
	await expect(page.getByTestId("session-list")).toBeVisible();
	await expect(composer).toBeVisible();
	await expect(composer).toHaveValue("half a thought");
	expect(await transcript.evaluate((el) => el.scrollTop)).toBe(place);
	// The panel is where it was: open, on the live view of the same subagent.
	await expect(page.getByTestId("subagent-detail")).toHaveAttribute("data-agent-id", "Gamma");
});

test("Escape leaves the full screen, from the steer box too, and the list opened over it takes the first Escape", async ({
	page,
}) => {
	await open(page, 0x13);
	await viewInPanel(page, "Gamma");

	await intoFull(page);
	await page.keyboard.press("Escape");
	await expect(full(page)).toHaveCount(0);

	// With the cursor in the steer box.
	await intoFull(page);
	await full(page).getByLabel("Message subagent").focus();
	await page.keyboard.press("Escape");
	await expect(full(page)).toHaveCount(0);

	// The list takes the first Escape and the full screen stays.
	await intoFull(page);
	await page.keyboard.press("Alt+KeyL");
	await expect(page.getByTestId("subagent-full-list")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("subagent-full-list")).toHaveCount(0);
	await expect(full(page)).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(full(page)).toHaveCount(0);

	// `?` is the shell's, and the shell is hidden here: it opens no page under the full screen (#639). Esc leaves it.
	await intoFull(page);
	await page.keyboard.press("?");
	await page.waitForTimeout(300);
	await expect(page.getByTestId("shortcuts")).toHaveCount(0);
	await expect(page.getByTestId("settings-page")).toHaveCount(0);
	await expect(full(page)).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(full(page)).toHaveCount(0);
});

test("`?` behind a subagent's full screen opens no page, and the Escape after it in the same task is the full screen's (#639)", async ({
	page,
}) => {
	await open(page, 0x13);
	await viewInPanel(page, "Gamma");
	await intoFull(page);

	// Both keys in one task. `?` opens nothing here (the shell under the full screen is hidden, as for its other keys), so
	// there is no overlay to take the Escape: it leaves the full screen, and nothing was drawn under it meanwhile.
	await page.evaluate(() => {
		const key = (k: string) =>
			document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
		key("?");
		key("Escape");
	});
	await expect(page.getByTestId("shortcuts")).toHaveCount(0);
	await expect(page.getByTestId("settings-page")).toHaveCount(0);
	await expect(full(page)).toHaveCount(0);
});

test("previous, next and the list switch between the conversation's subagents, one step of history for all of them", async ({
	page,
}) => {
	const { file } = await open(page, 0x14);
	await page.getByTestId("toggle-panel").click();
	await expect(page.getByTestId("subagent-item")).toHaveCount(3);
	const ids = await page
		.getByTestId("subagent-item")
		.evaluateAll((els) => els.map((e) => e.getAttribute("data-agent-id") as string));
	expect(ids[0]).toBe("Gamma");
	await viewInPanel(page, ids[0]);
	const before = await historyLength(page);

	await enter(page).click();
	await expect(nameOf(page)).toHaveText(ids[0]);
	const position = full(page).getByTestId("subagent-full-position");
	await expect(position).toHaveText("1/3");
	await expect(full(page).getByTestId("subagent-full-prev")).toBeDisabled();
	const afterEnter = await historyLength(page);
	expect(afterEnter).toBe(before + 1);

	// Next, by button and by key; the address and the view follow, in place.
	await full(page).getByTestId("subagent-full-next").click();
	await expect(nameOf(page)).toHaveText(ids[1]);
	await expect(position).toHaveText("2/3");
	expect(await hash(page)).toBe(`#/s/${encodeURIComponent(file)}/agent/${ids[1]}`);
	await expect(detail(page)).toHaveAttribute("data-agent-id", ids[1]);
	await expect(full(page).getByTestId("subagent-full-prev")).toBeEnabled();
	await page.keyboard.press("Alt+ArrowDown");
	await expect(nameOf(page)).toHaveText(ids[2]);
	await expect(full(page).getByTestId("subagent-full-next")).toBeDisabled();
	await page.keyboard.press("Alt+ArrowDown");
	await expect(nameOf(page)).toHaveText(ids[2]);
	await page.keyboard.press("Alt+ArrowUp");
	await expect(nameOf(page)).toHaveText(ids[1]);

	// The list names them all, the current one marked, and picks one.
	await page.keyboard.press("Alt+KeyL");
	const options = page.getByTestId("subagent-full-option");
	await expect(options).toHaveCount(3);
	await expect(options.nth(1)).toHaveAttribute("aria-checked", "true");
	await options.first().click();
	await expect(page.getByTestId("subagent-full-list")).toHaveCount(0);
	await expect(nameOf(page)).toHaveText(ids[0]);

	// Switching replaced the address: no step of history was added, and Back leaves the full screen in one go.
	expect(await historyLength(page)).toBe(afterEnter);
	await page.goBack();
	await expect(full(page)).toHaveCount(0);
	await expect(page.getByTestId("transcript")).toBeVisible();
	expect(await hash(page)).toBe(`#/s/${encodeURIComponent(file)}`);
	// Forward is the full screen again, on the subagent last shown.
	await page.goForward();
	await expect(full(page)).toBeVisible();
	await expect(nameOf(page)).toHaveText(ids[0]);
});

test("the address keeps the full screen across a reload, and names a subagent the conversation does not have", async ({
	page,
}) => {
	const { file } = await open(page, 0x15);
	await viewInPanel(page, "Alpha");
	await enter(page).click();
	await expect(detail(page)).toContainText("Worked for 5");

	await page.reload();
	await expect(full(page)).toBeVisible();
	await expect(nameOf(page)).toHaveText("Alpha");
	await expect(detail(page)).toContainText("Worked for 5");
	await expect(page.getByTestId("session-list")).toBeHidden();

	// Leaving a full screen the page was loaded into is the conversation's own address, replacing it.
	await page.keyboard.press("Escape");
	await expect(full(page)).toHaveCount(0);
	expect(await hash(page)).toBe(`#/s/${encodeURIComponent(file)}`);
	await expect(page.getByTestId("transcript")).toBeVisible();

	// An address naming a subagent that is not there says so, and still has the way out.
	await page.goto(`/#/s/${encodeURIComponent(file)}/agent/Nobody`);
	await expect(full(page)).toBeVisible();
	await expect(full(page)).toContainText("This subagent is not in the conversation");
	await expect(full(page)).toContainText("Nobody");
	await full(page).getByTestId("subagent-full-exit").click();
	await expect(full(page)).toHaveCount(0);
});

test("what the subagent says keeps arriving in the full screen, also in one that was loaded into", async ({ page }) => {
	const { tap, frame } = await open(page, 0x16);
	await viewInPanel(page, "Gamma");
	await intoFull(page);
	await expect(detail(page)).toContainText("I will search the tree.");

	const said = (t: string) => assistant(text(t), 20);
	frame(event("Gamma", { type: "message_start", message: said("") }));
	frame(
		event("Gamma", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", partial: said("Checking the config folder") },
		}),
	);
	await expect(detail(page)).toContainText("Checking the config folder");
	frame(
		event("Gamma", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", partial: said("Checking the config folder and the docs") },
		}),
	);
	await expect(detail(page)).toContainText("Checking the config folder and the docs");
	// The conversation under the full screen was not touched to show this.
	await expect(page.getByTestId("transcript")).toBeHidden();

	// A page loaded into the full screen finds the process that runs the conversation and listens to it. Beta is on disk;
	// omp starts it again after the reload, and what it says arrives.
	await page.keyboard.press("Alt+KeyL");
	await page.locator('[data-testid="subagent-full-option"][data-agent-id="Beta"]').click();
	await expect(nameOf(page)).toHaveText("Beta");
	const hydrated = tap.replies("get_subagents").length;
	await page.reload();
	await expect(nameOf(page)).toHaveText("Beta");
	await expect(detail(page)).toContainText("Worked for 6");
	// The page listens once the process has answered its attach and the page has read omp's own list of subagents (which
	// ends any it was told of that omp does not have): a frame before that has nothing to land on, or is ended by it.
	await expect.poll(() => tap.replies("get_subagents").length).toBeGreaterThan(hydrated);
	await expect
		.poll(async () => {
			frame(lifecycle("Beta", "started", { description: "A second look" }));
			return full(page).getByTestId("subagent-stop").count();
		})
		.toBe(1);
	frame(event("Beta", { type: "message_start", message: said("") }));
	frame(
		event("Beta", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", partial: said("Streaming after the reload") },
		}),
	);
	await expect(detail(page)).toContainText("Streaming after the reload");
});

test("focus goes into the full screen, stays in it, and goes back to what opened it", async ({ page }) => {
	await open(page, 0x17);
	await viewInPanel(page, "Gamma");

	// By keyboard.
	await enter(page).focus();
	await page.keyboard.press("Enter");
	await expect(full(page)).toBeVisible();
	await expect.poll(() => focusedIn(page, "subagent-full")).toBe(true);
	for (let i = 0; i < 14; i++) {
		await page.keyboard.press("Tab");
		expect(await focusedIn(page, "subagent-full")).toBe(true);
	}
	for (let i = 0; i < 14; i++) {
		await page.keyboard.press("Shift+Tab");
		expect(await focusedIn(page, "subagent-full")).toBe(true);
	}
	// A tooltip that showed as focus went by takes the first Escape (it is dismissed first, as any tooltip is); the next leaves.
	await page.keyboard.press("Escape");
	if ((await full(page).count()) > 0) await page.keyboard.press("Escape");
	await expect(full(page)).toHaveCount(0);
	await expect(enter(page)).toBeFocused();

	// By pointer, and out by the button.
	await enter(page).click();
	await expect(full(page)).toBeVisible();
	await full(page).getByTestId("subagent-full-exit").click();
	await expect(full(page)).toHaveCount(0);
	await expect(enter(page)).toBeFocused();

	// The full screen is a dialog with a name, for a screen reader.
	await enter(page).click();
	await expect(page.getByRole("dialog", { name: "Gamma, full screen" })).toBeVisible();
});

test("on a phone the full screen fits the width and its controls are in reach", async ({ page }) => {
	await open(page, 0x18);
	await page.setViewportSize({ width: 390, height: 720 });
	await page.getByRole("complementary").getByRole("button", { name: "Hide sidebar" }).click();
	await viewInPanel(page, "Gamma");
	await enter(page).click();
	await expect(full(page)).toBeVisible();

	const width = await page.evaluate(() => document.documentElement.scrollWidth);
	expect(width).toBeLessThanOrEqual(390);
	for (const id of ["subagent-full-exit", "subagent-full-switch", "subagent-full-prev", "subagent-full-next"]) {
		const box = await full(page).getByTestId(id).boundingBox();
		expect(box, id).not.toBeNull();
		expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
	}
	await expect(detail(page).getByTestId("subagent-scroll")).toBeVisible();
	await full(page).getByTestId("subagent-full-exit").click();
	await expect(full(page)).toHaveCount(0);
});

test("a window popped out for a subagent shows it alone, can go full screen, and closing it leaves the page as it was", async ({
	page,
}) => {
	const { file } = await open(page, 0x19);
	await viewInPanel(page, "Alpha");
	await page.getByTestId("composer").fill("not sent");
	await enter(page).click();
	await expect(full(page)).toBeVisible();

	const [popup] = await Promise.all([
		page.waitForEvent("popup"),
		full(page).getByTestId("subagent-full-popout").click(),
	]);
	await popup.waitForLoadState("domcontentloaded");
	expect(new URL(popup.url()).search).toBe("?popout");
	expect(new URL(popup.url()).hash).toBe(`#/s/${encodeURIComponent(file)}/agent/Alpha`);
	const popped = popup.getByTestId("subagent-full");
	await expect(popped).toBeVisible();
	await expect(popped).toHaveAttribute("data-mode", "popout");
	await expect(popped).toContainText("Worked for 5");
	// Alone: no sidebar, no conversation, no way out of the window it is in, and the window is named after it.
	await expect(popup.getByTestId("session-list")).toHaveCount(0);
	await expect(popup.getByTestId("transcript")).toHaveCount(0);
	await expect(popped.getByTestId("subagent-full-exit")).toHaveCount(0);
	await expect(popup).toHaveTitle(/^Alpha · /);
	// Next and previous work in it.
	await popped.getByTestId("subagent-full-next").click();
	await expect(popped.getByTestId("subagent-full-name")).not.toHaveText("Alpha");
	await popped.getByTestId("subagent-full-prev").click();
	await expect(popped.getByTestId("subagent-full-name")).toHaveText("Alpha");

	// The window's own full screen.
	const screen = popped.getByTestId("subagent-full-screen");
	await expect(screen).toHaveAccessibleName("Full screen");
	await screen.click();
	await expect.poll(() => popup.evaluate(() => document.fullscreenElement !== null)).toBe(true);
	await expect(screen).toHaveAccessibleName("Exit full screen");
	await screen.click();
	await expect.poll(() => popup.evaluate(() => document.fullscreenElement === null)).toBe(true);

	// The page the window was opened from left its full screen for it, and is the conversation again.
	await expect(full(page)).toHaveCount(0);
	await expect(page.getByTestId("transcript")).toBeVisible();
	await popup.close();
	await expect(page.getByTestId("composer")).toHaveValue("not sent");
	await expect(page.getByTestId("subagent-detail")).toHaveAttribute("data-agent-id", "Alpha");
	expect(await hash(page)).toBe(`#/s/${encodeURIComponent(file)}`);
});

test("the full screen's entrance uses only what the compositor animates, and none with reduced motion", async ({
	page,
}) => {
	await open(page, 0x1a);
	await viewInPanel(page, "Gamma");
	await intoFull(page);
	const used = await full(page).evaluate((el) => {
		const name = getComputedStyle(el).animationName;
		const props = new Set<string>();
		for (const sheet of document.styleSheets) {
			for (const rule of sheet.cssRules) {
				if (rule instanceof CSSKeyframesRule && rule.name === name) {
					for (const frame of rule.cssRules) for (const p of (frame as CSSKeyframeRule).style) props.add(p);
				}
			}
		}
		return { name, props: [...props].sort() };
	});
	expect(used.name).not.toBe("none");
	expect(used.props.every((p) => p === "opacity" || p === "transform")).toBe(true);

	await page.keyboard.press("Escape");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await intoFull(page);
	await expect(full(page)).toBeVisible();
	const duration = await full(page).evaluate((el) => getComputedStyle(el).animationDuration);
	expect(Number.parseFloat(duration)).toBeLessThan(0.001);
});

test("the full screen adds no renders of the conversation under it for what the subagent streams", async ({ page }) => {
	const { frame } = await open(page, 0x1c, { countRenders: true });
	await viewInPanel(page, "Gamma");
	// What is counted (`render-count.ts`): the conversation (the component that draws the transcript), which the page
	// redraws for each frame of the process, and its replies, every one in the transcript and none in the subagent's view
	// (it uses the same component), which that redraw passes by.
	await countRendersOf(page, "transcript", "chat");
	await countRendersOf(
		page,
		{ element: '[data-testid="transcript"] [data-testid="msg-assistant"]', within: '[data-testid="transcript"]' },
		"replies",
	);
	const said = (t: string) => assistant(text(t), 20);
	const stream = async (word: string) => {
		frame(event("Gamma", { type: "message_start", message: said("") }));
		for (let i = 1; i <= 25; i++) {
			frame(
				event("Gamma", {
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", partial: said(`${word} ${"w ".repeat(i)}`) },
				}),
			);
		}
		frame(
			event("Gamma", {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", partial: said(`${word} complete`) },
			}),
		);
	};
	/** What the conversation and its replies render while the subagent streams one reply, until `view` shows all of it. */
	const streamed = async (word: string, view: Locator) => {
		const chat = await rendersCounted(page, "chat");
		const replies = await rendersCounted(page, "replies");
		await stream(word);
		await expect(view).toContainText(`${word} complete`);
		return {
			chat: (await rendersCounted(page, "chat")) - chat,
			replies: (await rendersCounted(page, "replies")) - replies,
		};
	};

	// In the Agents tab: the page redraws its conversation for each frame of the process (the count sees that), and
	// that is what the full screen must not add to.
	const inPanel = await streamed("panel", page.getByTestId("subagent-detail"));

	// Full screen over it, for as many frames: the same, not more, of the conversation and of its replies.
	await intoFull(page);
	const inFull = await streamed("full", detail(page));
	expect(inPanel.chat).toBeGreaterThan(0);
	expect(inFull.chat).toBeLessThanOrEqual(Math.ceil(inPanel.chat * 1.25));
	expect(inFull.replies).toBeLessThanOrEqual(Math.ceil(inPanel.replies * 1.25));
});

test.describe("in Chinese", () => {
	test.use({ locale: "zh-CN" });

	test("the full screen speaks the interface language", async ({ page }) => {
		await open(page, 0x1b);
		await page.getByTestId("toggle-panel").click();
		await page.locator('[data-testid="subagent-item"][data-agent-id="Gamma"]').click();
		await expect(page.getByTestId("subagent-full-enter")).toHaveAccessibleName("全屏");
		await enter(page).click();
		await expect(full(page).getByTestId("subagent-full-exit")).toHaveAccessibleName("退出全屏");
		await expect(full(page).getByTestId("subagent-full-switch")).toHaveAccessibleName("Gamma");
		await expect(full(page).getByTestId("subagent-full-switch")).toHaveAccessibleDescription(/^切换子代理/);
		await expect(full(page).getByTestId("subagent-full-position")).toHaveAccessibleName("第 1 个，共 3 个");
		await expect(page.getByRole("dialog", { name: "Gamma，全屏" })).toBeVisible();
	});
});

test("the switcher and the panel's Agents tab are named by what they show", async ({ page }) => {
	await open(page, 0x1d);
	await viewInPanel(page, "Gamma");
	// WCAG 2.5.3 Label in Name, as axe's rule decides: the tab reads "Agents" and its count, the switcher the subagent's name.
	const mismatches = async (selector: string) =>
		(
			await new AxeBuilder({ page }).include(selector).withRules(["label-content-name-mismatch"]).analyze()
		).violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")));
	await expect(page.getByTestId("pane-tab-agents")).toHaveAccessibleName(/^Agents [\d/]+$/);
	expect(await mismatches('[data-testid="pane-tab-agents"]')).toEqual([]);
	await intoFull(page);
	const switcher = full(page).getByTestId("subagent-full-switch");
	await expect(switcher).toHaveAccessibleName("Gamma");
	expect(await mismatches('[data-testid="subagent-full-switch"]')).toEqual([]);
});

test("the shell's own shortcuts do nothing while the full screen hides it, and work again after", async ({ page }) => {
	await open(page, 0x20);
	await viewInPanel(page, "Gamma");
	const menu = page.getByTestId("approval-menu");
	await intoFull(page);
	// The permission menu, the next preset and the goal belong to a page nobody can see: they would change it unseen.
	await page.keyboard.press("Control+Shift+A");
	await page.keyboard.press("Control+Shift+M");
	await page.keyboard.press("Control+Shift+G");
	await page.waitForTimeout(600);
	await expect(menu).toHaveCount(0);
	await expect(page.getByTestId("goal-bar")).toHaveCount(0);
	// The control: the same key opens the menu on the page once the full screen is gone.
	await page.keyboard.press("Escape");
	await expect(full(page)).toHaveCount(0);
	await page.keyboard.press("Control+Shift+A");
	await expect(menu).toBeVisible();
});

test("a nested subagent opens in the view itself, in the window and in a window of its own", async ({ page }) => {
	const { file } = await open(page, 0x21);
	writeTranscript(join(file.replace(/\.jsonl$/, ""), "Alpha", "Alpha.Inner.jsonl"), [7]);
	await page.reload();
	await page.goto(`/#/s/${encodeURIComponent(file)}/agent/Alpha`);
	const child = full(page).getByTestId("subagent-child");
	await expect(child).toHaveCount(1);
	await child.click();
	expect(await hash(page)).toBe(`#/s/${encodeURIComponent(file)}/agent/Alpha.Inner`);
	await expect(nameOf(page)).toHaveText("Inner");
	await expect(detail(page)).toContainText("Worked for 7");
	await full(page).getByTestId("subagent-parent").click();
	expect(await hash(page)).toBe(`#/s/${encodeURIComponent(file)}/agent/Alpha`);

	// The same in a window popped out for it, which has no panel to change.
	await page.goto(`/?popout#/s/${encodeURIComponent(file)}/agent/Alpha`);
	await expect(full(page)).toHaveAttribute("data-mode", "popout");
	await full(page).getByTestId("subagent-child").click();
	await expect(nameOf(page)).toHaveText("Inner");
	await expect(detail(page)).toContainText("Worked for 7");
});

test("Option keys belong to the steer box while the cursor is in it, and are the full screen's elsewhere", async ({
	page,
}) => {
	await open(page, 0x22);
	await viewInPanel(page, "Gamma");
	await intoFull(page);
	const steer = full(page).getByLabel("Message subagent");
	await steer.focus();
	await page.keyboard.press("Alt+ArrowDown");
	await page.keyboard.press("Alt+KeyL");
	await page.waitForTimeout(400);
	await expect(nameOf(page)).toHaveText("Gamma");
	await expect(page.getByTestId("subagent-full-list")).toHaveCount(0);
	// Out of the field the same keys switch.
	await page.getByTestId("subagent-full").focus();
	await page.keyboard.press("Alt+ArrowDown");
	await expect(nameOf(page)).not.toHaveText("Gamma");
});

test("a window opened for a subagent whose address names none shows that, never the whole app", async ({ page }) => {
	const { file } = await open(page, 0x23);
	for (const hash of ["#/settings", `#/s/${encodeURIComponent(file)}`, "#/live/not-a-process/agent/Gamma"]) {
		await page.goto(`/?popout${hash}`);
		await expect(full(page)).toHaveAttribute("data-mode", "popout");
		await expect(full(page)).toContainText(/not in the conversation|names none/);
		await expect(page.getByTestId("session-list")).toHaveCount(0);
		await expect(page.getByTestId("composer")).toHaveCount(0);
	}
});

test("the panel's own view of the subagent does not read its transcript again behind the full screen", async ({
	page,
}) => {
	const { tap } = await open(page, 0x24);
	await viewInPanel(page, "Gamma");
	const reads = () => tap.commands("get_subagent_messages").filter((c) => c.subagentId === "Gamma").length;
	const over = async (ms: number) => {
		const before = reads();
		await page.waitForTimeout(ms);
		return reads() - before;
	};
	const inPanel = await over(8000);
	await intoFull(page);
	const inFull = await over(8000);
	expect(inPanel).toBeGreaterThan(1);
	// One reader keeps its clock; two of them would read twice as often.
	expect(inFull).toBeLessThanOrEqual(Math.ceil(inPanel * 1.4));
});
