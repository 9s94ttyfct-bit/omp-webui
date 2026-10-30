import { finite, isRecord, usageCost } from "@shared/guards.ts";
import type { FamilyStats, SessionEntry } from "@shared/protocol.ts";
import type { OverlayMessage } from "../store/live.ts";
import { entriesAfter } from "./answer.ts";
import { Fold } from "./lineage.ts";
import { type AgentMessage, messageOf } from "./messages.ts";
import { isPrompt, isUserCommand } from "./turns.ts";

/**
 * The figures the TUI prints after a turn (`10:49:50  Δ 5m6s  ↘419  ↗3.2K  💾 391K  ⏱ 1.6s  ⚡ 102.0/s`), from what omp
 * records on every assistant message: `usage`, `timestamp` (the request started), `completedAt`, `duration` and
 * `ttft`. A figure omp did not record is left out; none is made up.
 */

/** A request this short (ms) is not timed for a speed: the TUI's own limit. */
const MIN_TIMED_MS = 100;

/** One model request. */
export interface StepStats {
	/** When the request started, ms since the epoch. */
	startedAt?: number;
	/** When it ended. */
	finishedAt?: number;
	/** How long it took, ms. */
	durationMs?: number;
	/** Time to its first token, ms. */
	ttftMs?: number;
	/** Tokens by kind, as omp recorded them. The TUI's "in" is `input + cacheWrite`: what was sent and not read from the cache. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	model?: string;
	/** Output tokens per second of request time; absent for a request too short to time or without output. */
	tokensPerSecond?: number;
}

/** One agent turn: its requests added up. */
export interface TurnStats {
	requests: number;
	/** When the last request ended. */
	finishedAt?: number;
	/** From the first request's start to the last one's end (tool time included). */
	elapsedMs?: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** The first request's time to first token: how long until the model began to answer. */
	ttftMs?: number;
	/** All the output over all the time the model spent writing it. */
	tokensPerSecond?: number;
	cost: number;
	/** Models used, once each, in order. */
	models: string[];
	steps: StepStats[];
}

