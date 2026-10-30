import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { solidPng, writeChatSession } from "../support/chat-session.ts";
import { ownSession, startLive } from "../support/live.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Edit, Regenerate and Fork while omp is replying. omp moves to a new, empty session file for `branch`, then refuses the
 * prompt ("Agent is already processing") and the reply that is still coming lands in the new file without its prompt.
 * They are not offered while a reply runs, the state is read again right before the branch, and a failure after the
 * branch puts the text back in the composer. No model is called: the reply is a pushed frame, omp's answers are stubs.
 */

const edit = (page: Page) => page.getByRole("button", { name: "Edit (creates a branch)" });
const regenerate = (page: Page) => page.getByRole("button", { name: "Regenerate (new branch)" });
const forks = (page: Page) => page.getByRole("button", { name: /^(Fork into a new conversation|Branch from here)/ });

async function open(page: Page, n: number, title: string): Promise<{ tap: SocketTap; liveId: string }> {
	ownSession(n, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `edit-replying-${n}`);
	return { tap, liveId };
}

test("Edit, Regenerate and Fork are not offered while a reply runs, and an open editor waits for it", async ({
	page,
}) => {
	const { tap, liveId } = await open(page, 0x28, "Edit while replying");
	await expect(edit(page)).toHaveCount(1);
	await expect(regenerate(page)).toHaveCount(1);
	await expect(forks(page)).toHaveCount(2);

	await page.getByTestId("msg-user").first().hover();
	await edit(page).click();
	await page.getByLabel("Edit message").fill("Edit while replying, differently");

	// Another tab (or the terminal) sends: a reply begins.
	tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
	await expect(edit(page)).toHaveCount(0);
	await expect(regenerate(page)).toHaveCount(0);
	await expect(forks(page)).toHaveCount(0);
	// The editor is not closed on the user, and cannot send into the reply.
	await expect(page.getByLabel("Edit message")).toHaveValue("Edit while replying, differently");
	await expect(page.getByTestId("edit-busy")).toBeVisible();
	await expect(page.getByRole("button", { name: "Send as new branch" })).toBeDisabled();

	// The reply ends: the same editor can send.
	tap.push({ t: "frame", liveId, frame: { type: "agent_end", messages: [] } });
	await expect(page.getByTestId("edit-busy")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Send as new branch" })).toBeEnabled();
	await expect(regenerate(page)).toHaveCount(1);
	expect(tap.commands("branch")).toHaveLength(0);
});

test("a prompt omp refuses after the branch goes back to the composer: Edit's text, and Regenerate's prompt", async ({
	page,
}) => {
	const { tap } = await open(page, 0x29, "Refused after branch");
	tap.answer("branch", () => ({ ok: true, data: {} }));
	tap.answer("prompt", () => ({ ok: false, error: "Agent is already processing" }));
	const composer = page.getByTestId("composer");

	await page.getByTestId("msg-user").first().hover();
	await edit(page).click();
	await page.getByLabel("Edit message").fill("A better question");
	await page.getByRole("button", { name: "Send as new branch" }).click();
	await expect(page.getByTestId("toast").first()).toContainText("Edit failed: Agent is already processing");
	await expect(composer).toHaveValue("A better question");
	expect(tap.commands("branch")).toHaveLength(1);

	// Regenerate: the prompt it was about to send again is not left behind in the old branch.
	await composer.fill("");
	await regenerate(page).click();
	await expect(page.getByTestId("toast").filter({ hasText: "Regenerate failed" })).toBeVisible();
	await expect(composer).toHaveValue("Refused after branch?");
	expect(tap.commands("branch")).toHaveLength(2);
});

test("a reply that starts while the edit is being prepared stops it before the branch", async ({ page }) => {
	// The prompt has a picture that is loaded before anything is branched: slow, so a reply can start meanwhile.
	const hash = "ab".repeat(32);
	const file = writeChatSession(process.env.OMPW_E2E_AGENT_DIR as string, {
		n: 0x2a,
		title: "Race before branch",
		turns: [{ prompt: "Race before branch?", reply: "Race before branch.", image: hash }],
	});
	await page.route(`**/api/blob/${hash}`, async (route) => {
		await sleep(1200);
		await route.fulfill({ body: solidPng(8, 8), contentType: "image/png" });
	});
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	tap.answer("branch", () => ({ ok: true, data: {} }));
	tap.answer("prompt", () => ({ ok: true, data: {} }));
	await page.goto("/");
	const liveId = await startLive(page, tap, "Race before branch", "race-before-branch-up");
	try {
		await page.getByTestId("msg-user").first().hover();
		await edit(page).click();
		await page.getByLabel("Edit message").fill("Race before branch, edited");
		await page.getByRole("button", { name: "Send as new branch" }).click();
		// Clicked while idle; the picture is still on its way when the reply begins.
		tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });

		await expect(page.getByTestId("toast").first()).toContainText("Edit failed: The conversation is replying");
		await expect(page.getByTestId("composer")).toHaveValue("Race before branch, edited");
		expect(tap.commands("branch")).toHaveLength(0);
		expect(tap.commands("prompt")).toHaveLength(0);
	} finally {
		await page.unroute(`**/api/blob/${hash}`);
		rmSync(file, { force: true });
	}
});
