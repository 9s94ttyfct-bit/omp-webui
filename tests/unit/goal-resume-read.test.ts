import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import type { Goal } from "../../shared/goal.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { setPaused, useApp } from "../../web/src/store/app.ts";
import { initialLive } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * A conversation that is resumed reads its goal again: a frozen omp refuses the read, and the page must not keep
 * showing what it had before the pause. A refusal is not an answer — the read is asked for again as soon as the
 * conversation runs again (#500).
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const info = (liveId: string, paused: boolean): LiveInfo => ({
	liveId,
	pid: 1,
	cwd: "/",
	sessionFile: "/sessions/a.jsonl",
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: paused ? 1 : null,
	mode: "full",
});

const goal: Goal = { id: "g1", objective: "Ship it", status: "active", tokenBudget: 5000, tokensUsed: 900 };

/**
 * What omp answers for a `goal get`: the first time it is asked, the conversation is still frozen and refuses. The
 * read that comes after it is answered, as it is once the process runs again.
 */
let refuseFirst: boolean;
let rpc: Mock<typeof socket.rpc>;
let request: Mock<typeof socket.request>;

beforeEach(() => {
	refuseFirst = true;
	rpc?.mockRestore();
	request?.mockRestore();
	rpc = spyOn(socket, "rpc").mockImplementation((async (_liveId: string, command: { type: string }) => {
		if (command.type === "goal") {
			if (refuseFirst) {
				refuseFirst = false;
				throw new Error("This conversation is paused; resume it to continue.");
			}
			return { goal };
		}
		return { entries: [], leafId: null };
	}) as typeof socket.rpc);
	request = spyOn(socket, "request").mockImplementation((async () => info("L1", false)) as typeof socket.request);
	useApp.setState({
		view: { kind: "new" },
		lives: { L1: { ...initialLive(info("L1", true)), goal: null } },
		toasts: [],
		sessions: [],
	});
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("a goal read that was refused because the conversation was frozen is asked again once it runs", async () => {
	await setPaused("L1", false);
	await settle();
	// The read was refused (the process was still frozen), and the page has no goal yet.
	expect(useApp.getState().lives.L1.goal).toBeNull();
	// The conversation runs now: the read is asked again, and the goal it holds is what the page shows.
	await new Promise<void>((resolve) => setTimeout(resolve, 600));
	expect(useApp.getState().lives.L1.goal).toMatchObject({ id: "g1", status: "active" });
});

test("a goal read that keeps being refused is asked again, and not for ever", async () => {
	// Every read is refused: the conversation stays frozen, and the page must ask again — but not for ever.
	refuseFirst = false;
	rpc.mockImplementation((async (_liveId: string, command: { type: string }) => {
		if (command.type === "goal") throw new Error("This conversation is paused; resume it to continue.");
		return { entries: [], leafId: null };
	}) as typeof socket.rpc);
	await setPaused("L1", false);
	await settle();
	// The read is asked again: a refusal is not an answer, and the goal the page shows is the one omp holds.
	await new Promise<void>((resolve) => setTimeout(resolve, 600));
	const asked = rpc.mock.calls.filter(([, command]) => command.type === "goal").length;
	expect(asked).toBeGreaterThan(1);
	// And not for ever: the page gives up after a few tries, and keeps what it has.
	await new Promise<void>((resolve) => setTimeout(resolve, 3000));
	expect(rpc.mock.calls.filter(([, command]) => command.type === "goal").length).toBeLessThanOrEqual(30);
	expect(useApp.getState().lives.L1.goal).toBeNull();
});
