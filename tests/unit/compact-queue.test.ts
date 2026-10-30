import { expect, test } from "bun:test";
import { type CompactHost, type CompactOutcome, CompactQueue } from "../../server/omp/compact-queue.ts";
import type { RpcResponse } from "../../server/omp/rpc-client.ts";
import type { StepUnavailable } from "../../shared/compact-queue.ts";

/**
 * A compact queued while the agent works (#651): it is sent when the turn has ended, and the follow-ups that were queued
 * behind it go after it. Against a scripted process: what the queue sends omp, and in which order, is what is looked at.
 */

type Command = Record<string, unknown>;

/** omp as the queue sees it: what it has queued, what it answers, and every command it was sent, in order. */
function world(
	options: {
		followUps?: { message: string; images?: Record<string, unknown>[] }[];
		working?: boolean;
		unavailable?: StepUnavailable;
	} = {},
) {
	const sent: Command[] = [];
	const ended: CompactOutcome[] = [];
	const state = { working: options.working ?? true, paused: false, changes: 0 };
	/** What the queue told the process's extension, in order; what it let go; how often it asked omp for its state. */
	const armed: (number | null)[] = [];
	const letGo: string[] = [];
	const refreshes: number[] = [];
	/** Answers by command type; a handler may return a promise to hold the command. */
	const answers = new Map<string, (command: Command) => RpcResponse | Promise<RpcResponse>>();
	const queued = [...(options.followUps ?? [])];
	const ok = (command: Command, data?: unknown): RpcResponse => ({
		type: "response",
		command: String(command.type),
		success: true,
		data,
	});
	const host: CompactHost = {
		async send(command) {
			sent.push(command);
			const custom = answers.get(String(command.type));
			if (custom) return custom(command);
			if (command.type === "get_state")
				return ok(command, { queuedMessages: { steering: [], followUp: queued.map((q) => q.message) } });
			if (command.type === "remove_queued_message") {
				const at = queued.findIndex((q) => q.message === command.message);
				const [taken] = at >= 0 ? queued.splice(at, 1) : [];
				return ok(command, { removed: at >= 0, images: taken?.images ?? [] });
			}
			return ok(command, {});
		},
		working: () => state.working,
		paused: () => state.paused,
		changed: () => void state.changes++,
		ended: (outcome) => void ended.push(outcome),
		stepUnavailable: async () => options.unavailable ?? null,
		arm: (at) => void armed.push(at),
		letGo: (id) => void letGo.push(id),
		refresh: async () => void refreshes.push(1),
	};
	const queue = new CompactQueue(host, 20);
	return {
		queue,
		sent,
		ended,
		state,
		answers,
		armed,
		letGo,
		refreshed: () => refreshes.length,
		types: () => sent.map((c) => c.type),
	};
}

/** One turn of the event loop. */
async function turn(): Promise<void> {
	const next = Promise.withResolvers<void>();
	setImmediate(next.resolve);
	await next.promise;
}

/** Let the event loop turn until `condition` holds: the queue's work is a few promises, never a wall-clock wait. */
async function until(condition: () => boolean): Promise<void> {
	const deadline = performance.now() + 5000;
	while (!condition()) {
		if (performance.now() > deadline) throw new Error("the condition never held");
		await turn();
	}
}

/** Long enough in turns of the event loop for everything the queue has in hand to have been done: what is asserted after it did not happen. */
async function quiet(): Promise<void> {
	for (let i = 0; i < 20; i++) await turn();
}

const PICTURE = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };

