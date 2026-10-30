import { describe, expect, test } from "bun:test";
import type {
	FamilyDocument,
	FamilyStats,
	FamilyView,
	PathAbove,
	SessionEntry,
	SessionFileData,
	VersionGroup,
} from "../../shared/protocol.ts";
import { type Answer, answerOf, entriesAfter } from "../../web/src/lib/answer.ts";
import { buildFamily, destinationFor, FamilyBuilder } from "../../web/src/lib/family.ts";
import {
	Carried,
	figuresOf,
	type Held,
	heldFrom,
	joinPrompts,
	leadsOf,
	membersOf,
	needsStats,
	refreshed,
	STATS_MISSES_MAX,
	STATS_RETRY_CAP_MS,
	statsDelay,
	trimmedLater,
	versionEntries,
	wantsStats,
	withEarlier,
	withLater,
	withStats,
} from "../../web/src/lib/history.ts";
import { appended, extension } from "../../web/src/lib/lineage.ts";
import { providersUsed } from "../../web/src/lib/quota.ts";
import { savedGoal } from "../../web/src/lib/saved-goal.ts";
import { sumEntries, usageByModel } from "../../web/src/lib/totals.ts";
import { activeMs } from "../../web/src/lib/turn-stats.ts";

/**
 * What the page holds of a conversation's history: a stretch of one path, grown at its ends as the reader goes there, and
 * what the tree, the totals and the derived state make of it.
 */

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const stamp = (n: number) => new Date(T0 + n * 1000).toISOString();
const entry = (id: string, parentId: string | null, n: number, extra: Record<string, unknown> = {}): SessionEntry =>
	({ type: "message", id, parentId, timestamp: stamp(n), message: { role: "user" }, ...extra }) as SessionEntry;
/** A chain `e<from>`…`e<to>`, each the child of the one before (the first is the child of `e<from-1>` unless `from` is 0). */
const chain = (from: number, to: number): SessionEntry[] =>
	Array.from({ length: to - from + 1 }, (_, i) =>
		entry(`e${from + i}`, from + i === 0 ? null : `e${from + i - 1}`, from + i),
	);
const ids = (entries: readonly SessionEntry[]) => entries.map((e) => e.id);

const NO_ABOVE: PathAbove = { carry: [], prompts: [] };
const view = (over: Partial<FamilyView> = {}): FamilyView => ({
	kind: "tail",
	leaf: "e9",
	head: "e9",
	earlier: false,
	later: false,
	versions: [],
	above: NO_ABOVE,
	...over,
});
const member = (file: string, entries: SessionEntry[] = [], extra: Partial<SessionFileData> = {}): SessionFileData => ({
	file,
	header: null,
	entries,
	subagents: [],
	advisors: [],
	...extra,
});
const answer = (entries: SessionEntry[], over: Partial<FamilyView> = {}, others: SessionFileData[] = []): Answer => ({
	file: "/f/main.jsonl",
	members: [member("/f/main.jsonl", entries, { total: entries.length }), ...others],
	view: view(over),
});

describe("a window the server answered", () => {
	test("is the answer to a request with `view`: the lineage whole is an error", () => {
		const whole: FamilyDocument = { file: "/f/main.jsonl", members: [member("/f/main.jsonl")] };
		expect(() => answerOf(whole)).toThrow("window of the history");
		const kept: FamilyDocument = {
			file: "/f/main.jsonl",
			members: [{ file: "/f/main.jsonl", tag: "t", kept: true }],
			view: view(),
		};
		expect(() => answerOf(kept)).toThrow("window of the history");
		const window = answerOf({ file: "/f/main.jsonl", members: [member("/f/main.jsonl")], view: view() });
		expect(window.view.kind).toBe("tail");
	});

	test("is held as the stretch of the file it names; the other files stay by name", () => {
		const held = heldFrom(
			answer(chain(5, 9), { earlier: true }, [member("/f/fork.jsonl", [], { head: "x1", total: 12 })]),
			null,
		);
		expect(ids(held.entries)).toEqual(["e5", "e6", "e7", "e8", "e9"]);
		expect([held.leaf, held.head, held.earlier, held.later]).toEqual(["e9", "e9", true, false]);
		// The family the tree is built from: the file shown has the stretch, the others are as they were sent.
		const files = membersOf(held);
		expect(ids(files[0]?.entries ?? [])).toEqual(["e5", "e6", "e7", "e8", "e9"]);
		expect(files[1]).toMatchObject({ file: "/f/fork.jsonl", head: "x1", total: 12, entries: [] });
	});
});

