import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newChatIn } from "../support/new-chat.ts";
import { choose, readOptions } from "../support/select.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * New chat starts a new project by default (v0.17.0): a folder in the projects folder (Settings › Projects folder), named
 * as typed or from the time, made only when the first message is sent; omp is warmed up in the projects folder for the
 * pickers and never given the person's input there. An address with a folder (`#/new?cwd=`) opens New chat in that
 * folder instead. No model is called: the messages are `!commands`.
 */

const URL = () => process.env.OMPW_E2E_URL as string;
const headers = () => ({
	"x-omp-webui-token": String(process.env.OMPW_E2E_ACCESS_TOKEN),
	"x-omp-webui": "1",
	"content-type": "application/json",
});

/** Point the projects folder at `folder` (null: the default) for this test. */
async function setRoot(folder: string | null): Promise<void> {
	const res = await fetch(`${URL()}/api/projects`, {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({ folder }),
	});
	expect(res.status).toBe(200);
}

let n = 0;
/** A fresh, empty projects folder of this test's own. */
function freshRoot(): string {
	const root = join(process.env.OMPW_E2E_ROOT as string, `projects-${process.pid}-${Date.now()}-${++n}`);
	mkdirSync(root, { recursive: true });
	return root;
}

test.afterEach(async () => {
	await setRoot(null);
});

const opens = (tap: SocketTap) => tap.sent.filter((m) => m.t === "open").map((m) => m.target?.cwd);

async function openNewChat(page: Page): Promise<SocketTap> {
	const tap = await tapSocket(page);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	return tap;
}

async function sendCommand(page: Page, text: string): Promise<void> {
	const composer = page.getByTestId("composer");
	await composer.fill(text);
	await composer.press("Enter");
}

test("New chat offers a new project in the projects folder, focused, and makes nothing before the first message", async ({
	page,
}) => {
	const root = freshRoot();
	await setRoot(root);
	const tap = await openNewChat(page);
	const name = page.getByTestId("new-project-name");
	await expect(name).toBeFocused();
	await expect(name).toHaveValue("");
	await expect(page.getByTestId("new-project-root")).toContainText(root.split("/").pop() as string);
	// omp is warmed up in the projects folder, for the pickers; nothing is made there.
	expect(opens(tap)).toEqual([root]);
	await page.waitForTimeout(500);
	expect(readdirSync(root)).toEqual([]);
});

test("the first message makes a folder named by the time, and a !command runs there, never in the projects folder", async ({
	page,
}) => {
	const root = freshRoot();
	await setRoot(root);
	const tap = await openNewChat(page);
	await sendCommand(page, "!touch made-here");
	await expect.poll(() => readdirSync(root).filter((f) => f.startsWith("chat-"))).toHaveLength(1);
	const [made] = readdirSync(root);
	expect(made).toMatch(/^chat-\d{4}-\d{2}-\d{2}-\d{4}$/);
	await expect.poll(() => existsSync(join(root, made as string, "made-here")), { timeout: 30_000 }).toBe(true);
	expect(existsSync(join(root, "made-here"))).toBe(false);
	// The command ran in an omp started in the new folder; the projects folder only had the warm-up, for the pickers. (A
	// conversation of a !command alone has no session file yet: omp writes one with its first reply.)
	expect(opens(tap)).toEqual([root, join(root, made as string)]);
});

test("a typed name is the folder's name", async ({ page }) => {
	const root = freshRoot();
	await setRoot(root);
	await openNewChat(page);
	await page.getByTestId("new-project-name").fill("alpha-proj");
	await sendCommand(page, "!touch typed");
	await expect.poll(() => existsSync(join(root, "alpha-proj", "typed")), { timeout: 30_000 }).toBe(true);
	expect(readdirSync(root)).toEqual(["alpha-proj"]);
});

test("a thinking level picked before the first message is on the process started in the new folder", async ({
	page,
}) => {
	const root = freshRoot();
	await setRoot(root);
	const tap = await openNewChat(page);
	const picker = page.getByTestId("thinking-picker");
	const levels = (await readOptions(picker)).map((o) => o.value);
	const chosen = levels.find((l) => l !== null && l !== undefined && l !== "") as string;
	const current = await picker.getAttribute("data-value");
	const other = levels.find((l) => l !== current) as string;
	expect(chosen).toBeTruthy();
	await choose(picker, other);
	await expect.poll(() => tap.commands("set_thinking_level")).toHaveLength(1);
	await sendCommand(page, "!true");
	await expect.poll(() => opens(tap).length).toBe(2);
	expect(opens(tap)[1]).toMatch(new RegExp(`^${root}/chat-`));
	await expect.poll(() => tap.commands("set_thinking_level")).toHaveLength(2);
	expect(tap.commands("set_thinking_level")[1]).toEqual({ type: "set_thinking_level", level: other });
});

test("a projects folder that cannot be made in keeps the draft and its picture, says why, and sends nothing", async ({
	page,
}) => {
	const root = freshRoot();
	await setRoot(root);
	await openNewChat(page);
	// The folder goes, and a file takes its place, after New chat opened.
	rmSync(root, { recursive: true });
	writeFileSync(root, "");
	try {
		await page.getByTestId("composer").fill("!touch never");
		await page.getByTestId("composer").press("Enter");
		await expect(page.getByTestId("new-project-problem")).toContainText(/not a folder/i);
		await expect(page.getByTestId("composer")).toHaveValue("!touch never");
		await expect(page.getByTestId("new-project-name")).toBeVisible();
	} finally {
		rmSync(root, { force: true });
	}
});

test("an address with a folder opens New chat in that folder, as before: no new project", async ({ page }) => {
	const root = freshRoot();
	await setRoot(root);
	const work = join(process.env.OMPW_E2E_WORK as string, `existing-${Date.now()}`);
	mkdirSync(work, { recursive: true });
	const tap = await tapSocket(page);
	await page.goto(newChatIn(work));
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId("new-project-name")).toHaveCount(0);
	expect(opens(tap)).toEqual([work]);
	await sendCommand(page, "!touch in-existing");
	await expect.poll(() => existsSync(join(work, "in-existing")), { timeout: 30_000 }).toBe(true);
	expect(readdirSync(root)).toEqual([]);
});

test("Use an existing folder switches to the folder picker's choice, and back to a new project", async ({ page }) => {
	const root = freshRoot();
	await setRoot(root);
	const work = join(process.env.OMPW_E2E_WORK as string, `picked-${Date.now()}`);
	mkdirSync(work, { recursive: true });
	const tap = await openNewChat(page);
	await page.getByTestId("use-existing-folder").click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByTestId("dir-up")).toBeVisible();
	await dialog.getByLabel("Path").fill(work);
	await dialog.getByRole("button", { name: "Use this folder" }).click();
	await expect(page.getByTestId("cwd-picker")).toContainText(work.split("/").pop() as string);
	await expect.poll(() => opens(tap).at(-1)).toBe(work);
	await page.getByTestId("back-to-new-project").click();
	await expect(page.getByTestId("new-project-name")).toBeVisible();
	await expect.poll(() => opens(tap).at(-1)).toBe(root);
});
