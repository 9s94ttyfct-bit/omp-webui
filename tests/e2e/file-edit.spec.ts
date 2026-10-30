import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { writeChatSession } from "../support/chat-session.ts";
import { makeFilesProject } from "../support/files-project.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Editing a text file in the Files tab's large view (no model call): Edit opens CodeMirror on the file's text, ⌘S writes it,
 * a file that changed on the computer meanwhile is a conflict with Reload and Overwrite, and what has not been saved is not
 * left without asking (closing the view, another file, another conversation, Back). Files that are not text, or were cut at
 * the preview's limit, have no Edit button. What the server refuses is in `tests/unit/folder-edit.test.ts` and
 * `tests/contract/folder-edit.test.ts`.
 */

let s: TestServer;
let proj: string;
const TITLE = "Edit probe conversation";
const OTHER = "Another conversation";

test.beforeAll(async () => {
	s = await startTestServer(0, {}, { login: false });
	proj = makeFilesProject(realpathSync(s.work));
	writeChatSession(s.agentDir, { n: 0x71, title: TITLE, cwd: proj, turns: [{ prompt: "hello", reply: "hi" }] });
	writeChatSession(s.agentDir, { n: 0x72, title: OTHER, cwd: proj, turns: [{ prompt: "hello", reply: "hi" }] });
});
test.afterAll(async () => {
	await s?.stop();
});

const text = (name: string, body: string) => writeFileSync(join(proj, name), body);
const onDisk = (name: string) => readFileSync(join(proj, name), "utf8");
const row = (page: Page, path: string) => page.locator(`[data-testid="file-row"][data-path="${path}"]`);
/** The text area of the editor. */
const area = (page: Page) => page.getByTestId("big-edit-body").locator(".cm-content");
const status = (page: Page) => page.getByTestId("big-edit-status");
const dialog = (page: Page) => page.getByRole("dialog");

/** Open the conversation `title` with its Files tab. */
async function openFiles(page: Page, title = TITLE): Promise<void> {
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	const item = page.locator('[data-testid="session-item"]', { hasText: title });
	await expect(item).toHaveCount(1, { timeout: 30_000 });
	await item.click();
	await expect(page.getByTestId("composer")).toBeVisible();
	await page.getByTestId("toggle-panel").click();
	await page
		.getByTestId("right-panel")
		.getByTestId("panel-pane-bottom")
		.getByRole("tab", { name: /^Files|^文件/ })
		.click();
	await expect(page.getByTestId("files-pane")).toBeVisible();
	await expect(row(page, "src")).toBeVisible();
}

/** The file `name` (in the folder's root), open large in the main area; the panel goes back to its tree. */
async function openLarge(page: Page, name: string, backToTree = false): Promise<void> {
	await row(page, name).click();
	await expect(page.getByTestId("file-preview")).toHaveAttribute("data-path", name);
	await page.getByTestId("file-larger").click();
	await expect(page.getByTestId("big-view")).toHaveAttribute("data-path", name);
	if (backToTree) await page.getByTestId("file-back").click();
}

/** Press Edit and type `typed` at the end of the text. */
async function editAndType(page: Page, typed: string): Promise<void> {
	await page.getByTestId("big-edit").click();
	await expect(area(page)).toBeVisible();
	await expect(area(page)).toBeFocused();
	await page.keyboard.press("ControlOrMeta+End");
	await page.keyboard.type(typed);
	await expect(status(page)).toHaveText("Unsaved changes");
}