describe("the stretch grows at its ends", () => {
	const held = (over: Partial<FamilyView> = {}): Held =>
		heldFrom(answer(chain(5, 9), { earlier: true, ...over }), null);

	test("an older page is put above it, and what the path leaves above is the page's", () => {
		const above: PathAbove = { carry: [entry("m1", null, 1, { type: "mode_change" })], prompts: ["hello"] };
		const page = answer(chain(2, 4), { kind: "before", earlier: true, above });
		const next = withEarlier(held(), page);
		expect(ids(next?.entries ?? [])).toEqual(["e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9"]);
		expect(next?.earlier).toBe(true);
		expect(next?.above).toBe(above);
		// The start of the conversation: nothing more above.
		const start = withEarlier(held(), answer(chain(0, 4), { kind: "before", earlier: false }));
		expect(start?.earlier).toBe(false);
	});

	test("a page that does not join the stretch (the file was rewritten meanwhile) is none", () => {
		expect(withEarlier(held(), answer(chain(2, 3), { kind: "before" }))).toBeNull();
		expect(withLater(held(), answer(chain(11, 12), { kind: "after" }))).toBeNull();
	});

	test("a later page is put below it, and the stretch reaches the leaf when the page does", () => {
		const around = heldFrom(answer(chain(3, 6), { kind: "around", leaf: "e9", later: true, earlier: true }), null);
		expect(around.later).toBe(true);
		const next = withLater(around, answer(chain(7, 9), { kind: "after", later: false }));
		expect(ids(next?.entries ?? [])).toEqual(["e3", "e4", "e5", "e6", "e7", "e8", "e9"]);
		expect([next?.later, next?.earlier]).toEqual([false, true]);
	});

	test("the other versions of the entries are merged by the parent they share", () => {
		const group = (parent: string | null, entries: SessionEntry[], leads: VersionGroup["leads"]): VersionGroup => ({
			parent,
			entries,
			leads,
		});
		const a = heldFrom(
			answer(chain(5, 9), {
				versions: [group("e4", [entry("x1", "e4", 20)], { e5: { leaf: "e9", files: ["/f/main.jsonl"] } })],
			}),
			null,
		);
		const page = answer(chain(2, 4), {
			kind: "before",
			versions: [
				group("e4", [entry("x1", "e4", 20), entry("x2", "e4", 21)], { x2: { leaf: "x2", files: ["/f/fork.jsonl"] } }),
				group("e1", [entry("y1", "e1", 22)], { y1: { leaf: "y1", files: ["/f/main.jsonl"] } }),
			],
		});
		const next = withEarlier(a, page) as Held;
		expect(next.versions.map((g) => g.parent).sort()).toEqual(["e1", "e4"]);
		// An entry is in the tree once, however many answers named it.
		expect(ids(versionEntries(next)).sort()).toEqual(["x1", "x2", "y1"]);
		expect([...leadsOf(next).keys()].sort()).toEqual(["e5", "x2", "y1"]);
	});
});

