import "./browser-globals.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SessionEntry, SessionFileData } from "../../shared/protocol.ts";
import { sameTurn } from "../../web/src/components/AgentTurn.tsx";
import { buildFamily, FamilyBuilder } from "../../web/src/lib/family.ts";
import { appended, extension, Fold } from "../../web/src/lib/lineage.ts";
import { isVisible, type ToolResults } from "../../web/src/lib/messages.ts";
import { type LiveNotice, withLiveNotices } from "../../web/src/lib/notices.ts";
import { providersUsed } from "../../web/src/lib/quota.ts";
import { promptsOf } from "../../web/src/lib/recall.ts";
import { savedGoal } from "../../web/src/lib/saved-goal.ts";
import { savedSettings } from "../../web/src/lib/session-settings.ts";
import { sumEntries, usageByModel } from "../../web/src/lib/totals.ts";
import { PathTracker, pathTo } from "../../web/src/lib/tree.ts";
import { activeMs, liveTurn, unsavedSteps } from "../../web/src/lib/turn-stats.ts";
import { type Segment, Segmenter, segmentTranscript } from "../../web/src/lib/turns.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * A goal run grows one conversation by a few entries a second for hours, and the page derives a dozen things from its
 * entries (the tree, the path, the totals, the transcript's segments…). Each of them used to be derived again from the
 * first entry at every change, so a step cost more the longer the run had gone on (102 → 145 ms over 2000 steps; #287).
 *
 * Two kinds of test: what is derived by going on from where it was is what is derived from the start (one run, checked
 * against the other at every step, with live notices that come and are answered); and the work a step costs does not
 * depend on the length of the history, counted as the entries it reads, not timed.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const FILE = "/x/live.jsonl";
const NO_FILES: SessionFileData[] = [];
const T0 = Date.UTC(2026, 0, 5, 10, 0, 0);
const iso = (n: number) => new Date(T0 + n * 1000).toISOString();

let counted = 0;
/** An entry whose every read is counted: what a pass over the history costs shows as how many it reads. */
function watched(e: SessionEntry): SessionEntry {
	return new Proxy(e, {
		get(target, key, receiver) {
			counted++;
			return Reflect.get(target, key, receiver);
		},
	});
}

/** Writes the entries of a goal run: a prompt, then steps of an assistant message with a tool call, its result, a mode change and a note. */
class Run {
	entries: SessionEntry[] = [];
	private n = 0;
	private last: string | null = null;
	private readonly watch: boolean;

	constructor(watch = false) {
		this.watch = watch;
	}

	add(type: string, body: Record<string, unknown>): SessionEntry {
		const id = `e${this.n}`;
		const e: SessionEntry = { type, id, parentId: this.last, timestamp: iso(this.n), ...body };
		this.n++;
		this.last = id;
		return this.watch ? watched(e) : e;
	}

	prompt(text: string): SessionEntry[] {
		return [
			this.add("message", {
				message: {
					role: "user",
					content: [{ type: "text", text }],
					attribution: "user",
					timestamp: T0 + this.n * 1000,
				},
			}),
		];
	}

	/** One step: the assistant's message (it calls tool `call`), the tool's result, a mode change and a note. */
	step(call: string, provider = "anthropic"): SessionEntry[] {
		const started = T0 + this.n * 1000;
		const assistant = this.add("message", {
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: `step ${call}` },
					{ type: "toolCall", id: call, name: "bash", arguments: {} },
				],
				provider,
				model: "m",
				usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { total: 0.01 } },
				timestamp: started,
				duration: 500,
			},
		});
		const result = this.add("message", {
			message: { role: "toolResult", toolCallId: call, toolName: "bash", content: [{ type: "text", text: "ok" }] },
		});
		const mode = this.add("mode_change", {
			mode: "goal",
			data: { goal: { id: "g", objective: "o", status: "active", tokensUsed: this.n } },
		});
		const note = this.add("custom", { customType: "tool_execution_start", data: { toolCallId: call } });
		return [assistant, result, mode, note];
	}

	/** Entries as one pull brings them: the page's `entries` is the one before them with these added. */
	push(added: SessionEntry[]): SessionEntry[] {
		this.entries = appended(this.entries, added);
		return this.entries;
	}
}

