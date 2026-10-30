import { expect, test } from "bun:test";
import { PtyManager } from "../../server/pty.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * A terminal survives Run in Background (#627): when the macOS app says it is about to close its window, the page's terminals
 * are held, with the tail of what they printed, for the page of the window that opens again. Real pseudo-terminals, with `sh`
 * standing in for omp: `omp <args>` is `sh -c '<script>'` here.
 */

interface Seen {
	t: string;
	data?: string;
	code?: number | null;
}

/** A page: what the server sent it. */
function page() {
	const seen: Seen[] = [];
	return {
		seen,
		send: (msg: unknown) => void seen.push(msg as Seen),
		text: () => seen.map((m) => m.data ?? "").join(""),
	};
}

const SHELL = "/bin/sh";
const opened = (ptys: PtyManager, owner: ReturnType<typeof page>, script: string) =>
	ptys.open(owner, ["-c", script], undefined, 80, 24);

test("a page that goes away kills its terminals, as it always did", async () => {
	const ptys = new PtyManager(SHELL);
	const owner = page();
	const id = opened(ptys, owner, "exec cat");
	ptys.dropOwner(owner);
	await pollUntil(() => owner.seen.some((m) => m.t === "pty_exit"), "the process was ended");
	expect(ptys.held()).toEqual([]);
	expect(ptys.attach(page(), id)).toBeNull();
});

test("a close the app announced leaves the terminal held; the page that comes back takes it over with what it printed", async () => {
	const ptys = new PtyManager(SHELL);
	const before = page();
	const id = opened(ptys, before, "echo first; exec cat");
	await pollUntil(() => before.text().includes("first"), "the first output");

	ptys.expectDetach();
	ptys.dropOwner(before, true);
	expect(ptys.held()).toEqual([{ ptyId: id, args: ["-c", "echo first; exec cat"], cwd: expect.any(String) }]);

	// The page that left hears nothing more; the one that comes back is given the tail of what was printed.
	const heard = before.seen.length;
	const after = page();
	const taken = ptys.attach(after, id);
	expect(taken?.replay).toContain("first");
	expect(taken?.exited).toBeUndefined();
	expect(before.seen).toHaveLength(heard);
	expect(ptys.held()).toEqual([]);
	// From now on the page is told what it prints, and its input reaches it.
	ptys.input(after, id, "again\n");
	await pollUntil(() => after.text().includes("again"), "what it prints now reaches the new page");
	// A terminal has one page: nobody else can take it.
	expect(ptys.attach(page(), id)).toBeNull();
	ptys.killAll();
});

test("only a page of this computer's close, announced in time, leaves its terminals", async () => {
	const ptys = new PtyManager(SHELL);
	const remote = page();
	const late = page();
	opened(ptys, remote, "exec cat");
	opened(ptys, late, "exec cat");
	ptys.expectDetach(5_000, 1_000);
	// A page that is not this computer's, whatever the app said.
	ptys.dropOwner(remote, false, 1_001);
	// A page that closes after the announcement ran out.
	ptys.dropOwner(late, true, 7_000);
	expect(ptys.held()).toEqual([]);
	await pollUntil(
		() => remote.seen.some((m) => m.t === "pty_exit") && late.seen.some((m) => m.t === "pty_exit"),
		"both ended",
	);
});

test("a notice the app withdrew (its window was opened again) leaves nothing: the page that closes next kills its terminals", async () => {
	const ptys = new PtyManager(SHELL);
	const tab = page();
	opened(ptys, tab, "exec cat");
	ptys.expectDetach();
	ptys.cancelDetach();
	ptys.dropOwner(tab, true);
	expect(ptys.held()).toEqual([]);
	await pollUntil(() => tab.seen.some((m) => m.t === "pty_exit"), "its terminal ended with its page");
});

test("a terminal nobody came for is ended after the time it is held for", async () => {
	const ptys = new PtyManager(SHELL, 30);
	const owner = page();
	opened(ptys, owner, "exec cat");
	ptys.expectDetach();
	ptys.dropOwner(owner, true);
	expect(ptys.held()).toHaveLength(1);
	// A real, short hold: the deadline is a timer of the manager's own, which is what is under test.
	await pollUntil(() => ptys.held().length === 0, "the held terminal expired");
});

test("a terminal whose process ended while it was held shows how it ended to the page that comes back, once", async () => {
	const ptys = new PtyManager(SHELL);
	const owner = page();
	const id = opened(ptys, owner, "sleep 0.3; echo finished-ok; exit 3");
	ptys.expectDetach();
	ptys.dropOwner(owner, true);
	await pollUntil(() => ptys.held()[0]?.exited !== undefined, "it ended while held");
	expect(ptys.held()[0]).toMatchObject({ ptyId: id, exited: 3 });

	const back = page();
	const taken = ptys.attach(back, id);
	expect(taken?.exited).toBe(3);
	expect(taken?.replay).toContain("finished-ok");
	// Nothing is left of it, and the page is not also sent an exit message.
	expect(ptys.held()).toEqual([]);
	expect(ptys.attach(page(), id)).toBeNull();
	expect(back.seen).toEqual([]);
});

test("nobody types into or ends a held terminal by its id: it waits for the page that takes it over (#682)", async () => {
	const ptys = new PtyManager(SHELL);
	const owner = page();
	const id = opened(ptys, owner, "exec cat");
	ptys.expectDetach();
	ptys.dropOwner(owner, true);
	const stranger = page();
	ptys.input(stranger, id, "typed-by-a-stranger\n");
	ptys.kill(stranger, id);
	ptys.kill(owner, id);
	expect(ptys.held()).toMatchObject([{ ptyId: id }]);
	const back = page();
	const taken = ptys.attach(back, id);
	expect(taken?.exited).toBeUndefined();
	expect(taken?.replay ?? "").not.toContain("typed-by-a-stranger");
	// Taken over, it is that page's to end.
	ptys.kill(back, id);
	await pollUntil(() => back.seen.some((m) => m.t === "pty_exit"), "the page's kill to end it");
});

test("a terminal's Clear (#696): the page that attaches later is not given what was cleared, but what came after", async () => {
	const ptys = new PtyManager(SHELL);
	const owner = page();
	const id = opened(ptys, owner, "echo before-clear; exec cat");
	await pollUntil(() => owner.text().includes("before-clear"), "the first output");
	ptys.clear(owner, id);
	ptys.input(owner, id, "after-clear\n");
	await pollUntil(() => owner.text().includes("after-clear"), "output after Clear");
	ptys.expectDetach();
	ptys.dropOwner(owner, true);
	const taken = ptys.attach(page(), id);
	expect(taken?.replay).not.toContain("before-clear");
	expect(taken?.replay).toContain("after-clear");
	ptys.killAll();
});

test("only the page that has a terminal clears it (#682)", async () => {
	const ptys = new PtyManager(SHELL);
	const owner = page();
	const id = opened(ptys, owner, "echo kept-output; exec cat");
	await pollUntil(() => owner.text().includes("kept-output"), "the first output");
	ptys.clear(page(), id);
	ptys.expectDetach();
	ptys.dropOwner(owner, true);
	expect(ptys.attach(page(), id)?.replay).toContain("kept-output");
	ptys.killAll();
});
