import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_CWD } from "../support/fixtures.ts";
import { boxOf } from "../support/geometry.ts";
import { openSidebar, startLive } from "../support/live.ts";
import { topTab } from "../support/panel.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * The status line under the composer (the TUI's bottom line `13h › Opus 5.5 › Goal 1.5M › ~/omp › $173.34 (+198.96)
 * ── 39% ── 1M  👥 7`): how long the agent has worked, the model, the goal's budget, the folder, the cost with its
 * subagents', the context window and the agents running. What omp only reports after a model call (the model, the
 * context) is answered to the page, and the goal and the subagents arrive as pushed frames. No model call.
 */

const stamp = (ms: number) => new Date(ms).toISOString();

/**
 * One conversation whose single turn took 13 h 7 m 40 s (a prompt, and a reply that long after it) and cost $0.50.
 * `n` makes the file, its id and its title unique.
 */
function writeSession(n: number): string {
	const title = `Status line probe ${n}`;
	const id = `01a00000-0000-7000-8000-0000000099${n.toString(16).padStart(2, "0")}`;
	const prompt = Date.UTC(2026, 0, 10, 10, 0, 0);
	const reply = prompt + (13 * 3600 + 7 * 60 + 40) * 1000;
	const lines = [
		{ type: "session", version: 3, id, timestamp: stamp(prompt), cwd: FIXTURE_CWD, title },
		{
			type: "message",
			id: `st${n}01`,
			parentId: null,
			timestamp: stamp(prompt),
			message: { role: "user", content: [{ type: "text", text: title }], attribution: "user", timestamp: prompt },
		},
		{
			type: "message",
			id: `st${n}02`,
			parentId: `st${n}01`,
			timestamp: stamp(reply),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-5-5",
				usage: {
					input: 100,
					output: 50,
					cacheRead: 1000,
					cacheWrite: 0,
					totalTokens: 1150,
					cost: { total: 0.5 },
				},
				stopReason: "stop",
				timestamp: prompt + 1000,
			},
		},
	];
	const dir = join(process.env.OMPW_E2E_AGENT_DIR as string, "sessions", "-status-line-probe");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `2026-01-10T10-00-00-000Z_${id}.jsonl`),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);
	return title;
}

/** What omp reports of a conversation after a model call. */
const state = (percent: number) => ({
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	interruptMode: "immediate",
	messageCount: 2,
	queuedMessageCount: 0,
	thinkingLevel: "high",
	model: { id: "claude-opus-5-5", name: "Opus 5.5", provider: "anthropic", contextWindow: 1_000_000 },
	contextUsage: { tokens: percent * 10_000, contextWindow: 1_000_000, percent },
});

interface Running {
	page: Page;
	tap: SocketTap;
	frame: (f: Record<string, unknown>) => void;
}

/**
 * Start the conversation's own omp process, then tell the page what a model call would have: the model with its
 * thinking level, 39% of a 1M context, a goal 420k into a 1.5M budget, and two subagents running that have cost
 * $0.25 and $1.50 so far.
 */
async function openRunning(page: Page, n: number): Promise<Running> {
	const title = writeSession(n);
	// Auto-titling would send a prompt to the model when the pushed turn ends.
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	const liveId = await startLive(page, tap, title, `status-probe-${n}`);
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	tap.answer("get_state", () => ({ ok: true, data: state(39) }));
	// omp says its model changed (the first call does): the page reads the state. A goal's update does not make it read it.
	frame({ type: "model_changed" });
	frame({
		type: "goal_updated",
		goal: { id: "g1", objective: "Ship the release", status: "active", tokenBudget: 1_500_000, tokensUsed: 420_000 },
	});
	for (const [id, cost] of [
		["Scout", 0.25],
		["Mapper", 1.5],
	] as const) {
		frame({ type: "subagent_lifecycle", payload: { id, agent: "explore", index: 0, status: "started" } });
		frame({
			type: "subagent_progress",
			payload: {
				index: 0,
				agent: "explore",
				task: id,
				progress: { id, agent: "explore", status: "running", cost, tokens: 1000 },
			},
		});
	}
	return { page, tap, frame };
}

const line = (page: Page, id: string) => page.getByTestId("chat-status").getByTestId(id);

test.describe("a wide window", () => {
	test("the line shows every figure the TUI's does", async ({ page }) => {
		await openRunning(page, 0xa1);
		const status = page.getByTestId("chat-status");
		await expect(status).toBeVisible();
		// The turn took 13 h 7 m 40 s: working time is the time of the turns, not of the nights between them.
		await expect(line(page, "status-time")).toHaveText("Working time 13h 7m");
		await expect(line(page, "status-model")).toContainText("Opus 5.5");
		await expect(line(page, "status-thinking")).toHaveText("High");
		await expect(line(page, "status-goal")).toHaveText("Goal 420k / 1.5M");
		await expect(line(page, "status-goal")).toHaveAttribute("title", "Ship the release");
		// The folder is also the way to another one (Change folder…).
		await expect(line(page, "status-cwd")).toHaveAttribute("title", `${FIXTURE_CWD} · Change folder…`);
		await expect(line(page, "status-cwd")).toContainText("ompw-fixture-project");
		const cost = line(page, "status-cost");
		await expect(cost).toContainText("$0.50");
		await expect(cost).toContainText("(+$1.75)");
		expect(Number(await cost.getAttribute("data-main"))).toBeCloseTo(0.5, 9);
		expect(Number(await cost.getAttribute("data-subagents"))).toBeCloseTo(1.75, 9);
		const context = line(page, "status-context");
		await expect(context).toContainText("39%");
		await expect(context).toContainText("/ 1M");
		await expect(context).toHaveAttribute("data-percent", "39");
		await expect(line(page, "status-agents")).toHaveAttribute("data-running", "2");
		// Everything fits beside the title: no menu.
		await expect(page.getByTestId("chat-more")).toHaveCount(0);
	});

	test("the agents count opens the Agents tab of the side panel, wherever the panel was", async ({ page }) => {
		await openRunning(page, 0xa2);
		await page.getByTestId("toggle-panel").click();
		await topTab(page, /Info/).click();
		await expect(page.getByRole("tab", { name: /Info/, selected: true })).toBeVisible();
		await page.getByRole("button", { name: "Agents running: 2. Open the list." }).click();
		await expect(page.getByRole("tab", { name: /Agents/, selected: true })).toBeVisible();
		await expect(page.getByTestId("subagent-list")).toBeVisible();
		await expect(page.getByTestId("subagent-item")).toHaveCount(2);
	});

	test("a conversation set to auto says Auto with the level omp resolved it to, until a level is picked", async ({
		page,
	}) => {
		const { frame } = await openRunning(page, 0xa9);
		// omp reports the level `auto` resolved to as the conversation's level (`high` here), and `auto` as configured.
		frame({ type: "thinking_level_changed", thinkingLevel: "high", configured: "auto" });
		await expect(line(page, "status-thinking")).toHaveText("Auto (High)");
		frame({ type: "thinking_level_changed", thinkingLevel: "low" });
		await expect(line(page, "status-thinking")).toHaveText("Low");
	});

	test("a goal that is paused says so; a subagent that ends leaves the count", async ({ page }) => {
		const { frame } = await openRunning(page, 0xa3);
		frame({
			type: "goal_updated",
			goal: { id: "g1", objective: "Ship the release", status: "paused", tokenBudget: 1_500_000, tokensUsed: 500_000 },
		});
		await expect(line(page, "status-goal")).toContainText("Goal 500k / 1.5M");
		await expect(line(page, "status-goal")).toContainText("paused");
		await expect(line(page, "status-goal")).toHaveAttribute("data-status", "paused");
		frame({ type: "subagent_lifecycle", payload: { id: "Scout", agent: "explore", index: 0, status: "completed" } });
		await expect(line(page, "status-agents")).toHaveAttribute("data-running", "1");
		frame({ type: "subagent_lifecycle", payload: { id: "Mapper", agent: "explore", index: 0, status: "completed" } });
		await expect(page.getByTestId("status-agents")).toHaveCount(0);
		// Their cost stays: it was spent.
		await expect(line(page, "status-cost")).toContainText("(+$1.75)");
		frame({ type: "goal_updated", goal: null });
		await expect(page.getByTestId("status-goal")).toHaveCount(0);
	});

	test("the context figure follows the turn: it is asked for again as each request ends", async ({ page }) => {
		const { tap, frame } = await openRunning(page, 0xa4);
		await expect(line(page, "status-context")).toHaveAttribute("data-percent", "39");
		const asked = tap.commands("get_state").length;
		// The next state omp reports has more of the window used; only a running turn's new entry makes the page ask.
		tap.answer("get_state", () => ({ ok: true, data: state(45) }));
		let served = false;
		tap.answer("get_entries", () => {
			const entries = served
				? []
				: [
						{
							type: "message",
							id: "ctx-asst",
							parentId: (tap.replies("get_entries").at(-1) as { leafId?: string } | undefined)?.leafId ?? null,
							timestamp: stamp(Date.UTC(2026, 0, 10, 23, 8, 0)),
							message: {
								role: "assistant",
								content: [{ type: "text", text: "More." }],
								usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
								stopReason: "toolUse",
								timestamp: Date.UTC(2026, 0, 10, 23, 7, 59),
							},
						},
					];
			served = true;
			return { ok: true, data: { entries, leafId: "ctx-asst" } };
		});
		frame({ type: "agent_start" });
		frame({ type: "message_end", messageId: "m1", message: { role: "assistant", content: [] } });
		await expect(line(page, "status-context")).toHaveAttribute("data-percent", "45");
		expect(tap.commands("get_state").length).toBeGreaterThan(asked);
	});
});

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the line keeps the model, the context and the agents; the working time and the goal are in the menu", async ({
		page,
	}) => {
		await openRunning(page, 0xa5);
		await expect(line(page, "status-model")).toContainText("Opus 5.5");
		await expect(line(page, "status-context")).toHaveAttribute("data-percent", "39");
		await expect(line(page, "status-agents")).toHaveAttribute("data-running", "2");
		// What is folded is in the menu, or on the line, never both. How much folds depends on the fonts' widths (Linux's are
		// narrower than macOS's): at least the folder, the working time and the goal, in the line's order.
		const status = page.getByTestId("chat-status");
		await expect(status).toHaveAttribute("data-folds", /^cwd time goal/);
		const folds = ((await status.getAttribute("data-folds")) ?? "").split(" ");
		expect(folds).toEqual(FOLD_ORDER.slice(0, folds.length));
		for (const folded of folds) await expect(page.getByTestId(`status-${folded}`), folded).toHaveCount(0);
		// It fits the screen, in one line of figures.
		const box = await boxOf(status);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
		// One row of text-xs (24 px with its minimum): a second row, with the context figure alone on it, would be 34.
		expect(box.height).toBeLessThan(28);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no sideways scroll").toBe(
			true,
		);

		await page.getByTestId("chat-more").click();
		const menu = page.getByTestId("chat-more-panel");
		await expect(menu.getByTestId("status-time")).toHaveText("13h 7m");
		await expect(menu.getByTestId("status-goal")).toHaveText("Goal 420k / 1.5M");
		// The cost is the menu's own, with the subagents' share.
		await expect(menu.getByTestId("usage-split")).toHaveAttribute("data-subagent-cost", "1.75");
		await expect(page.getByTestId("chat-status").getByTestId("status-time")).toHaveCount(0);
	});

	test("the agents count is a button a finger can hit", async ({ page }) => {
		await openRunning(page, 0xa6);
		const button = page.getByRole("button", { name: "Agents running: 2. Open the list." });
		const box = await boxOf(button);
		expect(box.height).toBeGreaterThanOrEqual(24);
		expect(box.width).toBeGreaterThanOrEqual(24);
		await button.click();
		await expect(page.getByTestId("right-panel")).toBeVisible();
		await expect(page.getByTestId("subagent-list")).toBeVisible();
	});
});

/**
 * What the line can show, and what the header can show beside its title (each is on one of them, or in the menu).
 * `rename` is the header's Rename (a pencil beside the title, a row in the menu).
 */
const LINE_ITEMS = [
	"status-time",
	"status-model",
	"status-goal",
	"status-cwd",
	"status-cost",
	"status-context",
	"status-agents",
];
/** What the line puts elsewhere, in the order it gives them up (`STATUS_STEPS`). */
const FOLD_ORDER = ["cwd", "time", "goal", "cost"];
const HEADER_ITEMS = ["rename", "session-cost", "export-html", "session-controls", "open-goal", "open-loaded"];

/** What the line and the header show at the page's width now, whether they keep to their row, and what the menu lists. */
async function layoutNow(page: Page) {
	// Two frames: what the resize changed is measured, and what that gave way is drawn.
	await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
	const header = page.locator("header").filter({ has: page.getByTestId("chat-title") });
	const renameIn = async (root: Locator) =>
		(await root.getByRole("button", { name: "Rename", exact: true }).count()) > 0 ? ["rename"] : [];
	const shown = await page.evaluate(
		({ lineItems, headerItems }) => {
			const header = document.querySelector<HTMLElement>("header:has([data-testid=chat-title])");
			const line = document.querySelector<HTMLElement>("[data-testid=chat-status]");
			if (!header || !line) throw new Error("no header or status line");
			const on = (root: HTMLElement, ids: string[]) => ids.filter((id) => root.querySelector(`[data-testid="${id}"]`));
			const room = line.getBoundingClientRect();
			const items = [...line.children].map((c) => c.getBoundingClientRect()).filter((b) => b.width > 0);
			return {
				line: on(line, lineItems),
				header: on(header, headerItems),
				folds: line.dataset.folds ?? "",
				// One row, every item inside the line and after the one before it: nothing overlaps.
				lineOneRow: room.height < 28,
				lineInside: items.every((b) => b.left >= room.left - 0.5 && b.right <= room.right + 0.5),
				lineApart: items.every((b, i) => i === 0 || b.left >= items[i - 1].right),
				headerInside: header.scrollWidth <= header.clientWidth,
				headerHeight: header.getBoundingClientRect().height,
				title: document.querySelector("[data-testid=chat-title]")?.getBoundingClientRect().width ?? 0,
				hasMenu: Boolean(header.querySelector("[data-testid=chat-more]")),
			};
		},
		{ lineItems: LINE_ITEMS, headerItems: HEADER_ITEMS.filter((id) => id !== "rename") },
	);
	shown.header.unshift(...(await renameIn(header)));
	let menu: string[] = [];
	if (shown.hasMenu) {
		await page.getByTestId("chat-more").click();
		const panel = page.getByTestId("chat-more-panel");
		await expect(panel).toBeVisible();
		menu = await panel.evaluate(
			(el, ids) => ids.filter((id) => el.querySelector(`[data-testid="${id}"]`)),
			[...HEADER_ITEMS.filter((id) => id !== "rename"), "status-time", "status-goal"],
		);
		menu.unshift(...(await renameIn(panel)));
		await page.keyboard.press("Escape");
		await expect(panel).toHaveCount(0);
	}
	return { ...shown, menu };
}

test.describe("the line and the header at several widths", () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test("a wider column shows more; nothing overlaps or wraps; what is not shown is in the menu, and only that", async ({
		page,
	}) => {
		await openRunning(page, 0xaa);
		await expect(line(page, "status-context")).toHaveAttribute("data-percent", "39");
		await expect(line(page, "status-agents")).toHaveAttribute("data-running", "2");
		const panel = page.getByTestId("right-panel");
		// The sidebar put away (a 48 px rail), so that narrowing the window opens no drawer over the page.
		await page.getByRole("button", { name: "Hide sidebar" }).click();
		// From the widest column to the narrowest: the rail's 48 px and the side panel's 400 px take from the window's.
		const widths = [
			{ width: 1400, panel: false },
			{ width: 1568, panel: true },
			{ width: 800, panel: false },
			{ width: 1100, panel: true },
			{ width: 390, panel: false },
		];
		let before = Number.POSITIVE_INFINITY;
		for (const { width, panel: open } of widths) {
			const where = `${width} px${open ? " with the side panel" : ""}`;
			// The panel is closed while the window is wide: below 1024 px it is a sheet over the column.
			if (!open && (await panel.isVisible())) await page.getByTestId("right-panel-close").click();
			await page.setViewportSize({ width, height: 900 });
			if (open && !(await panel.isVisible())) await page.getByTestId("toggle-panel").click();
			await expect(panel).toBeVisible({ visible: open });
			const s = await layoutNow(page);

			expect(s.lineOneRow, `${where}: the line is one row`).toBe(true);
			expect(s.lineInside && s.lineApart, `${where}: the line's items are apart, inside it`).toBe(true);
			expect(s.headerInside, `${where}: nothing hangs off the header`).toBe(true);
			expect(s.headerHeight, `${where}: the header is one row`).toBeLessThanOrEqual(53);
			expect(s.title, `${where}: the title keeps its room`).toBeGreaterThanOrEqual(90);
			// The figures that matter most never leave the line.
			for (const id of ["status-model", "status-context", "status-agents"])
				expect(s.line, `${where}: ${id}`).toContain(id);
			// The header's own items are beside the title or in the menu, never both, never neither.
			for (const id of HEADER_ITEMS) {
				expect(Number(s.header.includes(id)) + Number(s.menu.includes(id)), `${where}: ${id} once`).toBe(1);
			}
			// The line's working time and goal are on it or in the menu; the folder on it or in the header (its path then);
			// the cost on it, or the header's own cost (on the header or in the menu) says it.
			for (const id of ["status-time", "status-goal"]) {
				expect(Number(s.line.includes(id)) + Number(s.menu.includes(id)), `${where}: ${id} once`).toBe(1);
			}
			expect(s.line.includes("status-cwd"), `${where}: the folder is on the line or folded`).toBe(
				!s.folds.split(" ").includes("cwd"),
			);
			// What gives way goes in the line's order, the least needed first.
			const folds = s.folds ? s.folds.split(" ") : [];
			expect(folds, `${where}: folded in order`).toEqual(FOLD_ORDER.slice(0, folds.length));
			// The menu is there while it lists something: what is not shown, and only that (above).
			expect(s.hasMenu, `${where}: a menu only for what is not shown`).toBe(s.menu.length > 0);
			const count = s.line.length + s.header.length;
			expect(count, `${where}: no more shown than in a wider column`).toBeLessThanOrEqual(before);
			before = count;
			if (width === 1568) {
				// The window of the screenshot this was asked for: the line has room for the model, the context, the folder
				// and the cost (and the rest of its figures), not only one of them.
				for (const id of [
					"status-model",
					"status-context",
					"status-cwd",
					"status-cost",
					"status-time",
					"status-goal",
				]) {
					expect(s.line, `${where}: ${id}`).toContain(id);
				}
			}
			if (width === 1400) {
				expect(s.menu, "a wide window has nothing to fold").toEqual([]);
				expect(s.line).toEqual(LINE_ITEMS);
			}
			if (width === 390) {
				expect(s.line).toEqual(expect.arrayContaining(["status-model", "status-context", "status-agents"]));
				expect(s.line).not.toContain("status-cwd");
				expect(s.menu).toEqual(
					expect.arrayContaining(["rename", "session-cost", "export-html", "status-time", "status-goal"]),
				);
			}
		}

		// The header's menu and the line follow the column both ways: back at the widest, everything is out again.
		await page.setViewportSize({ width: 1400, height: 900 });
		const wide = await layoutNow(page);
		expect(wide.line).toEqual(LINE_ITEMS);
		expect(wide.header).toEqual(HEADER_ITEMS);
		expect(wide.menu).toEqual([]);
	});

	test("with the side panel open the line keeps the figures it has room for, and closing the panel gives the rest back", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openRunning(page, 0xa7);
		for (const id of LINE_ITEMS) await expect(line(page, id), id).toBeVisible();
		// The panel (400 px) leaves the column 592 px: the folder gives way first (the header's path then), the working time
		// too where the fonts are wider (macOS); the goal and the cost stay.
		await line(page, "status-agents").click();
		await expect(page.getByTestId("right-panel")).toBeVisible();
		const status = page.getByTestId("chat-status");
		await expect(status).toHaveAttribute("data-folds", /^cwd/);
		const folds = ((await status.getAttribute("data-folds")) ?? "").split(" ");
		expect(folds).toEqual(FOLD_ORDER.slice(0, folds.length));
		for (const id of ["status-model", "status-goal", "status-cost", "status-context", "status-agents"]) {
			await expect(line(page, id), id).toBeVisible();
		}
		await expect(page.getByTestId("status-cwd")).toHaveCount(0);
		await expect(page.getByTestId("chat-cwd")).toContainText("ompw-fixture-project");
		// The working time is in the menu if it gave way, else on the line (and the header may then have nothing to fold).
		if (folds.includes("time")) {
			await page.getByTestId("chat-more").click();
			const menu = page.getByTestId("chat-more-panel");
			await expect(menu.getByTestId("status-time")).toHaveText("13h 7m");
			await expect(menu.getByTestId("status-goal")).toHaveCount(0);
			await page.keyboard.press("Escape");
		} else {
			await expect(line(page, "status-time")).toHaveText("13h 7m");
		}
		await page.getByTestId("right-panel-close").click();
		for (const id of LINE_ITEMS) await expect(line(page, id), id).toBeVisible();
		await expect(page.getByTestId("chat-status")).not.toHaveAttribute("data-folds");
	});
});

test("the line is in Chinese when the interface is", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	await openRunning(page, 0xa8);
	await expect(line(page, "status-goal")).toHaveText("目标 420k / 1.5M");
	await expect(line(page, "status-thinking")).toHaveText("高");
	await expect(line(page, "status-time")).toHaveText("工作时长 13小时7分");
	await expect(page.getByRole("button", { name: "运行中的子代理：2。点击查看列表。" })).toBeVisible();
});
