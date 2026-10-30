import type { Page } from "@playwright/test";
import { startLive } from "./live.ts";
import { type Msg, tapSocket } from "./socket-tap.ts";
import { type OwnSession, sessionWithSubagents } from "./subagent-fixtures.ts";

/**
 * A conversation for the agent graph specs (#719, #736): its own omp process (no model call), open on its graph, and
 * omp's subagent frames pushed to the page by hand, so a graph of any size can be had without running a subagent.
 */

export type Frame = Record<string, unknown>;

export const lifecycle = (id: string, status: string, extra: Frame = {}): Frame => ({
	type: "subagent_lifecycle",
	payload: { id, agent: "explore", agentSource: "bundled", index: 0, status, ...extra },
});
export const event = (id: string, ev: Frame): Frame => ({ type: "subagent_event", payload: { id, event: ev } });
const progress = (id: string, tokens: number, cost: number): Frame => ({
	type: "subagent_progress",
	payload: { id, progress: { id, status: "running", tokens, cost } },
});

export interface OpenGraph {
	own: OwnSession;
	/** Push one frame of omp's to the page. */
	frame(f: Frame): void;
	/**
	 * The subagents omp's registry lists as running (`get_subagents`, which the page reads when it attaches): add one here
	 * before its frames are pushed. A subagent the page holds as running that this does not list is taken to have ended,
	 * as it is with the real omp.
	 */
	running: Set<string>;
}

/**
 * Start `title`'s omp, push nothing yet, and open its graph on the Agents page. `agents` are subagents with transcripts on
 * disk (they are drawn too, finished, with the start of their transcript's header).
 */
export async function openGraph(
	page: Page,
	n: number,
	title: string,
	agents: Record<string, number[]> = {},
): Promise<OpenGraph> {
	const own = sessionWithSubagents(n, title, agents);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	const running = new Set<string>();
	tap.answer("get_subagents", () => ({
		ok: true,
		data: { subagents: [...running].map((id) => ({ id, status: "running" })) },
	}));
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `graph-probe-${n.toString(16)}`);
	await page.getByTestId("nav-agents").click();
	await page.getByTestId("agents-list").getByRole("button", { name: title }).click();
	await page.getByTestId("agents-canvas").waitFor();
	return { own, running, frame: (f) => tap.push({ t: "frame", liveId, frame: f } as Msg) };
}

/** How many finished task calls the big graph of the specs has. */
export const CALLS = 24;

/** Each subagent of a seeded batch used this much. */
export const SCOUT_TOKENS = 1000;
export const SCOUT_COST = 0.01;

const two = (n: number) => String(n).padStart(2, "0");
/** The id of the `i`th subagent of the `call`th seeded batch. */
export const scoutId = (call: number, i: number) => `Team${two(call)}Scout${two(i)}`;
export const callId = (call: number) => `call_${two(call)}`;

/** `calls` task calls, each of `per` subagents that started together and all completed. */
export function seedFinished(frame: OpenGraph["frame"], calls: number, per: number): void {
	for (let c = 0; c < calls; c++) {
		const batch = { parentToolCallId: callId(c) };
		for (let i = 0; i < per; i++) frame(lifecycle(scoutId(c, i), "started", { index: i, ...batch }));
		for (let i = 0; i < per; i++) {
			frame(progress(scoutId(c, i), SCOUT_TOKENS, SCOUT_COST));
			frame(lifecycle(scoutId(c, i), "completed", { index: i, ...batch }));
		}
	}
}

/** One call whose subagents finished but one failed, and a subagent that is still running. */
export function seedLive(g: OpenGraph): void {
	const mixed = { parentToolCallId: "call_mixed" };
	g.running.add("Runner");
	g.frame(lifecycle("MixedA", "started", { index: 0, ...mixed }));
	g.frame(lifecycle("MixedB", "started", { index: 1, ...mixed }));
	g.frame(lifecycle("MixedC", "started", { index: 2, ...mixed }));
	g.frame(lifecycle("MixedA", "completed", { index: 0, ...mixed }));
	g.frame(lifecycle("MixedB", "failed", { index: 1, ...mixed }));
	g.frame(lifecycle("MixedC", "completed", { index: 2, ...mixed }));
	g.frame(lifecycle("Runner", "started", { parentToolCallId: "call_run" }));
}
