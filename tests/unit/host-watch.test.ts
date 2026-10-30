import { describe, expect, test } from "bun:test";
import { type Wanted, WatchBook } from "../../web/src/lib/host-watch.ts";

/** Who on the page shows the host's load, and what the server is told of it (web/src/lib/host-watch.ts). */

/** What the server was told, as the socket gives it. */
type Told = Wanted & { on: boolean };

const line: Wanted = { detail: false, procs: false };
const graphs: Wanted = { detail: true, procs: false };
const table: Wanted = { detail: false, procs: true };

function book(connected = true) {
	const said: Told[] = [];
	const state = { connected, droppedProcs: 0 };
	const later: (() => void)[] = [];
	const b = new WatchBook(
		() => state.connected,
		(told) => said.push(told),
		() => state.droppedProcs++,
		(fn) => later.push(fn),
	);
	/** The microtask: runs what was put off. */
	const tick = () => {
		for (const fn of later.splice(0)) fn();
	};
	return { b, said, state, tick };
}

describe("telling the server what is watched", () => {
	test("the first watcher turns it on, once, however many are added in the same tick", () => {
		const { b, said, tick } = book();
		expect(b.watch({}, line)).toBe(true);
		expect(b.watch({}, line)).toBe(false);
		tick();
		expect(said).toEqual([{ on: true, detail: false, procs: false }]);
	});

	test("the last to go turns it off, and a page that watches nothing says nothing on a connection it has not told anything on", () => {
		const a = {};
		const { b, said, tick } = book();
		b.watch(a, line);
		tick();
		b.unwatch(a);
		tick();
		expect(said).toEqual([
			{ on: true, detail: false, procs: false },
			{ on: false, detail: false, procs: false },
		]);
		const quiet = book();
		quiet.b.watch(a, line);
		quiet.b.unwatch(a);
		quiet.tick();
		expect(quiet.said).toEqual([]);
	});

	test("the line alone asks for the background pace; the graphs ask for the live one while any of them is shown", () => {
		const tile = {};
		const pane = {};
		const { b, said, tick } = book();
		b.watch(tile, line);
		tick();
		b.watch(pane, graphs);
		tick();
		b.unwatch(pane);
		tick();
		expect(said).toEqual([
			{ on: true, detail: false, procs: false },
			{ on: true, detail: true, procs: false },
			{ on: true, detail: false, procs: false },
		]);
	});

	test("the processes are a listing at each look, not a pace: a page that shows them alone asks for the background pace", () => {
		const { b, said, tick } = book();
		b.watch({}, table);
		tick();
		expect(said).toEqual([{ on: true, detail: false, procs: true }]);
	});

	test("processes are asked for while any watcher shows them, and only then", () => {
		const tile = {};
		const pane = {};
		const { b, said, tick, state } = book();
		b.watch(tile, line);
		tick();
		b.watch(pane, { detail: true, procs: true });
		tick();
		b.unwatch(pane);
		tick();
		expect(said).toEqual([
			{ on: true, detail: false, procs: false },
			{ on: true, detail: true, procs: true },
			{ on: true, detail: false, procs: false },
		]);
		// What the page kept of the processes is dropped once nobody asks for them: it would be shown as if it were current.
		expect(state.droppedProcs).toBe(1);
	});

	test("a watcher that changes what it wants (an effect that runs again with another `procs`) is not told as off and on", () => {
		const owner = {};
		const { b, said, tick } = book();
		b.watch(owner, line);
		tick();
		// What React does when `procs` changes: the old effect is cleaned up and the new one runs, in one tick.
		b.unwatch(owner);
		b.watch(owner, graphs);
		tick();
		expect(said).toEqual([
			{ on: true, detail: false, procs: false },
			{ on: true, detail: true, procs: false },
		]);
	});

	test("something that came and went within one tick is never told", () => {
		const owner = {};
		const { b, said, tick } = book();
		b.watch(owner, graphs);
		b.unwatch(owner);
		tick();
		expect(said).toEqual([]);
	});

	test("what the server already has is not told again", () => {
		const { b, said, tick } = book();
		b.watch({}, line);
		tick();
		b.watch({}, line);
		tick();
		expect(said).toHaveLength(1);
	});
});

describe("the connection", () => {
	test("nothing is said on a connection that is not there, and what is watched is told when it comes", () => {
		const { b, said, tick, state } = book(false);
		b.watch({}, graphs);
		tick();
		expect(said).toEqual([]);
		state.connected = true;
		b.reconnected();
		tick();
		expect(said).toEqual([{ on: true, detail: true, procs: false }]);
	});

	test("a new connection starts from nothing: the server forgot what the old one watched", () => {
		const { b, said, tick, state } = book();
		b.watch({}, line);
		tick();
		state.connected = false;
		b.disconnected();
		state.connected = true;
		b.reconnected();
		tick();
		expect(said).toEqual([
			{ on: true, detail: false, procs: false },
			{ on: true, detail: false, procs: false },
		]);
	});

	test("a reconnection with nothing watched says nothing", () => {
		const { b, said, tick } = book();
		b.reconnected();
		tick();
		expect(said).toEqual([]);
	});
});