test("queue, turn end, compact, then the queued messages: omp's own and the ones sent meanwhile, in the order they were sent", async () => {
	const w = world({ followUps: [{ message: "first", images: [PICTURE] }, { message: "second" }] });
	await w.queue.queue("keep the API names");
	// omp's queue was emptied into the hold, and the compact waits for the turn: nothing but that was sent.
	expect(w.types()).toEqual(["get_state", "remove_queued_message", "remove_queued_message"]);
	expect(w.queue.info).toMatchObject({
		phase: "queued",
		instructions: "keep the API names",
		held: ["first", "second"],
	});

	// A follow-up sent while it waits is held behind them, and never reaches omp.
	const reply = await w.queue.intercept({ type: "prompt", message: "third", streamingBehavior: "followUp" }, {});
	expect(reply?.success).toBe(true);
	expect(w.queue.info?.held).toEqual(["first", "second", "third"]);
	expect(w.types()).toHaveLength(3);

	// The turn ends: the compact goes, with its note, and only after omp has answered it do the messages.
	w.state.working = false;
	w.queue.frame({ type: "agent_end", isTerminal: true });
	await until(() => w.ended.length === 1);
	expect(w.sent.slice(3)).toEqual([
		{ type: "compact", customInstructions: "keep the API names" },
		{ type: "prompt", message: "first", images: [PICTURE], streamingBehavior: "followUp" },
		{ type: "prompt", message: "second", streamingBehavior: "followUp" },
		{ type: "prompt", message: "third", streamingBehavior: "followUp" },
	]);
	expect(w.ended).toEqual([{ ok: true }]);
	expect(w.queue.info).toBeUndefined();
	expect(w.queue.active).toBe(false);
});

test("a compact queued with nothing behind it sends no note and holds nothing", async () => {
	const w = world();
	await w.queue.queue(undefined);
	w.state.working = false;
	w.queue.frame({ type: "session_settled" });
	await until(() => w.ended.length === 1);
	expect(w.sent.at(-1)).toEqual({ type: "compact" });
	expect(w.types()).toEqual(["get_state", "compact"]);
});

test("nothing is sent while the turn goes on: a turn omp carries on, a goal's next turn, a frozen omp, omp's own compaction", async () => {
	const w = world();
	await w.queue.queue(undefined);
	// The turn is not over: omp says it carries on.
	w.queue.frame({ type: "agent_end", isTerminal: false });
	// A turn that ended and began again before the compact could go (a goal's next one).
	w.queue.frame({ type: "agent_end", isTerminal: true });
	await quiet();
	expect(w.types()).toEqual(["get_state"]);

	// Frozen, and compacting by itself, are not the time either.
	w.state.working = false;
	w.state.paused = true;
	w.queue.frame({ type: "agent_end", isTerminal: true });
	await quiet();
	expect(w.types()).toEqual(["get_state"]);
	w.state.paused = false;
	w.queue.frame({ type: "auto_compaction_start" });
	w.queue.frame({ type: "agent_end", isTerminal: true });
	await quiet();
	expect(w.types()).toEqual(["get_state"]);

	// omp's own compaction is over: now the compact goes.
	w.queue.frame({ type: "auto_compaction_end" });
	await until(() => w.ended.length === 1);
	expect(w.types()).toEqual(["get_state", "compact"]);
});

test("a compact omp refuses because it compacts by itself is sent again when that is over, and the messages still wait", async () => {
	const w = world();
	await w.queue.queue(undefined);
	await w.queue.intercept({ type: "prompt", message: "after" }, {});
	let refused = true;
	w.answers.set("compact", (command) =>
		refused
			? { type: "response", command: "compact", success: false, error: "Compaction already in progress" }
			: { type: "response", command: "compact", success: true, data: command },
	);
	w.state.working = false;
	w.queue.frame({ type: "agent_end", isTerminal: true });
	await until(() => w.types().includes("compact"));
	await until(() => w.queue.info?.phase === "queued");
	expect(w.types()).not.toContain("prompt");
	expect(w.ended).toEqual([]);

	refused = false;
	w.queue.frame({ type: "session_settled" });
	await until(() => w.ended.length === 1);
	expect(w.types()).toEqual(["get_state", "compact", "compact", "prompt"]);
});

test("a message sent while the compact runs goes after it, behind the ones held", async () => {
	const w = world({ followUps: [{ message: "older" }] });
	await w.queue.queue(undefined);
	const compacting = Promise.withResolvers<RpcResponse>();
	w.answers.set("compact", () => compacting.promise);
	w.state.working = false;
	w.queue.frame({ type: "agent_end", isTerminal: true });
	await until(() => w.queue.info?.phase === "running");

	// A plain prompt (the turn has ended, the page sends it as a new turn) is held, not given to omp ahead of the compact.
	await w.queue.intercept({ type: "prompt", message: "newer" }, {});
	expect(w.queue.info?.held).toEqual(["older", "newer"]);
	expect(w.types()).toEqual(["get_state", "remove_queued_message", "compact"]);

	compacting.resolve({ type: "response", command: "compact", success: true, data: {} });
	await until(() => w.ended.length === 1);
	expect(w.sent.slice(3).map((c) => c.message)).toEqual(["older", "newer"]);
});

