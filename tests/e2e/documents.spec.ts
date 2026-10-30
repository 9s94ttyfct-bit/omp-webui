import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeChatSession } from "../support/chat-session.ts";
import { makeDocx, makePdf, textPage, wordPara, wordRun, wordTable } from "../support/documents.ts";
import { attachPicked } from "../support/drop-files.ts";
import { writeLongFakeOmp } from "../support/long-fake-omp-bin.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { removeTrackedTempDirs, tempDir } from "../support/temp-dirs.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * PDF and Word documents (#697), both ways: attached to a message (their text goes into it, and the pages of a PDF that
 * have no text, a scan, go as images) and read in the Files tab's large view (a PDF as its pages, a Word document as its
 * text). The documents are made here (`tests/support/documents.ts`); the omp is a stand-in, nothing reaches a model.
 *
 *   root/
 *     proj/     the conversation's folder, with a few documents in it for the Files tab
 */

let s: TestServer;
let proj: string;
const TITLE = "Documents conversation";

const REPORT = makePdf([textPage("Quarterly report"), textPage("Revenue by region")]);
const SCAN = makePdf([textPage("Cover page"), { picture: true }, { picture: true }]);
const MEMO = makeDocx(
	wordPara(wordRun("Memo to the team")) +
		wordPara() +
		wordPara(wordRun("Fish &amp; chips are "), wordRun("on the menu.")) +
		wordTable([
			["Item", "Qty"],
			["apples", "3"],
		]) +
		wordPara(wordRun("Thank you.")),
);
/** What an old Word file (or an encrypted one) starts with: an OLE compound file. */
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);

test.beforeAll(async () => {
	const binDir = tempDir("ompw-doc-bin-");
	s = await startTestServer(0, { OMP_BIN: writeLongFakeOmp(binDir) }, { login: false });
	proj = join(realpathSync(s.work), "proj");
	mkdirSync(proj);
	writeFileSync(join(proj, "README.md"), "# proj\n");
	writeFileSync(join(proj, "report.pdf"), REPORT);
	writeFileSync(join(proj, "scan.pdf"), SCAN);
	writeFileSync(join(proj, "long.pdf"), makePdf(Array.from({ length: 30 }, (_, i) => textPage(`Chapter ${i + 1}`))));
	writeFileSync(join(proj, "memo.docx"), MEMO);
	writeFileSync(join(proj, "old.doc"), OLE);
	writeFileSync(join(proj, "broken.pdf"), "this is not a PDF at all");
	writeChatSession(s.agentDir, { n: 0x73, title: TITLE, cwd: proj, turns: [{ prompt: "hello", reply: "hi" }] });
});
test.afterAll(async () => {
	await s?.stop();
	removeTrackedTempDirs();
});

/**
 * Open the conversation with a tap on its socket. The language is set every time: the preference is kept by the server,
 * so a test that chose Chinese would leave the next one in it.
 */
async function open(page: Page, lang: "en" | "zh-CN" = "en") {
	await page.addInitScript((l) => {
		localStorage.setItem("ompw.autoTitle", "off");
		localStorage.setItem("ompw.lang", l);
	}, lang);
	const tap = await tapSocket(page);
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	await page.locator('[data-testid="session-item"]', { hasText: TITLE }).click();
	await expect(page.getByTestId("composer")).toBeVisible();
	return tap;
}

const card = (page: Page) =>
	page.getByTestId("composer").locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
const chip = (page: Page) => card(page).getByTestId("file-chip");

const pdf = (name: string, buffer: Buffer) => ({ name, mimeType: "application/pdf", buffer });
const docx = (name: string, buffer: Buffer) => ({
	name,
	mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	buffer,
});

