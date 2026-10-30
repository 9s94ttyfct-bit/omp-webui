import AxeBuilder from "@axe-core/playwright";
import {
	CALLS,
	callId,
	event,
	lifecycle,
	openGraph,
	SCOUT_COST,
	SCOUT_TOKENS,
	scoutId,
	seedFinished,
	seedLive,
} from "../support/agent-graph-seed.ts";
import { boxOf, overlap, viewportOf } from "../support/geometry.ts";
import { sessionWithSubagents } from "../support/subagent-fixtures.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * The agent graph (#719, #736), with omp's subagent frames pushed to the page by hand (no model call): the running
 * conversation is listed, its agents are drawn with who started whom, the subagents of one task call framed together and
 * a message between two of them; a subagent opens its live view beside the graph, the main agent the conversation.
 * A conversation of hundreds of subagents stays readable: finished batches are one card each, the graph can be filtered
 * and searched, drawn compact when zoomed out, with siblings in a grid, or following what runs with a minimap.
 */

declare global {
	interface Window {
		/** The search field as it was typed in, to tell whether a later one is the same element. */
		graphSearch?: Element;
	}
}

const node = (page: Page, id: string) => page.locator(`[data-testid="agent-node"][data-agent-id="${id}"]`);

test("the graph of a running conversation: spawn edges, a batch, a message, and the live view of a subagent", async ({
	page,
}) => {
	const title = "Graph probe";
	// omp's registry lists what runs: opening the graph attaches again and reads it, maybe after the frames below (#748).
	const { running, frame } = await openGraph(page, 0xf8, title);
	await expect(page.getByTestId("agents-page")).toBeVisible();
	await expect(page.getByTestId("agents-list").getByRole("button", { name: title })).toHaveAttribute(
		"aria-current",
		"page",
	);
	// The main agent's card: the conversation (no tool runs) and its own model.
	await expect(node(page, "main")).toContainText(title);
	await expect(node(page, "main")).toContainText(/claude|gpt|model/i);
	await expect(page.getByTestId("agents-no-subagents")).toBeVisible();

	for (const id of ["Lead", "Helper", "Lead.Sub"]) running.add(id);
	frame(lifecycle("Lead", "started", { parentToolCallId: "call_1", description: "Lead the search" }));
	frame(lifecycle("Helper", "started", { index: 1, parentToolCallId: "call_1" }));
	frame(lifecycle("Lead.Sub", "started"));
	frame(
		event("Lead", {
			type: "tool_execution_start",
			toolCallId: "w1",
			toolName: "write",
			args: { path: "agent://Helper", content: "Take the docs folder." },
		}),
	);
	// A message to every agent: one mark on its sender, no line to each of them.
	frame(
		event("Helper", {
			type: "tool_execution_start",
			toolCallId: "w2",
			toolName: "write",
			args: { path: "agent://all", content: "Docs are done." },
		}),
	);

	for (const id of ["Lead", "Helper", "Lead.Sub"]) await expect(node(page, id)).toBeVisible();
	await expect(page.getByTestId("agents-no-subagents")).toHaveCount(0);
	await expect(page.locator('[data-testid="agents-edge-spawn"]')).toHaveCount(3);
	await expect(page.locator('[data-testid="agents-edge-spawn"][data-from=""][data-to="Lead"]')).toHaveCount(1);
	await expect(page.locator('[data-testid="agents-edge-spawn"][data-from="Lead"][data-to="Lead.Sub"]')).toHaveCount(1);
	await expect(page.locator('[data-testid="agents-edge-message"][data-from="Lead"][data-to="Helper"]')).toHaveCount(1);
	await expect(page.locator('[data-testid="agents-edge-message"][data-from="Helper"]')).toHaveCount(0);
	await expect(node(page, "Helper").getByTestId("agents-broadcast")).toHaveAttribute("data-count", "1");
	await expect(node(page, "Helper")).toHaveAccessibleName(/1 message to every agent/);
	await expect(page.getByTestId("agents-batch")).toHaveCount(1);
	await expect(page.getByTestId("agents-totals")).toContainText("3 running");
	await expect(page.getByTestId("agents-totals")).toContainText("3 subagents");

	// Children are drawn right of their parent.
	const x = async (id: string) => (await node(page, id).boundingBox())?.x ?? Number.NaN;
	expect(await x("Lead")).toBeGreaterThan(await x("main"));
	expect(await x("Lead.Sub")).toBeGreaterThan(await x("Lead"));

	// A subagent opens its live view beside the graph; Close puts it away.
	await node(page, "Lead").click();
	const detail = page.getByTestId("agents-detail");
	await expect(detail).toBeVisible();
	await expect(detail.getByTestId("subagent-full-detail")).toHaveAttribute("data-agent-id", "Lead");
	await expect(node(page, "Lead")).toHaveAttribute("aria-pressed", "true");
	await page.getByTestId("agents-detail-close").click();
	await expect(detail).toHaveCount(0);

	// The ended subagent is drawn as done.
	running.delete("Helper");
	frame(lifecycle("Helper", "completed", { index: 1, parentToolCallId: "call_1" }));
	await expect(node(page, "Helper")).toHaveAttribute("data-look", "done");
	await expect(page.getByTestId("agents-totals")).toContainText("2 running");

	// The main agent is the conversation.
	await node(page, "main").click();
	await expect(page.getByTestId("composer")).toBeVisible();
	await expect(page).toHaveURL(/#\/s\//);
});

test("a conversation with no title in the list is Untitled with when it began, not the id in its file's name", async ({
	page,
}) => {
	// Named in the address, and in no list of sessions (omp has not written it yet): the list used to show its file's name.
	const file = "/nowhere/sessions/2026-10-29T06-30-45-917Z_01a1b2c3d4e5f6a7.jsonl";
	await page.goto(`/#/agents/${encodeURIComponent(file)}`);
	// Other conversations of the spec may still run (the first test's): the list has this one's row among them.
	const row = page.getByTestId("agents-list").getByTestId("agents-conversation").filter({ hasText: "Untitled · " });
	await expect(row).toHaveCount(1);
	await expect(row).toContainText("Untitled · ");
	await expect(row).not.toContainText("01a1b2c3d4e5f6a7");
});

test("the address names the conversation: a reload keeps the graph on it", async ({ page }) => {
	const title = "Graph address probe";
	const own = sessionWithSubagents(0xf9, title, { Finished: [10] });
	await page.goto(`/#/agents/${encodeURIComponent(own.file)}`);
	await expect(page.getByTestId("agents-page")).toBeVisible();
	// Not running, but named: listed, chosen, and drawn from its transcripts on disk.
	await expect(page.getByTestId("agents-list").getByRole("button", { name: title })).toHaveAttribute(
		"aria-current",
		"page",
	);
	await expect(node(page, "Finished")).toHaveAttribute("data-look", "done");
	await page.reload();
	await expect(node(page, "Finished")).toBeVisible();
});

// ---------------------------------------------------------------------------------------------------------------------
// A conversation of hundreds of subagents (#736)

/** The subagents of the big graph: the finished batches, MixedA/B/C, Runner, and Ancient, whose transcript is on disk. */
const BIG = CALLS * 12 + 5;
/** The zoom below which cards are compact. */
const COMPACT_BELOW = 0.6;

const canvas = (page: Page) => page.getByTestId("agents-canvas");
const summaries = (page: Page) => page.getByTestId("agent-summary");
const summary = (page: Page, call: number) =>
	page.locator(`[data-testid="agent-summary"][data-batch="${callId(call)}"]`);
const scaleOf = async (page: Page) => Number(await canvas(page).getAttribute("data-scale"));
const statusFilter = (page: Page, status: "all" | "running" | "failed") =>
	page.getByTestId(`agents-filter-status-${status}`);
const timeFilter = (page: Page, time: "all" | "hour" | "today") => page.getByTestId(`agents-filter-time-${time}`);

/** Whether `inner` is wholly inside what `outer` shows on screen. */
async function inside(inner: Locator, outer: Locator): Promise<boolean> {
	const a = await boxOf(inner);
	const b = await boxOf(outer);
	return a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.width <= b.x + b.width + 1 && a.y + a.height <= b.y + b.height + 1;
}

/** The layout size of a card (what the graph lays out, whatever the zoom): its height and its left. */
const laidOut = (el: Locator) =>
	el.evaluate((n) => ({ h: (n as HTMLElement).offsetHeight, x: (n as HTMLElement).offsetLeft }));

/**
 * A conversation as a long run leaves it: 24 task calls of 12 subagents each, all finished; a call of three of which one
 * failed; one subagent still running; and one whose transcript is on disk, from the start of January.
 */
async function openBig(page: Page, n: number, title: string) {
	const g = await openGraph(page, n, title, { Ancient: [3] });
	seedFinished(g.frame, CALLS, 12);
	seedLive(g);
	await expect(page.getByTestId("agents-totals")).toContainText(`${BIG} subagents`, { timeout: 30_000 });
	return g;
}

/** A few finished batches: small enough for full cards at the first fit. */
async function openSmall(page: Page, n: number, title: string) {
	const g = await openGraph(page, n, title);
	seedFinished(g.frame, 3, 4);
	await expect(page.getByTestId("agents-totals")).toContainText("12 subagents", { timeout: 30_000 });
	return g;
}

test("finished batches are one card each; what runs or failed is drawn without opening anything", async ({ page }) => {
	await openBig(page, 0xe1, "Graph scale cards");
	await expect(summaries(page)).toHaveCount(CALLS);
	await expect(summary(page, 0)).toHaveAttribute("data-agents", "12");
	// None of the 288 finished subagents is a card of its own, but the running one and the ones of the call with a failure are.
	await expect(node(page, scoutId(0, 0))).toHaveCount(0);
	await expect(node(page, "Runner")).toHaveAttribute("data-look", "running");
	await expect(node(page, "MixedB")).toHaveAttribute("data-look", "failed");
	for (const id of ["MixedA", "MixedC", "Ancient"]) await expect(node(page, id)).toBeVisible();
	await expect(page.locator('[data-testid="agent-summary"][data-batch="call_mixed"]')).toHaveCount(0);
	// The spawn lines of a card are one line from the main agent, not twelve.
	await expect(page.locator(`[data-testid="agents-edge-spawn"][data-to="batch:${callId(0)}"]`)).toHaveCount(1);
	await expect(page.locator('[data-testid="agents-edge-spawn"]')).toHaveCount(CALLS + 5);
	// The totals are the conversation's, whatever the graph shows of it.
	await expect(page.getByTestId("agents-totals")).toContainText("1 running");
});

test("a card shows what its subagents used; Enter opens it in place and Collapse puts it back", async ({ page }) => {
	await openSmall(page, 0xe2, "Graph scale open");
	await expect(summaries(page)).toHaveCount(3);
	const card = summary(page, 0);
	await expect(card).toContainText("4 subagents");
	await expect(card).toContainText("4 done");
	await expect(card).toContainText(`${(4 * SCOUT_TOKENS) / 1000}.0k tokens`);
	await expect(card).toContainText(`$${(4 * SCOUT_COST).toFixed(2)}`);
	await expect(card).toHaveAttribute("aria-expanded", "false");

	await card.focus();
	await page.keyboard.press("Enter");
	for (let i = 0; i < 4; i++) await expect(node(page, scoutId(0, i))).toBeVisible();
	// Focus goes to what took the card's place, not to the page.
	await expect(node(page, scoutId(0, 0))).toBeFocused();
	await expect(summaries(page)).toHaveCount(2);
	await expect(page.getByTestId("agents-batch")).toHaveCount(1);
	// The frame has a control that closes it again; the batches nobody opened have none.
	await expect(page.getByTestId("agents-collapse")).toHaveCount(1);
	// Tab goes through the graph as it is drawn: the frame's Collapse before the subagents in it, and the cards below
	// after them, not every card of one kind first (B9).
	const order = await canvas(page).evaluate((el) =>
		[
			...el.querySelectorAll<HTMLElement>(
				'[data-testid="agent-node"], [data-testid="agent-summary"], [data-testid="agents-collapse"]',
			),
		].map((b) => ({ id: b.dataset.agentId ?? `${b.dataset.testid} ${b.dataset.batch}`, top: b.offsetTop })),
	);
	const ids = order.map((o) => o.id);
	expect(ids.indexOf(`agents-collapse ${callId(0)}`), "Collapse just before its first subagent").toBe(
		ids.indexOf(scoutId(0, 0)) - 1,
	);
	// Under the main agent (midway between its subagents), each is lower than the one before it.
	const tops = order.filter((o) => o.id !== "main").map((o) => o.top);
	expect(tops).toEqual([...tops].sort((a, b) => a - b));
	await page.getByRole("button", { name: "Collapse 4 subagents" }).click();
	await expect(summaries(page)).toHaveCount(3);
	await expect(card).toBeFocused();
	await expect(node(page, scoutId(0, 0))).toHaveCount(0);

	// Space opens another one; the first stays as it was left.
	await summary(page, 1).focus();
	await page.keyboard.press("Space");
	await expect(node(page, scoutId(1, 3))).toBeVisible();
	await expect(summary(page, 0)).toHaveCount(1);
});

/**
 * The size on screen of the first open frame's Collapse, and whether a press in its middle reaches it rather than a card
 * drawn over it (#786).
 */
const collapseHit = (page: Page) =>
	page
		.getByTestId("agents-collapse")
		.first()
		.evaluate((el) => {
			const r = el.getBoundingClientRect();
			const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
			return { width: Math.round(r.width), height: Math.round(r.height), reached: el.contains(top) };
		});

test("an open card's Collapse is above its subagents and a 24px target at any zoom", async ({ page }) => {
	await openBig(page, 0xed01, "Graph scale collapse");
	await summary(page, 0).focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("agents-collapse")).toHaveCount(1);
	expect(await scaleOf(page)).toBeLessThan(COMPACT_BELOW);
	const fitted = await collapseHit(page);
	expect(fitted.reached, "zoomed out, a press reaches Collapse").toBe(true);
	expect(fitted.width).toBeGreaterThanOrEqual(24);
	expect(fitted.height).toBeGreaterThanOrEqual(24);
	for (let i = 0; i < 6; i++) await page.getByTestId("agents-zoom-in").click();
	await expect(canvas(page)).toHaveAttribute("data-compact", "false");
	await page.getByTestId("agents-collapse").scrollIntoViewIfNeeded();
	const zoomed = await collapseHit(page);
	expect(zoomed.reached, "zoomed in, a press reaches Collapse").toBe(true);
	expect(zoomed.width).toBeGreaterThanOrEqual(24);
	await page.getByTestId("agents-collapse").click();
	await expect(summaries(page)).toHaveCount(CALLS);
	await expect(summary(page, 0)).toBeFocused();
});