function positive(n: number | undefined): number | undefined {
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The figures of one assistant message, or null when it has no usage. `entryTimestamp` (the saved entry's) says when
 * a message ended that omp wrote before it recorded `completedAt`.
 */
export function stepStats(m: AgentMessage, entryTimestamp?: string): StepStats | null {
	const u = m.usage;
	if (!isRecord(u)) return null;
	const output = finite(u.output);
	const durationMs = positive(m.duration);
	return {
		startedAt: positive(m.timestamp),
		finishedAt: positive(m.completedAt) ?? positive(entryTimestamp ? Date.parse(entryTimestamp) : undefined),
		durationMs,
		ttftMs: positive(m.ttft),
		input: finite(u.input),
		output,
		cacheRead: finite(u.cacheRead),
		cacheWrite: finite(u.cacheWrite),
		cost: usageCost(u),
		model: m.model,
		tokensPerSecond:
			durationMs !== undefined && durationMs > MIN_TIMED_MS && output > 0 ? (output / durationMs) * 1000 : undefined,
	};
}

/**
 * A turn's requests added up as they come: adding one is constant work, and the figures with a few more requests
 * (those that ended but are not saved yet) cost what those cost. A turn of a goal run has thousands of requests, and the
 * page shows its figures for every frame it streams.
 */
export class TurnTally {
	readonly steps: StepStats[] = [];
	/** When each request began (a request without a time counts as `undefined`): which requests the entries hold. */
	readonly started = new Set<number | undefined>();
	private readonly models = new Set<string>();
	private readonly sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, timedOutput: 0, timedMs: 0 };

	add(s: StepStats): void {
		this.steps.push(s);
		this.started.add(s.startedAt);
		if (s.model) this.models.add(s.model);
		TurnTally.sum(this.sum, s);
	}

	private static sum(sum: TurnTally["sum"], s: StepStats): void {
		sum.input += s.input;
		sum.output += s.output;
		sum.cacheRead += s.cacheRead;
		sum.cacheWrite += s.cacheWrite;
		sum.cost += s.cost;
		if (s.tokensPerSecond !== undefined && s.durationMs !== undefined) {
			sum.timedOutput += s.output;
			sum.timedMs += s.durationMs;
		}
	}

	/** The figures of the requests added and `extra` after them; null when there are none. */
	figures(extra: readonly StepStats[] = []): Omit<TurnStats, "steps"> | null {
		const first = this.steps[0] ?? extra[0];
		const last = extra.at(-1) ?? this.steps.at(-1);
		if (!first || !last) return null;
		const sum = extra.length ? { ...this.sum } : this.sum;
		const models = extra.length ? new Set(this.models) : this.models;
		for (const s of extra) {
			TurnTally.sum(sum, s);
			if (s.model) models.add(s.model);
		}
		// Clocks that disagree (a request that "ended" before it started) give no duration rather than a negative one.
		const elapsed =
			first.startedAt !== undefined && last.finishedAt !== undefined ? last.finishedAt - first.startedAt : 0;
		return {
			requests: this.steps.length + extra.length,
			finishedAt: last.finishedAt,
			elapsedMs: elapsed > 0 ? elapsed : undefined,
			input: sum.input,
			output: sum.output,
			cacheRead: sum.cacheRead,
			cacheWrite: sum.cacheWrite,
			ttftMs: first.ttftMs,
			tokensPerSecond: sum.timedMs > 0 ? (sum.timedOutput / sum.timedMs) * 1000 : undefined,
			cost: sum.cost,
			models: [...models],
		};
	}
}

/** A turn's requests added up, or null when it has none. */
export function turnStats(steps: StepStats[]): TurnStats | null {
	const tally = new TurnTally();
	for (const s of steps) tally.add(s);
	const figures = tally.figures();
	return figures && { ...figures, steps };
}

/** The turn a process is working on, as its saved entries show it. */
export interface SavedTurn {
	/** Every request since the last prompt. */
	steps: StepStats[];
	/** When that prompt was sent. */
	promptAt?: number;
}

/**
 * The requests of the turn the process is on: every assistant message since the last prompt on the branch ending at
 * `leafId` (the last entry when there is none). Costs a pass over `entries`, so keep the result until they change.
 */
export function savedTurn(entries: SessionEntry[], leafId: string | null): SavedTurn {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const steps: StepStats[] = [];
	let promptAt: number | undefined;
	for (let e = leafId ? byId.get(leafId) : entries.at(-1); e; e = e.parentId ? byId.get(e.parentId) : undefined) {
		const m = messageOf(e);
		if (m && isPrompt(m)) {
			promptAt = positive(m.timestamp) ?? positive(Date.parse(e.timestamp));
			break;
		}
		if (m && isUserCommand(m)) break;
		const step = m?.role === "assistant" ? stepStats(m, e.timestamp) : null;
		if (step) steps.push(step);
	}
	return { steps: steps.reverse(), promptAt };
}

/**
 * The requests that have ended but are not saved yet (`overlay`). A request still streaming does not count, one the
 * entries already hold is the same request (found by when it started: `known`), and one that started before the prompt
 * `since` belongs to an earlier turn.
 */
export function unsavedSteps(
	known: ReadonlySet<number | undefined>,
	overlay: OverlayMessage[],
	since?: number,
): StepStats[] {
	return overlay.flatMap((o) => {
		const startedAt = positive(o.message.timestamp);
		if (!o.ended || o.message.role !== "assistant" || known.has(startedAt)) return [];
		if (since !== undefined && (startedAt ?? 0) < since) return [];
		const step = stepStats(o.message);
		return step ? [step] : [];
	});
}

/** The saved requests plus the ones that have ended but are not saved yet (see `unsavedSteps`). */
export function withUnsaved(saved: StepStats[], overlay: OverlayMessage[], since?: number): StepStats[] {
	const unsaved = unsavedSteps(new Set(saved.map((s) => s.startedAt)), overlay, since);
	return unsaved.length ? [...saved, ...unsaved] : saved;
}

/** What `liveTurn` keeps while it goes through the entries. */
interface LiveTurnState {
	tally: TurnTally;
	promptAt: number | undefined;
	/** Each entry since the turn began is the child of the one before: the turn is the entries since its prompt, as they are. */
	linear: boolean;
}

const liveTurns = new Fold<SessionEntry, LiveTurnState>(
	() => ({ tally: new TurnTally(), promptAt: undefined, linear: true }),
	(s, entries, from) => {
		for (let i = from; i < entries.length; i++) {
			const e = entries[i];
			const m = messageOf(e);
			if (m && (isPrompt(m) || isUserCommand(m))) {
				s.tally = new TurnTally();
				s.promptAt = isPrompt(m) ? (positive(m.timestamp) ?? positive(Date.parse(e.timestamp))) : undefined;
				s.linear = true;
				continue;
			}
			if (i > 0 && e.parentId !== entries[i - 1].id) s.linear = false;
			const step = m?.role === "assistant" ? stepStats(m, e.timestamp) : null;
			if (step) s.tally.add(step);
		}
		return s;
	},
	true,
);

/**
 * `savedTurn`, with the requests added up (see `TurnTally`) and found by going on from where the last call over these
 * entries stopped: what a frame costs does not depend on how long the conversation or the turn is. Entries that are not
 * a chain to the leaf (a branch, a leaf that is not the last) are walked from the leaf, as `savedTurn` does.
 */
export function liveTurn(entries: SessionEntry[], leafId: string | null): { tally: TurnTally; promptAt?: number } {
	const kept = liveTurns.run(entries);
	if (kept.linear && (leafId === null || leafId === entries.at(-1)?.id)) return kept;
	const saved = savedTurn(entries, leafId);
	const tally = new TurnTally();
	for (const s of saved.steps) tally.add(s);
	return { tally, promptAt: saved.promptAt };
}

/**
 * How long the agent has worked in a conversation (the TUI's clock in its status line): each prompt's turn lasts until
 * the last entry written before the next prompt, so the time nobody was asking anything is left out. A command the
 * user ran ends a turn without starting one. A turn still running counts up to its last saved entry.
 *
 * A page that holds only the end of a long conversation has the server's clock for the whole file (`base`, as of the entry
 * it names) and goes on from it with the entries after that one.
 */
export function activeMs(
	entries: readonly SessionEntry[],
	base?: Pick<FamilyStats, "through" | "clock"> | null,
): number {
	const rest = base ? entriesAfter(entries, base.through) : null;
	const clock = base && rest ? stepClock(base.clock, rest, 0) : activeClocks.run(entries);
	return clock.total + (clock.start !== null ? clock.end - clock.start : 0);
}

type ActiveClock = FamilyStats["clock"];

/** The clock after `entries[from..]`, which are folded into a copy of it. */
function stepClock(clock: ActiveClock, entries: readonly SessionEntry[], from: number): ActiveClock {
	let { total, start, end } = clock;
	for (let i = from; i < entries.length; i++) {
		const e = entries[i];
		const m = messageOf(e);
		const at = Date.parse(e.timestamp);
		if (m && (isPrompt(m) || isUserCommand(m))) {
			if (start !== null) total += end - start;
			start = isPrompt(m) ? (positive(m.timestamp) ?? positive(at) ?? null) : null;
			end = start ?? 0;
		} else if (start !== null && Number.isFinite(at)) {
			end = Math.max(end, at);
		}
	}
	return { total, start, end };
}

const activeClocks = new Fold<SessionEntry, ActiveClock>(() => ({ total: 0, start: null, end: 0 }), stepClock);
