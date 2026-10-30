import "./browser-globals.ts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, test } from "bun:test";
import { useApp } from "../../web/src/store/app.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/** A toast leaves on its own, unless someone is reading it: then its countdown stops. */

beforeAll(installGlobals);
afterAll(restoreGlobals);

beforeEach(() => {
	jest.useFakeTimers();
	useApp.setState({ toasts: [] });
});
afterEach(() => jest.useRealTimers());

const shown = () => useApp.getState().toasts.map((t) => t.text);

test("an error toast stays 9 s, other toasts 4.5 s, one with a button 15 s", () => {
	const { toast } = useApp.getState();
	toast("error", "error");
	toast("info", "info");
	toast("info", "with button", { label: "Open", run: () => {} });
	jest.advanceTimersByTime(4499);
	expect(shown()).toEqual(["error", "info", "with button"]);
	jest.advanceTimersByTime(2);
	expect(shown()).toEqual(["error", "with button"]);
	jest.advanceTimersByTime(4500);
	expect(shown()).toEqual(["with button"]);
	jest.advanceTimersByTime(6000);
	expect(shown()).toEqual([]);
});

test("a paused toast stays however long it is read, then keeps what it had left", () => {
	const { toast, pauseToast, resumeToast } = useApp.getState();
	toast("error", "reading me");
	const id = useApp.getState().toasts[0].id;
	jest.advanceTimersByTime(2000);
	pauseToast(id);
	jest.advanceTimersByTime(120_000);
	expect(shown()).toEqual(["reading me"]);
	resumeToast(id);
	// 9 s minus the 2 s it had already shown.
	jest.advanceTimersByTime(6999);
	expect(shown()).toEqual(["reading me"]);
	jest.advanceTimersByTime(2);
	expect(shown()).toEqual([]);
});

test("a toast read to its last moment stays a couple of seconds after the reader lets go", () => {
	const { toast, pauseToast, resumeToast } = useApp.getState();
	toast("info", "almost gone");
	const id = useApp.getState().toasts[0].id;
	jest.advanceTimersByTime(4400);
	pauseToast(id);
	jest.advanceTimersByTime(30_000);
	resumeToast(id);
	jest.advanceTimersByTime(1999);
	expect(shown()).toEqual(["almost gone"]);
	jest.advanceTimersByTime(2);
	expect(shown()).toEqual([]);
});

test("pausing twice, or resuming a toast that runs, changes nothing", () => {
	const { toast, pauseToast, resumeToast } = useApp.getState();
	toast("info", "steady");
	const id = useApp.getState().toasts[0].id;
	resumeToast(id);
	jest.advanceTimersByTime(1000);
	pauseToast(id);
	pauseToast(id);
	jest.advanceTimersByTime(10_000);
	resumeToast(id);
	resumeToast(id);
	// 4.5 s minus 1 s shown = 3.5 s left, which is more than the 2 s grace.
	jest.advanceTimersByTime(3499);
	expect(shown()).toEqual(["steady"]);
	jest.advanceTimersByTime(2);
	expect(shown()).toEqual([]);
});

test("pausing or resuming a toast that is already gone does nothing", () => {
	const { toast, dismissToast, pauseToast, resumeToast } = useApp.getState();
	toast("info", "closed by hand");
	const id = useApp.getState().toasts[0].id;
	dismissToast(id);
	pauseToast(id);
	resumeToast(id);
	jest.advanceTimersByTime(60_000);
	expect(shown()).toEqual([]);
});

test("the stack keeps five toasts, the newest", () => {
	const { toast } = useApp.getState();
	for (let i = 1; i <= 7; i++) toast("info", `t${i}`);
	expect(shown()).toEqual(["t3", "t4", "t5", "t6", "t7"]);
});

test("a burst pushes out the oldest toasts that are not errors; an error that waits stays until it is shown", () => {
	const { toast } = useApp.getState();
	toast("error", "e1");
	toast("info", "i1");
	toast("error", "e2");
	for (let i = 2; i <= 6; i++) toast("info", `i${i}`);
	// Two shown, the rest waiting: e1 and e2 have not been on the screen yet, and are kept.
	expect(shown()).toEqual(["e1", "e2", "i4", "i5", "i6"]);
});

test("a stack of errors keeps every one of them", () => {
	const { toast } = useApp.getState();
	for (let i = 1; i <= 7; i++) toast("error", `e${i}`);
	toast("info", "i1");
	expect(shown()).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "i1"]);
});
