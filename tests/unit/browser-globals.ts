import { mock } from "bun:test";

/**
 * The few browser globals the app store touches: localStorage when it loads, location and history
 * when the view changes, fetch for the session list. Import this file first (`import "./browser-globals.ts"`).
 *
 * Bun runs every test file in one process and evaluates this module once, and a file's imports can be evaluated after
 * an earlier file has finished. The store module reads `localStorage` when it is first evaluated, by whichever file
 * imports it first, so what it needs of the browser is installed for good, when this module is first evaluated, and no
 * file's cleanup takes it away. `fetch` is a real function that other files use: each file installs its stub in
 * `beforeAll` and puts the real one back in `afterAll` (`installGlobals`, `restoreGlobals`).
 *
 * What a file spied on (`spyOn(socket, …)`) is let go of both ways: a spy outlives its file, and the next file's
 * `spyOn` of the same method returns that spy, with the calls and implementation it was left with, so `installGlobals`
 * and `restoreGlobals` both restore every spy (#602).
 */

export const location = { hash: "" };
/** `push <hash>` / `replace <hash>` for every history write. */
export const historyLog: string[] = [];

const storage = new Map<string, string>();
const browser: Record<string, unknown> = {
	localStorage: {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
	},
	location,
	history: {
		pushState: (_state: unknown, _title: string, url: string) => {
			historyLog.push(`push ${url}`);
			location.hash = url;
		},
		replaceState: (_state: unknown, _title: string, url: string) => {
			historyLog.push(`replace ${url}`);
			location.hash = url;
		},
	},
};
const stubFetch = async () => Response.json([]);

const globals = globalThis as Record<string, unknown>;
const realFetch = globals.fetch;
Object.assign(globalThis, browser);

export function installGlobals(): void {
	mock.restore();
	Object.assign(globalThis, browser, { fetch: stubFetch });
}
installGlobals();

export function restoreGlobals(): void {
	mock.restore();
	globals.fetch = realFetch;
}
