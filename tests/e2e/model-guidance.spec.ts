import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_GUIDANCE } from "../../shared/model-guidance.ts";
import { en } from "../../web/src/i18n/guidance.ts";
import { zh } from "../../web/src/i18n/zh-CN/guidance.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { openSidebar, ownSession, sessionRow, startLive } from "../support/live.ts";
import { topTab } from "../support/panel.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * Model guidance (#641) as a person meets it: New chat's *Guidance* control (off until picked), Settings › Model guidance
 * (the templates, edited and restored), and the Guidance tab of the side panel that says what a conversation carries and changes it.
 * No model is called: the warm-up process is real (a scripted provider is not needed for the pickers), and what the page
 * sends is read from its own socket.
 *
 * The strings are the namespace's own: the card and the picker are lazy chunks, so their English arrives with them
 * (`lib/guidance-strings.ts`) and the Chinese ones only for a page in Chinese.
 */

const root = () => process.env.OMPW_E2E_ROOT as string;
const dataFile = () => join(root(), "data", "model-guidance.json");
const post = { "x-omp-webui": "1" };

/** What the templates file holds (`server/omp/guidance/store.ts`). */
const stored = (): { rev: number; templates: { id: string; name: string; text: string; builtin?: true }[] } =>
	JSON.parse(readFileSync(dataFile(), "utf8"));

/** The `open` requests the page sent (§ every one starts an omp process). */
const opens = (tap: SocketTap) => tap.sent.filter((m) => m.t === "open");

const newChat = async (page: Page, cwd: string): Promise<void> => {
	await page.addInitScript((dir) => localStorage.setItem("ompw.cwd", dir), cwd);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
};

/** Settings is a page of its own, reached by its address; Model guidance is on its Models page. */
const settings = async (page: Page): Promise<void> => {
	await page.goto("/#/settings/models");
	await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 60_000 });
};

/** The button of the template named `name` in the Settings card (named by what it shows: the name, its badges, its summary). */
const template = (card: Locator, name: string): Locator =>
	card
		.getByTestId("guidance-template-row")
		.filter({ has: card.page().getByText(name, { exact: true }) })
		.getByRole("button");

test.beforeEach(async () => {
	// The worker's server is shared with the specs that run after this one: the templates go back to the shipped ones.
	// (An empty body is a read; the restore is what puts them back.)
});

test.afterEach(async ({ page }) => {
	const res = await page.request.post("/api/model-guidance/restore", { headers: post });
	expect(res.status()).toBe(200);
	const prefs = await page.request.post("/api/prefs", {
		headers: post,
		data: { changes: { "ompw.guidanceDefault": null } },
	});
	expect(prefs.status()).toBe(200);
});

test("New chat's Guidance chip is off until something is picked, and the pick is what the next process is started with", async ({
	page,
}) => {
	const tap = await tapSocket(page);
	await newChat(page, process.env.OMPW_E2E_WORK as string);
	expect(opens(tap)[0]?.target?.guidance).toBeUndefined();

	const control = page.getByTestId("guidance-picker");
	await expect(control).toHaveText(en.chipOff);
	await control.click();
	const list = page.getByTestId("guidance-list");
	await expect(list).toBeVisible();
	// The shipped templates are offered by name, each with a line of what it is about; the one under the pointer shows its text.
	const option = list.getByTestId("guidance-option").filter({ hasText: "One of each kind at a time" });
	await option.hover();
	await expect(list.getByTestId("guidance-preview")).toHaveText(BUILTIN_GUIDANCE[0]?.text as string);
	await option.click();
	await expect(control).toHaveText(en.chip.replace("{name}", "One of each kind at a time"));

	// A process started after the pick is started with it: the template's id, and the text it stands for.
	await page.getByRole("button", { name: /^Options/ }).click();
	const field = page.locator('[data-flag="--append-system-prompt"]');
	await field.fill("kept");
	await field.press("Enter");
	await expect.poll(() => opens(tap).length).toBe(2);
	expect(opens(tap)[1]?.target?.guidance).toEqual({
		template: "builtin-one-of-each",
		text: BUILTIN_GUIDANCE[0]?.text,
	});

	// Turned off, the next process is started with nothing.
	await control.click();
	await page.getByTestId("guidance-list").getByTestId("guidance-option-none").click();
	await expect(control).toHaveText(en.chipOff);
	await field.fill("kept twice");
	await field.press("Enter");
	await expect.poll(() => opens(tap).length).toBe(3);
	expect(opens(tap)[2]?.target?.guidance).toBeUndefined();
});