test("the status and time filters keep what matches and who started it, and drop the rest", async ({ page }) => {
	await openBig(page, 0xe3, "Graph scale filters");
	await expect(node(page, "Ancient")).toBeVisible();

	await statusFilter(page, "failed").click();
	await expect(statusFilter(page, "failed")).toHaveAttribute("aria-pressed", "true");
	// The failed one, and the main agent that started it: nothing else, and no card.
	await expect(page.getByTestId("agent-node")).toHaveCount(2);
	await expect(node(page, "MixedB")).toBeVisible();
	await expect(summaries(page)).toHaveCount(0);
	await expect(page.locator('[data-testid="agents-edge-spawn"][data-from=""][data-to="MixedB"]')).toHaveCount(1);
	await expect(page.getByTestId("agents-totals")).toContainText(`${BIG} subagents`);

	await statusFilter(page, "running").click();
	await expect(page.getByTestId("agent-node")).toHaveCount(2);
	await expect(node(page, "Runner")).toBeVisible();

	await statusFilter(page, "all").click();
	await expect(summaries(page)).toHaveCount(CALLS);

	// By when they started: the subagents of this run started a moment ago, Ancient's transcript in January.
	for (const time of ["hour", "today"] as const) {
		await timeFilter(page, time).click();
		await expect(node(page, "Ancient")).toHaveCount(0);
		await expect(node(page, "Runner")).toBeVisible();
		await expect(summaries(page)).toHaveCount(CALLS);
	}
	await timeFilter(page, "all").click();
	await expect(node(page, "Ancient")).toBeVisible();
});