describe("the end asked for again", () => {
	const held = (): Held =>
		withEarlier(
			heldFrom(answer(chain(5, 9), { earlier: true }), null),
			answer(chain(2, 4), { kind: "before", earlier: true }),
		) as Held;

	test("goes where it joins the stretch, so an older page the reader loaded stays", () => {
		const fresh = answer([...chain(7, 9), entry("e10", "e9", 10), entry("e11", "e10", 11)], {
			leaf: "e11",
			head: "e11",
		});
		const next = refreshed(held(), fresh);
		expect(ids(next.entries)).toEqual(["e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11"]);
		expect([next.earlier, next.leaf, next.head]).toEqual([true, "e11", "e11"]);
		// What the server says of the end of the conversation is what the page holds of it.
		expect(next.stats).toBeNull();
	});

	test("keeps the figures of the file as it was until those of the file as it is arrive: the cost does not go back to the stretch's", () => {
		const old = { through: "e9", usage: { cost: 1 } } as unknown as FamilyStats;
		const total =
			(n: number) =>
			(a: Answer): Answer => ({
				...a,
				members: a.members.map((m) => ({ ...m, total: n })),
			});
		const before = { ...withStats(held(), old), total: 10 };
		const fresh = total(12)(
			answer([...chain(7, 9), entry("e10", "e9", 10), entry("e11", "e10", 11)], { leaf: "e11", head: "e11" }),
		);
		const next = refreshed(before, fresh);
		// They are the old ones, which the stretch goes on from (`entriesAfter` finds `e9` among its entries) ...
		expect(next.stats).toBe(old);
		expect(figuresOf(next, next.entries)).toBe(old);
		// ... and they are asked for again, because the file's last entry is not where they end.
		expect([wantsStats(next), next.total]).toEqual([true, 12]);
		expect(wantsStats(withStats(next, { ...old, through: "e11" } as FamilyStats))).toBe(false);
		// Where the page was replaced by another stretch the old figures end at an entry it does not hold: none are kept.
		const moved = refreshed(before, answer(chain(40, 45), { leaf: "e45", head: "e45", earlier: true }));
		expect(moved.stats).toBeNull();
	});

	test("takes the place of everything held when it does not join it (the file moved on by more than a window)", () => {
		const fresh = answer(chain(40, 45), { leaf: "e45", head: "e45", earlier: true });
		const next = refreshed(held(), fresh);
		expect(ids(next.entries)).toEqual(["e40", "e41", "e42", "e43", "e44", "e45"]);
		expect(next.earlier).toBe(true);
	});

	test("replaces an entry that was rewritten in place, as the new object", () => {
		const rewritten = entry("e8", "e7", 8, { rewritten: true });
		const fresh = answer([...chain(7, 7), rewritten, entry("e9", "e8", 9)]);
		const next = refreshed(held(), fresh);
		expect(next.entries.find((e) => e.id === "e8")).toBe(rewritten);
	});

	test("a stretch that stops short of the end stays where it is when the file grows: the end is not put in its place", () => {
		const around = heldFrom(answer(chain(3, 5), { kind: "around", later: true, earlier: true, leaf: "e9" }), null);
		const grown = answer([...chain(7, 9), entry("e10", "e9", 10)], { leaf: "e10", head: "e10" });
		grown.members[0] = { ...(grown.members[0] as SessionFileData), total: 11 };
		const old = { through: "e9", cost: 1 } as unknown as FamilyStats;
		const next = refreshed({ ...around, stats: old }, grown);
		expect(ids(next.entries)).toEqual(["e3", "e4", "e5"]);
		expect([next.earlier, next.later]).toEqual([true, true]);
		// What describes the file is the file's now; the figures that add it up are those of the file as it was until they come again.
		expect([next.head, next.total, next.stats]).toEqual(["e10", 11, old]);
		expect(wantsStats(next)).toBe(true);
		// Asked for the file's last entry, the path leads to the new last entry: the pages below go there.
		expect(next.leaf).toBe("e10");
	});

	test("a stretch of a branch asked for by its leaf keeps leading to that leaf when the file grows", () => {
		const branch = heldFrom(answer(chain(3, 5), { kind: "around", later: true, leaf: "e9", head: "e12" }), "e9");
		const next = refreshed(branch, answer(chain(10, 13), { leaf: "e9", head: "e13" }));
		expect([next.leaf, next.asked, next.head]).toEqual(["e9", "e9", "e13"]);
		expect(ids(next.entries)).toEqual(["e3", "e4", "e5"]);
	});
});

describe("what the whole path leaves, for a stretch that stops short of its leaf", () => {
	const carry = (id: string): PathAbove["carry"] => [entry(id, null, 1, { type: "model_change", model: "p/m" })];
	const asAnswer = (entries: SessionEntry[], over: Partial<FamilyView>): Answer => answer(entries, over);

	test("is what the server said of it with the first stretch, whichever ends of it are let go or put back", () => {
		const around = heldFrom(
			asAnswer(chain(3, 5), { kind: "around", later: true, earlier: true, leaf: "e9", end: { carry: carry("mc") } }),
			null,
		);
		expect(ids(around.end?.carry ?? [])).toEqual(["mc"]);
		const joined = withEarlier(around, answer(chain(1, 2), { kind: "before", earlier: true })) as Held;
		expect(joined.end).toBe(around.end);
		expect(withLater(joined, answer(chain(6, 9), { kind: "after", later: false }))?.end).toBe(around.end);
		// A server that does not say leaves none: the page shows what the stretch has.
		expect(heldFrom(answer(chain(3, 5), { kind: "around", later: true }), null).end).toBeNull();
	});

	test("goes where the path goes when the file grows: the file's last entry is a new one, and a leaf asked for stays", () => {
		const around = heldFrom(
			asAnswer(chain(3, 5), { kind: "around", later: true, leaf: "e9", end: { carry: carry("old") } }),
			null,
		);
		const grown = asAnswer([...chain(7, 9), entry("e10", "e9", 10)], {
			leaf: "e10",
			head: "e10",
			end: { carry: carry("new") },
		});
		expect(ids(refreshed(around, grown).end?.carry ?? [])).toEqual(["new"]);
		const branch = heldFrom(
			asAnswer(chain(3, 5), { kind: "around", later: true, leaf: "e9", end: { carry: carry("branch") } }),
			"e9",
		);
		expect(ids(refreshed(branch, grown).end?.carry ?? [])).toEqual(["branch"]);
	});
});

