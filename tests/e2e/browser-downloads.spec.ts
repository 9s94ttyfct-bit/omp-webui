import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { BrowserDownload, ScreenClientMessage, ScreenServerMessage } from "../../shared/browser-protocol.ts";
import { writeChatSession } from "../support/chat-session.ts";
import { openSidebar } from "../support/live.ts";
import { writeLongFakeOmp } from "../support/long-fake-omp-bin.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The Browser tab's downloads (docs/agents/browser.md, "Downloads"), with the tab's socket (`/ws/browser`) played by the
 * spec: the server's list as it says it, what the tab asks for (cancel, show in Finder), a fetch link on a page that is
 * not on the Mac, the toasts of what changes, and the strings in Chinese. The app's CEF and the server's list are tested in
 * tests/contract/browser-engine.test.ts; no browser engine runs here and no model is called.
 */

let s: TestServer;
let binDir: string;
const TITLE = "Browser downloads";

test.beforeAll(async () => {
	binDir = mkdtempSync(join(tmpdir(), "ompw-browser-downloads-"));
	s = await startTestServer(0, { OMP_BIN: writeLongFakeOmp(binDir) }, { login: false });
	writeChatSession(s.agentDir, { n: 0xd1, title: TITLE, turns: [{ prompt: "hello", reply: "hi" }] });
});
test.afterAll(async () => {
	await s?.stop();
	rmSync(binDir, { recursive: true, force: true });
});

const running: BrowserDownload = {
	id: "run.1",
	name: "report.pdf",
	state: "progress",
	received: 50,
	total: 100,
	startedAt: 2,
};
const saved: BrowserDownload = { id: "run.0", name: "notes.txt", state: "done", received: 9, total: 9, startedAt: 1 };

/**
 * The tab's socket, answered by the spec: the watched conversation has no pages and the downloads `list` (on this Mac
 * when `local`). `say` sends that conversation a new list; `tell` sends the tab any message; `drop` closes the
 * connection, and the tab's next one is told `next`; `asked` is what the tab sent.
 */
async function socket(page: Page, list: BrowserDownload[], local: boolean) {
	const asked: ScreenClientMessage[] = [];
	/** What the server would answer a watch with now: the list it last said. */
	let current = list;
	let send: ((downloads: BrowserDownload[]) => void) | null = null;
	let close: (() => void) | null = null;
	let tellTab: ((msg: ScreenServerMessage) => void) | null = null;
	await page.routeWebSocket(/\/ws\/browser$/, (ws) => {
		close = () => void ws.close();
		tellTab = (msg) => ws.send(JSON.stringify(msg));
		ws.onMessage((raw) => {
			const msg = JSON.parse(String(raw)) as ScreenClientMessage;
			asked.push(msg);
			if (msg.t !== "watch") return;
			const owner = msg.owner;
			send = (downloads) => ws.send(JSON.stringify({ t: "downloads", owner, downloads, local }));
			ws.send(JSON.stringify({ t: "pages", owner, pages: [] }));
			send(current);
		});
	});
	return {
		asked,
		say: (downloads: BrowserDownload[]) => {
			if (!send) throw new Error("the tab has not watched yet");
			current = downloads;
			send(downloads);
		},
		tell: (msg: ScreenServerMessage) => {
			if (!tellTab) throw new Error("the tab has not connected yet");
			tellTab(msg);
		},
		drop: (next: BrowserDownload[]) => {
			current = next;
			close?.();
		},
	};
}

async function openTab(page: Page): Promise<void> {
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	await openSidebar(page);
	await page.locator('[data-testid="session-item"]', { hasText: TITLE }).click();
	await expect(page.getByTestId("composer")).toBeVisible();
	if (!(await page.getByTestId("right-panel").isVisible())) await page.getByTestId("toggle-panel").click();
	await page.getByTestId("pane-tab-browser").click();
	await expect(page.getByTestId("browser-tab")).toBeVisible();
}

const rows = (page: Page) => page.getByTestId("browser-download");

