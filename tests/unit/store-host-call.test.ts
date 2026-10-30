import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import { PROPOSAL_RESULTS } from "../../shared/guided-goal.ts";
import type { OmpFrame } from "../../shared/protocol.ts";
import {
	cancelGuidedGoal,
	confirmProposal,
	guidedGoalActive,
	pendingProposal,
	startGuidedGoal,
} from "../../web/src/lib/goal.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { answerDialog, onServer, useApp } from "../../web/src/store/app.ts";
import { applyFrame, initialLive, type LiveState } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * The guided goal on the page's side: how a tool call from omp becomes a proposal to decide on, and what each decision
 * sends. The socket is stubbed; nothing here reaches omp.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const info = {
	liveId: "L1",
	pid: 1,
	cwd: "/",
	sessionFile: null,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full" as const,
};

const call = (
	id: string,
	args: unknown = { objective: "Ship it", acceptance_criteria: ["It ships"], token_budget: 50000 },
) => ({ type: "host_tool_call", id, toolCallId: `t-${id}`, toolName: "propose_goal", arguments: args }) as OmpFrame;

const fold = (frames: OmpFrame[], from: LiveState = initialLive(info)) => frames.reduce(applyFrame, from);

/** Every RPC the page sent (a plain command, and the answer to a click), and every message it posted without waiting. */
let rpc: Mock<typeof socket.rpc>;
let act: Mock<typeof socket.act>;
let post: Mock<typeof socket.post>;
const rpcs: Record<string, unknown>[] = [];
/** What the page asked omp to do: the `get_state` refreshes that follow a change are not part of the decision. */
const sent = () => rpcs.filter((c) => c.type !== "get_state");
const posts: Record<string, unknown>[] = [];
/** Make omp answer every command the page sends it, whichever way, with what `answer` says. */
const answers = (answer: (command: Record<string, unknown>) => Promise<unknown>): void => {
	const reply = async (_id: string, command: Record<string, unknown>) => {
		rpcs.push(command);
		return answer(command);
	};
	rpc.mockImplementation(reply as typeof socket.rpc);
	act.mockImplementation(reply as typeof socket.act);
};
beforeEach(() => {
	rpc?.mockRestore();
	act?.mockRestore();
	post?.mockRestore();
	rpcs.length = 0;
	posts.length = 0;
	rpc = spyOn(socket, "rpc");
	act = spyOn(socket, "act");
	answers(async () => ({}));
	post = spyOn(socket, "post").mockImplementation(((msg: Record<string, unknown>) => {
		posts.push(msg);
	}) as typeof socket.post);
	useApp.setState({ view: { kind: "new" }, lives: { L1: initialLive(info) }, toasts: [] });
});

const text = (s: string, isError = false) => ({
	result: { content: [{ type: "text", text: s }] },
	...(isError ? { isError: true } : {}),
});

// ------------------------------------------------------------------ the call becomes a proposal

test("a propose_goal call is a proposal waiting for the user, and the conversation needs their input", () => {
	const s = fold([call("h1")]);
	expect(s.uiRequests).toEqual([
		{
			id: "h1",
			method: "propose_goal",
			proposal: { objective: "Ship it", criteria: ["It ships"], tokenBudget: 50000 },
		},
	]);
	expect(s.needsInput).toBe(true);
	expect(pendingProposal(s)?.id).toBe("h1");
});

test("a call the server shows again (after a reload) is not a second proposal", () => {
	const once = fold([call("h1")]);
	expect(fold([call("h1")], once)).toBe(once);
});

test("a call without a usable proposal, or to a tool that is not ours, shows nothing", () => {
	expect(fold([call("h1", { objective: " " })]).uiRequests).toEqual([]);
	expect(fold([{ ...call("h2"), toolName: "other_tool" }]).uiRequests).toEqual([]);
});

test("omp giving up on the call takes the proposal away; one that was never shown changes nothing", () => {
	const shown = fold([call("h1")]);
	const gone = fold([{ type: "host_tool_cancel", id: "c1", targetId: "h1" }], shown);
	expect(gone.uiRequests).toEqual([]);
	expect(gone.needsInput).toBe(false);
	expect(fold([{ type: "host_tool_cancel", id: "c2", targetId: "nope" }], shown)).toBe(shown);
});

test("the interview is under way while the process offers the tool that ends it", () => {
	const live = (tools?: string[]): LiveState => ({
		...initialLive(info),
		state: { dumpTools: tools?.map((name) => ({ name })) } as LiveState["state"],
	});
	expect(guidedGoalActive(live(["read", "bash"]))).toBe(false);
	expect(guidedGoalActive(live(["read", "propose_goal"]))).toBe(true);
	expect(guidedGoalActive(live(undefined))).toBe(false);
	expect(guidedGoalActive(undefined)).toBe(false);
});

// ------------------------------------------------------------------ calls nothing can serve

test("a call with no usable proposal is answered with an error at once, or the turn would wait for it for good", () => {
	onServer({ t: "frame", liveId: "L1", frame: call("h1", { objective: "" }) });
	onServer({ t: "frame", liveId: "L1", frame: { ...call("h2"), toolName: "mystery" } });
	expect(posts).toEqual([
		{
			t: "ui_response",
			liveId: "L1",
			response: { id: "h1", ...text("propose_goal needs a non-empty objective.", true) },
		},
		{
			t: "ui_response",
			liveId: "L1",
			response: { id: "h2", ...text("The web UI does not provide a tool named mystery.", true) },
		},
	]);
	expect(useApp.getState().lives.L1.uiRequests).toEqual([]);
});