describe("what the file's last entry leaves, for a branch that is not the newest", () => {
	const carry = (id: string): PathAbove["carry"] => [entry(id, null, 1, { type: "model_change", model: "p/m" })];

	test("is what the server said with the first stretch, and is the server's of the file as it is when the file grows", () => {
		const branch = heldFrom(
			answer(chain(3, 5), {
				kind: "around",
				later: true,
				leaf: "e9",
				head: "e12",
				end: { carry: carry("own") },
				headEnd: { carry: carry("newest") },
			}),
			"e9",
		);
		expect(ids(branch.headEnd?.carry ?? [])).toEqual(["newest"]);
		const grown = answer(chain(10, 13), { leaf: "e9", head: "e13", headEnd: { carry: carry("newer") } });
		expect(ids(refreshed(branch, grown).headEnd?.carry ?? [])).toEqual(["newer"]);
		// The file's last entry is the leaf of the path asked for: there is nothing else to say.
		expect(heldFrom(answer(chain(3, 5), { leaf: "e9", head: "e9" }), null).headEnd).toBeNull();
	});
});

describe("the end furthest from the reader", () => {
	/** Prompts at every entry (`entry`'s message is a user's), so any entry begins a turn; `reply` is one that does not. */
	const reply = (id: string, parentId: string, n: number): SessionEntry =>
		({
			type: "message",
			id,
			parentId,
			timestamp: stamp(n),
			message: { role: "assistant", content: [] },
		}) as SessionEntry;
	const turns = (count: number): SessionEntry[] =>
		Array.from({ length: count * 2 }, (_, i) =>
			i % 2 === 0
				? entry(`p${i / 2}`, i === 0 ? null : `r${(i - 2) / 2}`, i)
				: reply(`r${(i - 1) / 2}`, `p${(i - 1) / 2}`, i),
		);

	test("is let go beyond the cap, where a turn begins, and the path is marked as going on below", () => {
		const held = heldFrom(answer(turns(10), { earlier: true }), null);
		const next = trimmedLater(held, 7);
		// Seven entries fit; the eighth (r3) is not a turn's start, so the turn it is in is kept, and the cut falls before the prompt p4.
		expect(ids(next.entries)).toEqual(["p0", "r0", "p1", "r1", "p2", "r2", "p3", "r3"]);
		expect([next.later, next.earlier, next.leaf, next.head]).toEqual([true, true, "e9", "e9"]);
		// Nothing else about the file changes: the pages below come as any later page does, from the last entry kept.
		expect(next.total).toBe(held.total);
	});

	test("holds a stretch within the cap as it is, and a turn longer than the cap whole", () => {
		const held = heldFrom(answer(turns(4)), null);
		expect(trimmedLater(held, 8)).toBe(held);
		const long = heldFrom(
			answer([
				entry("p0", null, 0),
				reply("r1", "p0", 1),
				reply("r2", "r1", 2),
				reply("r3", "r2", 3),
				reply("r4", "r3", 4),
			]),
			null,
		);
		expect(trimmedLater(long, 3)).toBe(long);
	});

	test("keeps whole the long turn that goes beyond the cap, wherever in the stretch it is, and what follows it", () => {
		/** The entries as one path: each is the child of the one before. */
		const linked = (list: SessionEntry[]): SessionEntry[] =>
			list.map((e, i) => ({ ...e, parentId: i === 0 ? null : (list[i - 1] as SessionEntry).id }));
		const long = [entry("gp", null, 20), ...Array.from({ length: 10 }, (_, k) => reply(`gr${k}`, "", 21 + k))];
		const later = Array.from({ length: 4 }, (_, i) => [
			entry(`q${i}`, null, 50 + 2 * i),
			reply(`s${i}`, "", 51 + 2 * i),
		]);
		// Four turns (a page that just joined above), then a turn of ten replies, then four turns more.
		const path = linked([...turns(4), ...long, ...later.flat()]);
		const held = heldFrom(answer(path, { earlier: true }), null);
		// The cap falls in the middle of the long turn, which is the reader's: it is kept to its last reply, and the cut is where
		// the next turn begins.
		const next = trimmedLater(held, 12);
		expect(next.entries.at(-1)?.id).toBe("gr9");
		expect(ids(next.entries)).toContain("gp");
		expect([next.later, next.earlier]).toEqual([true, true]);
		// Where no turn begins after the cap, nothing is let go.
		const open = heldFrom(answer(linked([...turns(4), ...long]), { earlier: true }), null);
		expect(trimmedLater(open, 12)).toBe(open);
	});

	test("lets go of the versions of what was let go, and the page below joins it again as a later page", () => {
		const held = heldFrom(
			answer(turns(6), {
				versions: [
					{ parent: "r1", entries: [entry("alt1", "r1", 50)], leads: {} },
					{ parent: "r5", entries: [entry("alt5", "r5", 51)], leads: {} },
				],
			}),
			null,
		);
		const next = trimmedLater(held, 6);
		expect(ids(next.entries)).toEqual(["p0", "r0", "p1", "r1", "p2", "r2"]);
		expect(next.versions.map((g) => g.parent)).toEqual(["r1"]);
		const below = answer([...turns(6).slice(6)], { kind: "after" });
		expect(ids(withLater(next, below)?.entries ?? [])).toEqual(ids(turns(6)));
	});
});

