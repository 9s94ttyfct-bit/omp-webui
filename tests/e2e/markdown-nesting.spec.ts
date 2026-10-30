import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "../support/fixtures.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A reply that nests block quotes or lists a thousand deep overflowed the stack: the page showed its Reload screen, and
 * in Chrome 1,800 nested quotes crashed the renderer, again on every reload. Open labels (`![a ![a ![a`) ran the tab for
 * seconds. One message must never take the conversation with it: deep text is shown as written, a message that cannot
 * be rendered at all shows a placeholder, and the rest of the conversation reads and sends as usual (no model call).
 */

const ts = (min: number) => new Date(Date.UTC(2026, 0, 14, 10, min)).toISOString();
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A session of prompt/reply pairs: the replies are the contents given, in order (a reply can carry more fields of its own). */
function writeSession(
	agentDir: string,
	n: number,
	contents: (unknown[] | { content: unknown[]; extra: Record<string, unknown> })[],
): { file: string; title: string } {
	const bucket = join(agentDir, "sessions", FIXTURE_BUCKET);
	mkdirSync(bucket, { recursive: true });
	const id = `01a00000-0000-7000-8000-00000000e1e${n}`;
	const title = `Nesting fixture ${n}: deep quotes and lists`;
	const file = join(bucket, `2026-01-14T10-0${n}-00-000Z_${id}.jsonl`);
	const slot: Record<string, unknown> = { type: "title", v: 1, title, source: "user", updatedAt: ts(0), pad: "" };
	slot.pad = " ".repeat(Math.max(0, 255 - Buffer.byteLength(JSON.stringify(slot))));
	const entries: unknown[] = [];
	let parent: string | null = null;
	contents.forEach((given, i) => {
		const { content, extra } = Array.isArray(given) ? { content: given, extra: {} } : given;
		const prompt = `p${i}`;
		const reply = `r${i}`;
		entries.push({
			type: "message",
			id: prompt,
			parentId: parent,
			timestamp: ts(2 * i + 1),
			message: { role: "user", content: [{ type: "text", text: `prompt ${i}` }], attribution: "user", timestamp: 1 },
		});
		entries.push({
			type: "message",
			id: reply,
			parentId: prompt,
			timestamp: ts(2 * i + 2),
			message: {
				role: "assistant",
				content,
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-5-5",
				usage,
				stopReason: "stop",
				timestamp: 2,
				...extra,
			},
		});
		parent = reply;
	});
	const header = { type: "session", version: 3, id, timestamp: ts(0), cwd: FIXTURE_CWD };
	writeFileSync(file, `${JSON.stringify(slot)}\n${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
	return { file, title };
}

const text = (t: string) => [{ type: "text", text: t }];

test("text nested beyond reading is shown as written; the conversation around it is unharmed, also after a reload", async ({
	page,
}) => {
	const { file, title } = writeSession(process.env.OMPW_E2E_AGENT_DIR as string, 1, [
		text("first reply, fine"),
		// Each of these overflowed the stack, crashed the renderer or ran the tab for seconds.
		text(`${"> ".repeat(1800)}deep quotes`),
		text(`${"- ".repeat(1000)}deep list`),
		text(`${"> ".repeat(20_000)}very deep quotes`),
		text(`${"![a ".repeat(5000)}x${"](u)".repeat(5000)}`),
		// Within the limit it is still Markdown.
		text(`${"> ".repeat(100)}at the limit`),
		text("the last reply, after them all"),
	]);
	const crashes: string[] = [];
	page.on("crash", () => crashes.push("crash"));
	await page.goto(`/#/s/${encodeURIComponent(file)}`);
	await expect(page.getByTestId("chat-title")).toHaveText(title);
	await expect(page.getByTestId("msg-assistant").filter({ hasText: "the last reply, after them all" })).toBeVisible();

	// Four of the replies are too deep: each says so and keeps its text; the one at the limit is a stack of quotes.
	const plain = page.getByTestId("markdown-plain");
	await expect(plain).toHaveCount(4);
	await expect(plain.first()).toContainText("Nested too deeply to format: shown as plain text.");
	await expect(plain.first()).toContainText("deep quotes");
	await expect(page.getByTestId("msg-assistant").filter({ hasText: "at the limit" }).locator("blockquote")).toHaveCount(
		100,
	);

	// The conversation works: no error screen, and a draft can be typed.
	await expect(page.getByTestId("error-screen")).toHaveCount(0);
	const composer = page.getByTestId("composer");
	await composer.fill("still usable");
	await expect(composer).toHaveValue("still usable");

	// A reload shows the same.
	await page.reload();
	await expect(page.getByTestId("msg-assistant").filter({ hasText: "the last reply, after them all" })).toBeVisible();
	await expect(page.getByTestId("markdown-plain")).toHaveCount(4);
	expect(crashes).toEqual([]);
});

test("a message that cannot be rendered shows a placeholder; the others stay, and the conversation is usable", async ({
	page,
}) => {
	const { file } = writeSession(process.env.OMPW_E2E_AGENT_DIR as string, 2, [
		text("a reply before"),
		// A failure whose message is an object: drawing the message throws (a malformed content block no longer can).
		{
			content: [...text("hidden with it")],
			extra: { stopReason: "error", errorMessage: { not: "text" } },
		},
		text("a reply after"),
	]);
	await page.goto(`/#/s/${encodeURIComponent(file)}`);
	await expect(page.getByTestId("msg-assistant").filter({ hasText: "a reply after" })).toBeVisible();
	await expect(page.getByTestId("msg-assistant").filter({ hasText: "a reply before" })).toBeVisible();

	const failed = page.getByTestId("message-failed");
	await expect(failed).toHaveCount(1);
	await expect(failed).toContainText("This message could not be displayed.");
	// What went wrong is one click away, and the page itself is not the error screen.
	await failed.getByText("Details").click();
	await expect(failed.locator("pre")).not.toBeEmpty();
	await expect(page.getByTestId("error-screen")).toHaveCount(0);
	// Prompts and replies on both sides of it are there, and the composer works.
	await expect(page.getByTestId("msg-user")).toHaveCount(3);
	const composer = page.getByTestId("composer");
	await composer.fill("send me");
	await expect(composer).toHaveValue("send me");
});
