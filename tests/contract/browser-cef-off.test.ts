// needs: posixShell
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellMessage } from "../../server/shell-events.ts";
import type { BrowserState } from "../../shared/browser.ts";
import { PREF } from "../../shared/prefs.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * The Mac app does not start CEF while the browser is turned off when it starts (#188), and says so to its server
 * (`OMP_WEBUI_CEF_STARTED=0`, macos/main.swift). Turning the browser on then asks the app to restart, which starts CEF, and
 * Settings › Browser says the restart is due until it comes, or until the browser is turned off again.
 */

const data = mkdtempSync(join(tmpdir(), "ompw-browser-cef-off-"));
let server: TestServer;

beforeAll(async () => {
	server = await startTestServer(
		0,
		{ OMP_WEBUI_DATA_DIR: data, OMP_WEBUI_BROWSER_ENGINE: "cef", OMP_WEBUI_CEF_STARTED: "0" },
		{ login: false },
	);
}, 60_000);

afterAll(async () => {
	await server?.stop();
	rmSync(data, { recursive: true, force: true });
});

const headers = (extra: Record<string, string> = {}) => ({
	"x-omp-webui-token": server.accessToken,
	"x-omp-webui": "1",
	...extra,
});

const choose = async (browser: "off" | null) => {
	const res = await fetch(`${server.url}/api/prefs`, {
		method: "POST",
		headers: headers({ "content-type": "application/json" }),
		body: JSON.stringify({ changes: { [PREF.browser]: browser } }),
	});
	expect(res.status).toBe(200);
};

const restartNeeded = async (): Promise<boolean> =>
	((await (await fetch(`${server.url}/api/browser`, { headers: headers() })).json()) as BrowserState).restartNeeded;

/** The app reading the stream its restart requests come on (`ShellEvents`, macos/shellevents.swift). */
async function readApp() {
	const control = new AbortController();
	const res = await fetch(`${server.url}/api/shell/events`, {
		headers: { "x-omp-webui-token": server.accessToken },
		signal: control.signal,
	});
	expect(res.status).toBe(200);
	const body = res.body?.getReader();
	if (!body) throw new Error("no body");
	const decoder = new TextDecoder();
	const seen: ShellMessage[] = [];
	let buffer = "";
	void (async () => {
		for (;;) {
			const { value, done } = await body.read().catch(() => ({ value: undefined, done: true }));
			if (done) return;
			buffer += decoder.decode(value);
			for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
				const text = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				if (text) seen.push(JSON.parse(text) as ShellMessage);
			}
		}
	})();
	const until = async (what: string, ok: () => boolean) => {
		const end = Date.now() + 10_000;
		while (!ok()) {
			if (Date.now() > end) throw new Error(`timed out: ${what}`);
			await Bun.sleep(25);
		}
	};
	// The response has begun: the server has seen the app.
	await until("the app's first state", () => seen.some((m) => m.t === "state"));
	return { restarts: () => seen.filter((m) => m.t === "browserRestart").length, until, leave: () => control.abort() };
}

test("turned on in an app that did not start CEF, the browser asks the app to restart, and Settings says so until it is off again", async () => {
	await choose("off");
	const app = await readApp();
	try {
		expect(await restartNeeded()).toBe(false);

		await choose(null);
		await app.until("the app asked to restart", () => app.restarts() === 1);
		expect(await restartNeeded()).toBe(true);

		// Off again before the app restarted: nothing is due any more, and the app is not asked again.
		await choose("off");
		expect(await restartNeeded()).toBe(false);
		await Bun.sleep(200);
		expect(app.restarts()).toBe(1);
	} finally {
		app.leave();
	}
}, 60_000);
