import AxeBuilder from "@axe-core/playwright";
import type { HostHistory } from "../../shared/host.ts";
import { FIXTURE } from "../support/fixtures.ts";
import { boxOf } from "../support/geometry.ts";
import { HOUR, historyAt, lookAt, PROCS, stubHost } from "../support/host-fixtures.ts";
import { appReady, openSidebar, sessionRow } from "../support/live.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The host's load (#613) from the page: the sidebar's line (CPU, GPU, memory and a dot for the memory pressure), its popover
 * of graphs, the side panel's Host tab and the rail's version of the line. The first describe puts a stand-in for the
 * server's sampler at the page's boundary (`tests/support/host-fixtures.ts`), so that every figure on screen is one this spec
 * chose; the last one runs the real server and its real sampler (at a fast pace) and checks only what has to hold of any
 * computer's figures. No model call.
 */

const chip = (page: Page) => page.getByTestId("host-chip");
const popover = (page: Page) => page.getByTestId("host-popover");

/** A page at `/` with the app on screen, the sidebar shown, and what it asks of the server's sampler answered by `history`. */
async function open(page: Page, history: HostHistory) {
	const host = await stubHost(page, history);
	await page.goto("/");
	await openSidebar(page);
	await expect(chip(page)).toBeVisible();
	return host;
}

