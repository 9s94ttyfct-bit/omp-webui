import "./browser-globals.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { PREF } from "../../shared/prefs.ts";
import { flushPrefs, setPref } from "../../web/src/lib/prefs.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * An origin whose localStorage is full (#242) refuses every write: a choice made in Settings is then still sent to the server
 * (which keeps it for the next visit and the other pages), and what the page does after it goes on.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

test("a preference chosen while localStorage refuses writes is still sent to the server", async () => {
	const g = globalThis as unknown as Record<string, unknown>;
	const realStorage = g.localStorage;
	const realFetch = g.fetch;
	const refuse = () => {
		throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
	};
	g.localStorage = { getItem: () => null, setItem: refuse, removeItem: refuse };
	const sent: unknown[] = [];
	g.fetch = async (_url: string, init: { body: string }) => {
		sent.push(JSON.parse(init.body));
		return new Response("{}", { status: 500 });
	};
	try {
		let after = false;
		setPref(PREF.theme, "dark");
		after = true;
		await flushPrefs();
		expect(after).toBe(true);
		expect(sent).toEqual([{ changes: { [PREF.theme]: "dark" } }]);
	} finally {
		g.localStorage = realStorage;
		g.fetch = realFetch;
	}
});
