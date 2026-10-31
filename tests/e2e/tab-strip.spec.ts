import { startLive } from "../support/live.ts";
import { panelTab, topTab, topTabs } from "../support/panel.ts";
import { rpcState } from "../support/rpc-state.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { sessionWithSubagents } from "../support/subagent-fixtures.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * The side panel's tab strip (no model call): at the panel's default width every tab is on screen and clickable
 * with the counts of a busy conversation (Agents 1/55, Todos 12/20), in English and Chinese; when the panel is
 * narrower the active tab is kept in view, and the strip scrolls sideways, with the wheel, only as a fallback.
 */

const DEFAULT_WIDTH = 400;

async function openBusyPanel(page: Page, n: number, lang: "en" | "zh-CN") {
	const title = `Tab strip probe ${n}`;
	// 54 finished subagents, plus one that runs: the tab reads "1/55".
	const agents = Object.fromEntries(Array.from({ length: 54 }, (_, i) => [`Done${i}`, [1]]));
	sessionWithSubagents(n, title, agents);
	await page.addInitScript((l) => {
		localStorage.setItem("ompw.autoTitle", "off");
		localStorage.setItem("ompw.lang", l);
	}, lang);
	const tap = await tapSocket(page);
	await page.goto("/");
	const reveal = page.getByRole("button", { name: /Show sidebar|显示侧边栏/ });
	if (await reveal.isVisible()) await reveal.click();
	const liveId = await startLive(page, tap, title, `strip-probe-${n}`);
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	frame({
		type: "subagent_lifecycle",
		payload: {
			id: "Runner",
			agent: "explore",
			agentSource: "bundled",
			index: 0,
			status: "started",
			description: "Run",
		},
	});
	const tasks = Array.from({ length: 20 }, (_, i) => ({
		content: `Task ${i}`,
		status: i < 12 ? "completed" : "pending",
	}));
	tap.answer("get_state", () => ({ ok: true, data: rpcState({ todoPhases: [{ name: "All", tasks }] }) }));
	frame({ type: "tool_execution_end", toolCallId: `todo-${n}`, toolName: "todo", result: {} });
	await page.getByTestId("toggle-panel").click();
	const panel = page.getByTestId("right-panel");
	await expect(panel).toBeVisible();
	return panel;
}

/** Where each tab sits relative to the strip's visible box. */
async function placement(strip: Locator) {
	return strip.evaluate((el) => {
		const bar = el.getBoundingClientRect();
		return {
			overflows: el.scrollWidth > el.clientWidth,
			tabs: [...el.querySelectorAll('[role="tab"]')].map((t) => {
				const r = t.getBoundingClientRect();
				return { name: t.getAttribute("aria-label"), left: r.left - bar.left, right: bar.right - r.right };
			}),
		};
	});
}

for (const [lang, top, bottom] of [
	[
		"en",
		[/^Agents 1\/55$/, /^Todos 12\/20$/, /^Jobs 1\/1$/, /^Branches$/, /^Info$/, /^Guidance$/, /^Questions$/],
		[/^Files$/, /^Issues$/, /^CI$/, /^Ask$/, /^Host$/],
	],
	[
		"zh-CN",
		[/^子代理 1\/55$/, /^待办 12\/20$/, /^任务 1\/1$/, /^分支$/, /^信息$/, /^模型指引$/, /^问题$/],
		[/^文件$/, /^Issues$/, /^CI$/, /^提问$/, /^本机$/],
	],
] as const) {
	test(`at the default panel width every tab is whole and clickable, with counts (${lang})`, async ({ page }) => {
		const n = lang === "en" ? 0x70 : 0x71;
		const panel = await openBusyPanel(page, n, lang);
		await expect(topTab(panel, top[0])).toBeVisible();
		await expect(topTab(panel, top[1])).toBeVisible();
		expect(Math.round((await panel.boundingBox())?.width ?? 0)).toBe(DEFAULT_WIDTH);

		for (const [pane, tabs] of [
			["top", top],
			["bottom", bottom],
		] as const) {
			const strip = panel.getByTestId(`panel-pane-${pane}`).getByRole("tablist");
			const { overflows, tabs: spots } = await placement(strip);
			expect(overflows, `the ${pane} strip has nothing to scroll to`).toBe(false);
			for (const s of spots) {
				expect(s.left, `${s.name} starts inside the strip`).toBeGreaterThanOrEqual(0);
				expect(s.right, `${s.name} ends inside the strip`).toBeGreaterThanOrEqual(0);
			}
			// A click reaches each of them, the last too, with no scrolling needed first.
			for (const name of [...tabs].reverse()) {
				const tab = panelTab(panel, name);
				await tab.click();
				await expect(tab).toHaveAttribute("aria-selected", "true");
				expect((await placement(strip)).overflows).toBe(false);
			}
		}
	});
}

test("a narrower strip keeps the active tab in view, scrolls sideways as a fallback, and the wheel scrolls it", async ({
	page,
}) => {
	const panel = await openBusyPanel(page, 0x72, "en");
	const strip = topTabs(panel);
	// Narrower than even the icons and one label: the strip must scroll.
	await strip.evaluate((el) => {
		el.style.flex = "none";
		el.style.width = "120px";
	});
	await expect.poll(async () => (await placement(strip)).overflows).toBe(true);

	const visible = async (name: RegExp) => {
		const { tabs: spots } = await placement(strip);
		const tab = spots.find((s) => name.test(s.name ?? ""));
		return !!tab && tab.left >= 0 && tab.right >= 0;
	};
	// Going to the last tab (Left from the first wraps round) shows it; going back shows the first.
	await topTab(panel, /^Agents/).focus();
	await page.keyboard.press("ArrowLeft");
	await expect(topTab(panel, /^Questions$/)).toHaveAttribute("aria-selected", "true");
	await expect.poll(() => visible(/^Questions$/)).toBe(true);
	await page.keyboard.press("ArrowRight");
	await expect(topTab(panel, /^Agents/)).toHaveAttribute("aria-selected", "true");
	await expect.poll(() => visible(/^Agents/)).toBe(true);
	expect(await strip.evaluate((el) => el.scrollLeft)).toBe(0);

	// A vertical wheel over the strip moves it sideways.
	await strip.hover();
	await page.mouse.wheel(0, 60);
	await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
});