describe("the figures of the whole file", () => {
	test("are needed when the file has entries the stretch does not hold, and not when it holds them all", () => {
		const some = heldFrom(
			{ ...answer(chain(5, 9)), members: [member("/f/main.jsonl", chain(5, 9), { total: 10 })] },
			null,
		);
		expect(needsStats(some)).toBe(true);
		const all = heldFrom(
			{ ...answer(chain(0, 9)), members: [member("/f/main.jsonl", chain(0, 9), { total: 10 })] },
			null,
		);
		expect(needsStats(all)).toBe(false);
		// A file with another branch in it holds more than the path.
		const branched = heldFrom(
			{ ...answer(chain(0, 9)), members: [member("/f/main.jsonl", chain(0, 9), { total: 12 })] },
			null,
		);
		expect(needsStats(branched)).toBe(true);
		expect(withStats(some, stats("e9", 0)).stats).not.toBeNull();
	});

	/** What the server adds the first `upTo` entries up to, as `view=stats` does (here by the page's own folds, which it mirrors). */
	function stats(through: string, upTo: number): FamilyStats {
		const part = conversation.slice(0, upTo);
		return {
			through,
			usage: sumEntries(part),
			byModel: usageByModel(part),
			clock: { total: 0, start: null, end: 0 },
		};
	}
	const assistant = (id: string, parent: string, n: number, model: string, cost: number): SessionEntry =>
		entry(id, parent, n, {
			message: {
				role: "assistant",
				provider: "p",
				model,
				usage: { input: 10, output: 5, totalTokens: 15, cost: { total: cost } },
			},
		});
	const prompt = (id: string, parent: string | null, n: number): SessionEntry =>
		entry(id, parent, n, { message: { role: "user", timestamp: T0 + n * 1000 } });
	const conversation: SessionEntry[] = [
		prompt("u1", null, 1),
		assistant("a1", "u1", 5, "m1", 0.01),
		prompt("u2", "a1", 20),
		assistant("a2", "u2", 30, "m2", 0.02),
		assistant("a3", "a2", 40, "m1", 0.03),
		prompt("u3", "a3", 100),
		assistant("a4", "u3", 130, "m1", 0.04),
	];

	test("go on from the server's, with the entries after the one they end at, as the whole file adds up", () => {
		for (let upTo = 1; upTo < conversation.length; upTo++) {
			const base = stats(conversation[upTo - 1]?.id as string, upTo);
			const whole = sumEntries(conversation);
			const sum = sumEntries(conversation, base);
			expect({ ...sum, cost: 0 }).toEqual({ ...whole, cost: 0 });
			expect(sum.cost).toBeCloseTo(whole.cost, 12);
			const byModel = usageByModel(conversation, base);
			expect(byModel.map(([m]) => m)).toEqual(usageByModel(conversation).map(([m]) => m));
			for (const [m, used] of usageByModel(conversation)) {
				const got = byModel.find(([k]) => k === m)?.[1];
				expect([got?.tokens, got?.n]).toEqual([used.tokens, used.n]);
				expect(got?.cost).toBeCloseTo(used.cost, 12);
			}
		}
	});

	test("the time worked goes on from the server's clock", () => {
		const whole = activeMs(conversation);
		expect(whole).toBeGreaterThan(0);
		// The server's clock after a3: u1's turn is over (the prompt at 1 s to the last entry at 5 s), u2's is open from 20 s to 40 s.
		const base = { through: "a3", clock: { total: 4000, start: T0 + 20_000, end: T0 + 40_000 } };
		expect(activeMs(conversation, base)).toBe(whole);
		// What is before `through` is not read again: a page that holds only the end of the file gets the same time.
		expect(activeMs(conversation.slice(3), base)).toBe(whole);
		// The figures of another file are not used: the entries are what there is.
		expect(activeMs(conversation.slice(3), { ...base, through: "gone" })).toBe(activeMs(conversation.slice(3)));
	});

	test("are not used when the entry they end at is not among the entries (the figures are of another file)", () => {
		const base = stats("a2", 4);
		const other = conversation.slice(4);
		expect(sumEntries(other, { ...base, through: "gone" })).toEqual(sumEntries(other));
		expect(entriesAfter(other, "gone")).toBeNull();
		expect(ids(entriesAfter(conversation, "a3") ?? [])).toEqual(["u3", "a4"]);
		expect(ids(entriesAfter(conversation, null) ?? [])).toHaveLength(conversation.length);
	});

	/** A stretch of the end of `conversation`'s path (or of the middle, when `later`) of a file that has more entries than it holds. */
	const stretch = (from: number, to: number, later: boolean, upTo = conversation.length): Held => {
		const held = heldFrom(
			{
				file: "/f/main.jsonl",
				members: [member("/f/main.jsonl", conversation.slice(from, to), { total: conversation.length })],
				view: view({ kind: later ? "around" : "tail", leaf: "a4", head: "a4", later, earlier: from > 0 }),
			},
			null,
		);
		return withStats(held, stats(conversation[upTo - 1]?.id as string, upTo));
	};

	test("of a stretch that stops short of the file's end are the server's alone: what it holds is inside them", () => {
		const middle = stretch(2, 4, true);
		const figures = figuresOf(middle, middle.entries);
		expect(figures).not.toBeNull();
		// The cost is the whole file's, not what the two entries of the stretch cost.
		expect(sumEntries(middle.entries, figures).cost).toBeCloseTo(sumEntries(conversation).cost, 12);
		expect(usageByModel(middle.entries, figures).map(([m, u]) => [m, u.n])).toEqual(
			usageByModel(conversation).map(([m, u]) => [m, u.n]),
		);
		// The time worked is the server's clock (here a stopped one), not the ten seconds the two entries of the stretch span.
		expect(activeMs(middle.entries)).toBeGreaterThan(0);
		expect(activeMs(middle.entries, figures)).toBe(0);
	});

	test("of the end of the file are the server's with the entries after the one they end at, and none when the page cannot use them", () => {
		const end = stretch(3, 7, false, 5);
		// They end at `a3` (the fifth entry); the stretch holds `a3` and what follows it.
		expect(figuresOf(end, end.entries)).toBe(end.stats);
		// The entries of a process on the file, which do not hold the entry they end at: not usable, and the page says so.
		expect(figuresOf(end, conversation.slice(5))).toBeNull();
		// A process's entries that do hold it are what they are added to, even for a stretch that stops short of the end.
		const middle = stretch(2, 4, true, 5);
		expect(figuresOf(middle, conversation.slice(2))).toBe(middle.stats);
		// Nothing to give before they are asked for, or when the page holds all the file.
		expect(figuresOf({ ...middle, stats: null }, middle.entries)).toBeNull();
		const all = heldFrom(
			{
				file: "/f/main.jsonl",
				members: [member("/f/main.jsonl", conversation, { total: conversation.length })],
				view: view({ kind: "tail", leaf: "a4", head: "a4" }),
			},
			null,
		);
		expect(figuresOf(withStats(all, stats("a4", conversation.length)), all.entries)).toBeNull();
	});

	test("of a stretch that reaches the leaf of a branch that is not the file's last entry are the server's alone: its figures are of the whole file", () => {
		// The file's last entry (`head`) is on another branch: the stretch's last entry is its leaf, and the figures end at the head.
		const branch = { ...stretch(2, 4, false), leaf: "a3", head: "a4" };
		const figures = figuresOf(branch, branch.entries);
		expect(figures).not.toBeNull();
		expect(sumEntries(branch.entries, figures).cost).toBeCloseTo(sumEntries(conversation).cost, 12);
	});

	test("are asked for again when the file has grown past where they end, and not before", () => {
		const held = stretch(3, 7, false, 5);
		expect(wantsStats(held)).toBe(true);
		expect(wantsStats({ ...held, stats: stats("a4", conversation.length) })).toBe(false);
		expect(wantsStats({ ...held, stats: null })).toBe(true);
	});

	test("are asked for again when the entries the page adds them to do not hold the entry they end at (#711)", () => {
		// The figures end at the file's last entry, which is the stretch's last: they are the stretch's to use.
		const held = stretch(3, 7, false);
		expect(wantsStats(held)).toBe(false);
		// A process is on the file and the page adds the figures to its entries: they stop before it, so the chip would stay at "≥".
		const process = conversation.slice(0, 5);
		expect(figuresOf(held, process)).toBeNull();
		expect(wantsStats(held, process)).toBe(true);
		// Its entries that do hold it, and go on past it, are what the figures join: nothing to ask for.
		expect(figuresOf(held, conversation)).toBe(held.stats);
		expect(wantsStats(held, conversation)).toBe(false);
		// A file whose entries are all held is added up by the page, whatever its process holds.
		const all = heldFrom(
			{
				file: "/f/main.jsonl",
				members: [member("/f/main.jsonl", conversation, { total: conversation.length })],
				view: view({ kind: "tail", leaf: "a4", head: "a4" }),
			},
			null,
		);
		expect(wantsStats(all, process)).toBe(false);
	});

	test("the wait before asking again grows with each miss, up to a cap, and there is none before the first ask", () => {
		expect(statsDelay(0)).toBe(0);
		const waits = [1, 2, 3, 4, 5, 6, 7, 8].map(statsDelay);
		for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1] as number);
		expect(waits[0]).toBeGreaterThan(0);
		expect(Math.max(...waits)).toBe(STATS_RETRY_CAP_MS);
		// Asking stops after as many misses as the page is willing to wait out.
		expect(statsDelay(STATS_MISSES_MAX)).toBe(STATS_RETRY_CAP_MS);
	});
});

