import { rmSync } from "node:fs";
import { type ChatTurn, writeChatSession } from "../support/chat-session.ts";
import { startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * What a command prints (`/context`) belongs where the command was run: the messages that come after it are below it,
 * and loading the page again leaves it there. omp does not save it in the conversation, so this browser keeps it by the
 * conversation's file. A real omp runs the command; no model is called.
 */

const TITLE = "Command output place";
const turns: ChatTurn[] = Array.from({ length: 3 }, (_, i) => ({
	prompt: `Where does item ${i} go?`,
	reply: `Item ${i} goes in the drawer marked ${i}.`,
}));

/** Where each text is in the transcript, top to bottom. */
async function order(page: Page, texts: string[]): Promise<number[]> {
	const text = await page.getByTestId("transcript").innerText();
	return texts.map((t) => text.indexOf(t));
}

test("a command's output stays where it was run, below what came before and above what came after, and a reload keeps it", async ({
	page,
}) => {
	const file = writeChatSession(process.env.OMPW_E2E_AGENT_DIR as string, { n: 0xe1, title: TITLE, turns });
	try {
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		const tap = await tapSocket(page);
		await page.goto("/");
		await startLive(page, tap, TITLE, "probe-one");

		const composer = page.getByTestId("composer");
		await composer.fill("/context");
		await composer.press("Enter");
		const output = page.getByTestId("command-output");
		await expect(output).toHaveCount(1);
		await expect(output).toContainText("Context window");

		// Something that comes after the command: it is below its output, not above it as the output used to end the page.
		await composer.fill("!echo probe-two");
		await composer.press("Enter");
		await expect(page.getByTestId("transcript").getByText("probe-two", { exact: true })).toBeVisible({
			timeout: 30_000,
		});
		const [reply, printed, later] = await order(page, ["goes in the drawer marked 2", "Context window", "probe-two"]);
		expect(reply).toBeGreaterThanOrEqual(0);
		expect(printed).toBeGreaterThan(reply);
		expect(later).toBeGreaterThan(printed);

		// The page is loaded anew: nothing is running for it yet, and the output is where it was.
		await page.reload();
		await expect(page.getByTestId("command-output")).toHaveCount(1);
		await expect(page.getByTestId("command-output")).toContainText("Context window");
		const [replyAgain, printedAgain, laterAgain] = await order(page, [
			"goes in the drawer marked 2",
			"Context window",
			"probe-two",
		]);
		expect(printedAgain).toBeGreaterThan(replyAgain);
		expect(laterAgain).toBeGreaterThan(printedAgain);

		// The conversation runs again from this page: the same output, once, and a new command below it.
		await page.getByTestId("composer").fill("!echo probe-three");
		await page.getByTestId("composer").press("Enter");
		await expect(page.getByTestId("transcript").getByText("probe-three", { exact: true })).toBeVisible({
			timeout: 30_000,
		});
		await expect(page.getByTestId("command-output")).toHaveCount(1);
		const [kept, newest] = await order(page, ["Context window", "probe-three"]);
		expect(newest).toBeGreaterThan(kept);
	} finally {
		rmSync(file, { force: true });
	}
});