test("filters that leave nothing but the main agent say so", async ({ page }) => {
	await openSmall(page, 0xe4, "Graph scale empty");
	await expect(page.getByTestId("agents-filter-empty")).toHaveCount(0);
	await statusFilter(page, "failed").click();
	await expect(page.getByTestId("agents-filter-empty")).toBeVisible();
	await expect(page.getByTestId("agent-node")).toHaveCount(1);
	await expect(node(page, "main")).toBeVisible();
	await statusFilter(page, "all").click();
	await expect(page.getByTestId("agents-filter-empty")).toHaveCount(0);
});

test("search finds a subagent inside a card, opens it and brings the match into view; Enter goes to the next", async ({
	page,
}) => {
	await openBig(page, 0xe5, "Graph scale search");
	const search = page.getByTestId("agents-search");
	const count = page.getByTestId("agents-search-count");

	await search.fill(scoutId(13, 5));
	await expect(count).toHaveText("1 of 1");
	const hit = node(page, scoutId(13, 5));
	await expect(hit).toHaveAttribute("data-match", "current");
	// Its batch is open; the others are still cards.
	await expect(summaries(page)).toHaveCount(CALLS - 1);
	await expect(summary(page, 13)).toHaveCount(0);
	await expect.poll(() => inside(hit, canvas(page))).toBe(true);
	// Nothing to close while the search is on it.
	await expect(page.getByTestId("agents-collapse")).toHaveCount(0);

	await search.fill("");
	await expect(count).toHaveText("");
	await expect(summaries(page)).toHaveCount(CALLS);

	// A search with many matches: all are ringed, and Enter goes from one to the next (and Shift+Enter back).
	await search.fill("team07scout");
	await expect(count).toHaveText("1 of 12");
	await expect(page.locator("[data-match]")).toHaveCount(12);
	await expect(node(page, scoutId(7, 0))).toHaveAttribute("data-match", "current");
	await search.press("Enter");
	await expect(count).toHaveText("2 of 12");
	await expect(node(page, scoutId(7, 1))).toHaveAttribute("data-match", "current");
	await expect(node(page, scoutId(7, 0))).toHaveAttribute("data-match", "match");
	await expect.poll(() => inside(node(page, scoutId(7, 1)), canvas(page))).toBe(true);
	await search.press("Shift+Enter");
	await expect(count).toHaveText("1 of 12");

	await search.fill("no such subagent");
	await expect(count).toHaveText("No match");
	await expect(page.locator("[data-match]")).toHaveCount(0);
});