test.describe("attached to a message", () => {
	test("a PDF with text: the chip says what was taken, and the prompt carries its pages' text", async ({ page }) => {
		const tap = await open(page);
		await attachPicked(page, pdf("report.pdf", REPORT));
		await expect(chip(page)).toContainText("report.pdf");
		await expect(chip(page)).toContainText("2 pages");
		await expect(page.getByTestId("drop-choice")).toHaveCount(0);

		await page.getByTestId("composer").fill("summarise this");
		await page.getByTestId("send").click();
		await expect.poll(() => tap.commands("prompt").length).toBe(1);
		const [prompt] = tap.commands("prompt");
		const sent = String(prompt?.message);
		expect(sent.startsWith('summarise this\n\n<file name="report.pdf" size="')).toBe(true);
		expect(sent).toContain("PDF, 2 pages.");
		expect(sent).toContain("--- page 1 ---\nQuarterly report\nLine 1 of Quarterly report: the quick brown fox jumps.");
		expect(sent).toContain("--- page 2 ---\nRevenue by region");
		expect(sent).not.toContain("Left out");
		// Both pages have text: nothing goes as an image.
		expect(prompt?.images ?? []).toHaveLength(0);

		// The transcript shows a chip with the document's name; it opens onto the text.
		const message = page.getByTestId("msg-user").last();
		await expect(message.getByTestId("file-chip-name")).toHaveText("report.pdf");
		await message.getByTestId("file-chip-toggle").click();
		await expect(message.getByTestId("file-chip-text")).toContainText("Quarterly report");
	});

	test("a scanned PDF still reaches the model: the pages with no text go as images, and the text says which", async ({
		page,
	}) => {
		const tap = await open(page);
		await attachPicked(page, pdf("scan.pdf", SCAN));
		await expect(chip(page)).toContainText("scan.pdf");
		await expect(chip(page)).toContainText("3 pages · images: 2");
		// Each page that was drawn is a thumbnail, named for its page, which can be taken off on its own.
		await expect(page.getByRole("img", { name: "scan.pdf page 2.jpg" })).toBeVisible();
		await expect(page.getByRole("img", { name: "scan.pdf page 3.jpg" })).toBeVisible();

		await page.getByTestId("send").click();
		await expect.poll(() => tap.commands("prompt").length).toBe(1);
		const [prompt] = tap.commands("prompt");
		const sent = String(prompt?.message);
		expect(sent).toContain('<file name="scan.pdf" size="');
		expect(sent).toContain("Pages with no text, attached as images: 2–3.");
		expect(sent).toContain("--- page 1 ---\nCover page");
		expect(sent).toContain("--- page 2 ---\n[no text on this page; it is attached as an image]");
		const images = (prompt?.images ?? []) as { type: string; data: string; mimeType: string }[];
		expect(images).toHaveLength(2);
		for (const image of images) {
			expect(image.type).toBe("image");
			expect(image.mimeType).toBe("image/jpeg");
			// A JPEG: its first bytes, and a page's worth of them.
			const bytes = Buffer.from(image.data, "base64");
			expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
			expect(bytes.length).toBeGreaterThan(2000);
		}
	});

	test("a Word document: its paragraphs, a table as lines and the entities decoded", async ({ page }) => {
		const tap = await open(page);
		await attachPicked(page, docx("memo.docx", MEMO));
		await expect(chip(page)).toContainText("memo.docx");
		await expect(chip(page)).toContainText("Word document");
		await page.getByTestId("send").click();
		await expect.poll(() => tap.commands("prompt").length).toBe(1);
		const sent = String(tap.commands("prompt")[0]?.message);
		expect(sent).toContain('<file name="memo.docx" size="');
		expect(sent).toContain("Memo to the team\n\nFish & chips are on the menu.\nItem | Qty\napples | 3\nThank you.");
		expect(tap.commands("prompt")[0]?.images ?? []).toHaveLength(0);
	});

	test("a PDF past the page limit is cut there, and the toast and the text say how much was left out", async ({
		page,
	}) => {
		const tap = await open(page);
		const long = makePdf(Array.from({ length: 55 }, (_, i) => textPage(`Section ${i + 1}`, 1)));
		await attachPicked(page, pdf("long-report.pdf", long));
		await expect(chip(page)).toContainText("50 of 55 pages");
		await expect(page.getByTestId("toast").filter({ hasText: "50 of 55 pages were attached" })).toBeVisible();
		await page.getByTestId("send").click();
		await expect.poll(() => tap.commands("prompt").length).toBe(1);
		const sent = String(tap.commands("prompt")[0]?.message);
		expect(sent).toContain("PDF, 55 pages.");
		expect(sent).toContain("Left out (limit of 50 pages): pages 51–55.");
		expect(sent).toContain("--- page 50 ---\nSection 50");
		expect(sent).not.toContain("--- page 51 ---");
	});

	test("at most ten pages with no text go as images, and the toast says how many were not", async ({ page }) => {
		const tap = await open(page);
		await attachPicked(page, pdf("scans.pdf", makePdf(Array.from({ length: 12 }, () => ({ picture: true })))));
		await expect(chip(page)).toContainText("12 pages · images: 10", { timeout: 60_000 });
		await expect(
			page.getByTestId("toast").filter({ hasText: "2 more pages without text were not sent as images" }),
		).toBeVisible();
		await page.getByTestId("send").click();
		await expect.poll(() => tap.commands("prompt").length).toBe(1);
		const [prompt] = tap.commands("prompt");
		expect(prompt?.images).toHaveLength(10);
		const sent = String(prompt?.message);
		expect(sent).toContain("Pages with no text, attached as images: 1–10.");
		expect(sent).toContain("Pages with little or no text, no image attached: 11–12.");
	});

	test("what cannot be read attaches nothing, and the toast says why", async ({ page }) => {
		await open(page);
		await attachPicked(page, pdf("broken.pdf", Buffer.from("this is not a PDF at all")));
		await expect(page.getByTestId("toast").filter({ hasText: "“broken.pdf” could not be read" })).toBeVisible();
		await expect(chip(page)).toHaveCount(0);
		await expect(page.getByTestId("drop-choice")).toHaveCount(0);

		await attachPicked(page, docx("old.docx", OLE));
		await expect(page.getByTestId("toast").filter({ hasText: "old Word file or an encrypted one" })).toBeVisible();
		await attachPicked(page, docx("empty.docx", makeDocx(wordPara())));
		await expect(page.getByTestId("toast").filter({ hasText: "Nothing was attached from “empty.docx”" })).toBeVisible();
		await expect(chip(page)).toHaveCount(0);
		await expect(card(page).getByRole("img")).toHaveCount(0);
		await expect(page.getByTestId("send")).toBeDisabled();
	});

	test("a document over the size limit is not read: Attach is off, and the reason is given", async ({ page }) => {
		await open(page);
		await page.locator('input[type="file"]').setInputFiles(pdf("huge.pdf", Buffer.alloc(26 * 1024 * 1024, 0x20)));
		await expect(page.getByTestId("drop-choice")).toBeVisible();
		await expect(page.getByTestId("drop-row")).toHaveAttribute("data-kind", "document");
		await expect(page.getByTestId("drop-attach")).toBeDisabled();
		await expect(page.getByTestId("drop-why")).toContainText("25 MB");
		await page.keyboard.press("Escape");
		await expect(chip(page)).toHaveCount(0);
	});

	test("an old .doc cannot be attached, and the choice says only .docx and PDF can", async ({ page }) => {
		await open(page);
		await page
			.locator('input[type="file"]')
			.setInputFiles({ name: "old.doc", mimeType: "application/msword", buffer: OLE });
		await expect(page.getByTestId("drop-row")).toHaveAttribute("data-kind", "other");
		await expect(page.getByTestId("drop-attach")).toBeDisabled();
		await expect(page.getByTestId("drop-why")).toContainText("Only PDF and Word (.docx) documents can be attached");
		await page.keyboard.press("Escape");
	});

	test("the choice is in Chinese, and so are the chip's words", async ({ page }) => {
		await open(page, "zh-CN");
		await page.locator('input[type="file"]').setInputFiles(pdf("report.pdf", REPORT));
		await expect(page.getByTestId("drop-row")).toContainText("文档");
		await page.getByTestId("drop-attach").click();
		await expect(chip(page)).toContainText("2 页");
	});
});

