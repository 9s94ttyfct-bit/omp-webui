import { describe, expect, test } from "bun:test";
import { lazyChunk } from "../../web/src/lib/lazy-chunk.ts";
import { reloadOnPreloadError } from "../../web/src/lib/reload.ts";

const Component = () => null;

/** Lets the promise chains of a fetch that has settled run their handlers (no timer: they are microtasks). */
async function settle() {
	for (let turn = 0; turn < 10; turn++) await Promise.resolve();
}

describe("lazyChunk", () => {
	test("one fetch serves every preload", () => {
		let fetches = 0;
		const { preload } = lazyChunk(async () => {
			fetches++;
			return { default: Component };
		});
		preload();
		preload();
		preload();
		expect(fetches).toBe(1);
	});

	test("a chunk that failed is asked for again by the next preload (a network that came back needs no reload)", async () => {
		let fetches = 0;
		let up = false;
		const { preload } = lazyChunk(async () => {
			fetches++;
			if (!up) throw new Error("Failed to fetch dynamically imported module");
			return { default: Component };
		});
		preload();
		await settle();
		expect(fetches).toBe(1);

		up = true;
		preload();
		await settle();
		expect(fetches).toBe(2);
		// It arrived: it is kept.
		preload();
		expect(fetches).toBe(2);
	});

	test("a failed preload is quiet: nobody is asked to reload the tab for it, and nothing is left unhandled", async () => {
		const reloaded: number[] = [];
		const deps = {
			storage: { getItem: () => null, setItem: () => {} },
			now: 1_000_000,
			reload: () => reloaded.push(1),
			flush: () => {},
		};
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const { preload } = lazyChunk(async () => {
				// Vite reports the failure after the fetch has begun, while it is still on its way, then rejects it.
				await Promise.resolve();
				reloadOnPreloadError(deps);
				throw new Error("Failed to fetch dynamically imported module");
			});
			preload();
			await settle();
			expect(reloaded).toEqual([]);
			expect(unhandled).toEqual([]);
			// Afterwards a chunk that fails is a reason again.
			reloadOnPreloadError(deps);
			expect(reloaded).toEqual([1]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