test.describe("editing and saving", () => {
	test("Edit opens the text, typing is unsaved, ⌘S writes the file, and Done shows what was saved", async ({
		page,
	}) => {
		text("edit-me.txt", "alpha\nbeta\n");
		await openFiles(page);
		await openLarge(page, "edit-me.txt");
		await expect(page.getByTestId("big-edit-save")).toHaveCount(0);
		await page.getByTestId("big-edit").click();
		await expect(page.getByTestId("big-edit-body")).toContainText("alpha");
		// Nothing was changed, so there is nothing to save, and leaving does not ask.
		await expect(page.getByTestId("big-edit-save")).toBeDisabled();
		await expect(page.getByTestId("big-edit-cancel")).toHaveText("Done");

		await page.keyboard.press("ControlOrMeta+End");
		await page.keyboard.type("gamma\n");
		await expect(status(page)).toHaveText("Unsaved changes");
		await expect(page.getByTestId("big-edit-cancel")).toHaveText("Cancel");
		expect(onDisk("edit-me.txt")).toBe("alpha\nbeta\n");

		await page.keyboard.press("ControlOrMeta+s");
		await expect(status(page)).toHaveText("Saved");
		expect(onDisk("edit-me.txt")).toBe("alpha\nbeta\ngamma\n");
		await expect(page.getByTestId("big-edit-save")).toBeDisabled();

		// Undo is the editor's: it takes the typing back (the line break and the word are two steps), and that is a change
		// again, saved by the button; redo brings it back, saved by the key.
		await page.keyboard.press("ControlOrMeta+z");
		await page.keyboard.press("ControlOrMeta+z");
		await expect(status(page)).toHaveText("Unsaved changes");
		await page.getByTestId("big-edit-save").click();
		await expect(status(page)).toHaveText("Saved");
		expect(onDisk("edit-me.txt")).toBe("alpha\nbeta\n");
		// The button has the focus now: redo is the editor's. `Z`, not `z`: with Shift held a keyboard sends the capital,
		// and Playwright sends what it is given; Ctrl with a small `z` is undo to CodeMirror on Linux (Shift+Ctrl+Z is
		// redo there), so a small one undid the first redo instead of making the second.
		await area(page).focus();
		await page.keyboard.press("ControlOrMeta+Shift+Z");
		await page.keyboard.press("ControlOrMeta+Shift+Z");
		await page.keyboard.press("ControlOrMeta+s");
		await expect.poll(() => onDisk("edit-me.txt")).toBe("alpha\nbeta\ngamma\n");

		await page.getByTestId("big-edit-cancel").click();
		await expect(page.getByTestId("big-editor")).toHaveCount(0);
		await expect(page.getByTestId("big-file-body")).toContainText("gamma");
		await expect(page.getByTestId("big-edit")).toBeFocused();
	});

	test("a file with Windows line endings and a byte order mark comes back with both, changed only where it was edited", async ({
		page,
	}) => {
		writeFileSync(join(proj, "crlf.txt"), Buffer.from("\ufeffone\r\ntwo\r\n", "utf8"));
		await openFiles(page);
		await openLarge(page, "crlf.txt");
		await editAndType(page, "three");
		await page.keyboard.press("ControlOrMeta+s");
		await expect(status(page)).toHaveText("Saved");
		expect(readFileSync(join(proj, "crlf.txt")).toString("utf8")).toBe("\ufeffone\r\ntwo\r\nthree");
	});

	test("find is the editor's own (⌘F), and Escape closes it without leaving the view", async ({ page }) => {
		text("find-me.txt", "needle in a haystack\nanother needle\n");
		await openFiles(page);
		await openLarge(page, "find-me.txt");
		await page.getByTestId("big-edit").click();
		await expect(area(page)).toBeFocused();
		await page.keyboard.press("ControlOrMeta+f");
		const field = page.getByTestId("big-edit-body").getByRole("textbox", { name: "Find", exact: true });
		await expect(field).toBeFocused();
		await page.keyboard.type("needle");
		await expect(page.getByTestId("big-edit-body").locator(".cm-searchMatch")).toHaveCount(2);
		await page.keyboard.press("Escape");
		await expect(field).toHaveCount(0);
		await expect(page.getByTestId("big-view")).toBeVisible();
		await expect(page.getByTestId("big-editor")).toBeVisible();
	});

	test("a file of a language gets its mode (coloured with the app's own colours); a plain file stays plain", async ({
		page,
	}) => {
		text("colours.ts", 'export const answer: number = 42; // the answer\nconst s = "text";\n');
		text("plain.txt", "export const answer = 42;\n");
		await openFiles(page);
		await openLarge(page, "colours.ts");
		await page.getByTestId("big-edit").click();
		await expect.poll(() => area(page).locator("span").count()).toBeGreaterThan(3);
		// A keyword is in the colour the palette gives keywords (the read-only view's own variable).
		const keyword = await area(page)
			.locator("span", { hasText: /^export$/ })
			.first()
			.evaluate((el) => getComputedStyle(el).color);
		const wanted = await page.evaluate(() => {
			const probe = document.createElement("span");
			probe.style.color = "var(--shiki-token-keyword)";
			document.body.append(probe);
			const colour = getComputedStyle(probe).color;
			probe.remove();
			return colour;
		});
		expect(keyword).toBe(wanted);
		await page.getByTestId("big-edit-cancel").click();
		await page.getByTestId("big-close").click();
		await page.getByTestId("file-back").click();
		await openLarge(page, "plain.txt");
		await page.getByTestId("big-edit").click();
		await expect(page.getByTestId("big-edit-body")).toContainText("export const answer = 42;");
		await expect(area(page).locator("span")).toHaveCount(0);
	});
});

