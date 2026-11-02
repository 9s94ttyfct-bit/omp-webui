// needs: posixShell
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import puppeteer, { type Browser } from "puppeteer-core";
import { cdpUrlOf } from "../../server/browser/lazy.ts";
import { PageRegistry } from "../../server/browser/registry.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * The per-conversation CDP endpoint of a real server over a real Chrome for Testing, driven by puppeteer-core as omp
 * drives it (`puppeteer.connect({ browserURL })`): each conversation sees its own blank page and never the other's.
 * The conversations' tokens are seeded in `owners.json` (Task 5 gives them to omp through its overlay).
 */

const data = mkdtempSync(join(tmpdir(), "ompw-browser-proxy-http-"));
const owners = join(data, "browser", "owners.json");
const A = "/sessions/a.jsonl";
const B = "/sessions/b.jsonl";
const TA = "a".repeat(43);
const TB = "b".repeat(43);
let server: TestServer;
const connected: Browser[] = [];

beforeAll(async () => {
	mkdirSync(join(data, "browser"), { recursive: true });
	writeFileSync(owners, JSON.stringify({ generation: null, tokens: { [A]: TA, [B]: TB }, targets: {} }));
	server = await startTestServer(
		0,
		{
			OMP_WEBUI_DATA_DIR: data,
			OMPW_BROWSER_EXECUTABLE: process.env.OMPW_BROWSER_EXECUTABLE || chromium.executablePath(),
		},
		{ login: false },
	);
}, 60_000);

afterAll(async () => {
	for (const b of connected) await b.disconnect().catch(() => {});
	await server?.stop();
	rmSync(data, { recursive: true, force: true });
});

/** Connected as omp connects with the `browser.cdpUrl` it is given: the token as the URL's user name, at the root. */
async function connect(token: string): Promise<Browser> {
	const b = await puppeteer.connect({ browserURL: cdpUrlOf(server.url, token), defaultViewport: null });
	connected.push(b);
	return b;
}

async function targetIdOf(page: import("puppeteer-core").Page): Promise<string> {
	const session = await page.createCDPSession();
	const { targetInfo } = (await session.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
	await session.detach();
	return targetInfo.targetId;
}

test("each conversation's puppeteer sees its own blank page, and never the other's", async () => {
	const a = await connect(TA);
	const b = await connect(TB);
	const pagesA = await a.pages();
	const pagesB = await b.pages();
	expect(pagesA).toHaveLength(1);
	expect(pagesB).toHaveLength(1);
	expect(pagesA[0].url()).toBe("about:blank");
	const pageA = await targetIdOf(pagesA[0]);
	expect(await targetIdOf(pagesB[0])).not.toBe(pageA);

	await pagesA[0].goto("data:text/html,<title>ompw-a</title>");
	expect(await pagesA[0].title()).toBe("ompw-a");
	const titlesB = await Promise.all((await b.pages()).map((p) => p.title()));
	expect(titlesB).not.toContain("ompw-a");

	const extra = await b.newPage();
	await extra.goto("data:text/html,<title>ompw-b2</title>");
	expect(await b.pages()).toHaveLength(2);
	const titlesA = await Promise.all((await a.pages()).map((p) => p.title()));
	expect(titlesA).toEqual(["ompw-a"]);

	// owners.json says whose the page is; a registry read back for the same engine says so too.
	const saved = JSON.parse(readFileSync(owners, "utf8")) as { generation: string; targets: Record<string, string> };
	expect(saved.targets[pageA]).toBe(A);
	const again = new PageRegistry(owners);
	again.load(saved.generation);
	expect(again.ownerOfTarget(pageA)).toBe(A);
}, 60_000);

test("the endpoint refuses an unknown token and anything sent by a page", async () => {
	expect((await fetch(`${server.url}/browser-cdp/${"z".repeat(43)}/json/version`)).status).toBe(401);
	const fromPage = await fetch(`${server.url}/browser-cdp/${TA}/json/version`, { headers: { origin: server.url } });
	expect(fromPage.status).toBe(403);
	const version = await fetch(`${server.url}/browser-cdp/${TA}/json/version`);
	expect(version.status).toBe(200);
	const body = (await version.json()) as { webSocketDebuggerUrl: string };
	expect(body.webSocketDebuggerUrl).toBe(`${server.url.replace(/^http/, "ws")}/browser-cdp/${TA}/devtools/browser`);
});

test("the root discovery answers a token sent as the user name (omp's Puppeteer drops any path), and only that", async () => {
	const basic = (user: string) => ({ authorization: `Basic ${Buffer.from(`${user}:`).toString("base64")}` });
	const version = await fetch(`${server.url}/json/version`, { headers: basic(TB) });
	expect(version.status).toBe(200);
	const body = (await version.json()) as { webSocketDebuggerUrl: string };
	expect(body.webSocketDebuggerUrl).toBe(`${server.url.replace(/^http/, "ws")}/browser-cdp/${TB}/devtools/browser`);
	expect((await fetch(`${server.url}/json/version`, { headers: basic("z".repeat(43)) })).status).toBe(401);
	const fromPage = await fetch(`${server.url}/json/version`, { headers: { ...basic(TB), origin: server.url } });
	expect(fromPage.status).toBe(403);
	// Without a token it is no endpoint: the app's own page answers there, as before.
	expect((await fetch(`${server.url}/json/version`)).headers.get("content-type")).toContain("text/html");
});