test.describe("with figures the spec chose", () => {
	test("the line says CPU, GPU and memory as the history's last look had them, and each look that comes after it", async ({
		page,
	}) => {
		const now = Date.now();
		const history = historyAt(now);
		const host = await open(page, history);
		const last = lookAt(history.fine.t.at(-1) as number);
		await expect(page.getByTestId("host-figures")).toHaveText(
			`CPU ${Math.round(last.cpu)}% · GPU ${Math.round(last.gpu as number)}% · MEM ${Math.round(last.mem as number)}%`,
		);
		await expect(chip(page)).toHaveAttribute("data-level", "0");
		await expect(page.getByTestId("host-dot")).toHaveClass(/bg-success/);
		await expect(chip(page)).toHaveAttribute(
			"aria-label",
			/Host load: CPU \d+%, GPU \d+%, MEM \d+%\. Memory pressure: Normal\./,
		);

		await host.push({ cpu: 88, gpu: 41, mem: 73, pressure: 1 });
		await expect(page.getByTestId("host-figures")).toHaveText("CPU 88% · GPU 41% · MEM 73%");
		await expect(chip(page)).toHaveAttribute("data-level", "1");
		await expect(page.getByTestId("host-dot")).toHaveClass(/bg-warning/);

		await host.push({ cpu: 100, gpu: 99, mem: 97, pressure: 2 });
		await expect(page.getByTestId("host-dot")).toHaveClass(/bg-danger/);
		await expect(chip(page)).toHaveAttribute("aria-label", /Memory pressure: Critical\./);
	});

	test("a computer with no GPU to read has none on the line, nor a tile, nor a graph", async ({ page }) => {
		await open(page, historyAt(Date.now(), { noGpu: true }));
		await expect(page.getByTestId("host-figures")).toHaveText(/^CPU \d+% · MEM \d+%$/);
		await expect(chip(page)).not.toHaveAttribute("aria-label", /GPU/);
		await chip(page).click();
		await expect(popover(page)).toBeVisible();
		await expect(page.getByTestId("host-tile-cpu")).toBeVisible();
		await expect(page.getByTestId("host-tile-mem")).toBeVisible();
		await expect(page.getByTestId("host-tile-gpu")).toHaveCount(0);
		await expect(page.getByTestId("host-chart-gpu")).toHaveCount(0);
		await expect(page.getByTestId("host-chart-cpu")).toBeVisible();
	});

	test("a computer that tells no memory pressure has a neutral dot and says nothing of pressure", async ({ page }) => {
		const history = historyAt(Date.now(), { info: { pressure: false } });
		history.fine.pressure = history.fine.pressure.map(() => null);
		history.coarse.pressure = history.coarse.pressure.map(() => null);
		await open(page, history);
		await expect(page.getByTestId("host-dot")).toHaveClass(/bg-faint/);
		await expect(chip(page)).toHaveAttribute("aria-label", /^Host load: CPU \d+%, GPU \d+%, MEM \d+%\.$/);
		await chip(page).click();
		await expect(page.getByTestId("host-pressure")).toHaveCount(0);
	});

	test("the popover has the tiles, three graphs of the hour, the processes and how the figures are taken", async ({
		page,
	}) => {
		const now = Date.now();
		const host = await open(page, historyAt(now));
		await chip(page).click();
		await expect(popover(page)).toBeVisible();
		await expect(popover(page).getByRole("heading", { name: "Host load" })).toBeVisible();

		const last = lookAt(now - 30_000);
		await expect(page.getByTestId("host-tile-cpu-value")).toHaveText(`${Math.round(last.cpu)}%`);
		await expect(page.getByTestId("host-tile-cpu")).toContainText("12 cores");
		await expect(page.getByTestId("host-tile-gpu")).toContainText("Apple M4 Pro · 16 cores");
		await expect(page.getByTestId("host-tile-mem")).toContainText("of 24 GB");
		await expect(page.getByTestId("host-pressure")).toHaveAttribute("data-level", "0");
		await expect(page.getByTestId("host-pressure")).toHaveText("Normal");

		// 1 h at 30 s: 120 looks, fewer than the graph's limit, drawn as they are.
		for (const series of ["cpu", "gpu", "mem"]) {
			const graph = page.getByTestId(`host-chart-${series}`);
			await expect(graph).toBeVisible();
			await expect(graph).toHaveAttribute("data-points", "120");
			await expect(graph).toHaveAttribute("aria-label", /last 1 h: now \d+%, highest \d+%/);
			// The area is drawn: a path with a shape, in the series' own palette colour.
			const area = graph.locator("path.recharts-area-area");
			await expect(area).toHaveCount(1);
			expect((await boxOf(area)).width).toBeGreaterThan(150);
		}
		await expect(page.getByTestId("host-charts")).toHaveAttribute("data-range", "1h");
		await expect(page.getByTestId("host-footer")).toContainText(
			"every 2 s while a page shows these graphs, and every 10 s while only the sidebar's line does",
		);
		await expect(page.getByTestId("host-footer")).toContainText("starts over when it restarts");

		// The pane asks for the processes too; they come with the next look.
		await expect.poll(() => host.watches.some((w) => w.on && w.procs)).toBe(true);
		await expect(page.getByTestId("host-procs")).toContainText("Looking at the processes");
		await host.push({ cpu: 30 }, { procs: PROCS });
		const procs = page.getByTestId("host-procs");
		await expect(page.getByTestId("host-proc-server")).toContainText("omp-webui server");
		await expect(page.getByTestId("host-proc-server-cpu")).toHaveText("1.4%");
		await expect(page.getByTestId("host-proc-omp")).toContainText("2 conversations");
		await expect(page.getByTestId("host-proc-omp-cpu")).toHaveText("38%");
		await expect(page.getByTestId("host-proc-omp")).toContainText("1.2 GB");
		await expect(page.getByTestId("host-proc-relay")).toContainText("Relays");
		await expect(procs).toContainText("100% is one core fully busy");
	});

	test("the day is a graph of its own, a point a minute", async ({ page }) => {
		await open(page, historyAt(Date.now()));
		await chip(page).click();
		await expect(page.getByTestId("host-range-1h")).toHaveAttribute("aria-pressed", "true");
		await page.getByTestId("host-range-24h").click();
		await expect(page.getByTestId("host-range-24h")).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByTestId("host-charts")).toHaveAttribute("data-range", "24h");
		// 1440 minutes, brought down to what the graph can show.
		const points = Number(await page.getByTestId("host-chart-cpu").getAttribute("data-points"));
		expect(points).toBeGreaterThan(300);
		expect(points).toBeLessThanOrEqual(485);
		await expect(page.getByTestId("host-chart-cpu")).toHaveAttribute("aria-label", /last 24 h/);
	});

	test("memory pressure above normal is shaded on the memory graph, amber for a warning and red for critical", async ({
		page,
	}) => {
		await open(
			page,
			historyAt(Date.now(), {
				pressure: [
					[40, 60, 1],
					[80, 100, 2],
				],
			}),
		);
		await chip(page).click();
		const bands = page.getByTestId("host-chart-mem").getByTestId("host-pressure-band");
		await expect(bands).toHaveCount(2);
		await expect(bands.nth(0)).toHaveAttribute("data-level", "1");
		await expect(bands.nth(1)).toHaveAttribute("data-level", "2");
		await expect(page.getByTestId("host-popover")).toContainText("Shaded where memory pressure was above normal");
		// Only the memory graph has them.
		await expect(page.getByTestId("host-chart-cpu").getByTestId("host-pressure-band")).toHaveCount(0);
	});

	test("with fewer than two looks there is no graph to draw, and it says why", async ({ page }) => {
		await open(page, historyAt(Date.now(), { fine: 1 }));
		await chip(page).click();
		await expect(page.getByTestId("host-empty")).toContainText("Collecting the first figures");
		await expect(page.getByTestId("host-charts")).toHaveCount(0);
		// The tiles already have the one look.
		await expect(page.getByTestId("host-tile-cpu-value")).toHaveText(/^\d+%$/);
	});

	test("a history that has a gap in it is broken there, not drawn across", async ({ page }) => {
		const now = Date.now();
		const history = historyAt(now);
		// Ten minutes in the middle with no looks (the Mac was asleep).
		const keep = history.fine.t.map((t) => t < now - 40 * 60_000 || t > now - 30 * 60_000);
		for (const column of ["t", "cpu", "gpu", "mem", "pressure"] as const) {
			(history.fine[column] as unknown[]) = (history.fine[column] as unknown[]).filter((_, i) => keep[i]);
		}
		await open(page, history);
		await chip(page).click();
		// One more row than looks: the row of nothing that breaks the line.
		await expect(page.getByTestId("host-chart-cpu")).toHaveAttribute("data-points", String(history.fine.t.length + 1));
		// Two areas, or one broken in two: the path has two "move to"s.
		const d = await page.getByTestId("host-chart-cpu").locator("path.recharts-area-area").getAttribute("d");
		expect((d?.match(/M/g) ?? []).length).toBeGreaterThanOrEqual(2);
	});

	test("what the page tells the server: the line watches without the graphs (the background pace), the pane adds them and the processes while it is open, nothing while hidden", async ({
		page,
	}) => {
		const host = await open(page, historyAt(Date.now()));
		// The sidebar's line alone: the server is told to watch, at its background pace (no `detail`).
		await expect.poll(() => host.watches.at(-1)).toEqual({ on: true });
		await chip(page).click();
		// The popover: the graphs (`detail`) and the process table.
		await expect.poll(() => host.watches.at(-1)).toEqual({ on: true, detail: true, procs: true });
		await page.keyboard.press("Escape");
		await expect(popover(page)).toHaveCount(0);
		await expect.poll(() => host.watches.at(-1)).toEqual({ on: true });

		// A tab nobody sees watches nothing.
		await page.evaluate(() => {
			Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await expect.poll(() => host.watches.at(-1)).toEqual({ on: false });
		await page.evaluate(() => {
			Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await expect.poll(() => host.watches.at(-1)).toEqual({ on: true });
	});

	test("the history is read again when the page is shown after being away", async ({ page }) => {
		let reads = 0;
		const now = Date.now();
		await stubHost(page, historyAt(now));
		await page.route("**/api/host", (route) => {
			reads++;
			return route.fulfill({ json: historyAt(Date.now()) });
		});
		await page.goto("/");
		await openSidebar(page);
		await expect(chip(page)).toBeVisible();
		await expect.poll(() => reads).toBe(1);
		await page.evaluate(() => {
			Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await page.evaluate(() => {
			Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await expect.poll(() => reads).toBe(2);
	});

	test("a history that cannot be read leaves the line to the looks that come over the socket, and says so in the popover", async ({
		page,
	}) => {
		const host = await stubHost(page, historyAt(Date.now()));
		await page.route("**/api/host", (route) => route.fulfill({ status: 500, json: { error: "no" } }));
		await page.goto("/");
		await openSidebar(page);
		await expect(chip(page)).toBeVisible();
		await chip(page).click();
		await expect(page.getByTestId("host-load-failed")).toBeVisible();
		await host.push({ cpu: 55, gpu: 5, mem: 60 });
		await expect(page.getByTestId("host-figures")).toContainText("CPU 55%");
	});

	test("without a connection the line is told apart and stays readable, says the figures are the last it had; with one again it says what it watches anew", async ({
		page,
	}) => {
		const host = await open(page, historyAt(Date.now()));
		await expect(chip(page)).toHaveAttribute("data-connected", "true");
		const told = host.watches.filter((w) => w.on).length;
		host.cut();
		await expect(chip(page)).toHaveAttribute("data-connected", "false");
		// Told apart in the faint ink, and still 4.5:1 (faded to half opacity it was 2.2:1).
		const { violations } = await new AxeBuilder({ page })
			.include('[data-testid="host-chip"]')
			.withRules(["color-contrast"])
			.analyze();
		expect(violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")))).toEqual([]);
		await expect(chip(page)).toHaveAttribute("aria-label", /Not connected: these are the last figures received\.$/);
		// The figures it had are still there.
		await expect(page.getByTestId("host-figures")).toHaveText(/^CPU \d+% · GPU \d+% · MEM \d+%$/);
		host.reconnect();
		await expect(chip(page)).toHaveAttribute("data-connected", "true", { timeout: 30_000 });
		// The server forgot what the old connection watched: the new one is told.
		await expect.poll(() => host.watches.filter((w) => w.on).length).toBeGreaterThan(told);
	});
});

test.describe("the rail of a sidebar that is put away", () => {
	test("has the three bars and the dot, and the popover opens beside it", async ({ page }) => {
		await open(page, historyAt(Date.now()));
		await page.getByRole("button", { name: "Hide sidebar" }).click();
		const rail = page.getByRole("navigation", { name: "Shortcuts of the hidden sidebar" });
		await expect(rail).toBeVisible();
		const railChip = rail.getByTestId("host-chip");
		await expect(railChip).toBeVisible();
		await expect(railChip).toHaveAttribute("data-variant", "rail");
		await expect(railChip).toHaveAttribute("aria-label", /Host load: CPU \d+%, GPU \d+%, MEM \d+%/);
		expect((await boxOf(railChip)).width).toBeLessThanOrEqual(48);
		await railChip.click();
		await expect(popover(page)).toBeVisible();
		// To the right of the rail, inside the window.
		const box = await boxOf(popover(page));
		expect(box.x).toBeGreaterThanOrEqual(48);
		expect(box.x + box.width).toBeLessThanOrEqual(1400);
	});
});

test.describe("the side panel's Host tab", () => {
	test("is a tab like the others: the tiles, the graphs and the processes", async ({ page }) => {
		const host = await open(page, historyAt(Date.now()));
		await sessionRow(page, FIXTURE.gammaTitle).click();
		await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.gammaTitle);
		await page.getByTestId("toggle-panel").click();
		await expect(page.getByTestId("right-panel")).toBeVisible();
		await page.getByTestId("pane-tab-host").click();
		const tab = page.getByTestId("host-tab");
		await expect(tab).toBeVisible();
		await expect(tab.getByTestId("host-tile-cpu")).toBeVisible();
		await expect(tab.getByTestId("host-chart-cpu")).toBeVisible();
		await expect(tab.getByTestId("host-chart-mem")).toBeVisible();
		// The pane has no heading of its own (the tab names it), and nothing spills out of the panel's width.
		await expect(tab.getByRole("heading", { name: "Host load" })).toHaveCount(0);
		const panelBox = await boxOf(page.getByTestId("right-panel"));
		const tabBox = await boxOf(tab);
		expect(tabBox.x + tabBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
		await host.push({ cpu: 20 }, { procs: PROCS });
		await expect(tab.getByTestId("host-proc-omp")).toContainText("2 conversations");
		// The tab is listed by its name in the tab row.
		await expect(page.getByTestId("pane-tab-host")).toHaveAttribute("title", "Host");
	});
});

test.describe("in Chinese", () => {
	test.use({ locale: "zh-CN" });

	test("the line, the pressure and the pane are in Chinese, with CPU and GPU in Latin", async ({ page }) => {
		const host = await open(page, historyAt(Date.now(), { pressure: [[40, 60, 1]] }));
		await expect(page.getByTestId("host-figures")).toHaveText(/^CPU \d+% · GPU \d+% · 内存 \d+%$/);
		await expect(chip(page)).toHaveAttribute("aria-label", /本机负载：CPU \d+%, GPU \d+%, 内存 \d+%。内存压力：正常。/);
		await chip(page).click();
		await expect(popover(page).getByRole("heading", { name: "本机负载" })).toBeVisible();
		await expect(page.getByTestId("host-tile-gpu")).toContainText("Apple M4 Pro · 16 核");
		await expect(page.getByTestId("host-pressure")).toHaveText("正常");
		await expect(page.getByTestId("host-range-24h")).toHaveText("24 小时");
		await expect(page.getByTestId("host-chart-cpu")).toHaveAttribute("aria-label", /最近 1 小时/);
		await expect(page.getByTestId("host-footer")).toContainText("服务器重启后会重新开始");
		await host.push({ pressure: 2 });
		await expect(page.getByTestId("host-pressure")).toHaveText("严重");
		await host.push({ cpu: 20 }, { procs: PROCS });
		await expect(page.getByTestId("host-proc-server")).toContainText("omp-webui 服务器");
		await expect(page.getByTestId("host-proc-omp")).toContainText("2 个对话");
		await expect(page.getByTestId("host-proc-relay")).toContainText("中继");
	});
});

for (const theme of ["light", "dark"] as const) {
	test.describe(`${theme} theme`, () => {
		test.beforeEach(async ({ page }) => {
			await page.addInitScript((t) => localStorage.setItem("ompw.theme", t), theme);
		});

		test("the popover has no text below the contrast the page holds, and the dot colours are the app's", async ({
			page,
		}) => {
			const host = await open(
				page,
				historyAt(Date.now(), {
					pressure: [
						[100, 110, 1],
						[110, 120, 2],
					],
				}),
			);
			await chip(page).click();
			await host.push({ cpu: 20 }, { procs: PROCS });
			await expect(page.getByTestId("host-proc-omp")).toBeVisible();
			const { violations } = await new AxeBuilder({ page })
				.include('[data-testid="host-popover"]')
				.withRules(["color-contrast"])
				.analyze();
			expect(violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(" ")}: ${n.any[0]?.message}`))).toEqual([]);
			// The pressure badge uses the app's tones (the same classes as every other badge).
			await host.push({ pressure: 2 });
			await expect(page.getByTestId("host-pressure").locator("span")).toHaveClass(/bg-danger\/15/);
		});

		test("the line itself is readable beside the sidebar's other lines", async ({ page }) => {
			await open(page, historyAt(Date.now()));
			const { violations } = await new AxeBuilder({ page })
				.include('[data-testid="host-chip"]')
				.withRules(["color-contrast"])
				.analyze();
			expect(violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")))).toEqual([]);
		});
	});
}

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

	test("the line is in the drawer, and the popover fits the screen without a sideways scroll", async ({ page }) => {
		const host = await open(page, historyAt(Date.now()));
		await chip(page).tap();
		await expect(popover(page)).toBeVisible();
		await host.push({ cpu: 20 }, { procs: PROCS });
		await expect(page.getByTestId("host-proc-omp")).toBeVisible();
		const box = await boxOf(popover(page));
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
		expect(box.y).toBeGreaterThanOrEqual(0);
		expect(box.y + box.height).toBeLessThanOrEqual(780);
		// Nothing in it is wider than it is.
		const overflow = await popover(page).evaluate((el) => el.scrollWidth - el.clientWidth);
		expect(overflow).toBeLessThanOrEqual(1);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		// Three graphs, each inside the popover.
		for (const series of ["cpu", "gpu", "mem"]) {
			const g = await boxOf(page.getByTestId(`host-chart-${series}`));
			expect(g.x).toBeGreaterThanOrEqual(box.x);
			expect(g.x + g.width).toBeLessThanOrEqual(box.x + box.width + 1);
			expect(g.width).toBeGreaterThan(200);
		}
		// The popover scrolls within the screen: the last thing in it (how the figures are taken) can be reached.
		await page.getByTestId("host-footer").scrollIntoViewIfNeeded();
		await expect(page.getByTestId("host-footer")).toBeInViewport();
	});
});

test.describe("the real sampler", () => {
	let fast: TestServer;
	test.beforeAll(async () => {
		test.setTimeout(90_000);
		// The paces are the settings only tests use; what is read is this computer's own.
		fast = await startTestServer(
			0,
			{ OMP_WEBUI_HOST_LIVE_MS: "300", OMP_WEBUI_HOST_BACKGROUND_MS: "1000" },
			{ login: false },
		);
	});
	test.afterAll(async () => {
		await fast?.stop();
	});

	test("the line has this computer's figures, the popover graphs of what the server looked at, and the server is among the processes", async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(e.message));
		page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
		await page.goto(`${fast.url}/?token=${fast.accessToken}`);
		await appReady(page);
		await openSidebar(page);
		await expect(chip(page)).toBeVisible();
		await expect(page.getByTestId("host-figures")).toHaveText(/^CPU \d+%( · GPU \d+%)? · MEM \d+%$/, {
			timeout: 20_000,
		});
		await expect(chip(page)).toHaveAttribute("data-level", /^[012]?$/);

		await chip(page).click();
		await expect(popover(page)).toBeVisible();
		// A few looks at 300 ms: the graph has points of the page's own watching as well as the server's background looks.
		await expect
			.poll(
				async () =>
					Number(
						await page
							.getByTestId("host-chart-cpu")
							.getAttribute("data-points")
							.catch(() => "0"),
					),
				{
					timeout: 20_000,
				},
			)
			.toBeGreaterThanOrEqual(5);
		await expect(page.getByTestId("host-tile-cpu-value")).toHaveText(/^\d+%$/);
		await expect(page.getByTestId("host-tile-mem-value")).toHaveText(/^\d+%$/);
		await expect(page.getByTestId("host-tile-mem")).toContainText(/of \d+(\.\d)? GB/);
		await expect(page.getByTestId("host-footer")).toContainText(
			"every 0.3 s while a page shows these graphs, and every 1 s while only the sidebar's line does",
		);

		// The server's own process is listed with the memory it holds.
		await expect(page.getByTestId("host-proc-server")).toContainText("omp-webui server", { timeout: 20_000 });
		await expect(page.getByTestId("host-proc-server")).toContainText(/\d+(\.\d)? (MB|GB)/);
		await expect(page.getByTestId("host-proc-server-cpu")).toHaveText(/^\d+(\.\d)?%$/, { timeout: 20_000 });
		expect(errors).toEqual([]);

		// The history the server holds is the page's too: the same server, read over HTTP.
		const res = await page.request.get(`${fast.url}/api/host`);
		expect(res.ok()).toBe(true);
		const h = (await res.json()) as HostHistory;
		expect(h.info.cores).toBeGreaterThan(0);
		expect(h.fine.t.length).toBeGreaterThanOrEqual(5);
		expect(h.fine.t.at(-1)).toBeGreaterThan(Date.now() - HOUR);
	});
});