const ruleText = (name: string) =>
	`<system-reminder reason="rule_violation" rule="${name}" path="x.md">\nUser-defined rule matched. MUST comply.\n\nDo it.\n</system-reminder>`;

/** The notices a run can have: what a command printed, a rule that fired, a fallback, an IRC message. */
const notice = {
	command: (seq: number, after: string | null): LiveNotice => ({
		kind: "command",
		seq,
		at: seq,
		after,
		file: FILE,
		text: `out ${seq}`,
	}),
	rules: (seq: number, after: string | null, name: string): LiveNotice => ({
		kind: "rules",
		seq,
		at: seq,
		after,
		sig: `s${seq}`,
		rules: [{ name, text: "Do it." }],
	}),
	fallback: (seq: number, after: string | null, to: string): LiveNotice => ({
		kind: "fallback",
		seq,
		at: seq,
		after,
		from: "a/b",
		to,
	}),
	irc: (seq: number, after: string | null, id: string): LiveNotice => ({
		kind: "irc",
		seq,
		at: seq,
		after,
		message: { role: "custom", customType: "irc:incoming", details: { id }, content: "hi", timestamp: seq },
	}),
};

/** Everything the page derives from a conversation's entries, going on from where it was. */
class Page {
	readonly builder = new FamilyBuilder();
	readonly tracker = new PathTracker();
	readonly segmenter = new Segmenter();

	update(entries: SessionEntry[], notices: LiveNotice[] = []) {
		const fam = this.builder.update(NO_FILES, FILE, entries);
		const leaf = fam.headOf.get(FILE) ?? null;
		const path = this.tracker.path(fam.idx, leaf);
		const segments = this.segmenter.update(path, fam.idx, notices, []);
		const tally = liveTurn(entries, leaf).tally;
		return {
			fam,
			path,
			segments,
			usage: sumEntries(entries),
			worked: activeMs(entries),
			byModel: usageByModel(entries),
			goal: savedGoal(path),
			settings: savedSettings(path),
			prompts: promptsOf(path),
			providers: providersUsed(path, "anthropic"),
			figures: tally.figures(unsavedSteps(tally.started, [])),
		};
	}
}

/** The same, from the start, for a copy of the entries nobody appended to. */
function fromStart(entries: SessionEntry[], notices: LiveNotice[]) {
	const copy = [...entries];
	const fam = buildFamily([], FILE, copy);
	const leaf = fam.headOf.get(FILE) ?? null;
	const path = pathTo(fam.idx, leaf);
	const rows = withLiveNotices(path, notices, []).filter(isVisible);
	const tally = liveTurn([...entries], leaf).tally;
	return {
		fam,
		path,
		segments: segmentTranscript(rows, fam.idx),
		usage: sumEntries([...entries]),
		worked: activeMs([...entries]),
		byModel: usageByModel([...entries]),
		goal: savedGoal([...path]),
		settings: savedSettings([...path]),
		prompts: promptsOf([...path]),
		providers: providersUsed([...path], "anthropic"),
		figures: tally.figures(unsavedSteps(tally.started, [])),
	};
}

/** A segment as it reads: what the page draws from it. */
function shape(s: Segment) {
	return s.kind === "prompt"
		? ["prompt", s.entry.id]
		: [
				"turn",
				s.turn.rows.map((e) => e.id),
				s.turn.entries.map((e) => e.id),
				s.turn.siblings?.list.map((e) => e.id) ?? null,
				[...s.turn.toolIds].sort(),
			];
}

