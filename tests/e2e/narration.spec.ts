import { rmSync } from "node:fs";
import { ownSession, startLive } from "../support/live.ts";
import { Chain, writeRenderSession } from "../support/render-fixtures.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * omp 18.12 marks the thinking blocks a Claude model addresses to the user `narration: true`, and the terminal shows
 * them as answer text. The web UI does too: no fold, Markdown, and they count as the text the work summary leaves
 * visible. Synthetic sessions and pushed frames; no model call.
 */

const agentDir = () => process.env.OMPW_E2E_AGENT_DIR as string;

test("a narration block reads as Markdown answer text, beside a thought that stays folded", async ({ page }) => {
	const prompt = "Narration probe: explain the cache";
	const chain = new Chain("na01");
	chain.user(prompt);
	chain.assistant([
		{ type: "thinking", thinking: "PRIVATE-REASONING-TEXT: weigh the options." },
		{ type: "thinking", thinking: "NARRATION-PROSE: I will read the **config** first.", narration: true },
		{ type: "text", text: "ANSWER-TEXT: the cache is keyed by path." },
	]);
	const file = writeRenderSession(agentDir(), "01a00000-0000-7000-8000-00000000b142", chain.entries);
	try {
		await page.goto("/");
		await page.getByRole("complementary").getByText(prompt).click();
		const message = page.getByTestId("msg-assistant");
		await expect(message.getByText("ANSWER-TEXT: the cache is keyed by path.")).toBeVisible();

		// The narration is text: shown without a click, with its Markdown rendered.
		await expect(message.getByText("NARRATION-PROSE: I will read the")).toBeVisible();
		await expect(message.locator("strong", { hasText: "config" })).toBeVisible();
		// Only the real thought is a fold, and it is closed.
		await expect(message.getByTestId("thinking")).toHaveCount(1);
		await expect(message.getByText("PRIVATE-REASONING-TEXT")).toHaveCount(0);
		await message.getByTestId("thinking").getByRole("button").click();
		await expect(message.getByText("PRIVATE-REASONING-TEXT")).toBeVisible();
	} finally {
		rmSync(file, { force: true });
	}
});

test("a turn whose last step is narration shows it as the answer when its steps fold", async ({ page }) => {
	const prompt = "Narration probe: fold the steps";
	const chain = new Chain("na02");
	chain.user(prompt);
	chain.assistant([
		{ type: "text", text: "INTERMEDIATE-NOTE: reading the first file." },
		{ type: "toolCall", id: "toolu_na1", name: "read", arguments: { path: "/tmp/a.ts" } },
	]);
	chain.toolResult("toolu_na1", "read", [{ type: "text", text: "contents of a" }]);
	chain.assistant([{ type: "toolCall", id: "toolu_na2", name: "bash", arguments: { command: "echo hi" } }]);
	chain.toolResult("toolu_na2", "bash", [{ type: "text", text: "hi" }]);
	chain.assistant([{ type: "thinking", thinking: "FINAL-NARRATION: everything is in place.", narration: true }]);
	const file = writeRenderSession(agentDir(), "01a00000-0000-7000-8000-00000000b143", chain.entries);
	try {
		await page.goto("/");
		await page.getByRole("complementary").getByText(prompt).click();
		const turn = page.getByTestId("agent-turn");
		await expect(page.getByTestId("work-summary")).toBeVisible();
		await expect(turn.getByText("FINAL-NARRATION: everything is in place.")).toBeVisible();
		await expect(turn.getByText("INTERMEDIATE-NOTE")).toHaveCount(0);
		await expect(turn.getByTestId("thinking")).toHaveCount(0);

		await page.getByTestId("work-summary").click();
		await expect(turn.getByText("INTERMEDIATE-NOTE: reading the first file.")).toBeVisible();
		await expect(turn.getByText("FINAL-NARRATION: everything is in place.")).toBeVisible();
	} finally {
		rmSync(file, { force: true });
	}
});

test("a narration block streamed live turns from a thought into text once omp says it is narration", async ({
	page,
}) => {
	ownSession(0xb3, "Live narration probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Live narration probe", "live-narration-probe");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	const id = "m-live-narration";
	const update = (assistantMessageEvent: Record<string, unknown>) =>
		frame({ type: "message_update", messageId: id, message: { role: "assistant" }, assistantMessageEvent });

	// The delta stream carries the words, not the flag: until the flag arrives it is a thought being written.
	frame({ type: "message_start", messageId: id, message: { role: "assistant", content: [] } });
	update({ type: "thinking_start", contentIndex: 0 });
	update({ type: "thinking_delta", contentIndex: 0, delta: "LIVE-NARRATION: checking the **config**." });
	const thinking = page.getByTestId("thinking");
	await expect(thinking).toContainText("Thinking…");

	// A full snapshot (omp's default stream) knows already.
	const message = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "LIVE-NARRATION: checking the **config**.", narration: true }],
	};
	frame({
		type: "message_update",
		messageId: id,
		message,
		assistantMessageEvent: {
			type: "thinking_end",
			contentIndex: 0,
			content: message.content[0].thinking,
			partial: message,
		},
	});
	const text = page.getByTestId("msg-assistant").last();
	await expect(text.locator("strong", { hasText: "config" })).toBeVisible();
	await expect(text.getByText("LIVE-NARRATION: checking the")).toBeVisible();
	await expect(text.getByTestId("thinking")).toHaveCount(0);
});
