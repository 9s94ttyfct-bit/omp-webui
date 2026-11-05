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
	// Every page is its window's active one: A's, older than B's new tab, still renders (engine.ts `ownSession`).
	expect(await pagesA[0].evaluate(() => document.visibilityState)).toBe("visible");
	expect(await pagesA[0].evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve("frame"))))).toBe(
		"frame",
	);

	// owners.json says whose the page is; a registry read back for the same engine says so too.
	const saved = JSON.parse(readFileSync(owners, "utf8")) as { generation: string; targets: Record<string, string> };
	expect(saved.targets[pageA]).toBe(A);
	const again = new PageRegistry(owners);
	again.load(saved.generation);
	expect(again.ownerOfTarget(pageA)).toBe(A);
}, 60_000);

test("a conversation's downloads: its puppeteer's session of the browser sets the folder and hears the download, and sees none of the other's pages", async () => {
	const site = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (req) =>
			new URL(req.url).pathname === "/f.txt"
				? new Response("ompw download\n", { headers: { "content-disposition": 'attachment; filename="f.txt"' } })
				: new Response('<a id="d" href="/f.txt">f</a>', { headers: { "content-type": "text/html" } }),
	});
	const folder = join(data, "downloads-a");
	try {
		const a = await connect(TA);
		const b = await connect(TB);
		// omp's downloads: `browser.target().createCDPSession()`, then the browser's download behaviour and events there.
		const session = await a.target().createCDPSession();
		const done = new Promise<{ state: string; filePath?: string }>((resolve) =>
			session.on("Browser.downloadProgress", (e) => {
				if (e.state !== "inProgress") resolve(e);
			}),
		);
		await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: folder, eventsEnabled: true });
		const [page] = await a.pages();
		await page.goto(`http://127.0.0.1:${site.port}/`);
		await page.click("#d");
		const progress = await done;
		expect(progress.state).toBe("completed");
		expect(progress.filePath).toBe(join(folder, "f.txt"));
		expect(readFileSync(join(folder, "f.txt"), "utf8")).toBe("ompw download\n");

		// The other conversation's session of its browser sees its own browser and pages only.
		expect(String(b.target().type())).toBe("browser");
		const other = await b.target().createCDPSession();
		const { targetInfos } = await other.send("Target.getTargets");
		expect(targetInfos.map((t) => t.url)).not.toContain(`http://127.0.0.1:${site.port}/`);
		const theirs = (await session.send("Target.getTargetInfo")).targetInfo.targetId;
		await expect(other.send("Target.attachToTarget", { targetId: theirs, flatten: true })).rejects.toThrow(
			/Not this conversation's page/,
		);
		await other.detach();
		await session.detach();
	} finally {
		site.stop(true);
	}
}, 60_000);

test("a page's WebMCP tools are offered to the conversation's agent (the browser runs with WebMCP on)", async () => {
	const site = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () =>
			new Response('<form toolname="greet" tooldescription="Greets"><input name="who"></form>', {
				headers: { "content-type": "text/html" },
			}),
	});
	try {
		const a = await connect(TA);
		const [page] = await a.pages();
		await page.goto(`http://127.0.0.1:${site.port}/`);
		const session = await page.createCDPSession();
		const names: string[] = [];
		session.on("WebMCP.toolsAdded", (e) => names.push(...e.tools.map((t) => t.name)));
		// omp's `webmcpList`: enabling the domain replays the page's tools.
		await session.send("WebMCP.enable");
		expect(names).toEqual(["greet"]);
		await session.detach();
	} finally {
		site.stop(true);
	}
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
	// Without a token it is no endpoint: the app's own page answers there, as before (its HTML, or the note that the web UI
	// is not built), never the browser's discovery nor a refusal of a token.
	const plain = await fetch(`${server.url}/json/version`);
	expect(plain.status).not.toBe(401);
	expect(plain.headers.get("content-type")).not.toContain("application/json");
	expect(await plain.text()).not.toContain("webSocketDebuggerUrl");
});