function sameResults(a: ToolResults, b: ToolResults, calls: string[]) {
	for (const id of [...calls, "none"]) expect(a.get(id)).toBe(b.get(id));
}

/** Checks the page's derivations against the ones from the start. */
function check(page: ReturnType<Page["update"]>, scratch: ReturnType<typeof fromStart>, calls: string[]) {
	expect([...page.fam.idx.byId.keys()]).toEqual([...scratch.fam.idx.byId.keys()]);
	expect([...page.fam.idx.order]).toEqual([...scratch.fam.idx.order]);
	expect([...page.fam.idx.children].map(([k, v]) => [k, v.map((e) => e.id)])).toEqual(
		[...scratch.fam.idx.children].map(([k, v]) => [k, v.map((e) => e.id)]),
	);
	expect([...page.fam.filesOf]).toEqual([...scratch.fam.filesOf]);
	expect([...page.fam.headOf]).toEqual([...scratch.fam.headOf]);
	sameResults(page.fam.toolResults, scratch.fam.toolResults, calls);
	expect(page.path.map((e) => e.id)).toEqual(scratch.path.map((e) => e.id));
	expect(page.segments.map(shape)).toEqual(scratch.segments.map(shape));
	expect(page.usage).toEqual(scratch.usage);
	expect(page.worked).toBe(scratch.worked);
	expect(page.byModel).toEqual(scratch.byModel);
	expect(page.goal).toEqual(scratch.goal);
	expect(page.settings).toEqual(scratch.settings);
	expect(page.prompts).toEqual(scratch.prompts);
	expect(page.providers).toEqual(scratch.providers);
	expect(page.figures).toEqual(scratch.figures);
}

