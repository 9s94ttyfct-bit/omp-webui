import { expect, test } from "bun:test";
import { installPolyfills } from "../../web/src/lib/polyfills.ts";
import { randomId } from "../../web/src/lib/random-id.ts";

/** What the page needs of a browser older than the newest it is built for (#269, #246). */

test("Promise.withResolvers is added where a browser lacks it, and works as the native one does", async () => {
	const native = Promise.withResolvers;
	// Safari 16.4–17.3: the page's socket asks for it on its first request.
	(Promise as unknown as { withResolvers?: unknown }).withResolvers = undefined;
	try {
		installPolyfills();
		const ok = Promise.withResolvers<string>();
		ok.resolve("done");
		expect(await ok.promise).toBe("done");
		const bad = Promise.withResolvers<string>();
		bad.reject(new Error("no"));
		await expect(bad.promise).rejects.toThrow("no");
	} finally {
		Promise.withResolvers = native;
	}
});

test("the native Promise.withResolvers is left alone", () => {
	const native = Promise.withResolvers;
	installPolyfills();
	expect(Promise.withResolvers).toBe(native);
});

test("an id is made without crypto.randomUUID, which a page on plain http does not have", () => {
	const realUuid = crypto.randomUUID;
	(crypto as unknown as { randomUUID?: unknown }).randomUUID = undefined;
	try {
		const a = randomId();
		expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(randomId()).not.toBe(a);
	} finally {
		crypto.randomUUID = realUuid;
	}
});