test("cancel hands the held messages to omp as they were sent, in order, and sends no compact", async () => {
	const w = world({ followUps: [{ message: "one" }] });
	await w.queue.queue("note");
	await w.queue.intercept({ type: "prompt", message: "two", streamingBehavior: "followUp" }, {});
	await w.queue.cancel();
	expect(w.sent.slice(2)).toEqual([
		{ type: "prompt", message: "one", streamingBehavior: "followUp" },
		{ type: "prompt", message: "two", streamingBehavior: "followUp" },
	]);
	expect(w.queue.info).toBeUndefined();
	// The turn ends later: nothing is compacted.
	w.state.working = false;
	w.queue.frame({ type: "agent_end", isTerminal: true });
	await quiet();
	expect(w.types()).not.toContain("compact");
	// And a second cancel is no error.
	await w.queue.cancel();
});

test("a compact that has started cannot be cancelled", async () => {
	const w = world();
	await w.queue.queue(undefined);
	const compacting = Promise.withResolvers<RpcResponse>();
	w.answers.set("compact", () => compacting.promise);
	w.state.working = false;
	w.queue.frame({ type: "agent_end", isTerminal: true });
	await until(() => w.queue.info?.phase === "running");
	await expect(w.queue.cancel()).rejects.toThrow("already started");
	compacting.resolve({ type: "response", command: "compact", success: true, data: {} });
	await until(() => w.ended.length === 1);
});

test("Stop drops the request and gives the held messages back, and the turn that it ends compacts nothing", async () => {
	const w = world({ followUps: [{ message: "queued one", images: [PICTURE] }] });
	await w.queue.queue(undefined);
	await w.queue.intercept({ type: "prompt", message: "queued two" }, {});
	expect(await w.queue.withdraw()).toEqual([{ message: "queued one", images: [PICTURE] }, { message: "queued two" }]);
	expect(w.queue.info).toBeUndefined();
	w.state.working = false;
	w.queue.frame({ type: "agent_end", isTerminal: true });
	await quiet();
	expect(w.types()).toEqual(["get_state", "remove_queued_message"]);
	expect(w.ended).toEqual([]);
});

test("Stop while the follow-ups are being taken out of omp's queue still gives every one of them back", async () => {
	const w = world({ followUps: [{ message: "first" }, { message: "second" }] });
	const removing = Promise.withResolvers<void>();
	let removals = 0;
	w.answers.set("remove_queued_message", async () => {
		removals++;
		// The second removal waits: Stop is pressed while the first message is out of omp's queue and not yet held.
		if (removals === 2) await removing.promise;
		return { type: "response", command: "remove_queued_message", success: true, data: { removed: true, images: [] } };
	});
	const queued = w.queue.queue(undefined);
	await until(() => removals === 2);
	const withdrawn = w.queue.withdraw();
	expect(w.queue.info).toBeUndefined();
	removing.resolve();
	await queued;
	expect(await withdrawn).toEqual([{ message: "first" }, { message: "second" }]);
	w.state.working = false;
	w.queue.frame({ type: "agent_end", isTerminal: true });
	await quiet();
	expect(w.types()).not.toContain("compact");
	expect(w.ended).toEqual([]);
});