describe("what is derived by going on is what is derived from the start", () => {
	test("a goal run, step by step, pull by pull", () => {
		const run = new Run();
		const page = new Page();
		const calls: string[] = [];
		check(page.update(run.push(run.prompt("go"))), fromStart(run.entries, []), calls);
		for (let i = 0; i < 25; i++) {
			calls.push(`c${i}`);
			const step = run.step(`c${i}`, i < 10 ? "anthropic" : "openai");
			// One pull brings the step in pieces of different sizes, as the refreshes of a step do.
			for (const piece of i % 2 ? [step.slice(0, 1), step.slice(1)] : [step.slice(0, 3), step.slice(3)]) {
				check(page.update(run.push(piece)), fromStart(run.entries, []), calls);
			}
			if (i === 12) check(page.update(run.push(run.prompt("and now this"))), fromStart(run.entries, []), calls);
		}
	});

	test("live notices that come, stay and are answered by what is saved", () => {
		const run = new Run();
		const page = new Page();
		const calls: string[] = [];
		let notices: LiveNotice[] = [];
		const go = () => check(page.update(run.entries, notices), fromStart(run.entries, notices), calls);
		run.push(run.prompt("go"));
		go();
		for (let i = 0; i < 24; i++) {
			calls.push(`c${i}`);
			const step = run.step(`c${i}`);
			run.push(step);
			go();
			const tail = step[step.length - 1].id;
			// What came while it ran, each right after the last saved entry.
			if (i === 2) notices = [...notices, notice.command(1, tail)];
			if (i === 4) notices = [...notices, notice.rules(2, tail, "no-eval")];
			if (i === 6) notices = [...notices, notice.fallback(3, tail, "openai/gpt")];
			if (i === 8) notices = [...notices, notice.irc(4, tail, "irc-1")];
			go();
			// The saved records that answer them arrive a few steps later: the rule's reminder, the model switch, the message.
			if (i === 10) {
				run.push([
					run.add("message", {
						message: {
							role: "developer",
							content: [{ type: "text", text: ruleText("no-eval") }],
							attribution: "agent",
						},
					}),
				]);
				go();
			}
			if (i === 12) {
				run.push([run.add("model_change", { model: "openai/gpt-5", resolvedModelIsFallback: true })]);
				go();
			}
			if (i === 14) {
				run.push([
					run.add("custom_message", {
						customType: "irc:incoming",
						details: { id: "irc-1" },
						content: "hi",
						display: true,
					}),
				]);
				go();
			}
			// A notice dropped for a newer one (the page keeps the last few), another with no entry yet to follow.
			if (i === 16) notices = notices.slice(1);
			if (i === 18) notices = [...notices, notice.command(5, null)];
			go();
		}
	});

	test("a rewritten conversation, a longer one that is not an extension and a leaf that moves back are built from the start", () => {
		const run = new Run();
		const page = new Page();
		run.push([...run.prompt("go"), ...run.step("c0"), ...run.step("c1")]);
		check(page.update(run.entries), fromStart(run.entries, []), ["c0", "c1"]);
		// An entry rewritten (omp marks a failed message recovered): a new array of which some entries are new objects.
		const rewritten = run.entries.map((e, i) => (i === 2 ? { ...e } : e));
		check(page.update(rewritten), fromStart(rewritten, []), ["c0", "c1"]);
		// Growing from the rewritten one goes on from it.
		const more = appended(rewritten, run.step("c2"));
		check(page.update(more), fromStart(more, []), ["c0", "c1", "c2"]);
		// An older array asked about again (a render that is behind) is answered, not mixed with the newer.
		check(page.update(run.entries), fromStart(run.entries, []), ["c0", "c1"]);
	});

	test("an entry that is not the newest or that forks the tree is not added to the tree: it is built again", () => {
		const run = new Run();
		const page = new Page();
		run.push([...run.prompt("go"), ...run.step("c0")]);
		page.update(run.entries);
		// Another version of the first reply: same parent as an entry there is, and older than the newest.
		const sibling: SessionEntry = {
			type: "message",
			id: "other",
			parentId: run.entries[0].id,
			timestamp: iso(0.5),
			message: { role: "assistant", content: [{ type: "text", text: "another" }] },
		};
		const forked = appended(run.entries, [sibling]);
		const fam = new FamilyBuilder();
		fam.update(NO_FILES, FILE, run.entries);
		const built = fam.update(NO_FILES, FILE, forked);
		// The newer entry sorts after the older one only if it is newer: this one is not, so it comes first.
		expect(built.idx.children.get(run.entries[0].id)?.map((e) => e.id)).toEqual(["other", run.entries[1].id]);
		expect([...built.idx.order]).toEqual([...buildFamily([], FILE, [...forked]).idx.order]);
	});
});

describe("lineages", () => {
	test("an array made by appending begins with the one before it; any other array is not known to", () => {
		const a = [1, 2];
		const b = appended(a, [3]);
		const c = appended(b, [4, 5]);
		expect(extension(a, b)).toBe(2);
		expect(extension(a, c)).toBe(2);
		expect(extension(b, c)).toBe(3);
		expect(extension(c, b)).toBeNull();
		expect(extension(a, [1, 2, 3])).toBeNull();
		expect(extension(undefined, a)).toBeNull();
		expect(extension(c, c)).toBe(5);
		expect(appended(a, [])).toBe(a);
	});

	test("appending to an array that already has a successor is another chain, not a fork of the first", () => {
		const a = [1];
		const b = appended(a, [2]);
		const other = appended(a, [9]);
		expect(extension(a, b)).toBe(1);
		expect(extension(a, other)).toBeNull();
		expect(extension(b, other)).toBeNull();
	});

	test("a fold reads each item once as the array grows, and an older array is answered from the start", () => {
		let read = 0;
		const sum = new Fold<number, number>(
			() => 0,
			(total, items, from) => {
				let t = total;
				for (let i = from; i < items.length; i++) {
					read++;
					t += items[i];
				}
				return t;
			},
		);
		let items = appended([1, 2, 3], [4]);
		expect(sum.run(items)).toBe(10);
		const older = items;
		for (let i = 0; i < 50; i++) items = appended(items, [1]);
		expect(sum.run(items)).toBe(60);
		expect(sum.run(items)).toBe(60);
		expect(read).toBe(4 + 50);
		expect(sum.run(older)).toBe(10);
	});
});

