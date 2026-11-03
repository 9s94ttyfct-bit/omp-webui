import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeChatSession } from "../support/chat-session.ts";
import { sessionRow, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * *Continue from here* under a reply: the conversation goes on from that reply in its own file (the one its sidebar row,
 * its pin and its settings belong to), and the whole conversation as it was is kept as a branch beside it. omp does the
 * work: a fork of the whole session (the copy is the branch), a switch back to the conversation's file, and a move of its
 * leaf to the reply. No model is called.
 */

const continueHere = "Continue from here (keep the original as a branch)";

test("Continue from here goes on from that reply in the conversation's own file, and keeps the conversation as it was as a branch", async ({
	page,
}) => {
	const title = "Continue from here probe";
	const file = writeChatSession(process.env.OMPW_E2E_AGENT_DIR as string, {
		n: 0xc5,
		title,
		turns: [
			{ prompt: "First question", reply: "First answer" },
			{ prompt: "Second question", reply: "Second answer" },
		],
	});
	const id = basename(file, ".jsonl").split("_").pop() as string;
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await startLive(page, tap, title, "continue-here");
	await expect(page.getByText("Second answer", { exact: true })).toBeVisible();

	// One button under each reply: the first reply's.
	await page.getByRole("button", { name: continueHere }).first().click();
	await expect(page.getByTestId("toast").filter({ hasText: "Continuing from here" })).toBeVisible();

	// The conversation on screen is still its own file, and ends at the first reply.
	expect(decodeURIComponent(page.url())).toContain(id);
	await expect(page.getByText("First answer", { exact: true })).toBeVisible();
	await expect(page.getByText("Second answer", { exact: true })).toHaveCount(0);

	// omp was asked for a copy of the whole conversation, then back to this file, then to the first reply.
	const fork = tap.commands("fork");
	expect(fork).toHaveLength(1);
	expect(fork[0]).not.toHaveProperty("entryId");
	// The server names a file by its real path (macOS's temp folder is under /private).
	expect(tap.commands("switch_session").map((c) => c.sessionPath)).toEqual([realpathSync(file)]);
	expect(tap.commands("navigate_tree").map((c) => c.entryId)).toEqual(["t0r"]);

	// The copy is a branch of the conversation, with the whole conversation as it was (omp may write a title line before
	// the header).
	const header = (f: string) =>
		readFileSync(f, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type?: string; parentSession?: string })
			.find((line) => line.type === "session");
	const branches = readdirSync(dirname(file))
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => join(dirname(file), f))
		.filter((f) => header(f)?.parentSession === id);
	expect(branches).toHaveLength(1);
	expect(readFileSync(branches[0], "utf8")).toContain("Second answer");

	// In the sidebar the conversation keeps its row, and the copy is marked a branch.
	const rows = sessionRow(page, title);
	await expect(rows).toHaveCount(2);
	await expect(rows.filter({ has: page.getByLabel("Branch", { exact: true }) })).toHaveCount(1);
});

test("Send here sends an edited prompt in the conversation's own file, in place of the prompt, and keeps the conversation as it was as a branch", async ({
	page,
}) => {
	const title = "Send here probe";
	const file = writeChatSession(process.env.OMPW_E2E_AGENT_DIR as string, {
		n: 0xc6,
		title,
		turns: [
			{ prompt: "First question", reply: "First answer" },
			{ prompt: "Second question", reply: "Second answer" },
		],
	});
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	// The edited prompt is taken and nothing is answered: no model is called.
	tap.answer("prompt", () => ({ ok: true, data: {} }));
	await page.goto("/");
	await startLive(page, tap, title, "send-here");
	await expect(page.getByText("Second answer", { exact: true })).toBeVisible();

	const second = page.getByTestId("msg-user").filter({ hasText: "Second question" });
	await second.hover();
	await second.getByRole("button", { name: "Edit (creates a branch)" }).click();
	await page.getByLabel("Edit message").fill("Second question, asked better");
	await page.getByRole("button", { name: "Send here (keep the original as a branch)" }).click();

	// The conversation stays in its own file, back to just before the edited prompt, and the edit is sent there.
	await expect(page.getByText("Second answer", { exact: true })).toHaveCount(0);
	await expect(page.getByText("First answer", { exact: true })).toBeVisible();
	expect(tap.commands("fork")).toHaveLength(1);
	expect(tap.commands("switch_session").map((c) => c.sessionPath)).toEqual([realpathSync(file)]);
	expect(tap.commands("navigate_tree").map((c) => c.entryId)).toEqual(["t1p"]);
	expect(tap.commands("branch")).toHaveLength(0);
	await expect.poll(() => tap.commands("prompt").map((c) => c.message)).toEqual(["Second question, asked better"]);
	await expect(sessionRow(page, title)).toHaveCount(2);
});
