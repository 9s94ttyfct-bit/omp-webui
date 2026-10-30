import { attachPicked } from "../support/drop-files.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * What New chat does with attached images when the message is not a plain prompt (#445). A `!command` has no way to
 * carry a picture (omp's bash takes none): as in a conversation, with images it goes as a message to the model. A goal
 * that starts at once takes an objective and a budget only: it is refused with the draft and the images kept, not
 * started without them. Prompts, commands and goals are answered by the spec, so nothing runs and no model is called.
 */

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

async function newChat(page: Page) {
	const tap = await tapSocket(page);
	for (const type of ["prompt", "bash", "goal"]) tap.answer(type, () => ({ ok: true, data: {} }));
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	return tap;
}

async function draft(page: Page, text: string) {
	await page.getByTestId("composer").fill(text);
	await attachPicked(page, { name: "dot.png", mimeType: "image/png", buffer: PNG_1X1 });
	await expect(page.getByRole("img", { name: "dot.png" })).toBeVisible();
}

/** The goals started: the page also reads omp's goal state (`op: "get"`), which starts nothing. */
const created = (tap: SocketTap) => tap.commands("goal").filter((c) => c.op === "create");

test("a !command with an image is sent as a message with the image, not run without it", async ({ page }) => {
	const tap = await newChat(page);
	await draft(page, "!ls");
	await page.getByTestId("send").click();
	// The conversation opens: under its process, or under its file when omp has named it already (omp 18.13, #722).
	await expect(page).toHaveURL(/#\/(live|s)\//);

	const [prompt] = tap.commands("prompt");
	expect(prompt?.message).toBe("!ls");
	expect(prompt?.images).toHaveLength(1);
	expect(tap.commands("bash")).toEqual([]);
});

test("a !command without an image still runs as a command", async ({ page }) => {
	const tap = await newChat(page);
	await page.getByTestId("composer").fill("!ls");
	await page.getByTestId("send").click();
	await expect.poll(() => tap.commands("bash")).toEqual([{ type: "bash", command: "ls" }]);
	expect(tap.commands("prompt")).toEqual([]);
});

test("a goal that starts at once is refused with an image: nothing is sent and the draft stays", async ({ page }) => {
	const tap = await newChat(page);
	await page.getByTestId("goal-mode").click();
	await page.getByTestId("goal-direct").click();
	await draft(page, "ship the release");
	await page.getByTestId("send").click();

	await expect(page.getByTestId("toast").filter({ hasText: "images" })).toBeVisible();
	await expect(page.getByTestId("composer")).toHaveValue("ship the release");
	await expect(page.getByRole("img", { name: "dot.png" })).toBeVisible();
	await expect(page.getByTestId("cwd-picker")).toBeVisible();
	expect(created(tap)).toEqual([]);
	expect(tap.commands("prompt")).toEqual([]);

	// Without the image the same goal starts.
	await page.getByRole("button", { name: "Remove dot.png" }).click();
	await page.getByTestId("send").click();
	await expect.poll(() => created(tap)).toEqual([{ type: "goal", op: "create", objective: "ship the release" }]);
});