test("a held follow-up is removed, edited or sent ahead like omp's own; what is not held is omp's", async () => {
	const w = world({ followUps: [{ message: "held one", images: [PICTURE] }, { message: "held two" }] });
	await w.queue.queue(undefined);
	const sentBefore = w.sent.length;

	// Removed: answered here, with its pictures, as omp answers.
	const removed = await w.queue.intercept(
		{ type: "remove_queued_message", message: "held one", queue: "followUp" },
		{},
	);
	expect(removed?.data).toEqual({ removed: true, images: [PICTURE] });
	expect(w.queue.info?.held).toEqual(["held two"]);

	// Sent ahead: a steer, so omp takes it at the next step.
	const promoted = await w.queue.intercept({ type: "promote_queued_message", message: "held two" }, { user: true });
	expect(promoted?.success).toBe(true);
	expect(w.sent.at(-1)).toEqual({ type: "steer", message: "held two" });
	expect(w.queue.info?.held).toEqual([]);

	// Not held: omp's (a steering message, a message omp already took).
	expect(
		await w.queue.intercept({ type: "remove_queued_message", message: "held one", queue: "steering" }, {}),
	).toBeNull();
	expect(await w.queue.intercept({ type: "remove_queued_message", message: "gone", queue: "followUp" }, {})).toBeNull();
	expect(w.sent.length).toBe(sentBefore + 1);
});

test("what omp runs at once goes to omp: a slash command, a steer, anything that is no message", async () => {
	const w = world();
	await w.queue.queue(undefined);
	expect(await w.queue.intercept({ type: "prompt", message: "/todo import x" }, {})).toBeNull();
	expect(await w.queue.intercept({ type: "prompt", message: "  /status" }, {})).toBeNull();
	expect(await w.queue.intercept({ type: "prompt", message: "now", streamingBehavior: "steer" }, {})).toBeNull();
	expect(await w.queue.intercept({ type: "steer", message: "now" }, {})).toBeNull();
	expect(await w.queue.intercept({ type: "get_state" }, {})).toBeNull();
	expect(w.queue.info?.held).toEqual([]);
});

test("with nothing queued every command is omp's", async () => {
	const w = world();
	expect(w.queue.active).toBe(false);
	expect(await w.queue.intercept({ type: "prompt", message: "hello" }, {})).toBeNull();
});

test("a compact queued while no turn runs is sent at once", async () => {
	const w = world({ working: false });
	await w.queue.queue("now");
	await until(() => w.ended.length === 1);
	expect(w.types()).toEqual(["compact"]);
});

test("a second ask replaces the note and queues nothing new; one that runs is refused", async () => {
	const w = world();
	await w.queue.queue("first note");
	const at = w.queue.info?.at;
	await w.queue.queue("second note");
	expect(w.queue.info).toMatchObject({ at, instructions: "second note" });
	expect(w.types()).toEqual(["get_state"]);

	const compacting = Promise.withResolvers<RpcResponse>();
	w.answers.set("compact", () => compacting.promise);
	w.state.working = false;
	w.queue.frame({ type: "agent_end", isTerminal: true });
	await until(() => w.queue.info?.phase === "running");
	await expect(w.queue.queue("third")).rejects.toThrow("already running");
	compacting.resolve({ type: "response", command: "compact", success: true, data: {} });
	await until(() => w.ended.length === 1);
});

test("a compact omp could not do still releases what waited, and says why", async () => {
	const w = world({ followUps: [{ message: "waiting" }] });
	await w.queue.queue(undefined);
	w.answers.set("compact", () => ({
		type: "response",
		command: "compact",
		success: false,
		error: "Nothing to compact (session too small)",
	}));
	w.state.working = false;
	w.queue.frame({ type: "agent_end", isTerminal: true });
	await until(() => w.ended.length === 1);
	expect(w.ended).toEqual([{ ok: false, error: "Nothing to compact (session too small)" }]);
	expect(w.sent.at(-1)).toEqual({ type: "prompt", message: "waiting", streamingBehavior: "followUp" });
});

test("a message omp refuses is given back with the ones behind it, not lost", async () => {
	const w = world({ followUps: [{ message: "a" }, { message: "b" }, { message: "c" }] });
	await w.queue.queue(undefined);
	w.answers.set("prompt", (command) =>
		command.message === "b"
			? { type: "response", command: "prompt", success: false, error: "paused" }
			: { type: "response", command: "prompt", success: true, data: {} },
	);
	w.state.working = false;
	w.queue.frame({ type: "agent_end", isTerminal: true });
	await until(() => w.ended.length === 1);
	expect(w.ended).toEqual([{ ok: true, returned: ["b", "c"] }]);
	expect(w.queue.info).toBeUndefined();
});