describe("what lies above the stretch", () => {
	const mode = (id: string, mode: string): SessionEntry =>
		({
			type: "mode_change",
			id,
			parentId: null,
			timestamp: stamp(1),
			mode,
			data: { goal: { id: "g1", objective: "ship", status: "active" } },
		}) as SessionEntry;

	test("is put in front of the path for what is read from all of it; with nothing above, the path itself", () => {
		const carried = new Carried();
		const path = chain(5, 9);
		expect(carried.derive([], path)).toBe(path);
		const above = [mode("m1", "goal")];
		const whole = carried.derive(above, path);
		expect(ids(whole)).toEqual(["m1", "e5", "e6", "e7", "e8", "e9"]);
		// The goal the entry above left is the conversation's goal (an active one comes back paused).
		expect(savedGoal(whole)?.objective).toBe("ship");
		expect(savedGoal(path)).toBeNull();
	});

	test("goes on from where it was as the path grows, so what is derived from it is not derived again", () => {
		const carried = new Carried();
		const above = [mode("m1", "goal")];
		const path = chain(5, 9);
		const first = carried.derive(above, path);
		const grown = appended(path, chain(10, 11));
		const second = carried.derive(above, grown);
		expect(ids(second)).toEqual(["m1", ...ids(grown)]);
		expect(extension(first, second)).toBe(first.length);
		// A path that is not the old one grown is made anew.
		const other = carried.derive(above, chain(5, 7));
		expect(extension(second, other)).toBeNull();
		// Other things above: made anew.
		expect(ids(carried.derive([mode("m2", "none")], grown))[0]).toBe("m2");
	});

	test("the prompts above and the path's are one history, a repeat in a row counted once", () => {
		expect(joinPrompts([], ["a", "b"])).toEqual(["a", "b"]);
		expect(joinPrompts(["x", "y"], [])).toEqual(["x", "y"]);
		expect(joinPrompts(["x", "y"], ["y", "z"])).toEqual(["x", "y", "z"]);
		expect(joinPrompts(["x", "y"], ["z"])).toEqual(["x", "y", "z"]);
	});

	test("the providers of the rest of the conversation come after those the stretch names", () => {
		const assistant = (id: string, provider: string): SessionEntry =>
			entry(id, null, 1, { message: { role: "assistant", provider, model: "m" } });
		const path = [assistant("a1", "openai"), assistant("a2", "anthropic")];
		expect(providersUsed(path, null, false, ["google", "openai"])).toEqual(["anthropic", "openai", "google"]);
		expect(providersUsed(path, "xai", false, ["google"])).toEqual(["xai", "anthropic", "openai", "google"]);
		// A local backend's conversation spends none of them.
		expect(providersUsed(path, "local", true, ["google"])).toEqual(["local"]);
	});
});