test("zoomed out, cards are compact (a dot and the name) and rows are closer; zoomed in they are full again", async ({
	page,
}) => {
	await openSmall(page, 0xe6, "Graph scale compact");
	const main = node(page, "main");
	await expect(canvas(page)).toHaveAttribute("data-compact", "false");
	expect((await laidOut(main)).h).toBe(96);

	const zoomOut = page.getByTestId("agents-zoom-out");
	for (let i = 0; i < 5 && (await scaleOf(page)) >= COMPACT_BELOW; i++) await zoomOut.click();
	expect(await scaleOf(page)).toBeLessThan(COMPACT_BELOW);
	await expect(canvas(page)).toHaveAttribute("data-compact", "true");
	await expect(main).toContainText("Main agent");
	expect((await laidOut(main)).h).toBe(28);
	// The name is as large as 11px on screen at the zoom where compact cards begin.
	const label = main.locator("span.font-semibold");
	const font = Number.parseFloat(await label.evaluate((el) => getComputedStyle(el).fontSize));
	expect(font * COMPACT_BELOW).toBeGreaterThanOrEqual(11);
	await expect(summary(page, 0)).toContainText("4 subagents");

	await page.getByTestId("agents-zoom-in").click();
	await page.getByTestId("agents-zoom-in").click();
	await page.getByTestId("agents-zoom-in").click();
	await expect(canvas(page)).toHaveAttribute("data-compact", "false");
	expect((await laidOut(main)).h).toBe(96);
});