test("a template made the default in Settings is what New chat starts with, until another (or none) is picked there", async ({
	page,
}) => {
	await settings(page);
	const card = page.getByTestId("guidance-settings");
	await card.scrollIntoViewIfNeeded();
	await expect(card.getByTestId("guidance-default-line")).toHaveText(en.newChatsNone);
	await template(card, "One of each kind at a time").click();
	const editor = page.getByTestId("guidance-editor");
	await editor.getByTestId("guidance-make-default").check();
	await editor.getByTestId("guidance-save-template").click();
	await expect(card.getByTestId("guidance-default-line")).toHaveText(
		en.newChatsGet.replace("{name}", "One of each kind at a time"),
	);
	await expect(
		card.getByTestId("guidance-template-row").filter({ hasText: "One of each kind at a time" }),
	).toContainText(en.defaultBadge);

	// New chat starts with it: the first process is started with the template, and the chip names it.
	const tap = await tapSocket(page);
	await newChat(page, process.env.OMPW_E2E_WORK as string);
	await expect.poll(() => opens(tap).length).toBeGreaterThan(0);
	expect(opens(tap)[0]?.target?.guidance).toEqual({ template: "builtin-one-of-each" });
	const control = page.getByTestId("guidance-picker");
	await expect(control).toHaveText(en.chip.replace("{name}", "One of each kind at a time"));
	// None, picked here, is what this chat gets.
	await control.click();
	await page.getByTestId("guidance-list").getByTestId("guidance-option-none").click();
	await expect(control).toHaveText(en.chipOff);
});

test("the Guidance tab of a conversation that runs is its editor: text written there, a template picked, turned off", async ({
	page,
}) => {
	// A conversation of the spec's own (#712), its omp started by a `!command` (no model call): the Guidance tab (#704) is
	// where its guidance is edited (#715); the Info tab has none.
	ownSession(0x7150, "Guidance tab running 715");
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	await startLive(page, tap, "Guidance tab running 715", "guidance-info-row");
	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Info/).click();
	await expect(page.getByTestId("session-info")).toBeVisible();
	await expect(page.getByTestId("guidance-editor")).toHaveCount(0);
	await topTab(page, /Guidance/).click();
	const editor = page.getByTestId("guidance-editor");
	await expect(editor.getByTestId("guidance-template")).toHaveValue("", { timeout: 30_000 });
	await expect(editor.getByTestId("guidance-applies-next")).toHaveCount(0);

	// Text of its own, written in the box: Save for this conversation is usable once it differs, and what is saved is what
	// the process carries.
	await editor.getByTestId("guidance-template").selectOption("custom");
	const box = editor.getByTestId("guidance-text");
	await expect(editor.getByTestId("guidance-save")).toHaveAttribute("aria-disabled", "true");
	await box.fill("At most 2 subagents at a time, and say which you started.");
	await editor.getByTestId("guidance-save").click();
	await expect(editor.getByTestId("guidance-save")).toHaveAttribute("aria-disabled", "true");
	await expect(editor.getByTestId("guidance-template")).toHaveValue("custom");
	// Edited again in place: no question, the text is the conversation's own.
	await box.fill("At most 3 subagents at a time.");
	await editor.getByTestId("guidance-save").click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(editor.getByTestId("guidance-save")).toHaveAttribute("aria-disabled", "true");
	await expect(box).toHaveValue("At most 3 subagents at a time.");
	// Revert puts back what is carried.
	await box.fill("Something else");
	await editor.getByTestId("guidance-revert").click();
	await expect(box).toHaveValue("At most 3 subagents at a time.");

	// A template picked: the box holds its text.
	const each = BUILTIN_GUIDANCE.find((b) => b.name === "One of each kind at a time");
	await editor.getByTestId("guidance-template").selectOption({ label: "One of each kind at a time" });
	await expect(box).toHaveValue(each?.text ?? "");

	// Turned off: none, and the box is empty.
	await editor.getByTestId("guidance-template").selectOption("");
	await expect(editor.getByTestId("guidance-template")).toHaveValue("");
	await expect(box).toHaveValue("");
});