test.describe("read in the Files tab", () => {
	const row = (page: Page, path: string) => page.locator(`[data-testid="file-row"][data-path="${path}"]`);

	async function openFiles(page: Page): Promise<void> {
		await page.addInitScript(() => {
			localStorage.setItem("ompw.autoTitle", "off");
			localStorage.setItem("ompw.lang", "en");
		});
		await page.goto(`${s.url}/?token=${s.accessToken}`);
		await page.locator('[data-testid="session-item"]', { hasText: TITLE }).click();
		await expect(page.getByTestId("composer")).toBeVisible();
		await page.getByTestId("toggle-panel").click();
		await page
			.getByTestId("right-panel")
			.getByTestId("panel-pane-bottom")
			.getByRole("tab", { name: /^Files|^文件/ })
			.click();
		await expect(page.getByTestId("files-pane")).toBeVisible();
		await expect(row(page, "report.pdf")).toBeVisible();
	}

	async function openLarge(page: Page, name: string): Promise<void> {
		await row(page, name).click();
		await expect(page.getByTestId("file-preview")).toHaveAttribute("data-path", name);
		await page.getByTestId("file-larger").click();
		await expect(page.getByTestId("big-view")).toHaveAttribute("data-path", name);
	}

	/** How many pixels of the canvas of the page `n` are not white: a page that was drawn has some. */
	const inked = (page: Page, n: number) =>
		page
			.getByTestId("big-view")
			.locator(`[data-testid="file-pdf-page"][data-page="${n}"] canvas`)
			.evaluate((canvas: HTMLCanvasElement) => {
				const ctx = canvas.getContext("2d");
				if (!ctx || !canvas.width) return 0;
				const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
				let n = 0;
				for (let i = 0; i < data.length; i += 4) if ((data[i] ?? 255) < 200) n++;
				return n;
			});

	test("a PDF opens large as its pages, drawn; it is read only, with no Edit", async ({ page }) => {
		await openFiles(page);
		await openLarge(page, "report.pdf");
		const view = page.getByTestId("big-view").getByTestId("file-pdf");
		await expect(view).toBeVisible();
		await expect(view).toHaveAttribute("data-pages", "2");
		await expect(view).toContainText("2 pages");
		const first = page.getByTestId("big-view").locator('[data-testid="file-pdf-page"][data-page="1"]');
		await expect(first).toHaveAttribute("data-state", "drawn");
		await expect(first.locator("canvas")).toHaveAccessibleName("Page 1 of 2");
		// The first page has text on it: its letters are dark pixels on white.
		await expect.poll(() => inked(page, 1)).toBeGreaterThan(100);
		// Read only: the Edit button is only for text.
		await expect(page.getByTestId("big-edit")).toHaveCount(0);
		await expect(page.getByTestId("big-file-source")).toHaveCount(0);
	});

	test("a scanned page is drawn too, and a PDF that is not one says so", async ({ page }) => {
		await openFiles(page);
		await openLarge(page, "scan.pdf");
		await expect(page.getByTestId("big-view").locator('[data-testid="file-pdf-page"][data-page="2"]')).toHaveAttribute(
			"data-state",
			"drawn",
		);
		await expect.poll(() => inked(page, 2)).toBeGreaterThan(1000);
		await page.getByTestId("big-close").click();
		await page.getByTestId("file-back").click();
		await openLarge(page, "broken.pdf");
		await expect(page.getByTestId("big-view")).toContainText("damaged, or it is not a PDF");
		await expect(page.getByTestId("big-view").getByTestId("file-pdf")).toHaveCount(0);
	});

	test("a long PDF is drawn as it comes near: the pages far from the reader are not drawn", async ({ page }) => {
		await openFiles(page);
		await openLarge(page, "long.pdf");
		const state = (n: number) =>
			page.getByTestId("big-view").locator(`[data-testid="file-pdf-page"][data-page="${n}"]`);
		await expect(state(1)).toHaveAttribute("data-state", "drawn");
		// 30 pages of a thousand pixels each: the last is far off, and is only a sheet of the right shape.
		await expect(state(30)).toHaveAttribute("data-state", "idle");
		await state(30).scrollIntoViewIfNeeded();
		await expect(state(30)).toHaveAttribute("data-state", "drawn");
		// And the first, now far behind, has let go of its pixels.
		await expect(state(1)).toHaveAttribute("data-state", "idle");
	});

	test("a Word document opens large as its text, with the table as lines; there is no Edit", async ({ page }) => {
		await openFiles(page);
		await openLarge(page, "memo.docx");
		const text = page.getByTestId("big-view").getByTestId("file-docx");
		await expect(text).toBeVisible();
		await expect(text).toContainText("Memo to the team");
		await expect(text).toContainText("Fish & chips are on the menu.");
		await expect(text).toContainText("Item | Qty");
		await expect(text).toContainText("apples | 3");
		await expect(page.getByTestId("big-edit")).toHaveCount(0);
		await expect(page.getByTestId("big-file-source")).toHaveCount(0);
	});

	test("an old .doc is still a binary file: named by its size, and nothing is fetched for it", async ({ page }) => {
		const fetched: string[] = [];
		page.on("request", (r) => {
			if (r.url().includes("/api/folder/doc")) fetched.push(r.url());
		});
		await openFiles(page);
		await row(page, "old.doc").click();
		await expect(page.getByTestId("file-preview")).toHaveAttribute("data-path", "old.doc");
		await expect(page.getByTestId("file-preview")).toContainText("Binary file");
		expect(fetched).toEqual([]);
	});

	test("the panel's own preview draws a PDF as well, and the PDF reader is fetched only then", async ({ page }) => {
		const chunks: string[] = [];
		page.on("request", (r) => {
			const path = new URL(r.url()).pathname;
			if (/\/assets\/(pdf|DocumentView)-.*\.js$/.test(path)) chunks.push(path);
		});
		await openFiles(page);
		expect(chunks).toEqual([]);
		await row(page, "report.pdf").click();
		const view = page.getByTestId("file-preview").getByTestId("file-pdf");
		await expect(view).toBeVisible();
		await expect(view.locator('[data-testid="file-pdf-page"][data-page="1"]')).toHaveAttribute("data-state", "drawn");
		expect(chunks.length).toBeGreaterThanOrEqual(2);
	});
});