test("a graph too big to fit with full cards is fitted whole with compact ones, and Fit brings it back", async ({
	page,
}) => {
	await openBig(page, 0xe7, "Graph scale fit");
	await expect(canvas(page)).toHaveAttribute("data-compact", "true");
	expect(await scaleOf(page)).toBeLessThan(COMPACT_BELOW);
	expect(await scaleOf(page)).toBeGreaterThan(0.15);
	// The whole graph is on screen, with nothing to scroll to.
	const room = await canvas(page).evaluate((el) => ({
		over: el.scrollHeight - el.clientHeight,
		wide: el.scrollWidth - el.clientWidth,
	}));
	expect(room.over).toBeLessThanOrEqual(1);
	expect(room.wide).toBeLessThanOrEqual(1);
	for (const id of ["main", "Runner", "MixedB"]) await expect(node(page, id)).toBeVisible();
	await expect.poll(() => inside(node(page, "Runner"), canvas(page))).toBe(true);

	const fitted = await scaleOf(page);
	const zoomIn = page.getByTestId("agents-zoom-in");
	for (let i = 0; i < 6; i++) await zoomIn.click();
	await expect(canvas(page)).toHaveAttribute("data-compact", "false");
	await page.getByTestId("agents-fit").click();
	await expect(canvas(page)).toHaveAttribute("data-compact", "true");
	expect(await scaleOf(page)).toBeCloseTo(fitted, 5);
});

test("siblings in a grid: the switch is remembered, and the layout changes with it", async ({ page }) => {
	const title = "Graph scale grid";
	const own = sessionWithSubagents(
		0xe8,
		title,
		Object.fromEntries(["S0", "S1", "S2", "S3", "S4", "S5", "S6"].map((id) => [id, [1]])),
	);
	await page.goto(`/#/agents/${encodeURIComponent(own.file)}`);
	const grid = page.getByTestId("agents-grid");
	const columns = async () => {
		const xs = await page.getByTestId("agent-node").evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetLeft));
		return new Set(xs).size - 1;
	};
	await expect(node(page, "S6")).toBeVisible();
	await expect(grid).toHaveAttribute("aria-pressed", "false");
	expect(await columns()).toBe(1);

	await grid.click();
	await expect(grid).toHaveAttribute("aria-pressed", "true");
	// At most five to a row.
	expect(await columns()).toBe(5);
	const ys = await page.getByTestId("agent-node").evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetTop));
	expect(new Set(ys).size).toBeLessThanOrEqual(3);
	// Still started by the main agent, one line each.
	await expect(page.locator('[data-testid="agents-edge-spawn"][data-from=""]')).toHaveCount(7);

	await page.reload();
	await expect(node(page, "S6")).toBeVisible();
	await expect(page.getByTestId("agents-grid")).toHaveAttribute("aria-pressed", "true");
	expect(await columns()).toBe(5);

	await page.getByTestId("agents-grid").click();
	await page.reload();
	await expect(node(page, "S6")).toBeVisible();
	await expect(page.getByTestId("agents-grid")).toHaveAttribute("aria-pressed", "false");
	expect(await columns()).toBe(1);
});

