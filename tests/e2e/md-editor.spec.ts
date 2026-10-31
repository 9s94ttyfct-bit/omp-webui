import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { writeChatSession } from "../support/chat-session.ts";
import { makeFilesProject } from "../support/files-project.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The Markdown editor (no model call): a `.md` file of the conversation's folder over the whole window, its source beside a
 * rendering that follows the typing, saved with ⌘S. It opens from the Files tab, the large view, the Changes view and a link
 * in the conversation; a file that changed on the computer is taken when nothing is unsaved and is otherwise a conflict
 * (Reload, Overwrite, Show diff); unsaved text is not left without asking; Mermaid and KaTeX arrive when a file needs them.
 * What it renders and refuses to render is in `tests/unit/md-editor.test.ts`.
 */

let s: TestServer;
let proj: string;
const TITLE = "Markdown editor conversation";

test.beforeAll(async () => {
	s = await startTestServer(0, {}, { login: false });
	proj = makeFilesProject(realpathSync(s.work));
	writeChatSession(s.agentDir, {
		n: 0x91,
		title: TITLE,
		cwd: proj,
		turns: [{ prompt: "where are the notes?", reply: "They are in [the guide](docs/guide.md)." }],
	});
});
test.afterAll(async () => {
	await s?.stop();
});

const write = (name: string, body: string) => writeFileSync(join(proj, name), body);
const onDisk = (name: string) => readFileSync(join(proj, name), "utf8");
const row = (page: Page, path: string) => page.locator(`[data-testid="file-row"][data-path="${path}"]`);
const editor = (page: Page) => page.getByTestId("md-editor");
const source = (page: Page) => page.getByTestId("md-source").locator(".cm-content");
const preview = (page: Page) => page.getByTestId("md-preview");
const status = (page: Page) => page.getByTestId("md-status");

/** Open the conversation with its Files tab (on a phone: the sidebar is a drawer, and the Files tab is in the top pane). */
async function openFiles(page: Page, phone = false): Promise<void> {
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	if (phone) await page.getByRole("button", { name: /Show sidebar/ }).click();
	const item = page.locator('[data-testid="session-item"]', { hasText: TITLE });
	await expect(item).toHaveCount(1, { timeout: 30_000 });
	await item.click();
	await expect(page.getByTestId("composer")).toBeVisible();
	await page.getByTestId("toggle-panel").click();
	await page
		.getByTestId("right-panel")
		.getByTestId(phone ? "panel-pane-top" : "panel-pane-bottom")
		.getByRole("tab", { name: /^Files|^文件/ })
		.click();
	await expect(page.getByTestId("files-pane")).toBeVisible();
	await expect(row(page, "src")).toBeVisible();
}

/** The file `name` of the folder's root, opened in the editor from the Files tab's preview. */
async function openInEditor(page: Page, name: string): Promise<void> {
	await row(page, name).click();
	await expect(page.getByTestId("file-preview")).toHaveAttribute("data-path", name);
	await page.getByTestId("file-md-editor").click();
	await expect(editor(page)).toHaveAttribute("data-path", name);
	await expect(source(page)).toBeVisible();
}

/** Type `typed` at the end of the source. */
async function typeAtEnd(page: Page, typed: string): Promise<void> {
	await source(page).click();
	await page.keyboard.press("ControlOrMeta+End");
	await page.keyboard.type(typed);
}