test("a process that moves to another conversation drops what waited; a handoff keeps it", async () => {
	const w = world({ followUps: [{ message: "kept" }] });
	await w.queue.queue("note");
	w.queue.moved("handoff");
	expect(w.queue.info?.held).toEqual(["kept"]);
	const changes = w.state.changes;
	w.queue.moved("new_session");
	expect(w.queue.info).toBeUndefined();
	expect(w.state.changes).toBe(changes + 1);

	// What was running for the conversation it left releases nothing into the new one.
	const w2 = world({ followUps: [{ message: "stray" }] });
	await w2.queue.queue(undefined);
	const compacting = Promise.withResolvers<RpcResponse>();
	w2.answers.set("compact", () => compacting.promise);
	w2.state.working = false;
	w2.queue.frame({ type: "agent_end", isTerminal: true });
	await until(() => w2.queue.info?.phase === "running");
	w2.queue.moved("switch_session");
	compacting.resolve({ type: "response", command: "compact", success: true, data: {} });
	await quiet();
	expect(w2.types()).not.toContain("prompt");
	expect(w2.ended).toEqual([]);
});

test("a failure to read omp's queue queues nothing, and what was sent meanwhile reaches omp as it was sent", async () => {
	const w = world();
	const reading = Promise.withResolvers<RpcResponse>();
	w.answers.set("get_state", () => reading.promise);
	const queuing = w.queue.queue(undefined);
	await until(() => w.queue.active && w.sent.length === 1);
	await w.queue.intercept({ type: "prompt", message: "meanwhile", streamingBehavior: "followUp" }, {});
	reading.resolve({ type: "response", command: "get_state", success: false, error: "omp did not answer" });
	await expect(queuing).rejects.toThrow("omp did not answer");
	expect(w.queue.info).toBeUndefined();
	expect(w.sent.at(-1)).toEqual({ type: "prompt", message: "meanwhile", streamingBehavior: "followUp" });
});

test("the compact waits for the follow-ups to be taken out of omp's queue, even when the turn ends meanwhile", async () => {
	const w = world({ followUps: [{ message: "late" }] });
	const reading = Promise.withResolvers<RpcResponse>();
	w.answers.set("get_state", () => reading.promise);
	const queuing = w.queue.queue(undefined);
	await until(() => w.sent.length === 1);
	// The turn ends before omp has said what it holds.
	w.state.working = false;
	w.queue.frame({ type: "agent_end", isTerminal: true });
	await quiet();
	expect(w.types()).toEqual(["get_state"]);
	reading.resolve({
		type: "response",
		command: "get_state",
		success: true,
		data: { queuedMessages: { steering: [], followUp: ["late"] } },
	});
	await queuing;
	await until(() => w.ended.length === 1);
	expect(w.types()).toEqual(["get_state", "remove_queued_message", "compact", "prompt"]);
});

test("a kept conversation's record carries the waiting compact and its messages, and a restored one waits as it did", async () => {
	const w = world({ followUps: [{ message: "kept", images: [PICTURE] }] });
	await w.queue.queue("note");
	const record = w.queue.record;
	expect(record).toMatchObject({ instructions: "note", held: [{ message: "kept", images: [PICTURE] }] });

	const restored = world();
	restored.queue.restore(record);
	expect(restored.queue.info).toMatchObject({ phase: "queued", instructions: "note", held: ["kept"] });
	restored.state.working = false;
	restored.queue.frame({ type: "agent_end", isTerminal: true });
	await until(() => restored.ended.length === 1);
	expect(restored.types()).toEqual(["compact", "prompt"]);

	// One that already runs is not kept.
	const running = world();
	await running.queue.queue(undefined);
	running.answers.set("compact", () => Promise.withResolvers<RpcResponse>().promise);
	running.state.working = false;
	running.queue.frame({ type: "agent_end", isTerminal: true });
	await until(() => running.queue.info?.phase === "running");
	expect(running.queue.record).toBeUndefined();
});

const HOLD = "omp-webui: compact between two steps";
const hold = (id: string) => ({
	type: "extension_ui_request",
	id,
	method: "select",
	title: HOLD,
	options: ["Continue"],
});