test("focus frames the main agent and what runs, with a minimap that pans the canvas; the switch is remembered", async ({
	page,
}) => {
	const g = await openBig(page, 0xe9, "Graph scale focus");
	const focus = page.getByTestId("agents-focus");
	await expect(focus).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByTestId("agents-minimap")).toHaveCount(0);
	const whole = await scaleOf(page);

	await focus.click();
	await expect(focus).toHaveAttribute("aria-pressed", "true");
	const map = page.getByTestId("agents-minimap");
	await expect(map).toBeVisible();
	await expect(page.getByTestId("agents-minimap-view")).toHaveCount(1);
	// At most 180 by 120 inside a padding and a border, and no more than about a third of the canvas.
	const size = await boxOf(map);
	const room = await boxOf(canvas(page));
	expect(size.width).toBeLessThanOrEqual(190);
	expect(size.height).toBeLessThanOrEqual(130);
	expect(size.width).toBeLessThanOrEqual(room.width * 0.31);
	expect(size.height).toBeLessThanOrEqual(room.height * 0.31);
	// Framed on the main agent and the running one: larger than the whole graph was, and both are in the window.
	expect(await scaleOf(page)).toBeGreaterThan(whole);
	await expect.poll(() => inside(node(page, "Runner"), canvas(page))).toBe(true);
	await expect.poll(() => inside(node(page, "main"), canvas(page))).toBe(true);

	// A press on the top of the minimap moves the canvas to the top of the graph.
	const top = () => canvas(page).evaluate((el) => el.scrollTop);
	const before = await top();
	expect(before).toBeGreaterThan(0);
	const box = await boxOf(map);
	await page.mouse.click(box.x + box.width / 2, box.y + 8);
	await expect.poll(top).toBeLessThan(before);

	// A new subagent that runs (the frame is pushed after the person moved the view) leaves the view where it was put.
	const moved = await top();
	g.running.add("Latecomer");
	g.frame(lifecycle("Latecomer", "started", { parentToolCallId: "call_late" }));
	await expect(node(page, "Latecomer")).toBeVisible();
	expect(await top()).toBe(moved);
	// Fit frames it again.
	await page.getByTestId("agents-fit").click();
	await expect.poll(() => inside(node(page, "Latecomer"), canvas(page))).toBe(true);

	await page.getByTestId("agents-focus").click();
	await expect(page.getByTestId("agents-minimap")).toHaveCount(0);
	await page.getByTestId("agents-focus").click();

	// Remembered: the page again, from its address.
	await page.goto(`/#/agents/${encodeURIComponent(g.own.file)}`);
	await page.reload();
	await expect(page.getByTestId("agents-focus")).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("agents-minimap")).toBeVisible();
	await page.getByTestId("agents-focus").click();
	await page.reload();
	await expect(page.getByTestId("agents-focus")).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByTestId("agents-minimap")).toHaveCount(0);
});

test("turning Focus on, or changing Grid while it is on, frames what runs again after the view was moved and zoomed", async ({
	page,
}) => {
	await openBig(page, 0xec, "Graph scale reframe");
	const search = page.getByTestId("agents-search");
	const framed = async (where: string) => {
		await expect.poll(() => inside(node(page, "Runner"), canvas(page)), { message: `Runner, ${where}` }).toBe(true);
		await expect.poll(() => inside(node(page, "main"), canvas(page)), { message: `main, ${where}` }).toBe(true);
	};

	// The person searched (which moves the view) and zoomed in before ever using the switches: with Grid on, Focus is
	// still a view of what runs, not of wherever the search left the canvas.
	await search.fill(scoutId(13, 5));
	await expect(page.getByTestId("agents-search-count")).toHaveText("1 of 1");
	await search.fill("");
	await page.getByTestId("agents-zoom-in").click();
	await page.getByTestId("agents-grid").click();
	await page.getByTestId("agents-focus").click();
	await expect(page.getByTestId("agents-minimap")).toBeVisible();
	await framed("focus turned on after a search and a zoom, with grid siblings");

	// Moved again in focus (the view then stays where it was put), and Grid changes the layout under it: framed again.
	await search.fill("team07scout");
	await expect(page.getByTestId("agents-search-count")).toHaveText("1 of 12");
	await search.fill("");
	await page.getByTestId("agents-grid").click();
	await framed("grid turned off in focus");
	await page.getByTestId("agents-grid").click();
	await framed("grid turned on in focus");
});

