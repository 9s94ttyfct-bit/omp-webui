import "./browser-globals.ts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, test } from "bun:test";
import { useApp } from "../../web/src/store/app.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * The same notice again while it is still up (an extension that fails on every tool call) is one toast with a count, not
 * a stack of copies that hides the page's other notices for minutes (#382).
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

beforeEach(() => {
	jest.useFakeTimers();
	useApp.setState({ toasts: [] });
});
afterEach(() => jest.useRealTimers());

const toasts = () => useApp.getState().toasts;

test("forty identical errors are one toast with a count, and another notice is not pushed out", () => {
	const { toast } = useApp.getState();
	toast("info", "Saved");
	for (let i = 0; i < 40; i++) toast("error", "Extension error: hook failed");
	expect(toasts().map((t) => [t.text, t.count ?? 1])).toEqual([
		["Saved", 1],
		["Extension error: hook failed", 40],
	]);
});

test("the notice that came again is the newest, and its clock starts over", () => {
	const { toast } = useApp.getState();
	toast("error", "same");
	toast("info", "other");
	jest.advanceTimersByTime(4000);
	toast("error", "same");
	expect(toasts().map((t) => t.text)).toEqual(["other", "same"]);
	// 9.5 s in: the first copy would have left at 9 s, and the repeat keeps it a full 9 s from the 4th second.
	jest.advanceTimersByTime(5500);
	expect(toasts().map((t) => t.text)).toEqual(["same"]);
	jest.advanceTimersByTime(3501);
	expect(toasts()).toEqual([]);
});

test("a different level, text or button is another toast", () => {
	const { toast } = useApp.getState();
	toast("error", "same");
	toast("warning", "same");
	toast("error", "other");
	toast("error", "same", { label: "Open", run: () => {} });
	expect(toasts()).toHaveLength(4);
});