test("Save for this conversation leaves the template alone; Save to template asks first when another conversation uses it", async ({
	page,
	request,
}) => {
	const name = "Shared from the tab";
	const made = await request.post("/api/model-guidance", {
		headers: post,
		data: { template: { id: "shared-from-tab", name, text: "Original template text." } },
	});
	expect(made.ok()).toBe(true);
	// Another conversation, not running, uses the template too.
	const other = writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0x7153, "Guidance shared other");
	const given = await request.post("/api/model-guidance/live", {
		headers: post,
		data: { file: other, guidance: { template: "shared-from-tab" } },
	});
	expect(given.ok()).toBe(true);
	ownSession(0x7151, "Guidance template edit 715");
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	await startLive(page, tap, "Guidance template edit 715", "guidance-template-edit");
	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Guidance/).click();
	const editor = page.getByTestId("guidance-editor");
	await editor.getByTestId("guidance-template").selectOption({ label: name }, { timeout: 30_000 });
	const box = editor.getByTestId("guidance-text");
	await expect(box).toHaveValue("Original template text.");
	const toTemplate = editor.getByTestId("guidance-to-template");
	// The three ways of saving are all there; with nothing edited, none of the saves has anything to do.
	await expect(toTemplate).toHaveAttribute("title", en.toTemplateSame.replace("{name}", name));
	await expect(toTemplate).toHaveAttribute("aria-disabled", "true");
	await expect(editor.getByTestId("guidance-new-template")).not.toHaveAttribute("aria-disabled", "true");

	// Save for this conversation: it carries the text as its own, and the template is as it was.
	await box.fill("Changed for this conversation.");
	await expect(editor.getByTestId("guidance-save")).toHaveAttribute("title", en.saveHereHint);
	await editor.getByTestId("guidance-save").click();
	await expect(editor.getByTestId("guidance-template")).toHaveValue("custom");
	expect(stored().templates.find((t) => t.id === "shared-from-tab")?.text).toBe("Original template text.");
	// It uses no template now: Save to template says why it cannot, and to make one instead.
	await expect(toTemplate).toHaveAttribute("aria-disabled", "true");
	await expect(toTemplate).toHaveAttribute("title", en.toTemplateNone);
	await toTemplate.click({ force: true });
	await expect(page.getByRole("dialog")).toHaveCount(0);

	// Picked again and saved into the template: the other conversation uses it, so the person is asked first.
	await editor.getByTestId("guidance-template").selectOption({ label: name });
	await expect(box).toHaveValue("Original template text.");
	await box.fill("Changed in the template.");
	await toTemplate.click();
	const ask = page.getByRole("dialog");
	await expect(ask).toContainText(en.confirmTitle.replace("{name}", name));
	await expect(ask).toContainText(en.confirmShared.replace("{n}", "1"));
	await ask.getByTestId("guidance-confirm-cancel").click();
	await expect(ask).toHaveCount(0);
	expect(stored().templates.find((t) => t.id === "shared-from-tab")?.text).toBe("Original template text.");
	await toTemplate.click();
	await page.getByRole("dialog").getByTestId("guidance-confirm-update").click();
	await expect(editor.getByTestId("guidance-template")).toHaveValue("shared-from-tab");
	await expect
		.poll(() => stored().templates.find((t) => t.id === "shared-from-tab")?.text)
		.toBe("Changed in the template.");
	await expect(box).toHaveValue("Changed in the template.");
	// The conversation that is not running carries the template as it is now when it is opened next.
	const otherNow: { guidance: { text: string } | null } = await (
		await request.get(`/api/model-guidance/session?file=${encodeURIComponent(other)}`)
	).json();
	expect(otherNow.guidance?.text).toBe("Changed in the template.");

	// Deleted by another page between the question and the answer: saving into it fails visibly and does not bring it back.
	await box.fill("Too late.");
	await page.route("**/api/model-guidance", async (route) => {
		if (route.request().method() === "POST" && route.request().postDataJSON()?.update === true)
			await request.post("/api/model-guidance", { headers: post, data: { remove: "shared-from-tab" } });
		await route.continue();
	});
	await toTemplate.click();
	await page.getByRole("dialog").getByTestId("guidance-confirm-update").click();
	await expect(editor.getByTestId("guidance-error")).toContainText(en.templateGone);
	expect(stored().templates.some((t) => t.id === "shared-from-tab")).toBe(false);
	// The conversation keeps what it carried: the edit was not applied to it either.
	await expect(editor.getByTestId("guidance-revert")).toBeVisible();
});

