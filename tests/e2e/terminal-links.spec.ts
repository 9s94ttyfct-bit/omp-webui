import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A hyperlink in the terminal's output (OSC 8) asks, then opens by its address: xterm's own handler opens a blank
 * window and sets its location, which the macOS app drops (it hands a new window to the system's browser by the address
 * it is opened with, and a blank one has none). Output is pushed into the page's terminal; nothing is run for it.
 */

const OPEN = "\u001b]8;;";
const END = "\u001b\\";
const link = (url: string, text: string) => `${OPEN}${url}${END}${text}${OPEN}${END}`;

/** What the page asked `window.open` for, in order: the macOS app opens a window by the address it is called with. */
const opens = (page: Page) => page.evaluate(() => (window as unknown as { __opens: unknown[][] }).__opens);

/** A terminal on the commands page with `output` written into it. */
async function terminalWith(page: Page, output: string) {
	await page.addInitScript(() => {
		const calls: unknown[][] = [];
		(window as unknown as { __opens: unknown[][] }).__opens = calls;
		const open = window.open.bind(window);
		window.open = (...args: Parameters<typeof window.open>) => {
			calls.push(args);
			return open(...args);
		};
	});
	let ptyId = "";
	const tap = await tapSocket(page);
	// The id the server gave the terminal, from the reply to the page's own request.
	tap.rewrite((msg, request) => {
		if (request?.t === "pty_open" && msg.t === "reply" && msg.ok === true) {
			ptyId = String((msg.data as { ptyId: string }).ptyId);
		}
		return msg;
	});
	await page.goto("/#/cli");
	await page.getByTestId("cli-line").fill("--version");
	await page.getByTestId("cli-run").click();
	await expect.poll(() => ptyId).not.toBe("");
	// `omp --version` ends at once: the screen is what it will be once its own last line is in, then the output follows it.
	await expect(page.getByTestId("terminal-status")).toContainText("exited");
	tap.push({ t: "pty_data", ptyId, data: `${output}\r\n` });
}

async function clickText(page: Page, text: string) {
	const word = page.getByTestId("terminal").locator(".xterm-rows").getByText(text).first();
	await expect(word).toBeVisible();
	// xterm redraws its rows as output comes in and as the pointer moves: a box asked for twice can be gone the second
	// time, so the one that was got is the one used.
	const found: { box: { x: number; y: number; width: number; height: number } | null } = { box: null };
	await expect
		.poll(async () => {
			found.box = await word.boundingBox();
			return found.box;
		})
		.not.toBeNull();
	const box = found.box;
	if (!box) throw new Error(`${text} is not on screen`);
	const at = { x: box.x + 4, y: box.y + box.height / 2 };
	// xterm finds the link under the pointer after it has moved there.
	await page.mouse.move(at.x, at.y);
	await page.waitForTimeout(250);
	await page.mouse.click(at.x, at.y);
}

test("a web link in the output asks with its address, then opens that address in a new tab", async ({
	page,
	context,
}) => {
	await context.route("https://example.com/**", (route) => route.fulfill({ body: "ok", contentType: "text/plain" }));
	const asked: string[] = [];
	page.on("dialog", (dialog) => {
		asked.push(dialog.message());
		void dialog.accept();
	});
	await terminalWith(page, link("https://example.com/docs?x=1", "read the docs"));

	const [popup] = await Promise.all([context.waitForEvent("page"), clickText(page, "read")]);
	// Opened by its address, not as a blank window that is given one afterwards.
	await expect.poll(() => popup.url()).toBe("https://example.com/docs?x=1");
	expect(await opens(page)).toEqual([["https://example.com/docs?x=1", "_blank", "noopener,noreferrer"]]);
	expect(asked).toHaveLength(1);
	expect(asked[0]).toContain("Open this link in your browser?");
	expect(asked[0]).toContain("https://example.com/docs?x=1");
});

test("a declined link opens nothing; links that are not web addresses are not even offered", async ({
	page,
	context,
}) => {
	const pages: string[] = [];
	context.on("page", (p) => pages.push(p.url()));
	const asked: string[] = [];
	page.on("dialog", (dialog) => {
		asked.push(dialog.message());
		void dialog.dismiss();
	});
	await terminalWith(
		page,
		[
			link("https://example.com/declined", "declined"),
			link("javascript:window.PWNED_LINK=1", "scripted"),
			link("file:///etc/passwd", "localfile"),
			link("ssh://evil.example", "remoteshell"),
		].join("\r\n"),
	);

	await clickText(page, "declined");
	await expect.poll(() => asked.length).toBe(1);
	for (const text of ["scripted", "localfile", "remoteshell"]) await clickText(page, text);
	await page.waitForTimeout(800);
	expect(asked).toHaveLength(1);
	expect(pages).toEqual([]);
	expect(await opens(page)).toEqual([]);
	expect(await page.evaluate(() => Object.keys(window).filter((k) => k.startsWith("PWNED")))).toEqual([]);
});