describe("the family the tree is built from", () => {
	const main = (entries: SessionEntry[], extra: Partial<SessionFileData> = {}) =>
		member("/f/main.jsonl", entries, extra);

	test("a stretch is a tree whose first entry has a parent that is not in it, and the file's last entry is the server's", () => {
		const fam = buildFamily([main(chain(5, 9), { head: "e12" })], null, []);
		expect(fam.idx.byId.has("e4")).toBe(false);
		expect(fam.headOf.get("/f/main.jsonl")).toBe("e12");
	});

	test("the entries a process sent go on from the stretch where it joins it, and replace what the page held when it sent the file whole", () => {
		const held = chain(5, 9);
		const joined = buildFamily([main(held, { head: "e9" })], "/f/main.jsonl", chain(8, 11));
		expect([...joined.idx.byId.keys()].sort()).toEqual(["e10", "e11", "e5", "e6", "e7", "e8", "e9"].sort());
		expect(joined.headOf.get("/f/main.jsonl")).toBe("e11");
		const whole = buildFamily([main(held)], "/f/main.jsonl", chain(0, 11));
		expect(whole.idx.byId.size).toBe(12);
	});

	test("the entries a process sent that the stretch does not hold (a window far from the end) are added to it, which stays as it was", () => {
		const fam = buildFamily([main(chain(5, 9), { head: "e25" })], "/f/main.jsonl", chain(20, 25));
		expect([...fam.idx.byId.keys()].sort()).toEqual([...ids(chain(5, 9)), ...ids(chain(20, 25))].sort());
		// The file ends where the process says; the stretch's entries are not the process's, and are not lost to it.
		expect(fam.headOf.get("/f/main.jsonl")).toBe("e25");
		expect(fam.filesOf.get("e7")).toEqual(["/f/main.jsonl"]);
		// The same when the process sent more than a window of the end, which still does not reach the stretch.
		const far = buildFamily([main(chain(5, 9))], "/f/main.jsonl", chain(100, 140));
		expect(far.idx.byId.has("e5") && far.idx.byId.has("e140")).toBe(true);
	});

	test("entries that the process appends after a stretch are added to the tree as it grows, not built again", () => {
		const builder = new FamilyBuilder();
		const files = [main(chain(5, 9))];
		const live = appended(chain(8, 9), []);
		const first = builder.update(files, "/f/main.jsonl", live);
		const grown = appended(live, chain(10, 11));
		const second = builder.update(files, "/f/main.jsonl", grown);
		expect(second.idx.byId.has("e11")).toBe(true);
		// The same maps went on: nothing was sorted and indexed again.
		expect(second.filesOf).toBe(first.filesOf);
	});

	test("the other versions the server named are in the tree, and say where each leads", () => {
		const versions: VersionGroup[] = [
			{
				parent: "e6",
				entries: [entry("x7", "e6", 30)],
				leads: {
					e7: { leaf: "e9", files: ["/f/main.jsonl"] },
					x7: { leaf: "x9", files: ["/f/fork.jsonl"] },
				},
			},
		];
		const held = heldFrom(answer(chain(5, 9), { versions }, [member("/f/fork.jsonl", [], { head: "x9" })]), null);
		const fam = new FamilyBuilder().update(membersOf(held), null, [], {
			entries: versionEntries(held),
			leads: leadsOf(held),
		});
		expect(fam.idx.children.get("e6")?.map((e) => e.id)).toEqual(["e7", "x7"]);
		// The newest entry under the other version is in a file the page holds none of the entries of: the server's word.
		expect(destinationFor(fam, "x7", "/f/main.jsonl")).toEqual({ file: "/f/fork.jsonl", leaf: "x9" });
		expect(destinationFor(fam, "e7", "/f/main.jsonl")).toEqual({ file: "/f/main.jsonl", leaf: "e9" });
		// Without the server's word, the newest entry the tree holds under it.
		expect(destinationFor(fam, "e8", "/f/main.jsonl")).toEqual({ file: "/f/main.jsonl", leaf: "e9" });
	});
});
