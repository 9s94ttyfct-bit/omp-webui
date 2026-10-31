import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "../support/fixtures.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A link of a reply opens in a window of its own, so it must name somewhere else. A relative path, the empty address
 * react-markdown leaves for a scheme it refuses, and a footnote's `#anchor` named this page: a click opened a second
 * copy of the app in a browser (and nothing in the macOS app, which hands only web and mail addresses to the system).
 * Those are text now, and a footnote reference scrolls within its message (no model call). A path to a Markdown file of
 * the folder is a button that opens it in the Markdown editor over this page (v0.13.0), still with no address.
 */

const ts = (min: number) => new Date(Date.UTC(2026, 0, 15, 10, min)).toISOString();
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** One conversation whose reply has links of every kind, and a footnote defined far below its reference. */
function writeSession(agentDir: string): { file: string; title: string } {
	const bucket = join(agentDir, "sessions", FIXTURE_BUCKET);
	mkdirSync(bucket, { recursive: true });
	const id = "01a00000-0000-7000-8000-00000000e2e2";
	const title = "Links fixture: paths, footnotes, schemes";
	const file = join(bucket, `2026-01-15T10-00-00-000Z_${id}.jsonl`);
	const slot: Record<string, unknown> = { type: "title", v: 1, title, source: "user", updatedAt: ts(0), pad: "" };
	slot.pad = " ".repeat(Math.max(0, 255 - Buffer.byteLength(JSON.stringify(slot))));
	const filler = Array.from(
		{ length: 40 },
		(_, i) => `Paragraph ${i + 1}: ${"lorem ipsum dolor sit amet ".repeat(12)}`,
	);
	const reply = [
		"Open [the README](docs/README.md), [the handler](/tmp/project/src/a.ts#L10) and [a sibling](./b.ts); a [web page](https://example.com/ok), a [mail address](mailto:a@example.com), a [phone](tel:+15551234567), a [shell](ssh://evil.example), a [script](javascript:window.PWNED_LINK=1) and a claim with a note[^1].",
		...filler,
		"[^1]: The note at the very end.",
	].join("\n\n");
	const entries = [
		{
			type: "message",
			id: "k1",
			parentId: null,
			timestamp: ts(1),
			message: { role: "user", content: [{ type: "text", text: "give links" }], attribution: "user", timestamp: 1 },
		},
		{
			type: "message",
			id: "k2",
			parentId: "k1",
			timestamp: ts(2),
			message: {
				role: "assistant",
				content: [{ type: "text", text: reply }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-5-5",
				usage,
				stopReason: "stop",
				timestamp: 2,
			},
		},
	];
	const header = { type: "session", version: 3, id, timestamp: ts(0), cwd: FIXTURE_CWD };
	writeFileSync(file, `${JSON.stringify(slot)}\n${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
	return { file, title };
}

test("only web and mail addresses are links; paths and refused schemes are text that opens nothing", async ({
	page,
	context,
}) => {
	const { file, title } = writeSession(process.env.OMPW_E2E_AGENT_DIR as string);
	const opened: string[] = [];
	context.on("page", (p) => opened.push(p.url()));
	await page.goto(`/#/s/${encodeURIComponent(file)}`);
	await expect(page.getByTestId("chat-title")).toHaveText(title);
	const reply = page.getByTestId("msg-assistant").first();
	await expect(reply).toContainText("Paragraph 40");
	const hash = await page.evaluate(() => location.hash);

	// The links that are links.
	const hrefs = await reply.locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
	expect(hrefs).toEqual(["https://example.com/ok", "mailto:a@example.com"]);
	await expect(reply.getByRole("link", { name: "web page" })).toHaveAttribute("target", "_blank");
	await expect(reply.getByRole("link", { name: "web page" })).toHaveAttribute("rel", /noopener/);

	// A Markdown file of the folder opens in the Markdown editor over this page (v0.13.0): a button, still no address.
	const readme = reply.getByTestId("md-open-link");
	await expect(readme).toHaveText("the README");
	await expect(readme).toHaveAttribute("data-path", "docs/README.md");
	await readme.click();
	const editor = page.getByTestId("md-editor");
	await expect(editor).toHaveAttribute("data-path", "docs/README.md");
	// The fixture folder has no such file: the editor says so, and Close closes it.
	await expect(editor.getByTestId("md-open-error")).toBeVisible();
	await page.getByTestId("md-close").click();
	await expect(editor).toHaveCount(0);

	// The rest read as text: a path shows as a hint, a refused scheme (which react-markdown leaves with no address) as plain words; clicking opens nothing.
	for (const [text, hint] of [
		["the handler", "/tmp/project/src/a.ts#L10"],
		["a sibling", "./b.ts"],
	] as const) {
		const word = reply.getByText(text, { exact: true });
		await expect(word).toHaveAttribute("title", hint);
		await word.click();
	}
	for (const text of ["phone", "shell", "script"]) {
		const word = reply.getByText(text, { exact: true });
		await expect(word).not.toHaveAttribute("href", /.*/);
		await word.click();
	}
	await page.waitForTimeout(800);
	expect(opened).toEqual([]);
	expect(await page.evaluate(() => location.hash)).toBe(hash);
	expect(await page.evaluate(() => Object.keys(window).filter((k) => k.startsWith("PWNED")))).toEqual([]);
	await expect(reply.locator('a[href=""], a[href^="javascript:"], a[href^="/"], a[href^="docs"]')).toHaveCount(0);
});

test("a footnote reference scrolls to its note in the same message, and back, without opening anything", async ({
	page,
	context,
}) => {
	const { file } = writeSession(process.env.OMPW_E2E_AGENT_DIR as string);
	const opened: string[] = [];
	context.on("page", (p) => opened.push(p.url()));
	await page.goto(`/#/s/${encodeURIComponent(file)}`);
	const reply = page.getByTestId("msg-assistant").first();
	await expect(reply).toContainText("Paragraph 40");
	const hash = await page.evaluate(() => location.hash);

	const note = reply.locator("li#user-content-fn-1");
	const reference = reply.locator("#user-content-fnref-1");
	await expect(note).toHaveCount(1);
	await expect(reference).toHaveCount(1);
	// The reference is a button, and the note is a screen away from it.
	await expect(reference).toHaveAttribute("data-testid", "md-anchor");
	await reference.scrollIntoViewIfNeeded();
	await expect(note).not.toBeInViewport();

	await reference.click();
	await expect(note).toBeInViewport();
	await expect(note).toBeFocused();
	// The way back is the note's own button, named for a screen reader.
	const back = note.getByTestId("md-anchor");
	await expect(back).toHaveAccessibleName(/back to reference 1/i);
	await back.click();
	await expect(reference).toBeInViewport();

	// Nothing opened and the address of the page did not change.
	await page.waitForTimeout(500);
	expect(opened).toEqual([]);
	expect(await page.evaluate(() => location.hash)).toBe(hash);
});