/** Reads of entries a pass costs, for one step of a run that has `steps` behind it, with live notices or without. */
function readsOfOneStep(steps: number, withNotices: boolean): number {
	const run = new Run(true);
	const page = new Page();
	run.push(run.prompt("go"));
	// A prompt every 100 steps, as a long conversation has.
	for (let i = 0; i < steps; i++) {
		if (i % 100 === 99) run.push(run.prompt(`q${i}`));
		run.push(run.step(`c${i}`));
	}
	let notices: LiveNotice[] = [];
	if (withNotices) {
		const at = run.entries[Math.floor(run.entries.length / 2)].id;
		const recent = run.entries[run.entries.length - 1].id;
		notices = [notice.command(1, at), notice.rules(2, recent, "no-eval"), notice.irc(3, recent, "i1")];
	}
	page.update(run.entries, notices);
	// The step whose cost is measured: its entries arrive in two pulls, as a step's refreshes do.
	const step = run.step("measured");
	counted = 0;
	page.update(run.push(step.slice(0, 2)), notices);
	page.update(run.push(step.slice(2)), notices);
	return counted;
}

describe("what a step costs does not grow with the history", () => {
	test("entries read for a step are the same after 100 steps and after 2000", () => {
		const short = readsOfOneStep(100, false);
		const long = readsOfOneStep(2000, false);
		expect(short).toBeGreaterThan(0);
		// Reads the new entries only: the long run (8000 entries) reads what the short one (400) does.
		expect(long).toBeLessThanOrEqual(short + 10);
		expect(long).toBeLessThan(400);
	});

	test("the same with live notices on screen, which must be looked at again as the path grows", () => {
		const short = readsOfOneStep(100, true);
		const long = readsOfOneStep(2000, true);
		expect(long).toBeLessThanOrEqual(short + 10);
		expect(long).toBeLessThan(400);
	});

	test("a tool moving costs the turns on screen what a few tools cost, not a look at every call of every turn", () => {
		const run = new Run(true);
		const page = new Page();
		run.push(run.prompt("go"));
		for (let i = 0; i < 1500; i++) run.push(run.step(`c${i}`));
		const before = page.update(run.entries);
		const step = run.step("next");
		const after = page.update(run.push(step));
		const turn = (p: ReturnType<Page["update"]>) => {
			const last = p.segments.at(-1);
			if (last?.kind !== "turn") throw new Error("no turn");
			return last.turn;
		};
		const props = (p: ReturnType<Page["update"]>) => ({
			turn: turn(p),
			actions: {},
			live: true,
			tools: {},
			toolResults: p.fam.toolResults,
		});
		counted = 0;
		// The turn changed: it is drawn again, whatever the tools did.
		expect(sameTurn(props(before), props(after))).toBe(false);
		// Between two renders of the same turn a result of another turn's call is saved: not this turn's business.
		const same = props(after);
		const elsewhere = { ...same, toolResults: page.update(run.push(run.prompt("again"))).fam.toolResults };
		counted = 0;
		expect(
			sameTurn(same, {
				...same,
				tools: { stranger: { toolCallId: "stranger", toolName: "x", args: {}, done: false, startedAt: 0 } },
			}),
		).toBe(true);
		expect(sameTurn(same, { ...elsewhere, turn: same.turn })).toBe(true);
		// Its own call has a live record now.
		expect(
			sameTurn(same, {
				...same,
				tools: { next: { toolCallId: "next", toolName: "bash", args: {}, done: false, startedAt: 0 } },
			}),
		).toBe(false);
		// None of that read an entry.
		expect(counted).toBe(0);
	});
});
