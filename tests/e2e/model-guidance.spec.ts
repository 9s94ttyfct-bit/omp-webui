import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_GUIDANCE } from "../../shared/model-guidance.ts";
import { en } from "../../web/src/i18n/guidance.ts";
import { zh } from "../../web/src/i18n/zh-CN/guidance.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { openSidebar, ownSession, sessionRow, startLive } from "../support/live.ts";
import { newChatIn } from "../support/new-chat.ts";
import { topTab } from "../support/panel.ts";
import { choose } from "../support/select.ts";
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

/**
 * What the templates file holds (`server/omp/guidance/store.ts`). A data dir the store has not written to yet has no file,
 * and the store then holds the shipped templates: a test that runs first in its worker meets that.
 */
const stored = (): { rev: number; templates: { id: string; name: string; text: string; builtin?: true }[] } =>
	existsSync(dataFile())
		? JSON.parse(readFileSync(dataFile(), "utf8"))
		: { rev: 0, templates: BUILTIN_GUIDANCE.map((t) => ({ ...t })) };

/**
 * A page script that lets a test act right after React commits, before the effects of that commit run: React reports
 * each commit to a DevTools hook there, so the page gets one that calls `window.ompwAfterCommit` (set by the test).
 * A busy runner puts a person's keystroke in that gap; here it is put there on purpose.
 */
const afterCommitHook = () => {
	const w = window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown; ompwAfterCommit?: () => void };
	w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
		supportsFiber: true,
		renderers: new Map(),
		inject: () => 1,
		onCommitFiberRoot: () => w.ompwAfterCommit?.(),
		onCommitFiberUnmount: () => {},
		onPostCommitFiberRoot: () => {},
	};
};

/**
 * Press Save for this conversation and type `text` into the box in the moment the save is drawn as finished: right
 * after the commit that ends "Saving…" on the button, before that commit's effects ran (`afterCommitHook`), the
 * earliest a person typing right after a save can land. Resolves once it was typed.
 */
const saveThenType = (editor: Locator, text: string): Promise<void> =>
	editor.evaluate(
		(root, [text, saving]) => {
			const w = window as unknown as { ompwAfterCommit?: () => void };
			const save = root.querySelector('[data-testid="guidance-save"]') as HTMLButtonElement;
			const box = root.querySelector('[data-testid="guidance-text"]') as HTMLTextAreaElement;
			const { promise, resolve } = Promise.withResolvers<void>();
			let started = false;
			w.ompwAfterCommit = () => {
				if (save.title === saving) started = true;
				else if (started) {
					w.ompwAfterCommit = undefined;
					// As a keystroke does: the value changes, then the input event React reads it from.
					Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, text);
					box.dispatchEvent(new Event("input", { bubbles: true }));
					resolve();
				}
			};
			save.click();
			return promise;
		},
		[text, en.saving],
	);

/** The `open` requests the page sent (§ every one starts an omp process). */
const opens = (tap: SocketTap) => tap.sent.filter((m) => m.t === "open");