test("no button until there is a download; the list shows each, with its progress, and a running one is cancelled", async ({
	page,
}) => {
	const tab = await socket(page, [], true);
	await openTab(page);
	await expect(page.getByTestId("browser-address")).toBeVisible();
	await expect(page.getByTestId("browser-downloads")).toHaveCount(0);

	tab.say([running, saved]);
	const button = page.getByTestId("browser-downloads");
	await expect(button).toHaveAccessibleName("Downloads, 1 running");
	await button.click();
	await expect(rows(page)).toHaveCount(2);
	const first = rows(page).first();
	await expect(first).toContainText("report.pdf");
	await expect(first.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
	await expect(rows(page).nth(1)).toContainText("notes.txt");
	await expect(rows(page).nth(1)).toContainText("Saved, 9 B");
	// Axe reads the colours on screen: once the popover's fade-in is over.
	await page.evaluate(() =>
		Promise.allSettled(
			document
				.getAnimations()
				.filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
				.map((a) => a.finished),
		),
	);
	expect(
		(await new AxeBuilder({ page }).include('[data-testid="browser-downloads-list"]').analyze()).violations,
	).toEqual([]);

	await first.getByRole("button", { name: "Cancel the download of report.pdf" }).click();
	await expect
		.poll(() => tab.asked.filter((m) => m.t === "download_cancel"))
		.toEqual([{ t: "download_cancel", id: "run.1" }]);
});

test("a finished one is shown in Finder from a page on the Mac, and fetched to the device from any other that may download files", async ({
	page,
}) => {
	const tab = await socket(page, [saved], true);
	await openTab(page);
	await page.getByTestId("browser-downloads").click();
	await expect(page.getByTestId("browser-download-fetch")).toHaveCount(0);
	await page.getByTestId("browser-download-reveal").click();
	await expect
		.poll(() => tab.asked.filter((m) => m.t === "download_reveal"))
		.toEqual([{ t: "download_reveal", id: "run.0" }]);
	// Finder could not show it (the file was moved or deleted since): the page says so, naming it.
	tab.tell({ t: "download_reveal_failed", id: "run.0", gone: true });
	await expect(page.getByText("notes.txt is not where it was saved any more: it was moved or deleted")).toBeVisible();
	tab.tell({ t: "download_reveal_failed", id: "run.0", gone: false });
	await expect(page.getByText("Finder could not show notes.txt")).toBeVisible();

	const remote = await page.context().newPage();
	await socket(remote, [saved], false);
	await openTab(remote);
	await remote.getByTestId("browser-downloads").click();
	await expect(remote.getByTestId("browser-download-reveal")).toHaveCount(0);
	const fetch = remote.getByTestId("browser-download-fetch");
	await expect(fetch).toHaveText("Download to this device");
	await expect(fetch).toHaveAttribute("href", "/api/browser/downloads/run.0/file");
	await expect(fetch).toHaveAttribute("download", "notes.txt");

	// A page File transfer gives nothing to (`off`) is offered no fetch.
	const off = await page.context().newPage();
	await off.route("**/api/meta", async (route) => {
		const response = await route.fetch();
		await route.fulfill({ response, json: { ...(await response.json()), fileTransfer: "off" } });
	});
	await socket(off, [saved], false);
	await openTab(off);
	await off.getByTestId("browser-downloads").click();
	await expect(off.getByTestId("browser-download")).toContainText("notes.txt");
	await expect(off.getByTestId("browser-download-fetch")).toHaveCount(0);
});

test("what changes while the tab is shown is told in a toast, what was there before is not; in Chinese too", async ({
	page,
}) => {
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	const tab = await socket(page, [saved], true);
	await openTab(page);
	await expect(page.getByTestId("browser-downloads")).toHaveAccessibleName("下载");
	await expect(page.getByTestId("toast")).toHaveCount(0);

	tab.say([running, saved]);
	await expect(page.getByTestId("toast-text")).toHaveText(["正在下载 report.pdf"]);
	await expect(page.getByTestId("browser-downloads")).toHaveAccessibleName("下载，1 个进行中");
	tab.say([{ ...running, state: "done", received: 100 }, saved]);
	await expect(page.getByTestId("toast-text").last()).toHaveText("report.pdf 已下载到“下载”文件夹");
	tab.say([{ ...running, id: "run.2", name: "big.iso", state: "failed", error: "Interrupted (reason 20)" }, saved]);
	await expect(page.getByTestId("toast-text").last()).toHaveText("big.iso 下载失败");

	// What finished while the connection was down is no news: the list after it comes back toasts nothing.
	const toasts = await page.getByTestId("toast").count();
	const watches = tab.asked.filter((m) => m.t === "watch").length;
	tab.drop([{ ...running, id: "run.3", name: "late.zip", state: "done", received: 100 }, saved]);
	await expect.poll(() => tab.asked.filter((m) => m.t === "watch").length).toBeGreaterThan(watches);
	await page.getByTestId("browser-downloads").click();
	await expect(rows(page).first()).toContainText("late.zip");
	await expect(page.getByTestId("toast")).toHaveCount(toasts);
	await expect(rows(page).nth(1).getByRole("button", { name: "在访达中显示" })).toBeVisible();
});
