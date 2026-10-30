import { describe, expect, test } from "bun:test";
import {
	isChunkLoadError,
	quietly,
	RELOAD_WINDOW_MS,
	reloadOnce,
	reloadOnPreloadError,
} from "../../web/src/lib/reload.ts";

describe("isChunkLoadError", () => {
	test.each([
		["Chrome", "TypeError: Failed to fetch dynamically imported module: http://127.0.0.1:7879/assets/UsagePage-abc.js"],
		["Firefox", "TypeError: error loading dynamically imported module: http://127.0.0.1:7879/assets/UsagePage-abc.js"],
		["Safari", "TypeError: Importing a module script failed."],
		["Vite's CSS preload", "Error: Unable to preload CSS for /assets/CliPage-abc.css"],
	])("recognises the %s message", (_browser, message) => {
		const [name, ...rest] = message.split(": ");
		const err = new Error(rest.join(": "));
		err.name = name;
		expect(isChunkLoadError(err)).toBe(true);
	});

	test("recognises a non-Error rejection by its text", () => {
		expect(isChunkLoadError("Failed to fetch dynamically imported module: /assets/x.js")).toBe(true);
	});

	test("ignores every other error", () => {
		expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'cost')"))).toBe(false);
		expect(isChunkLoadError(new Error("Connection lost"))).toBe(false);
		expect(isChunkLoadError(undefined)).toBe(false);
		expect(isChunkLoadError(null)).toBe(false);
	});
});

describe("reloadOnce", () => {
	function memory() {
		const m = new Map<string, string>();
		return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
	}

	test("reloads the first time and remembers it", () => {
		const storage = memory();
		let reloads = 0;
		expect(reloadOnce({ storage, now: 1_000_000, reload: () => reloads++ })).toBe(true);
		expect(reloads).toBe(1);
	});

	test("does not reload again moments later (a still-missing chunk would loop forever)", () => {
		const storage = memory();
		let reloads = 0;
		const reload = () => reloads++;
		reloadOnce({ storage, now: 1_000_000, reload });
		expect(reloadOnce({ storage, now: 1_000_000 + 1, reload })).toBe(false);
		expect(reloadOnce({ storage, now: 1_000_000 + RELOAD_WINDOW_MS - 1, reload })).toBe(false);
		expect(reloads).toBe(1);
	});

	test("reloads again once the window has passed (a newer upgrade)", () => {
		const storage = memory();
		let reloads = 0;
		const reload = () => reloads++;
		reloadOnce({ storage, now: 1_000_000, reload });
		expect(reloadOnce({ storage, now: 1_000_000 + RELOAD_WINDOW_MS, reload })).toBe(true);
		expect(reloads).toBe(2);
	});

	test("never reloads when it cannot remember having done so", () => {
		const broken = {
			getItem: () => {
				throw new Error("storage is blocked");
			},
			setItem: () => {
				throw new Error("storage is blocked");
			},
		};
		let reloads = 0;
		expect(reloadOnce({ storage: broken, now: 1_000_000, reload: () => reloads++ })).toBe(false);
		expect(reloads).toBe(0);
	});
});

describe("reloadOnPreloadError", () => {
	function reloads() {
		const storage = new Map<string, string>();
		let count = 0;
		return {
			deps: {
				storage: {
					getItem: (k: string) => storage.get(k) ?? null,
					setItem: (k: string, v: string) => void storage.set(k, v),
				},
				now: 1_000_000,
				reload: () => count++,
				flush: () => {},
			},
			count: () => count,
		};
	}

	test("reloads for a chunk that failed to load", () => {
		const r = reloads();
		reloadOnPreloadError(r.deps);
		expect(r.count()).toBe(1);
	});

	test("does not reload while a chunk fetched ahead is on its way (whoever asks for it gets the failure)", async () => {
		const r = reloads();
		const ahead = Promise.withResolvers<void>();
		quietly(ahead.promise);
		reloadOnPreloadError(r.deps);
		expect(r.count()).toBe(0);

		// Once it has failed, the next chunk that fails is a reason again.
		ahead.reject(new Error("Failed to fetch dynamically imported module"));
		await ahead.promise.catch(() => {});
		reloadOnPreloadError(r.deps);
		expect(r.count()).toBe(1);
	});

	test("counts every fetch that is on its way, not the last one", async () => {
		const r = reloads();
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		quietly(first.promise);
		quietly(second.promise);
		first.resolve();
		await first.promise;
		reloadOnPreloadError(r.deps);
		expect(r.count()).toBe(0);
		second.resolve();
		await second.promise;
		reloadOnPreloadError(r.deps);
		expect(r.count()).toBe(1);
	});
});