test("the graph of hundreds of subagents has no accessibility violations, with the minimap and a search on", async ({
	page,
}) => {
	await openBig(page, 0xea, "Graph scale axe");
	const audit = async (where: string) => {
		const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
		expect(
			violations.map((v) => `${where}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
			where,
		).toEqual([]);
	};
	await audit("zoomed out, compact cards");
	await page.getByTestId("agents-focus").click();
	await page.getByTestId("agents-grid").click();
	await page.getByTestId("agents-search").fill("team03scout");
	await expect(page.getByTestId("agents-search-count")).toHaveText("1 of 12");
	await audit("grid, focus and a search");
	for (let i = 0; i < 6; i++) await page.getByTestId("agents-zoom-in").click();
	await expect(canvas(page)).toHaveAttribute("data-compact", "false");
	await audit("zoomed in, full cards");
});

test("the search keeps what is typed in it and the focus when the strip folds and unfolds", async ({ page }) => {
	const own = sessionWithSubagents(0xeb01, "Graph search fold", { Scout: [1], Other: [1] });
	await page.goto(`/#/agents/${encodeURIComponent(own.file)}`);
	await expect(node(page, "Scout")).toBeVisible();
	// The sidebar put away, so that narrowing the window opens no drawer over the page (it would take the focus).
	await page.getByRole("button", { name: "Hide sidebar" }).click();
	const search = page.getByTestId("agents-search");
	await search.fill("Sco");
	await search.evaluate((el) => {
		window.graphSearch = el;
	});
	const same = () => search.evaluate((el) => el === window.graphSearch);
	const wide = viewportOf(page);
	// Narrow: the strip folds behind Filters, and the field is the one that was typed in.
	await page.setViewportSize({ width: 390, height: wide.height });
	await expect(page.getByTestId("agents-more")).toBeVisible();
	await expect(search).toBeFocused();
	await expect(search).toHaveValue("Sco");
	expect(await same(), "the same field, folded").toBe(true);
	// Wide again: it unfolds around the same field.
	await page.setViewportSize(wide);
	await expect(page.getByTestId("agents-grid")).toBeVisible();
	await expect(search).toBeFocused();
	expect(await same(), "the same field, unfolded").toBe(true);
});

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the filters, the switches and the legend fold behind Filters; open, they wrap and fit the screen", async ({
		page,
	}) => {
		const own = sessionWithSubagents(0xeb, "Graph scale phone", { Scout: [1], Other: [1] });
		await page.goto(`/#/agents/${encodeURIComponent(own.file)}`);
		await expect(node(page, "Scout")).toBeVisible();
		const { width } = viewportOf(page);
		// Folded: the search is there, the rest is behind one button.
		const more = page.getByTestId("agents-more");
		await expect(page.getByTestId("agents-search")).toBeVisible();
		await expect(more).toHaveAttribute("aria-expanded", "false");
		for (const id of ["agents-filter-status", "agents-filter-time", "agents-grid", "agents-focus", "agents-legend"])
			await expect(page.getByTestId(id), `${id} is folded`).toHaveCount(0);
		await more.click();
		await expect(more).toHaveAttribute("aria-expanded", "true");
		await expect(page.getByTestId("agents-more-panel")).toBeVisible();
		await expect(page.getByTestId("agents-legend")).toBeVisible();
		// The button says what it opens and whether it is open; the panel it opens is as accessible as the strip was.
		await expect(more).toHaveAttribute(
			"aria-controls",
			(await page.getByTestId("agents-more-panel").getAttribute("id")) ?? "",
		);
		const found = await new AxeBuilder({ page }).include('[data-testid="agents-column"]').analyze();
		expect(found.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
		const ids = [
			"agents-filter-status",
			"agents-filter-time",
			"agents-search",
			"agents-more",
			"agents-grid",
			"agents-focus",
		];
		const boxes = [];
		for (const id of ids) {
			const box = await boxOf(page.getByTestId(id));
			expect(box.x, `${id} starts on the screen`).toBeGreaterThanOrEqual(0);
			expect(box.x + box.width, `${id} ends on the screen`).toBeLessThanOrEqual(width);
			boxes.push(box);
		}
		for (const [i, a] of boxes.entries())
			for (const [j, b] of boxes.entries()) if (i < j) expect(overlap(a, b), `${ids[i]} and ${ids[j]}`).toBe(false);
		// A filter that is on is counted on the button, so that it is seen with the panel shut.
		await statusFilter(page, "running").click();
		await expect(more).toHaveAttribute("data-on", "1");
		await expect(more).toContainText("1");
		await statusFilter(page, "all").click();
		await expect(more).toHaveAttribute("data-on", "0");
		// Nothing makes the page wider than the screen.
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
		await page.getByTestId("agents-focus").click();
		await expect(page.getByTestId("agents-minimap")).toBeVisible();
		expect(await inside(page.getByTestId("agents-minimap"), page.getByTestId("agents-page"))).toBe(true);
		// It does not cover the graph: about a third of the canvas at most, where it used to be half of a phone's.
		const map = await boxOf(page.getByTestId("agents-minimap"));
		const room = await boxOf(canvas(page));
		expect(map.width, "the minimap's width").toBeLessThanOrEqual(room.width * 0.31);
		expect(map.height, "the minimap's height").toBeLessThanOrEqual(room.height * 0.31);
	});

	test("beside an open subagent the graph has most of its column, and the strip stays in the graph's half", async ({
		page,
	}) => {
		const own = sessionWithSubagents(0xee, "Graph scale phone detail", { Scout: [1], Other: [1] });
		await page.goto(`/#/agents/${encodeURIComponent(own.file)}`);
		await node(page, "Scout").click();
		await expect(page.getByTestId("agents-detail")).toBeVisible();
		const aside = await boxOf(page.getByTestId("agents-detail"));
		// The graph, not the strip over it, has the column: at least half its height.
		const column = await boxOf(page.getByTestId("agents-column"));
		const room = await boxOf(canvas(page));
		expect(room.height, "the canvas's share of the column").toBeGreaterThanOrEqual(column.height * 0.5);
		await expect(page.getByTestId("agents-more")).toHaveAttribute("aria-expanded", "false");
		await page.getByTestId("agents-more").click();
		const strip = await boxOf(page.getByTestId("agents-controls"));
		// Narrow as the half is, nothing of the strip runs under the detail or out of the strip.
		expect(strip.x + strip.width).toBeLessThanOrEqual(aside.x + 1);
		const ids = [
			"agents-filter-status",
			"agents-filter-time",
			"agents-search",
			"agents-more",
			"agents-grid",
			"agents-focus",
		];
		const boxes = [];
		for (const id of ids) {
			const box = await boxOf(page.getByTestId(id));
			expect(box.x, `${id} starts on the screen`).toBeGreaterThanOrEqual(0);
			expect(box.x + box.width, `${id} ends before the detail`).toBeLessThanOrEqual(aside.x + 1);
			boxes.push(box);
		}
		for (const [i, a] of boxes.entries())
			for (const [j, b] of boxes.entries()) if (i < j) expect(overlap(a, b), `${ids[i]} and ${ids[j]}`).toBe(false);
		// Every choice is in its own box, whole.
		for (const group of ["agents-filter-status", "agents-filter-time"]) {
			const around = await boxOf(page.getByTestId(group));
			for (const button of await page.getByTestId(group).getByRole("button").all()) {
				const b = await boxOf(button);
				expect(b.x, `${group}: a choice starts inside it`).toBeGreaterThanOrEqual(around.x - 1);
				expect(b.x + b.width, `${group}: a choice ends inside it`).toBeLessThanOrEqual(around.x + around.width + 1);
			}
		}
		// The prompt of the empty search is read to its end, not cut at "Find by".
		const whole = await page.getByTestId("agents-search").evaluate((el: HTMLInputElement) => {
			const style = getComputedStyle(el);
			const ctx = document.createElement("canvas").getContext("2d");
			if (!ctx) throw new Error("no canvas context");
			ctx.font = style.font;
			const room = el.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
			return { text: ctx.measureText(el.placeholder).width, room };
		});
		expect(whole.text).toBeLessThanOrEqual(whole.room);
	});

	test("an open subagent's tokens, cost and time are each whole, side by side or on the next row (#789)", async ({
		page,
	}) => {
		const own = sessionWithSubagents(0xed03, "Graph phone stats", { Scout: [3], Other: [1] });
		await page.goto(`/#/agents/${encodeURIComponent(own.file)}`);
		await node(page, "Scout").click();
		// The time's figure, in its stat, in the row of the three.
		const elapsed = page.getByTestId("agents-detail").getByTestId("subagent-detail-elapsed");
		await expect(elapsed).toHaveText(/\dh \d\dm/);
		const items = await elapsed.locator("xpath=../..").evaluate((el) =>
			[...el.children].map((item) => {
				const r = item.getBoundingClientRect();
				const figure = item.firstElementChild as HTMLElement;
				return {
					text: item.textContent,
					box: { x: r.x, y: r.y, width: r.width, height: r.height },
					lines: figure.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(figure).lineHeight),
					spills: figure.scrollWidth > item.clientWidth + 1,
				};
			}),
		);
		expect(items).toHaveLength(3);
		for (const item of items) {
			expect(item.lines, `${item.text}: one line`).toBeLessThan(1.5);
			expect(item.spills, `${item.text}: inside its own box`).toBe(false);
		}
		for (const [i, a] of items.entries())
			for (const b of items.slice(i + 1)) expect(overlap(a.box, b.box), `${a.text} and ${b.text}`).toBe(false);
	});

	test.describe("touch", () => {
		// A touch screen: `(pointer: coarse)`.
		test.use({ hasTouch: true });

		test("an open card's Collapse is above its subagents and a 44px target for a finger (#786)", async ({ page }) => {
			// The conversation is started from the sidebar, which a phone hides: wide for that, a phone for the graph.
			const phone = viewportOf(page);
			await page.setViewportSize({ width: 1280, height: phone.height });
			await openBig(page, 0xed02, "Graph phone collapse");
			// The sidebar put away, so that narrowing the window opens no drawer over the page.
			await page.getByRole("button", { name: "Hide sidebar" }).click();
			await page.setViewportSize(phone);
			await summary(page, 0).focus();
			await page.keyboard.press("Enter");
			await expect(page.getByTestId("agents-collapse")).toHaveCount(1);
			const hit = await collapseHit(page);
			expect(hit.reached, "a press reaches Collapse").toBe(true);
			expect(hit.width).toBeGreaterThanOrEqual(44);
			expect(hit.height).toBeGreaterThanOrEqual(44);
			await page.getByTestId("agents-collapse").tap();
			await expect(summaries(page)).toHaveCount(CALLS);
		});
	});
});
