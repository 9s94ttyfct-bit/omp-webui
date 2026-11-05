import { expect, test } from "bun:test";
import { noteRecentModel, onRecentModels, recentModels } from "../../web/src/lib/model-recent.ts";

/**
 * The models picked recently (`lib/model-recent.ts`): a list kept in this browser's storage. Storage that is full or
 * refused must not stop the pick it is noted for (the model picker notes the pick before it asks omp for the model).
 */

const refused = {
	getItem: (): string | null => {
		throw new DOMException("refused", "SecurityError");
	},
	setItem: (): void => {
		throw new DOMException("full", "QuotaExceededError");
	},
};

test("a pick is remembered newest first, once", () => {
	const stored = new Map<string, string>();
	const storage = {
		getItem: (k: string) => stored.get(k) ?? null,
		setItem: (k: string, v: string) => void stored.set(k, v),
	};
	noteRecentModel("a/1", storage);
	noteRecentModel("b/2", storage);
	expect(noteRecentModel("a/1", storage)).toEqual(["a/1", "b/2"]);
	expect(recentModels(storage)).toEqual(["a/1", "b/2"]);
});

test("full or refused storage does not stop the pick: the list is still told to this page", () => {
	const heard: (readonly string[])[] = [];
	const stop = onRecentModels((keys) => heard.push(keys));
	expect(noteRecentModel("a/1", refused)).toEqual(["a/1"]);
	expect(heard).toEqual([["a/1"]]);
	expect(recentModels(refused)).toEqual([]);
	stop();
});