test("Create new template asks for a name it checks, makes the template and uses it; the pencil renames it in place", async ({
	page,
	request,
}) => {
	ownSession(0x7154, "Guidance new template");
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	await startLive(page, tap, "Guidance new template", "guidance-create-probe");
	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Guidance/).click();
	const editor = page.getByTestId("guidance-editor");
	await expect(editor.getByTestId("guidance-template")).toHaveValue("", { timeout: 30_000 });
	// No text yet: nothing to make a template of, and no template to rename.
	await expect(editor.getByTestId("guidance-new-template")).toHaveAttribute("title", en.textNeeded);
	await expect(editor.getByTestId("guidance-rename")).toHaveCount(0);
	await editor.getByTestId("guidance-template").selectOption("custom");
	await editor.getByTestId("guidance-text").fill("Text for a new template.");

	// The dialog, by keyboard: its field has the focus, and Enter is Create.
	await editor.getByTestId("guidance-new-template").click();
	const dialog = page.getByRole("dialog");
	const field = dialog.getByTestId("guidance-new-name");
	await expect(field).toBeFocused();
	await field.press("Enter");
	await expect(dialog.getByTestId("guidance-new-problem")).toHaveText(en.nameEmpty);
	await field.fill("   ");
	await dialog.getByTestId("guidance-new-create").click();
	await expect(dialog.getByTestId("guidance-new-problem")).toHaveText(en.nameEmpty);
	await field.fill(" One of each kind at a time ");
	await expect(dialog.getByTestId("guidance-new-problem")).toHaveText(en.nameRepeated);
	await field.fill("x".repeat(61));
	await expect(dialog.getByTestId("guidance-new-problem")).toHaveText(en.nameTooLong.replace("{max}", "60"));
	await field.press("Enter");
	await expect(dialog).toBeVisible();
	const before = stored().templates.length;
	expect(before).toBeGreaterThan(0);
	await field.fill("  Made in the tab  ");
	await field.press("Enter");
	await expect(dialog).toHaveCount(0);
	const made = () => stored().templates.find((t) => t.name === "Made in the tab");
	await expect.poll(() => made()?.text).toBe("Text for a new template.");
	// The conversation uses it now.
	await expect(editor.getByTestId("guidance-template")).toHaveValue(made()?.id as string);

	// Renamed with the pencil: Esc puts the name back and the focus on the pencil.
	const pencil = editor.getByTestId("guidance-rename");
	await expect(pencil).toHaveAccessibleName(en.rename);
	await pencil.click();
	const input = editor.getByTestId("guidance-rename-input");
	await expect(input).toBeFocused();
	await expect(input).toHaveValue("Made in the tab");
	await input.fill("Not kept");
	await input.press("Escape");
	await expect(input).toHaveCount(0);
	await expect(pencil).toBeFocused();
	expect(made()).toBeDefined();
	// The same checks as Create: another template's name is refused and Enter does nothing.
	await pencil.press("Enter");
	await input.fill("One of each kind at a time");
	await expect(editor.getByTestId("guidance-rename-note")).toHaveText(en.nameRepeated);
	await input.press("Enter");
	await expect(input).toBeVisible();
	await input.fill("  Renamed in the tab ");
	await input.press("Enter");
	await expect(input).toHaveCount(0);
	await expect
		.poll(() => stored().templates.find((t) => t.text === "Text for a new template.")?.name)
		.toBe("Renamed in the tab");
	await expect(editor.getByTestId("guidance-template").locator("option:checked")).toHaveText("Renamed in the tab");
	// What the person made is theirs, which Restore defaults leaves alone: it goes, so the worker's next spec starts clean.
	const id = stored().templates.find((t) => t.name === "Renamed in the tab")?.id;
	expect((await request.post("/api/model-guidance", { headers: post, data: { remove: id } })).status()).toBe(200);
});

test("a conversation that is not running has the same editor; the change is carried when it is opened (#715)", async ({
	page,
}) => {
	ownSession(0x7152, "Guidance closed 715");
	await page.goto("/");
	await openSidebar(page);
	await sessionRow(page, "Guidance closed 715").click();
	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Guidance/).click();
	const editor = page.getByTestId("guidance-editor");
	await expect(editor.getByTestId("guidance-applies-next")).toBeVisible({ timeout: 30_000 });
	await editor.getByTestId("guidance-template").selectOption("custom");
	await editor.getByTestId("guidance-text").fill("Kept for the next opening.");
	await editor.getByTestId("guidance-save").click();
	await expect(editor.getByTestId("guidance-save")).toHaveAttribute("aria-disabled", "true");
	// Read again from the server: it is what was kept for the file.
	await page.reload();
	await openSidebar(page);
	await sessionRow(page, "Guidance closed 715").click();
	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Guidance/).click();
	await expect(page.getByTestId("guidance-text")).toHaveValue("Kept for the next opening.", { timeout: 30_000 });
});

