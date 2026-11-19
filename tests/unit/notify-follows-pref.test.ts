import "./browser-globals.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { PREF } from "../../shared/prefs.ts";
import { followStoredNotify, useNotify } from "../../web/src/lib/attention.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

beforeAll(installGlobals);
afterAll(restoreGlobals);

// #239: Notifications turned off in another window reach this page through localStorage; the switch and notify() read the store.
test("the notifications switch follows the stored preference, both ways", () => {
	localStorage.setItem(PREF.notify, "on");
	followStoredNotify();
	expect(useNotify.getState().enabled).toBe(true);
	localStorage.setItem(PREF.notify, "off");
	followStoredNotify();
	expect(useNotify.getState().enabled).toBe(false);
});