test("a proposal that can be shown is left for the user", () => {
	onServer({ t: "frame", liveId: "L1", frame: call("h1") });
	expect(posts).toEqual([]);
	expect(useApp.getState().lives.L1.uiRequests.map((r) => r.id)).toEqual(["h1"]);
});

// ------------------------------------------------------------------ starting the interview

test("the interview starts by giving the model its tool, then asking it to begin", async () => {
	await startGuidedGoal("L1", "make the tests faster");
	expect(sent()[0]).toMatchObject({ type: "set_host_tools", tools: [{ name: "propose_goal", loadMode: "essential" }] });
	expect(sent()[1]).toMatchObject({ type: "prompt" });
	expect(String(sent()[1].message)).toContain("My rough idea: make the tests faster");
	// A conversation that is idle takes it as a plain prompt, with no images.
	expect(sent()[1]).not.toHaveProperty("streamingBehavior");
	expect(sent()[1]).not.toHaveProperty("images");
});

test("a turn that is still running takes the request after it, and pictures go along", async () => {
	const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
	await startGuidedGoal("L1", "", { queue: true, images: [image] });
	expect(sent()[1]).toMatchObject({ type: "prompt", streamingBehavior: "followUp", images: [image] });
	expect(String(sent()[1].message)).toContain("I do not have a precise idea yet");
});

test("an interview that cannot start leaves no tool behind, and says why", async () => {
	answers(async (command) => {
		if (command.type === "prompt") throw new Error("omp refused");
		return {};
	});
	await expect(startGuidedGoal("L1", "x")).rejects.toThrow("omp refused");
	expect(sent().map((c) => c.type)).toEqual(["set_host_tools", "prompt", "set_host_tools"]);
	expect(sent().at(-1)).toEqual({ type: "set_host_tools", tools: [] });
});

// ------------------------------------------------------------------ the user's decision

test("confirming creates the goal first, then tells the model, then takes the tool away", async () => {
	useApp.setState((s) => ({ lives: { L1: fold([call("h1")], s.lives.L1) } }));
	await confirmProposal("L1", "h1", { objective: "Ship it", criteria: ["It ships", ""], tokenBudget: 50000 });
	const objective = "Ship it\n\nAcceptance criteria:\n- It ships";
	expect(sent()).toEqual([
		{ type: "goal", op: "create", objective, token_budget: 50000 },
		{ type: "set_host_tools", tools: [] },
	]);
	expect(posts).toEqual([
		{ t: "ui_response", liveId: "L1", response: { id: "h1", ...text(PROPOSAL_RESULTS.confirmed(objective)) } },
	]);
	// The proposal is gone from the page.
	expect(useApp.getState().lives.L1.uiRequests).toEqual([]);
});

test("a goal omp refuses is not confirmed: nothing is sent to the model and the proposal stays", async () => {
	useApp.setState((s) => ({ lives: { L1: fold([call("h1")], s.lives.L1) } }));
	answers(async (command) => {
		if (command.type === "goal") throw new Error("A goal is already active. Drop it before creating another.");
		return {};
	});
	await expect(confirmProposal("L1", "h1", { objective: "Ship it", criteria: [] })).rejects.toThrow(/already active/);
	expect(posts).toEqual([]);
	expect(sent().map((c) => c.type)).toEqual(["goal"]);
	expect(useApp.getState().lives.L1.uiRequests.map((r) => r.id)).toEqual(["h1"]);
});

test("no budget is no token_budget", async () => {
	await confirmProposal("L1", "h1", { objective: "Ship it", criteria: [] });
	expect(sent()[0]).toEqual({ type: "goal", op: "create", objective: "Ship it" });
});

test("cancelling with a proposal open declines it to the model and leaves no goal", async () => {
	const live = fold([call("h1")]);
	await cancelGuidedGoal({ ...live, streaming: true });
	expect(posts).toEqual([
		{ t: "ui_response", liveId: "L1", response: { id: "h1", ...text(PROPOSAL_RESULTS.cancelled) } },
	]);
	// The turn is finishing on its own (the model acknowledges), so it is not aborted.
	expect(sent()).toEqual([{ type: "set_host_tools", tools: [] }]);
});

test("cancelling in the middle of the interview stops the turn that is running", async () => {
	await cancelGuidedGoal({ ...initialLive(info), streaming: true });
	expect(posts).toEqual([]);
	expect(sent()).toEqual([{ type: "set_host_tools", tools: [] }, { type: "abort" }]);
});

test("cancelling between turns only takes the tool away", async () => {
	await cancelGuidedGoal(initialLive(info));
	expect(sent()).toEqual([{ type: "set_host_tools", tools: [] }]);
	expect(sent().some((c) => c.type === "goal")).toBe(false);
});

test("answering a proposal removes it from the page and goes to the server as the call's result", () => {
	useApp.setState((s) => ({ lives: { L1: fold([call("h1")], s.lives.L1) } }));
	answerDialog("L1", { id: "h1", ...text("later") });
	expect(posts).toEqual([{ t: "ui_response", liveId: "L1", response: { id: "h1", ...text("later") } }]);
	expect(useApp.getState().lives.L1.needsInput).toBe(false);
});
