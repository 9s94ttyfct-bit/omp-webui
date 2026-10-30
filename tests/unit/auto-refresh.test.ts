import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { AUTO_REFRESH_MS, autoRefresh, type PageEnv } from "../../web/src/lib/auto-refresh.ts";

/**
 * The Issues tab refreshes by itself while it is shown (#695): at an interval while the page is visible, and when the page
 * comes back; nothing runs while the page is hidden. A scripted page and a fake clock: nothing waits for a real minute.
 */

function page(visible = true) {
	let shown = visible;
	const visibility = new Set<() => void>();
	const focus = new Set<() => void>();
	const env: PageEnv = {
		visible: () => shown,
		onVisibility: (l) => {
			visibility.add(l);
			return () => visibility.delete(l);
		},
		onFocus: (l) => {
			focus.add(l);
			return () => focus.delete(l);
		},
	};
	return {
		env,
		listeners: () => visibility.size + focus.size,
		show: () => {
			shown = true;
			for (const l of visibility) l();
		},
		hide: () => {
			shown = false;
			for (const l of visibility) l();
		},
		focus: () => {
			for (const l of focus) l();
		},
	};
}

beforeEach(() => {
	jest.useFakeTimers();
});
afterEach(() => {
	jest.useRealTimers();
});

test("it refreshes at the interval while the page is visible, and not before", () => {
	const p = page();
	let n = 0;
	const stop = autoRefresh(() => n++, 1000, p.env);
	jest.advanceTimersByTime(999);
	expect(n).toBe(0);
	jest.advanceTimersByTime(1);
	expect(n).toBe(1);
	jest.advanceTimersByTime(2000);
	expect(n).toBe(3);
	stop();
});

test("the interval is a minute unless it is given", () => {
	const p = page();
	let n = 0;
	const stop = autoRefresh(() => n++, undefined, p.env);
	jest.advanceTimersByTime(AUTO_REFRESH_MS - 1);
	expect(n).toBe(0);
	jest.advanceTimersByTime(1);
	expect(n).toBe(1);
	stop();
});

test("a hidden page is not refreshed, and refreshes at once when it is shown again", () => {
	const p = page();
	let n = 0;
	const stop = autoRefresh(() => n++, 1000, p.env);
	p.hide();
	jest.advanceTimersByTime(60_000);
	expect(n).toBe(0);
	p.show();
	expect(n).toBe(1);
	// The interval counts from the return.
	jest.advanceTimersByTime(999);
	expect(n).toBe(1);
	jest.advanceTimersByTime(1);
	expect(n).toBe(2);
	stop();
});

test("a page that starts hidden has no timer until it is shown", () => {
	const p = page(false);
	let n = 0;
	const stop = autoRefresh(() => n++, 1000, p.env);
	jest.advanceTimersByTime(10_000);
	expect(n).toBe(0);
	p.show();
	expect(n).toBe(1);
	stop();
});

test("the window getting the focus refreshes at once while visible, and does nothing while hidden", () => {
	const p = page();
	let n = 0;
	const stop = autoRefresh(() => n++, 1000, p.env);
	p.focus();
	expect(n).toBe(1);
	p.hide();
	p.focus();
	expect(n).toBe(1);
	stop();
});

test("stopping ends the timer and the listeners", () => {
	const p = page();
	let n = 0;
	const stop = autoRefresh(() => n++, 1000, p.env);
	expect(p.listeners()).toBe(2);
	stop();
	expect(p.listeners()).toBe(0);
	jest.advanceTimersByTime(10_000);
	p.focus();
	p.show();
	expect(n).toBe(0);
});