const newChat = async (page: Page, cwd: string): Promise<void> => {
	await page.goto(newChatIn(cwd));
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

/** Set (or with null forget) synced preferences on the server. (A test's browser starts ahead of them: see `fixtures.ts`.) */
const putPrefs = async (page: Page, changes: Record<string, string | null>): Promise<void> => {
	const res = await page.request.post("/api/prefs", { headers: post, data: { changes } });
	expect(res.status()).toBe(200);
};

/** What the server holds of a synced preference. */
const prefOnServer = async (page: Page, key: string): Promise<string | null> =>
	((await (await page.request.get("/api/prefs")).json()) as { values: Record<string, string | null> }).values[key] ??
	null;

test.afterEach(async ({ page }) => {
	const res = await page.request.post("/api/model-guidance/restore", { headers: post });
	expect(res.status()).toBe(200);
	await putPrefs(page, { "ompw.guidanceDefault": null, "ompw.guidanceLast": null });
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

test("the Guidance list stays where it opened while the pointer moves over it, so a template can be clicked", async ({
	page,
}) => {
	await newChat(page, process.env.OMPW_E2E_WORK as string);
	const control = page.getByTestId("guidance-picker");
	// Window heights where the list fits on one side of the chip without a template's text and not with it: the list used to
	// grow by the text under the pointer, turn to the other side of the chip, put another row under the pointer, shrink, and
	// turn back, so it jumped up and down as the pointer moved and a click landed on whichever row was there.
	for (const height of [560, 640, 720, 800, 900]) {
		await page.setViewportSize({ width: 1280, height });
		await control.click();
		const list = page.getByTestId("guidance-list");
		await expect(list).toBeVisible();
		const options = list.getByTestId("guidance-option");
		await expect(options.first()).toBeVisible();
		const opened = await list.boundingBox();
		if (!opened) throw new Error("no list");
		expect(opened.y, `${height}px: the list starts inside the window`).toBeGreaterThanOrEqual(0);
		expect(opened.y + opened.height, `${height}px: and ends inside it`).toBeLessThanOrEqual(height);
		const count = await options.count();
		for (let i = 0; i < count; i++) {
			const option = options.nth(i);
			// In a short window the rows scroll inside the list (the list itself stays put).
			await option.scrollIntoViewIfNeeded();
			const box = await option.boundingBox();
			if (!box) throw new Error("no option");
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
			// Two frames for the popper to place the list after what the hover changed.
			await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
			expect(await list.boundingBox(), `${height}px: the list did not move under option ${i}`).toEqual(opened);
			const under = await option.evaluate(
				(el, [x, y]) => el.contains(document.elementFromPoint(x as number, y as number)),
				[box.x + box.width / 2, box.y + box.height / 2],
			);
			expect(under, `${height}px: option ${i} is still under the pointer`).toBe(true);
		}
		const last = options.nth(count - 1);
		const name = (await last.locator("span.font-medium").textContent()) ?? "";
		await last.click();
		await expect(control).toHaveText(en.chip.replace("{name}", name));
		await page.keyboard.press("Escape");
	}
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
	// Leave the app first: New chat's address differs from Settings' only after the `#`, and the tap sees the sockets of
	// a page load, not those of the page already open.
	await page.goto("about:blank");
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
	await expect(editor.getByTestId("guidance-template")).toHaveAttribute("data-value", "", { timeout: 30_000 });
	await expect(editor.getByTestId("guidance-applies-next")).toHaveCount(0);

	// Text of its own, written in the box: Save for this conversation is usable once it differs, and what is saved is what
	// the process carries.
	await choose(editor.getByTestId("guidance-template"), "custom");
	const box = editor.getByTestId("guidance-text");
	await expect(editor.getByTestId("guidance-save")).toHaveAttribute("aria-disabled", "true");
	await box.fill("At most 2 subagents at a time, and say which you started.");
	await editor.getByTestId("guidance-save").click();
	await expect(editor.getByTestId("guidance-save")).toHaveAttribute("aria-disabled", "true");
	await expect(editor.getByTestId("guidance-template")).toHaveAttribute("data-value", "custom");
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
	await choose(editor.getByTestId("guidance-template"), { label: "One of each kind at a time" });
	await expect(box).toHaveValue(each?.text ?? "");

	// Turned off: none, and the box is empty.
	await choose(editor.getByTestId("guidance-template"), "");
	await expect(editor.getByTestId("guidance-template")).toHaveAttribute("data-value", "");
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
	await page.addInitScript(afterCommitHook);
	await page.goto("/");
	await openSidebar(page);
	await startLive(page, tap, "Guidance template edit 715", "guidance-template-edit");
	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Guidance/).click();
	const editor = page.getByTestId("guidance-editor");
	await choose(editor.getByTestId("guidance-template"), { label: name }, { timeout: 30_000 });
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
	// Typed in the moment the save is drawn as done, what is typed stays: the box is not given the carried text again.
	await saveThenType(editor, "Typed as it saved.");
	await expect(editor.getByTestId("guidance-template")).toHaveAttribute("data-value", "custom");
	await expect(box).toHaveValue("Typed as it saved.");
	await expect(editor.getByTestId("guidance-save")).toHaveAttribute("title", en.saveHereHint);
	expect(stored().templates.find((t) => t.id === "shared-from-tab")?.text).toBe("Original template text.");
	// It uses no template now: Save to template says why it cannot, and to make one instead.
	await expect(toTemplate).toHaveAttribute("aria-disabled", "true");
	await expect(toTemplate).toHaveAttribute("title", en.toTemplateNone);
	await toTemplate.click({ force: true });
	await expect(page.getByRole("dialog")).toHaveCount(0);

	// Picked again and saved into the template: the other conversation uses it, so the person is asked first.
	await choose(editor.getByTestId("guidance-template"), { label: name });
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
	// The save has ended once the template has the box's text (while it runs the button says it is saving).
	await expect(toTemplate).toHaveAttribute("title", en.toTemplateSame.replace("{name}", name));
	await expect(editor.getByTestId("guidance-template")).toHaveAttribute("data-value", "shared-from-tab");
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
	await expect(editor.getByTestId("guidance-template")).toHaveAttribute("data-value", "", { timeout: 30_000 });
	// No text yet: nothing to make a template of, and no template to rename.
	await expect(editor.getByTestId("guidance-new-template")).toHaveAttribute("title", en.textNeeded);
	await expect(editor.getByTestId("guidance-rename")).toHaveCount(0);
	await choose(editor.getByTestId("guidance-template"), "custom");
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
	await expect(editor.getByTestId("guidance-template")).toHaveAttribute("data-value", made()?.id as string);

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
	await expect(editor.getByTestId("guidance-template")).toHaveText("Renamed in the tab");
	// What the person made is theirs, which Restore defaults leaves alone: it goes, so the worker's next spec starts clean.
	const id = stored().templates.find((t) => t.name === "Renamed in the tab")?.id;
	expect((await request.post("/api/model-guidance", { headers: post, data: { remove: id } })).status()).toBe(200);
});

test("a template edited on another page reaches the open Guidance tab of a running conversation that uses it", async ({
	page,
	request,
}) => {
	const made = await request.post("/api/model-guidance", {
		headers: post,
		data: { template: { id: "follow-other-page", name: "Followed", text: "Text before the edit." } },
	});
	expect(made.ok()).toBe(true);
	ownSession(0x7155, "Guidance follows the template");
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	await startLive(page, tap, "Guidance follows the template", "guidance-follow-probe");
	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Guidance/).click();
	const editor = page.getByTestId("guidance-editor");
	await choose(editor.getByTestId("guidance-template"), { label: "Followed" }, { timeout: 30_000 });
	const box = editor.getByTestId("guidance-text");
	await expect(box).toHaveValue("Text before the edit.");

	// Another page edits the template in Settings: its name and its text.
	const other = await page.context().newPage();
	await settings(other);
	const card = other.getByTestId("guidance-settings");
	await card.scrollIntoViewIfNeeded();
	await template(card, "Followed").click();
	const dialog = other.getByRole("dialog");
	await dialog.getByTestId("guidance-name").fill("Followed, renamed");
	await dialog.getByTestId("guidance-body").fill("Text after the edit.");
	await dialog.getByTestId("guidance-save-template").click();
	await expect(dialog).toHaveCount(0);
	await other.close();

	// This page shows it without a reload: the box, the menu's name, and Save to template has nothing to write back.
	await expect(box).toHaveValue("Text after the edit.");
	await expect(editor.getByTestId("guidance-template")).toHaveText("Followed, renamed");
	await expect(editor.getByTestId("guidance-to-template")).toHaveAttribute(
		"title",
		en.toTemplateSame.replace("{name}", "Followed, renamed"),
	);
	expect(
		(await request.post("/api/model-guidance", { headers: post, data: { remove: "follow-other-page" } })).ok(),
	).toBe(true);
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
	await choose(editor.getByTestId("guidance-template"), "custom");
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

test("Settings › Model guidance keeps the editor open with what was written when a save is refused, and a template whose delete failed stays the default", async ({
	page,
}) => {
	await settings(page);
	const card = page.getByTestId("guidance-settings");
	await card.scrollIntoViewIfNeeded();

	// Another template's name is said before anything is sent.
	await card.getByTestId("guidance-new").click();
	const editor = page.getByRole("dialog");
	await editor.getByTestId("guidance-name").fill(BUILTIN_GUIDANCE[0]?.name as string);
	await editor.getByTestId("guidance-body").fill("A long text the person wrote.");
	await expect(editor.getByTestId("guidance-problem")).toHaveText(en.nameRepeated);
	await expect(editor.getByTestId("guidance-save-template")).toBeDisabled();

	// A save the store refuses (the name taken on another page meanwhile): the editor stays, with the name and the text.
	/** How the store answers a change: refusing the name, failing, or (null) as it does. */
	let refuse: "name" | "fail" | null = "name";
	await page.route("**/api/model-guidance", (route) =>
		refuse && route.request().method() === "POST"
			? route.fulfill(
					refuse === "name"
						? { status: 400, json: { error: "taken", problem: "nameRepeated" } }
						: { status: 500, json: { error: "disk full" } },
				)
			: route.fallback(),
	);
	await editor.getByTestId("guidance-name").fill("Mine");
	await editor.getByTestId("guidance-save-template").click();
	await expect(editor.getByTestId("guidance-save-error")).toHaveText(en.saveFailed.replace("{error}", en.nameRepeated));
	await expect(editor.getByTestId("guidance-name")).toHaveValue("Mine");
	await expect(editor.getByTestId("guidance-body")).toHaveValue("A long text the person wrote.");
	await expect(card.getByTestId("guidance-settings-error")).toHaveCount(0);
	await editor.getByRole("button", { name: en.cancel }).click();

	// The default template's delete fails: it is still the default, and the card says the delete failed.
	const shipped = BUILTIN_GUIDANCE[0];
	if (!shipped) throw new Error("no shipped template");
	await template(card, shipped.name).click();
	await page.getByTestId("guidance-make-default").check();
	refuse = null;
	await page.getByTestId("guidance-save-template").click();
	await expect(card.getByTestId("guidance-default-line")).toHaveText(en.newChatsGet.replace("{name}", shipped.name));
	refuse = "fail";
	await template(card, shipped.name).click();
	await page.getByTestId("guidance-delete").click();
	await page.getByTestId("guidance-delete-confirm").click();
	await expect(card.getByTestId("guidance-settings-error")).toHaveText(en.deleteFailed.replace("{error}", "disk full"));
	await expect(card.getByTestId("guidance-default-line")).toHaveText(en.newChatsGet.replace("{name}", shipped.name));
	expect(stored().templates.some((t) => t.id === shipped.id)).toBe(true);
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

/** Open New chat in the work folder and wait for its first process. */
const newChatHere = async (page: Page): Promise<void> => {
	await page.goto(newChatIn(process.env.OMPW_E2E_WORK as string));
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
};

/** Start the conversation with a command (no model is asked), and wait until the server keeps what New chat remembered. */
const startWithCommand = async (page: Page): Promise<void> => {
	const composer = page.getByTestId("composer");
	await composer.fill("!true");
	await composer.press("Enter");
	await expect(page).not.toHaveURL(/#\/new/);
	await expect.poll(() => prefOnServer(page, "ompw.guidanceLast")).not.toBeNull();
};

test("New chat starts with the guidance the last new chat was started with: a template, then none over Settings' default", async ({
	page,
}) => {
	const tap = await tapSocket(page);
	// The conversation's page has its chunk only once New chat is open again, as on a runner where it came late: New chat
	// left for it is not shown again as it was then (its warm-up process the conversation it started, and none started).
	const chatChunk = Promise.withResolvers<void>();
	await page.route(/\/assets\/ChatView-[^/]*\.js$/, async (route) => {
		await chatChunk.promise;
		await route.continue();
	});
	await newChatHere(page);
	const control = page.getByTestId("guidance-picker");
	await control.click();
	await page
		.getByTestId("guidance-list")
		.getByTestId("guidance-option")
		.filter({ hasText: "One of each kind at a time" })
		.click();
	await expect(control).toHaveText(en.chip.replace("{name}", "One of each kind at a time"));
	await startWithCommand(page);
	expect(await prefOnServer(page, "ompw.guidanceLast")).toBe('{"template":"builtin-one-of-each"}');

	// The next New chat starts with it, though Settings makes no template the default.
	await newChatHere(page);
	await expect(control).toHaveText(en.chip.replace("{name}", "One of each kind at a time"));
	await expect.poll(() => opens(tap).at(-1)?.target?.guidance).toEqual({ template: "builtin-one-of-each" });
	chatChunk.resolve();

	// Started with none, though Settings now has a default: the next starts with none.
	await page.evaluate(() => localStorage.setItem("ompw.guidanceDefault", "builtin-one-of-each"));
	await control.click();
	await page.getByTestId("guidance-list").getByTestId("guidance-option-none").click();
	await expect(control).toHaveText(en.chipOff);
	await startWithCommand(page);
	await expect.poll(() => prefOnServer(page, "ompw.guidanceLast")).toBe('{"none":true}');
	const before = opens(tap).length;
	await newChatHere(page);
	await expect.poll(() => opens(tap).length).toBeGreaterThan(before);
	expect(opens(tap).at(-1)?.target?.guidance).toBeUndefined();
	await expect(control).toHaveText(en.chipOff);
});

test("a remembered template deleted since is not what New chat starts with: Settings' default is", async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem("ompw.guidanceLast", '{"template":"deleted-since"}');
		localStorage.setItem("ompw.guidanceDefault", "builtin-one-of-each");
	});
	const tap = await tapSocket(page);
	await newChatHere(page);
	await expect.poll(() => opens(tap).length).toBeGreaterThan(0);
	expect(opens(tap)[0]?.target?.guidance).toEqual({ template: "builtin-one-of-each" });
	await expect(page.getByTestId("guidance-picker")).toHaveText(en.chip.replace("{name}", "One of each kind at a time"));
});