test.describe("editing", () => {
	test("opens from the Files tab; the preview follows the typing; ⌘S writes the file; Escape closes it and gives the focus back", async ({
		page,
	}) => {
		write("notes.md", "---\ntitle: Weekly notes\ntags: [web, ui]\n---\n# Notes\n\nFirst line.\n");
		await openFiles(page);
		await openInEditor(page, "notes.md");
		await expect(source(page)).toBeFocused();
		// Both panes, with the front matter as a table of its keys, not as text.
		const table = preview(page).getByTestId("md-front-matter");
		await expect(table).toContainText("title");
		await expect(table).toContainText("Weekly notes");
		await expect(table).toContainText("web, ui");
		await expect(preview(page).getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();
		await expect(page.getByTestId("md-save")).toBeDisabled();

		// The Markdown mode continues a list on Enter: the text ends on the item.
		await typeAtEnd(page, "\n## Added *now*\n\n- [x] done");
		await expect(preview(page).getByRole("heading", { level: 2, name: "Added now" })).toBeVisible();
		await expect(preview(page).locator('input[type="checkbox"]')).toBeChecked();
		await expect(status(page)).toHaveText("Unsaved changes");
		expect(onDisk("notes.md")).not.toContain("Added");

		await page.keyboard.press("ControlOrMeta+s");
		await expect(status(page)).toHaveText("Saved");
		expect(onDisk("notes.md")).toBe(
			"---\ntitle: Weekly notes\ntags: [web, ui]\n---\n# Notes\n\nFirst line.\n\n## Added *now*\n\n- [x] done",
		);
		await expect(page.getByTestId("md-save")).toBeDisabled();

		// Nothing is unsaved: Escape closes without asking, and the focus is back on the button that opened it.
		await page.keyboard.press("Escape");
		await expect(editor(page)).toHaveCount(0);
		await expect(page.getByTestId("file-md-editor")).toBeFocused();
		// The panel's preview shows what was saved.
		await expect(page.getByTestId("file-body")).toContainText("Added now");
	});

	test("the views: source and preview, the preview alone (render only), the source alone; the choice is kept", async ({
		page,
	}) => {
		write("views.md", "# Views\n\nText.\n");
		await openFiles(page);
		await openInEditor(page, "views.md");
		await expect(page.getByTestId("md-view-split")).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByTestId("md-source")).toBeVisible();
		await expect(preview(page)).toBeVisible();

		await page.getByTestId("md-view-preview").click();
		await expect(page.getByTestId("md-view-preview")).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByTestId("md-source")).toBeHidden();
		await expect(preview(page).getByRole("heading", { name: "Views" })).toBeVisible();
		// The preview fills the window.
		const width = await preview(page).evaluate((el) => el.getBoundingClientRect().width);
		expect(width).toBeGreaterThan((page.viewportSize()?.width ?? 0) * 0.9);

		await page.getByTestId("md-view-source").click();
		await expect(preview(page)).toBeHidden();
		await expect(page.getByTestId("md-source")).toBeVisible();

		// Closed and opened again: the view last chosen.
		await page.getByTestId("md-close").click();
		await expect(editor(page)).toHaveCount(0);
		await page.getByTestId("file-md-editor").click();
		await expect(page.getByTestId("md-view-source")).toHaveAttribute("aria-pressed", "true");
		await page.getByTestId("md-view-split").click();
		await expect(preview(page)).toBeVisible();
	});
});

test.describe("a file that changed on the computer", () => {
	test("is taken as it is when nothing is unsaved, and is a conflict otherwise: Show diff, Overwrite, Reload", async ({
		page,
	}) => {
		write("shared.md", "# Shared\n\none\n");
		await openFiles(page);
		await openInEditor(page, "shared.md");

		// Nothing unsaved: what is on the computer is taken, and the editor says so.
		write("shared.md", "# Shared\n\nfrom outside\n");
		await expect(source(page)).toContainText("from outside", { timeout: 10_000 });
		await expect(status(page)).toHaveText("Updated: the file changed on the computer");
		await expect(preview(page)).toContainText("from outside");

		// Unsaved text: a conflict, found by looking at the file (no save was asked for), and nothing written.
		await typeAtEnd(page, "\nmine\n");
		write("shared.md", "# Shared\n\ntheirs\n");
		const banner = page.getByTestId("md-conflict");
		await expect(banner).toBeVisible({ timeout: 10_000 });
		await expect(banner).toContainText("shared.md");
		expect(onDisk("shared.md")).toBe("# Shared\n\ntheirs\n");
		await expect(source(page)).toContainText("mine");

		// The diff: the file on the computer against the text being edited.
		await page.getByTestId("md-show-diff").click();
		const diff = page.getByTestId("md-diff");
		await expect(diff).toBeVisible();
		await expect(diff).toContainText("theirs");
		await expect(diff).toContainText("mine");

		// ⌘S does not write over it: the save names what the text was made from, and the server refuses.
		await page.keyboard.press("ControlOrMeta+s");
		await expect(banner).toBeVisible();
		expect(onDisk("shared.md")).toBe("# Shared\n\ntheirs\n");

		await page.getByTestId("md-overwrite").click();
		await expect(banner).toHaveCount(0);
		await expect(status(page)).toHaveText("Saved");
		expect(onDisk("shared.md")).toBe("# Shared\n\nfrom outside\n\nmine\n");

		// Again, and this time Reload: what was typed goes, what is there comes.
		await typeAtEnd(page, "dropped\n");
		write("shared.md", "# Shared\n\ntheirs, again\n");
		await page.keyboard.press("ControlOrMeta+s");
		await expect(banner).toBeVisible();
		await page.getByTestId("md-reload").click();
		await expect(banner).toHaveCount(0);
		await expect(source(page)).toContainText("theirs, again");
		await expect(source(page)).not.toContainText("dropped");
		await expect(page.getByTestId("md-save")).toBeDisabled();
		expect(onDisk("shared.md")).toBe("# Shared\n\ntheirs, again\n");
	});
});