test.describe("a file that changed on the computer meanwhile", () => {
	test("is a conflict: Reload takes what is there, Overwrite takes what was typed", async ({ page }) => {
		text("conflict.txt", "one\n");
		await openFiles(page);
		await openLarge(page, "conflict.txt");
		await editAndType(page, "mine\n");
		text("conflict.txt", "theirs\n");
		await page.keyboard.press("ControlOrMeta+s");

		const banner = page.getByTestId("big-edit-conflict");
		await expect(banner).toBeVisible();
		await expect(banner).toContainText("conflict.txt");
		// Nothing was written over what was there, and what was typed is still there to choose from.
		expect(onDisk("conflict.txt")).toBe("theirs\n");
		await expect(status(page)).toHaveText("Unsaved changes");
		await expect(page.getByTestId("big-edit-body")).toContainText("mine");

		await page.getByTestId("big-edit-reload").click();
		await expect(banner).toHaveCount(0);
		await expect(page.getByTestId("big-edit-body")).toContainText("theirs");
		await expect(page.getByTestId("big-edit-body")).not.toContainText("mine");
		await expect(status(page)).toHaveText("");
		await expect(page.getByTestId("big-edit-save")).toBeDisabled();
		await expect(page.getByTestId("big-edit-cancel")).toHaveText("Done");

		// Typing on from what was read is saved without asking; a file that changed again is a conflict again.
		await area(page).click();
		await page.keyboard.press("ControlOrMeta+End");
		await page.keyboard.type("again\n");
		text("conflict.txt", "theirs, again\n");
		await page.keyboard.press("ControlOrMeta+s");
		await expect(banner).toBeVisible();
		expect(onDisk("conflict.txt")).toBe("theirs, again\n");
		await page.getByTestId("big-edit-overwrite").click();
		await expect(banner).toHaveCount(0);
		await expect(status(page)).toHaveText("Saved");
		expect(onDisk("conflict.txt")).toBe("theirs\nagain\n");
	});

	test("is not read again behind the editor while there is text to lose, and is read again when the editing is over", async ({
		page,
	}) => {
		text("steady.txt", "one\n");
		const reads: string[] = [];
		page.on("request", (r) => {
			const url = new URL(r.url());
			if (r.method() === "GET" && url.pathname === "/api/folder/file" && url.searchParams.get("path") === "steady.txt")
				reads.push(r.url());
		});
		await openFiles(page);
		// The panel's own preview would read it too: back to the tree, so that only the large view does.
		await openLarge(page, "steady.txt", true);
		await expect(page.getByTestId("big-file-body")).toContainText("one");

		// The large view follows the folder while nothing is being edited.
		text("steady.txt", "two\n");
		await expect(page.getByTestId("big-file-body")).toContainText("two");

		await editAndType(page, "mine\n");
		const during = reads.length;
		text("steady.txt", "three\n");
		// An absence cannot be awaited: a real wait, longer than the server's debounce and the page's own.
		await page.waitForTimeout(1600);
		expect(reads.length).toBe(during);
		await expect(page.getByTestId("big-edit-body")).toContainText("mine");

		// What is saved is checked against the disk, not against what was last read.
		await page.keyboard.press("ControlOrMeta+s");
		await expect(page.getByTestId("big-edit-conflict")).toBeVisible();
		await page.getByTestId("big-edit-reload").click();
		await expect(page.getByTestId("big-edit-body")).toContainText("three");
		await page.getByTestId("big-edit-cancel").click();
		await expect(page.getByTestId("big-file-body")).toContainText("three");
	});
});