test("between steps: the extension is told, the compact goes out at its boundary, and the messages wait for the turn that goes on", async () => {
	const w = world({ followUps: [{ message: "after" }] });
	await w.queue.queue("keep names", "step");
	expect(w.queue.info).toMatchObject({ phase: "queued", where: "step", held: ["after"] });
	expect(w.queue.info?.stepUnavailable).toBeUndefined();
	expect(w.armed).toEqual([w.queue.info?.at ?? null]);

	// The extension holds omp at a boundary: the compact is sent while the turn is still going.
	expect(w.queue.frame(hold("d1"))).toBe(true);
	await until(() => w.queue.info?.phase === "following");
	expect(w.types()).toEqual(["get_state", "remove_queued_message", "compact"]);
	expect(w.sent.at(-1)).toMatchObject({ customInstructions: "keep names" });
	// Nothing is held at the boundary any more, the compact is said to be over, and the pages are told what waits.
	expect(w.armed.at(-1)).toBeNull();
	expect(w.ended).toEqual([{ ok: true }]);
	expect(w.letGo).toEqual([]);

	// omp carries the turn on by itself (a new agent_start, no agent_end before it); the message goes after that turn's end.
	w.queue.frame({ type: "extension_ui_request", method: "cancel", targetId: "d1" });
	w.queue.frame({ type: "agent_start" });
	w.queue.frame({ type: "agent_end", isTerminal: false });
	await quiet();
	expect(w.types()).not.toContain("prompt");
	w.state.working = false;
	w.queue.frame({ type: "agent_end", isTerminal: true });
	await until(() => w.queue.info === undefined);
	expect(w.types()).toEqual(["get_state", "remove_queued_message", "compact", "prompt"]);
	expect(w.sent.at(-1)).toMatchObject({ message: "after", streamingBehavior: "followUp" });
});

test("between steps with nothing held behind it: the compact is the whole request", async () => {
	const w = world();
	await w.queue.queue(undefined, "step");
	w.queue.frame(hold("d1"));
	await until(() => w.ended.length === 1);
	expect(w.queue.info).toBeUndefined();
	expect(w.types()).toEqual(["get_state", "compact"]);
});

test("a process that cannot be held between steps compacts at the end of the turn, and says why", async () => {
	for (const why of ["trustedExtension", "notLoaded", "noContinue"] as const) {
		const w = world({ unavailable: why });
		await w.queue.queue(undefined, "step");
		expect(w.queue.info).toMatchObject({ phase: "queued", where: "turn", stepUnavailable: why });
		// Never told to hold, and a hold that comes anyway is let go and taken (no page is shown it).
		expect(w.armed.filter((a) => a !== null)).toEqual([]);
		expect(w.queue.frame(hold("d1"))).toBe(true);
		expect(w.letGo).toEqual(["d1"]);
		expect(w.types()).toEqual(["get_state"]);
		w.state.working = false;
		w.queue.frame({ type: "agent_end", isTerminal: true });
		await until(() => w.ended.length === 1);
		expect(w.types()).toEqual(["get_state", "compact"]);
	}
});

test("a hold with no compact waiting for it is let go at once, and the dialog is the queue's, not a page's", async () => {
	const w = world();
	expect(w.queue.frame(hold("idle"))).toBe(true);
	expect(w.letGo).toEqual(["idle"]);
	// A compact asked for the end of the turn does not take the hold either.
	await w.queue.queue(undefined, "turn");
	expect(w.queue.frame(hold("turn-queued"))).toBe(true);
	expect(w.letGo).toEqual(["idle", "turn-queued"]);
	expect(w.types()).toEqual(["get_state"]);
	// Another extension's dialog is none of its business.
	expect(w.queue.frame({ type: "extension_ui_request", id: "x", method: "select", title: "Pick one" })).toBe(false);
});

test("a step compact that is cancelled takes the file away and sends what was held", async () => {
	const w = world({ followUps: [{ message: "held" }] });
	await w.queue.queue(undefined, "step");
	expect(w.armed.at(-1)).toBe(w.queue.info?.at);
	await w.queue.cancel();
	expect(w.armed.at(-1)).toBeNull();
	expect(w.queue.info).toBeUndefined();
	expect(w.types()).toEqual(["get_state", "remove_queued_message", "prompt"]);
	// A hold that arrives after the cancel is let go.
	w.queue.frame(hold("late"));
	expect(w.letGo).toEqual(["late"]);
});