test.describe("what is not saved is not lost without asking", () => {
	test("Escape and Close ask; Keep editing stays; Discard closes and writes nothing; Save and close saves", async ({
		page,
	}) => {
		write("draft.md", "# Draft\n");
		await openFiles(page);
		await openInEditor(page, "draft.md");
		await typeAtEnd(page, "\nunsaved\n");
		await expect(status(page)).toHaveText("Unsaved changes");

		await page.keyboard.press("Escape");
		const question = page.getByRole("dialog", { name: "Discard your changes?" });
		await expect(question).toBeVisible();
		await page.getByTestId("md-keep").click();
		await expect(question).toHaveCount(0);
		await expect(editor(page)).toBeVisible();

		await page.getByTestId("md-close").click();
		await expect(question).toBeVisible();
		await page.getByTestId("md-discard").click();
		await expect(editor(page)).toHaveCount(0);
		expect(onDisk("draft.md")).toBe("# Draft\n");

		await page.getByTestId("file-md-editor").click();
		await typeAtEnd(page, "\nkept\n");
		await page.getByTestId("md-close").click();
		await page.getByTestId("md-save-close").click();
		await expect(editor(page)).toHaveCount(0);
		expect(onDisk("draft.md")).toBe("# Draft\n\nkept\n");
	});
});

test.describe("diagrams and math", () => {
	test("Mermaid draws a diagram and KaTeX typesets math, each fetched when first needed, under the page's CSP", async ({
		page,
	}) => {
		const violations: string[] = [];
		page.on("console", (m) => {
			if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
		});
		const fetched: string[] = [];
		page.on("request", (r) => fetched.push(new URL(r.url()).pathname));
		write(
			"diagram.md",
			[
				"# Diagram",
				"",
				"Inline $e^{i\\pi} + 1 = 0$ and a block:",
				"",
				"$$",
				"\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}",
				"$$",
				"",
				"```mermaid",
				"graph TD",
				"  A[Start] --> B{Ready?}",
				"  B -->|yes| C[Go]",
				'  click A href "javascript:alert(1)"',
				"```",
				"",
				"```ts",
				"const answer: number = 42;",
				"```",
			].join("\n"),
		);
		await openFiles(page);
		await row(page, "diagram.md").click();
		// Not before the editor wants them.
		expect(fetched.some((p) => /\/(mermaid|katex)[^/]*\.js$/.test(p))).toBe(false);
		await page.getByTestId("file-md-editor").click();

		const drawn = preview(page).getByTestId("md-mermaid");
		await expect(drawn.locator("svg")).toBeVisible({ timeout: 30_000 });
		await expect(drawn).toContainText("Start");
		await expect(preview(page).getByTestId("md-mermaid-pending")).toHaveCount(0);
		// Nothing of the diagram runs or leads out of the page.
		const unsafe = await drawn.evaluate((el) => {
			const found: string[] = [];
			for (const node of [el, ...el.querySelectorAll("*")]) {
				if (["SCRIPT", "IFRAME", "OBJECT", "EMBED"].includes(node.tagName.toUpperCase())) found.push(node.tagName);
				for (const attr of node.attributes) {
					if (/^on/i.test(attr.name)) found.push(`${node.tagName}@${attr.name}`);
					if (/href|src/i.test(attr.name) && /^\s*javascript:/i.test(attr.value)) found.push(attr.value);
				}
			}
			return found;
		});
		expect(unsafe).toEqual([]);

		await expect(preview(page).locator(".katex").first()).toBeVisible({ timeout: 30_000 });
		await expect(preview(page).locator(".katex-display")).toHaveCount(1);
		await expect(preview(page).getByTestId("md-math-pending")).toHaveCount(0);
		// Code is coloured by the conversation's highlighter.
		await expect(preview(page).locator(".shiki").first()).toBeVisible();
		expect(fetched.some((p) => /\/katex[^/]*\.js$/.test(p))).toBe(true);
		expect(violations).toEqual([]);
	});
});