test.describe("what is not saved is not lost without asking", () => {
	test("closing the view, Cancel and another file ask first; Keep editing keeps the text, Discard drops it", async ({
		page,
	}) => {
		text("guard.txt", "keep\n");
		text("guard-other.txt", "other\n");
		await openFiles(page);
		await openLarge(page, "guard.txt");
		await editAndType(page, "unsaved\n");

		// Escape is the editor's (it closes the find panel): the view stays.
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("big-view")).toBeVisible();

		await page.getByTestId("big-close").click();
		await expect(dialog(page)).toContainText("Discard your changes?");
		await expect(dialog(page)).toContainText("guard.txt");
		await expect(dialog(page).getByTestId("big-edit-keep")).toBeFocused();
		await dialog(page).getByTestId("big-edit-keep").click();
		await expect(dialog(page)).toHaveCount(0);
		await expect(page.getByTestId("big-edit-body")).toContainText("unsaved");

		await page.getByTestId("big-edit-cancel").click();
		await expect(dialog(page)).toBeVisible();
		await dialog(page).getByTestId("big-edit-keep").click();
		await expect(page.getByTestId("big-edit-body")).toContainText("unsaved");

		// Another file, opened large from the panel, which is still beside the view.
		await page.getByTestId("file-back").click();
		await row(page, "guard-other.txt").click();
		await page.getByTestId("file-larger").click();
		await expect(dialog(page)).toBeVisible();
		await dialog(page).getByTestId("big-edit-keep").click();
		await expect(page.getByTestId("big-view")).toHaveAttribute("data-path", "guard.txt");
		await expect(page.getByTestId("big-edit-body")).toContainText("unsaved");

		await page.getByTestId("file-larger").click();
		await dialog(page).getByTestId("big-edit-discard").click();
		await expect(page.getByTestId("big-view")).toHaveAttribute("data-path", "guard-other.txt");
		await expect(page.getByTestId("big-editor")).toHaveCount(0);
		await expect(page.getByTestId("big-file-body")).toContainText("other");
		expect(onDisk("guard.txt")).toBe("keep\n");

		// Cancel, once discarded, closes the editor and nothing is asked when there is nothing to lose.
		await page.getByTestId("big-edit").click();
		await expect(page.getByTestId("big-edit-cancel")).toHaveText("Done");
		await page.getByTestId("big-edit-cancel").click();
		await expect(page.getByTestId("big-editor")).toHaveCount(0);
		await expect(dialog(page)).toHaveCount(0);
	});

	test("another conversation and the browser's Back ask too, and staying leaves the address as it was", async ({
		page,
	}) => {
		text("leave.txt", "stay\n");
		await openFiles(page);
		const address = new URL(page.url()).hash;
		expect(address).toMatch(/^#\/s\//);
		await openLarge(page, "leave.txt");
		await editAndType(page, "unsaved\n");

		await page.locator('[data-testid="session-item"]', { hasText: OTHER }).click();
		await expect(dialog(page)).toContainText("Discard your changes?");
		await dialog(page).getByTestId("big-edit-keep").click();
		await expect(dialog(page)).toHaveCount(0);
		expect(new URL(page.url()).hash).toBe(address);
		await expect(page.getByTestId("big-edit-body")).toContainText("unsaved");

		await page.goBack();
		await expect(dialog(page)).toContainText("Discard your changes?");
		await dialog(page).getByTestId("big-edit-keep").click();
		await expect(dialog(page)).toHaveCount(0);
		expect(new URL(page.url()).hash).toBe(address);
		await expect(page.getByTestId("big-view")).toBeVisible();
		await expect(page.getByTestId("big-edit-body")).toContainText("unsaved");

		await page.locator('[data-testid="session-item"]', { hasText: OTHER }).click();
		await dialog(page).getByTestId("big-edit-discard").click();
		await expect(page.getByTestId("big-view")).toHaveCount(0);
		expect(new URL(page.url()).hash).not.toBe(address);
		expect(onDisk("leave.txt")).toBe("stay\n");
	});

	test("a saved file is left without a question", async ({ page }) => {
		text("saved.txt", "a\n");
		await openFiles(page);
		await openLarge(page, "saved.txt");
		await editAndType(page, "b\n");
		await page.keyboard.press("ControlOrMeta+s");
		await expect(status(page)).toHaveText("Saved");
		await page.getByTestId("big-close").click();
		await expect(page.getByTestId("big-view")).toHaveCount(0);
		await expect(dialog(page)).toHaveCount(0);
		expect(onDisk("saved.txt")).toBe("a\nb\n");
	});
});

