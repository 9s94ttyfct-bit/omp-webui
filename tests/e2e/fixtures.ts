import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";
import { PREFS_SYNC_KEY, type PrefsSnapshot } from "../../shared/prefs.ts";
import { endAllLives } from "../support/lives.ts";
import { rawKeysIn } from "../support/raw-keys.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

export * from "@playwright/test";

/** The spec file this worker ran a test of last (module state: every worker is a process of its own). */
let lastFile: string | undefined;

/**
 * Files stay sequential within a worker; no server, HOME, config, sessions or auth state crosses worker boundaries, and no
 * omp process crosses a file boundary: the first test of a file finds no process the file before it left running.
 */
export const test = base.extend<
	{ freshFile: undefined; noRawKeys: undefined; serverErrors: undefined },
	{ e2eServer: TestServer; workerStorageState: string }
>({
	freshFile: [
		async ({ e2eServer }, use, testInfo) => {
			if (lastFile !== undefined && lastFile !== testInfo.file) await endAllLives(e2eServer);
			lastFile = testInfo.file;
			await use(undefined);
		},
		{ auto: true },
	],
	/**
	 * What the worker's server wrote to stderr while this test ran, shown only when the test failed (#774): a passing test
	 * that meant to hit an error (a port taken, a refused call) leaves nothing in the log that looks like a failure.
	 */
	serverErrors: [
		async ({ e2eServer }, use, testInfo) => {
			const since = e2eServer.errors().length;
			await use(undefined);
			if (testInfo.status === testInfo.expectedStatus) return;
			const text = e2eServer.errors().slice(since);
			if (!text) return;
			await testInfo.attach("server-stderr", { body: text, contentType: "text/plain" });
			process.stderr.write(`\n[server stderr during "${testInfo.title}"]\n${text}\n`);
		},
		{ auto: true },
	],
	/**
	 * A page that shows a translation key (`pages.newPlaceholder`) instead of its text asked `t()` for a string that was
	 * not registered yet (the strings of lazy namespaces and of the `-later` halves arrive with the chunk that uses them).
	 * Every page the test left open is read at its end; a test that has failed already is left to say why.
	 */
	noRawKeys: [
		async ({ context }, use, testInfo) => {
			await use(undefined);
			if (testInfo.status !== testInfo.expectedStatus) return;
			for (const page of context.pages()) {
				if (page.isClosed()) continue;
				const read = () =>
					page.evaluate(() => {
						// What a person reads: the text, and the words a control carries in an attribute.
						const words = [document.title, document.body?.innerText ?? ""];
						for (const el of document.querySelectorAll("[aria-label],[title],[placeholder],[alt]")) {
							for (const name of ["aria-label", "title", "placeholder", "alt"]) words.push(el.getAttribute(name) ?? "");
						}
						return words.join("\n");
					});
				let text = "";
				for (let tries = 1; ; tries++) {
					try {
						text = await read();
						break;
					} catch (error) {
						// A page that closed while it was read has nothing left to show.
						if (page.isClosed()) break;
						// A page whose server the test stopped may load itself again (a chunk it could not fetch then, see
						// `reloadOnce`): what it shows once loaded is read. Any other failure is the test's.
						if (tries < 3 && /Execution context was destroyed/.test(String(error))) {
							await page.waitForLoadState().catch(() => {});
							continue;
						}
						throw error;
					}
				}
				expect(rawKeysIn(text), `translation keys shown as text on ${page.url()}`).toEqual([]);
			}
		},
		{ auto: true },
	],
	e2eServer: [
		async ({ playwright: _playwright }, use, workerInfo) => {
			// With no base, the OS chooses every port. An explicit base reserves one port per parallel slot in this checkout.
			const configured = process.env.OMPW_E2E_PORT;
			const port = configured && configured !== "0" ? Number(configured) + workerInfo.parallelIndex : 0;
			const server = await startTestServer(port, {}, { login: !process.env.OMPW_E2E_OFFLINE });
			process.env.OMPW_E2E_ROOT = server.root;
			process.env.OMPW_E2E_AGENT_DIR = server.agentDir;
			process.env.OMPW_E2E_HOME = server.home;
			process.env.OMPW_E2E_WORK = server.work;
			process.env.OMPW_E2E_URL = server.url;
			process.env.OMPW_E2E_ACCESS_TOKEN = server.accessToken;
			try {
				await use(server);
			} finally {
				await server.stop();
			}
		},
		{ scope: "worker", auto: true },
	],
	workerStorageState: [
		async ({ e2eServer: server }, use) => {
			// A browser starts ahead of server preferences, so an earlier test's saved preferences cannot change its defaults.
			const { id } = (await (
				await fetch(`${server.url}/api/prefs`, { headers: { "x-omp-webui-token": server.accessToken } })
			).json()) as PrefsSnapshot;
			const path = join(server.root, "auth.json");
			writeFileSync(
				path,
				JSON.stringify({
					cookies: [
						{
							name: "ompw_token",
							value: server.accessToken,
							domain: "127.0.0.1",
							path: "/",
							expires: -1,
							httpOnly: true,
							secure: false,
							sameSite: "Strict",
						},
					],
					origins: [
						{ origin: server.url, localStorage: [{ name: PREFS_SYNC_KEY, value: `${id}:${Number.MAX_SAFE_INTEGER}` }] },
					],
				}),
			);
			await use(path);
		},
		{ scope: "worker" },
	],
	baseURL: async ({ e2eServer }, use) => use(e2eServer.url),
	storageState: async ({ workerStorageState }, use) => use(workerStorageState),
});