test("Settings › Model guidance edits a template, keeps it in the data folder, and Restore defaults puts the shipped ones back", async ({
	page,
}) => {
	await settings(page);
	const card = page.getByTestId("guidance-settings");
	await card.scrollIntoViewIfNeeded();
	await expect(card).toBeVisible();

	// A new template: saved to the data folder, and listed.
	await card.getByTestId("guidance-new").click();
	const editor = page.getByRole("dialog");
	await editor.getByTestId("guidance-name").fill("DeepSeek for reading");
	await editor.getByTestId("guidance-body").fill("Mechanical reading goes to a DeepSeek subagent.");
	await editor.getByTestId("guidance-save-template").click();
	await expect(card.getByTestId("guidance-templates")).toContainText("DeepSeek for reading");
	expect(stored().templates.some((t) => t.name === "DeepSeek for reading")).toBe(true);

	// Edited: the stored text follows.
	await template(card, "DeepSeek for reading").click();
	const again = page.getByRole("dialog");
	await again.getByTestId("guidance-body").fill("Mechanical reading goes to DeepSeek.");
	await again.getByTestId("guidance-save-template").click();
	await expect
		.poll(() => stored().templates.find((t) => t.name === "DeepSeek for reading")?.text)
		.toBe("Mechanical reading goes to DeepSeek.");
	// The list says what it is about, not all of it.
	await expect(card.getByTestId("guidance-template-row").filter({ hasText: "DeepSeek for reading" })).toContainText(
		"Mechanical reading goes to DeepSeek.",
	);

	// Duplicated: a copy with its own name, saved as a template of its own.
	await template(card, "DeepSeek for reading").click();
	await page.getByTestId("guidance-duplicate").click();
	await expect(page.getByTestId("guidance-name")).toHaveValue("DeepSeek for reading (copy)");
	await page.getByTestId("guidance-save-template").click();
	await expect
		.poll(() => stored().templates.filter((t) => t.text === "Mechanical reading goes to DeepSeek.").length)
		.toBe(2);

	// Deleted: it goes, and a conversation that used it keeps its text (the store's own rule, tested elsewhere).
	const openOriginal = template(card, "DeepSeek for reading");
	await openOriginal.click();
	await page.getByTestId("guidance-delete").click();
	await page.getByTestId("guidance-delete-confirm").click();
	await expect(openOriginal).toHaveCount(0);
	expect(stored().templates.some((t) => t.name === "DeepSeek for reading")).toBe(false);
	// The copy is the person's own, which Restore defaults leaves alone: it goes too, so the worker's next spec starts clean.
	const copy = stored().templates.find((t) => t.name === "DeepSeek for reading (copy)");
	expect(copy).toBeDefined();
	const removed = await page.request.post("/api/model-guidance", { headers: post, data: { remove: copy?.id } });
	expect(removed.status()).toBe(200);

	// A shipped template that was changed can be put back as it ships, from its editor.
	await template(card, "One of each kind at a time").click();
	await page.getByTestId("guidance-body").fill("Changed.");
	await page.getByTestId("guidance-reset").click();
	await expect(page.getByTestId("guidance-body")).toHaveValue(BUILTIN_GUIDANCE[0]?.text as string);
	await page.getByRole("button", { name: en.cancel }).click();

	// Restored: the shipped templates come back with their own names.
	await card.getByTestId("guidance-restore").click();
	await expect(card.getByTestId("guidance-notice")).toHaveText(en.restoreDone);
	await expect(card.getByTestId("guidance-templates")).toContainText("One of each kind at a time");
});

test("a page in Chinese reads the guidance card in Chinese", async ({ page }) => {
	// The language is a preference the page applies before it paints.
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	await settings(page);
	const card = page.getByTestId("guidance-settings");
	await card.scrollIntoViewIfNeeded();
	await expect(card).toContainText(zh.title);
	await expect(card).toContainText(zh.settingsIntro);
	await card.getByTestId("guidance-new").click();
	const editor = page.getByRole("dialog");
	await expect(editor).toContainText(zh.nameLabel);
	await expect(editor).toContainText(zh.bodyLabel);
});