test("a turn that ends before it comes to a boundary is compacted at its end", async () => {
	const w = world({ followUps: [{ message: "m" }] });
	await w.queue.queue(undefined, "step");
	w.state.working = false;
	w.queue.frame({ type: "agent_end", isTerminal: true });
	await until(() => w.ended.length === 1);
	expect(w.types()).toEqual(["get_state", "remove_queued_message", "compact", "prompt"]);
	expect(w.armed.at(-1)).toBeNull();
	expect(w.queue.info).toBeUndefined();
});

test("a summary that fails at a boundary stops the turn: said so, omp asked, the messages given back to it", async () => {
	const w = world({ followUps: [{ message: "m" }] });
	w.answers.set("compact", () => ({
		type: "response",
		command: "compact",
		success: false,
		error: "summarizer refused",
	}));
	await w.queue.queue(undefined, "step");
	w.queue.frame(hold("d1"));
	await until(() => w.ended.length === 1);
	expect(w.ended[0]).toMatchObject({ ok: false, error: "summarizer refused", stopped: true });
	expect(w.refreshed()).toBe(1);
	expect(w.types().at(-1)).toBe("prompt");
	expect(w.queue.info).toBeUndefined();
});

test("omp that does not carry the turn on after a boundary compact: asked, and the held messages sent", async () => {
	const w = world({ followUps: [{ message: "m" }] });
	await w.queue.queue(undefined, "step");
	w.queue.frame(hold("d1"));
	await until(() => w.queue.info?.phase === "following");
	// No agent_start comes; the queue asks omp (the stub says it is idle) and sends.
	w.state.working = false;
	await until(() => w.queue.info === undefined);
	expect(w.refreshed()).toBe(1);
	expect(w.types()).toEqual(["get_state", "remove_queued_message", "compact", "prompt"]);
});

test("a compact that omp refuses as already in progress leaves the boundary to go on", async () => {
	const w = world();
	w.answers.set("compact", () => ({
		type: "response",
		command: "compact",
		success: false,
		error: "Compaction already in progress",
	}));
	await w.queue.queue(undefined, "step");
	w.queue.frame(hold("d1"));
	await until(() => w.letGo.length === 1);
	expect(w.letGo).toEqual(["d1"]);
	expect(w.queue.info).toMatchObject({ phase: "queued", where: "step" });
	expect(w.ended).toEqual([]);
});

test("a new compact asked while the messages wait for the turn that went on is queued before them", async () => {
	const w = world({ followUps: [{ message: "m" }] });
	await w.queue.queue(undefined, "step");
	w.queue.frame(hold("d1"));
	await until(() => w.queue.info?.phase === "following");
	await w.queue.queue("again", "step");
	expect(w.queue.info).toMatchObject({ phase: "queued", where: "step", instructions: "again", held: ["m"] });
	expect(w.armed.at(-1)).toBe(w.queue.info?.at);
});

test("a record keeps the place a compact waits for, and the messages that wait for the turn after one that was made", async () => {
	const w = world({ followUps: [{ message: "k" }] });
	await w.queue.queue("n", "step");
	expect(w.queue.record).toMatchObject({ instructions: "n", where: "step", held: [{ message: "k" }] });
	expect(w.queue.record?.following).toBeUndefined();
	w.queue.frame(hold("d1"));
	await until(() => w.queue.info?.phase === "following");
	expect(w.queue.record).toMatchObject({ following: true, held: [{ message: "k" }] });

	// A restored one tells its extension what it wants again (a file a former server left is not trusted).
	const restored = world();
	restored.queue.restore({ at: 7, where: "step", held: [] });
	restored.queue.rearm();
	expect(restored.armed).toEqual([7]);
	const following = world();
	following.queue.restore({ at: 7, where: "step", following: true, held: [{ message: "k" }] });
	following.queue.rearm();
	expect(following.armed).toEqual([null]);
	following.state.working = false;
	following.queue.frame({ type: "agent_end", isTerminal: true });
	await until(() => following.queue.info === undefined);
	expect(following.types()).toEqual(["prompt"]);
});