test.describe("what has no Edit button", () => {
	for (const name of ["data.bin", "big.txt", "logo.png"]) {
		test(`${name}: it is not text the page may rewrite, so the large view is read only`, async ({ page }) => {
			await openFiles(page);
			await openLarge(page, name);
			await expect(page.getByTestId("big-file")).toBeVisible();
			await expect(page.getByTestId("big-edit")).toHaveCount(0);
			await expect(page.getByTestId("big-view").locator("[contenteditable='true'], textarea")).toHaveCount(0);
		});
	}
});

for (const theme of ["light", "dark"] as const) {
	test(`the editor, its find panel and its question pass axe in the ${theme} theme`, async ({ page }) => {
		await page.addInitScript((t) => localStorage.setItem("ompw.theme", t), theme);
		text("axe.ts", "export const answer = 42; // the answer\n");
		await openFiles(page);
		await openLarge(page, "axe.ts");
		await page.getByTestId("big-edit").click();
		await expect.poll(() => area(page).locator("span").count()).toBeGreaterThan(2);
		await page.keyboard.press("ControlOrMeta+f");
		await expect(page.getByTestId("big-edit-body").getByRole("textbox", { name: "Find", exact: true })).toBeFocused();
		await page.keyboard.type("answer");
		await page.keyboard.press("Escape");
		await page.keyboard.press("ControlOrMeta+End");
		await page.keyboard.type("x");
		const scan = async (what: string, within = '[data-testid="big-view"]') => {
			// The view fades in, and axe reads the colours of what is on screen: it waits for that to be over.
			await page.evaluate(() =>
				Promise.allSettled(
					document
						.getAnimations()
						.filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
						.map((a) => a.finished),
				),
			);
			const result = await new AxeBuilder({ page }).include(within).analyze();
			expect(
				result.violations.map((v) => `${what}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
				what,
			).toEqual([]);
		};
		await scan("editor");
		await page.keyboard.press("ControlOrMeta+f");
		await scan("editor with find");
		await page.getByTestId("big-edit-cancel").click();
		await expect(dialog(page)).toBeVisible();
		await scan("discard question", '[role="dialog"]');
	});
}
