import { expect, test } from "bun:test";
import { AutoTitle, type TitleTarget } from "../../server/auto-title.ts";

/**
 * When the server asks omp for a conversation's title (#627): once, after the first exchange, with Settings on; a title model
 * that gives nothing is asked twice more and then again when another turn ends. The process is a stand-in here;
 * `tests/contract/auto-title.test.ts` has the real omp and the real server.
 */

const DECLINED = "Could not generate a session title. Use /rename <title> to set one.";
const NAMED = "Session renamed to A title.";

function process(over: Partial<{ state: Record<string, unknown> | null; says: (n: number) => string | null }> = {}) {
	const world = {
		state: { sessionId: "s1", messageCount: 2 } as Record<string, unknown> | null,
		renames: 0,
		gone: false,
		enabled: true,
		says: (_n: number): string | null => NAMED,
		throws: false,
		...over,
	};
	const target: TitleTarget = {
		state: async () => world.state,
		rename: async () => {
			world.renames++;
			if (world.throws) throw new Error("paused");
			return world.says(world.renames);
		},
		gone: () => world.gone,
	};
	const titles = new AutoTitle(target, () => world.enabled, 1);
	return { world, titles };
}

/** Everything scheduled has run: the checks are promises and the retries a millisecond or two of timers. */
const settle = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("the first exchange is given a title, once: later turns of the same conversation ask for none", async () => {
	const { world, titles } = process();
	titles.turnEnded();
	await settle();
	expect(world.renames).toBe(1);
	titles.turnEnded();
	titles.turnEnded();
	await settle();
	expect(world.renames).toBe(1);
});

test("nothing is asked while the conversation has a name, has no reply yet, or Settings has titles off", async () => {
	const named = process({ state: { sessionId: "s1", sessionName: "Mine", messageCount: 4 } });
	named.titles.turnEnded();
	const early = process({ state: { sessionId: "s1", messageCount: 1 } });
	early.titles.turnEnded();
	const unknown = process({ state: null });
	unknown.titles.turnEnded();
	const off = process();
	off.world.enabled = false;
	off.titles.turnEnded();
	const gone = process();
	gone.world.gone = true;
	gone.titles.turnEnded();
	await settle();
	for (const p of [named, early, unknown, off, gone]) expect(p.world.renames).toBe(0);
});

test("a title model that gives nothing is asked twice more, and then again when another turn ends", async () => {
	const { world, titles } = process({ says: () => DECLINED });
	titles.turnEnded();
	await settle(80);
	// Three attempts after one first exchange, and no more until a turn ends.
	expect(world.renames).toBe(3);
	await settle(40);
	expect(world.renames).toBe(3);
	world.says = () => NAMED;
	titles.turnEnded();
	await settle();
	expect(world.renames).toBe(4);
	// Named: no longer asked.
	titles.turnEnded();
	await settle();
	expect(world.renames).toBe(4);
});

test("a retry that finds the conversation named by then asks for nothing", async () => {
	const { world, titles } = process();
	// The declined attempt is the last thing that happens before the person names the conversation themselves.
	world.says = () => {
		world.state = { sessionId: "s1", sessionName: "Named meanwhile", messageCount: 2 };
		return DECLINED;
	};
	titles.turnEnded();
	await settle(60);
	expect(world.renames).toBe(1);
});

test("a rename that could not be run (a paused conversation) is asked again at the next turn's end", async () => {
	const { world, titles } = process();
	world.throws = true;
	titles.turnEnded();
	await settle();
	expect(world.renames).toBe(1);
	world.throws = false;
	titles.turnEnded();
	await settle();
	expect(world.renames).toBe(2);
});

test("an omp that does not list the command, or ends while a title is waited for, is not asked over and over", async () => {
	const none = process({ says: () => "" });
	none.titles.turnEnded();
	await settle();
	none.titles.turnEnded();
	await settle();
	expect(none.world.renames).toBe(1);

	const ending = process({ says: () => DECLINED });
	ending.titles.turnEnded();
	await settle(3);
	ending.world.gone = true;
	ending.titles.stop();
	const seen = ending.world.renames;
	await settle(40);
	expect(ending.world.renames).toBe(seen);
});

test("two turns ending at once make one check", async () => {
	const { world, titles } = process();
	titles.turnEnded();
	titles.turnEnded();
	await settle();
	expect(world.renames).toBe(1);
});

test("a conversation that moves to another session is asked about on its own", async () => {
	const { world, titles } = process();
	titles.turnEnded();
	await settle();
	world.state = { sessionId: "s2", messageCount: 2 };
	titles.turnEnded();
	await settle();
	expect(world.renames).toBe(2);
});
