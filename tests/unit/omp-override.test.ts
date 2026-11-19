import { afterAll, expect, spyOn, test } from "bun:test";
import type { StoreApi } from "zustand";
import * as zustand from "zustand";
import { ompOverride } from "../../web/src/store/omp-override.ts";

/**
 * One of omp's settings that a conversation can choose for itself (`store/omp-override.ts`: usage wait, parallel
 * subagents, compact at). What the page shows is the store's state; the stores it makes are caught here to read it.
 */

const made: StoreApi<unknown>[] = [];
const create = zustand.create;
const spy = spyOn(zustand, "create").mockImplementation(((init: never) => {
	const store = create(init);
	made.push(store);
	return store;
}) as typeof create);
afterAll(() => spy.mockRestore());

interface Answer {
	omp: boolean | null;
	session: boolean | null;
}

test("a refused change puts back only what it set, not what the store learned while it was on its way", async () => {
	const answers = new Map<string, { resolve: (a: Answer) => void; reject: (e: Error) => void }>();
	const setting = ompOverride<boolean, boolean, boolean>({
		get: async () => ({ omp: false, session: null }),
		setDefault: async (enabled) => ({ omp: enabled, session: null }),
		setSession: (file) => {
			const answer = Promise.withResolvers<Answer>();
			answers.set(file, answer);
			return answer.promise;
		},
		shownDefault: (enabled) => enabled,
	});
	const store = made.at(-1) as StoreApi<{ omp: boolean | null | undefined; sessions: Record<string, boolean | null> }>;

	const first = setting.setConversation("a.jsonl", true);
	const second = setting.setConversation("b.jsonl", true);
	answers.get("b.jsonl")?.resolve({ omp: false, session: true });
	await second;
	answers.get("a.jsonl")?.reject(new Error("refused"));
	await expect(first).rejects.toThrow("refused");

	// B's confirmed choice and omp's value stay; only A's own change is gone.
	expect(store.getState()).toEqual({ omp: false, sessions: { "b.jsonl": true } });
});

test("a refused change leaves alone a newer word of the server about the same thing", async () => {
	let refuse: (e: Error) => void = () => {};
	const setting = ompOverride<boolean, boolean, boolean>({
		get: async () => ({ omp: true, session: null }),
		setDefault: () => {
			const answer = Promise.withResolvers<Answer>();
			refuse = answer.reject;
			return answer.promise;
		},
		setSession: async (_file, value) => ({ omp: true, session: value }),
		shownDefault: (enabled) => enabled,
	});
	const store = made.at(-1) as StoreApi<{ omp: boolean | null | undefined }>;

	const change = setting.setDefault(false);
	expect(store.getState().omp).toBe(false);
	// omp's value is read again meanwhile (its config changed): that is the newer word.
	await setting.setConversation("c.jsonl", null);
	refuse(new Error("refused"));
	await expect(change).rejects.toThrow("refused");
	expect(store.getState().omp).toBe(true);
});

test("a read asked before a change does not put back what the change replaced (#386)", async () => {
	const reads: { held: Answer; release: () => void }[] = [];
	let server: Answer = { omp: false, session: null };
	const setting = ompOverride<boolean, boolean, boolean>({
		// The server answers a read by asking omp: it holds what it had when asked, and answers late.
		get: (file) => {
			const answer = Promise.withResolvers<Answer>();
			const held = { ...server, session: file === null ? null : server.session };
			reads.push({ held, release: () => answer.resolve(held) });
			return answer.promise;
		},
		setDefault: async (enabled) => {
			server = { ...server, omp: enabled };
			return server;
		},
		setSession: async (_file, value) => {
			server = { ...server, session: value };
			return server;
		},
		shownDefault: (enabled) => enabled,
	});
	const store = made.at(-1) as StoreApi<{ omp: boolean | null | undefined; sessions: Record<string, boolean | null> }>;

	const unwatch = setting.watch("a.jsonl");
	await setting.setConversation("a.jsonl", true);
	await setting.setDefault(true);
	expect(store.getState()).toEqual({ omp: true, sessions: { "a.jsonl": true } });
	for (const read of reads) read.release();
	await Bun.sleep(0);
	expect(store.getState()).toEqual({ omp: true, sessions: { "a.jsonl": true } });

	// A read asked after the change is the server's word, and is shown.
	reads.length = 0;
	server = { omp: false, session: false };
	unwatch();
	setting.watch("a.jsonl");
	for (const read of reads) read.release();
	await Bun.sleep(0);
	expect(store.getState()).toEqual({ omp: false, sessions: { "a.jsonl": false } });
});
