import { expect, test } from "bun:test";
import { WindowPresence } from "../../web/src/lib/browser-window.ts";

/** Which windows popped out for a conversation's browser are open (#26): the browser is in the panel only when none is. */

const A = "/sessions/a.jsonl";
const B = "/sessions/b.jsonl";

function clock() {
	let t = 1_000_000;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

test("two windows for one conversation: closing one leaves the browser out of the panel until the other closes", () => {
	const c = clock();
	const p = new WindowPresence(c.now, 3500);
	p.open(A, "w1");
	p.open(A, "w2");
	expect(p.isOpen(A)).toBe(true);
	p.closed(A, "w1");
	expect(p.isOpen(A)).toBe(true);
	p.closed(A, "w2");
	expect(p.isOpen(A)).toBe(false);
});

test("a window that stops saying it is open (a crash) is closed a few seconds later, whatever the others do", () => {
	const c = clock();
	const p = new WindowPresence(c.now, 3500);
	p.open(A, "w1");
	p.open(A, "w2");
	c.advance(2000);
	p.open(A, "w2");
	c.advance(2000);
	// w1 was last heard 4 s ago, w2 2 s ago.
	expect(p.isOpen(A)).toBe(true);
	c.advance(2000);
	expect(p.isOpen(A)).toBe(false);
});

test("windows are of their conversation, and asking all of one conversation's to close forgets only those", () => {
	const c = clock();
	const p = new WindowPresence(c.now, 3500);
	p.open(A, "w1");
	p.open(A, "w2");
	p.open(B, "w3");
	p.closedAll(A);
	expect(p.isOpen(A)).toBe(false);
	expect(p.isOpen(B)).toBe(true);
});

test("a close from a window that was never heard of leaves nothing open", () => {
	const p = new WindowPresence(clock().now, 3500);
	p.closed(A, "never-opened");
	expect(p.isOpen(A)).toBe(false);
});