test.describe("where it opens from", () => {
	test("a link in the conversation, the large view and the Changes view", async ({ page }) => {
		await openFiles(page);
		// A link to a Markdown file of the folder in a message.
		const link = page.getByTestId("md-open-link").filter({ hasText: "the guide" });
		await expect(link).toHaveAttribute("data-path", "docs/guide.md");
		await link.click();
		await expect(editor(page)).toHaveAttribute("data-path", "docs/guide.md");
		await expect(preview(page).getByRole("heading", { name: "Guide" })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(editor(page)).toHaveCount(0);
		await expect(link).toBeFocused();

		// The large view of a Markdown file.
		await row(page, "README.md").click();
		await page.getByTestId("file-larger").click();
		await expect(page.getByTestId("big-view")).toHaveAttribute("data-path", "README.md");
		await page.getByTestId("big-md-editor").click();
		await expect(editor(page)).toHaveAttribute("data-path", "README.md");
		// A link of the file to another opens that one here.
		await preview(page).getByTestId("md-open-link").filter({ hasText: "the guide" }).click();
		await expect(editor(page)).toHaveAttribute("data-path", "docs/guide.md");
		await page.getByTestId("md-close").click();
		await page.getByTestId("big-close").click();

		// The Changes view, for a Markdown file that changed.
		await page.getByTestId("file-back").click();
		await page.getByTestId("files-view-changes").click();
		await page.locator('[data-testid="change-row"][data-path="README.md"]').click();
		await page.getByTestId("change-md-editor").click();
		await expect(editor(page)).toHaveAttribute("data-path", "README.md");
		await expect(preview(page).getByRole("heading", { name: "Sample project" })).toBeVisible();
	});
});

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

	test("source and preview are two tabs; the preview is first; the arrow keys move between them", async ({ page }) => {
		write("phone.md", "# On a phone\n\nText.\n");
		await openFiles(page, true);
		await row(page, "phone.md").click();
		await page.getByTestId("file-md-editor").click();
		await expect(editor(page)).toHaveAttribute("data-path", "phone.md");
		const tabs = editor(page).getByRole("tablist");
		await expect(tabs).toBeVisible();
		await expect(page.getByTestId("md-view-split")).toHaveCount(0);
		await expect(page.getByTestId("md-view-preview")).toHaveAttribute("aria-selected", "true");
		await expect(preview(page).getByRole("heading", { name: "On a phone" })).toBeVisible();
		await page.getByTestId("md-view-source").click();
		await expect(page.getByTestId("md-source")).toBeVisible();
		await expect(preview(page)).toBeHidden();
		await page.getByTestId("md-view-source").focus();
		await page.keyboard.press("ArrowRight");
		await expect(page.getByTestId("md-view-preview")).toHaveAttribute("aria-selected", "true");
		await expect(page.getByTestId("md-view-preview")).toBeFocused();
		// The editor takes the whole window.
		const box = await editor(page).boundingBox();
		expect(box?.width).toBe(390);
	});
});

for (const theme of ["light", "dark"] as const) {
	test(`the editor and its conflict pass axe in the ${theme} theme`, async ({ page }) => {
		await page.addInitScript((t) => localStorage.setItem("ompw.theme", t), theme);
		write(`axe-${theme}.md`, "---\ntitle: Axe\n---\n# Axe\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- [ ] task\n");
		await openFiles(page);
		await openInEditor(page, `axe-${theme}.md`);
		await typeAtEnd(page, "\nmine\n");
		write(`axe-${theme}.md`, "# Theirs\n");
		await expect(page.getByTestId("md-conflict")).toBeVisible({ timeout: 10_000 });
		await page.getByTestId("md-show-diff").click();
		await page.evaluate(() =>
			Promise.allSettled(
				document
					.getAnimations()
					.filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
					.map((a) => a.finished),
			),
		);
		// The diff's rows are `DiffBody`'s, as the Changes view draws them: axe reports the line numbers of its semi-transparent
		// tinted rows (a property of that component, left out of the Changes view's own axe check too), so they are left out here.
		const result = await new AxeBuilder({ page })
			.include('[data-testid="md-editor"]')
			.exclude('[data-testid="changes-diff-body"]')
			.analyze();
		expect(result.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
	});
}
