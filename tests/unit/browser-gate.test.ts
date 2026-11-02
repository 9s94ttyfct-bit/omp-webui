import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canManageBrowser } from "../../server/browser/gate.ts";
import { BrowserInstaller, handleBrowserRoute } from "../../server/browser/install.ts";
import { BROWSER_NOT_HERE, type BrowserState } from "../../shared/browser.ts";

/**
 * Who may install, update and clear the built-in browser: a page on this computer, or one signed in through Cloudflare
 * Access. A page that holds only the server's token (or none, with auth off) may look but not manage.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-browser-gate-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const nowhere = (async () => new Response("offline", { status: 503 })) as unknown as typeof fetch;
const inst = new BrowserInstaller({ root, engine: "cft", fetch: nowhere });
const post = (path: string) =>
	new Request(`http://127.0.0.1/api/browser/${path}`, { method: "POST", headers: { "x-omp-webui": "1" } });
const identity = { email: "a@b", validUntil: Date.now() + 60_000 };

test("only this computer or a verified Access sign-in may manage the browser", () => {
	expect(canManageBrowser(null, false)).toBe(false);
	expect(canManageBrowser(null, true)).toBe(true);
	expect(canManageBrowser(identity, false)).toBe(true);
});

test("a token-only network page is refused install, update, cancel and clear, and may read the state", async () => {
	for (const path of ["install", "check", "cancel", "clear"]) {
		const res = await handleBrowserRoute(post(path), new URL(post(path).url), inst, { remote: null, local: false });
		expect(res.status).toBe(403);
		expect(((await res.json()) as { problem: string }).problem).toBe(BROWSER_NOT_HERE);
	}
	const get = new Request("http://127.0.0.1/api/browser");
	const res = await handleBrowserRoute(get, new URL(get.url), inst, { remote: null, local: false });
	expect(res.status).toBe(200);
	expect(((await res.json()) as BrowserState).canManage).toBe(false);
});

test("a page on this computer, or signed in through Access, starts an install", async () => {
	for (const who of [
		{ remote: null, local: true },
		{ remote: identity, local: false },
	]) {
		const req = post("install");
		const res = await handleBrowserRoute(req, new URL(req.url), inst, who);
		expect(res.status).toBe(202);
		expect(((await res.json()) as BrowserState).canManage).toBe(true);
		inst.cancel();
	}
});
