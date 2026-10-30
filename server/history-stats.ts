import { closeSync, openSync } from "node:fs";
import { finite, isRecord, usageCost } from "../shared/guards.ts";
import type { FamilyStats } from "../shared/protocol.ts";
import { type FileIndex, parseObject, Role, readEntries, type StatsState } from "./history-index.ts";

/**
 * `view=stats`: what the entries of a whole file add up to, which a page that holds only a stretch of the file cannot sum.
 * The same three figures the page derives from the entries it has, folded the same way (`sumEntries`, `usageByModel` in
 * `web/src/lib/totals.ts`, `activeMs` in `web/src/lib/turn-stats.ts`), so a page that holds the whole file and one that
 * is told its stats show the same:
 *
 * - usage: the requests of the assistant messages and of the `model_usage` entries;
 * - by model: the same requests, by `provider/model` (a `model_usage` entry names its own: a judge's, a reviewer's);
 * - the clock: each prompt's turn lasts until the last entry written before the next prompt or command.
 *
 * Only the lines that can matter are parsed: assistant messages that mention `usage`, `model_usage` entries, and the
 * messages that may be a prompt or a command. The clock needs nothing else of the other entries but their timestamp, which
 * the index has. The figures are kept with the index and go on from the last entry they hold when the file grows.
 */

/** A batch of lines read and parsed together: bounded, so the text held does not grow with the file (nor its footprint, see `CHUNK` in `history-index.ts`). */
const BATCH_BYTES = 2 * 1024 * 1024;
const BATCH_ENTRIES = 4096;

const positive = (n: unknown): number | undefined =>
	typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;

function addUsage(into: StatsState["usage"], usage: unknown): void {
	if (!isRecord(usage)) return;
	into.input += finite(usage.input);
	into.output += finite(usage.output);
	into.cacheRead += finite(usage.cacheRead);
	into.cacheWrite += finite(usage.cacheWrite);
	into.cost += usageCost(usage);
}

/** One request of `provider/model` that used `usage`, added to `byModel`. */
function byModelAdd(
	byModel: StatsState["byModel"],
	provider: unknown,
	model: unknown,
	usage: Record<string, unknown>,
): void {
	const key = `${provider}/${model}`;
	const cur = byModel.get(key) ?? { tokens: 0, cost: 0, n: 0 };
	cur.tokens += finite(usage.totalTokens);
	cur.cost += usageCost(usage);
	cur.n++;
	byModel.set(key, cur);
}

/** What `index`'s entries add up to, folded from where the last call stopped. */
export function statsOf(index: FileIndex): FamilyStats {
	index.stats ??= {
		folded: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		byModel: new Map(),
		clock: { total: 0, start: null, end: 0 },
	};
	const state = index.stats;
	const to = index.committed;
	if (state.folded < to) fold(index, state, state.folded, to);
	return {
		through: to > 0 ? (index.ids[to - 1] as string) : null,
		usage: { ...state.usage },
		byModel: [...state.byModel].map(([model, v]) => [model, { ...v }]),
		clock: { ...state.clock },
	};
}

function fold(index: FileIndex, state: StatsState, from: number, to: number): void {
	// The entries whose lines say something the index does not: every request's usage, and what makes a turn begin.
	const need: number[] = [];
	for (let i = from; i < to; i++) {
		const type = index.types[i];
		if (type === "model_usage" || (type === "message" && index.roles[i] !== Role.OTHER)) need.push(i);
	}
	/** The entries that begin a turn (a prompt, with when it was sent) or end one (a command the user ran). */
	const bounds = new Map<number, { prompt: boolean; sentAt: number | undefined }>();
	const fd = openSync(index.file, "r");
	try {
		for (let a = 0; a < need.length; ) {
			let b = a;
			let bytes = 0;
			while (b < need.length && b - a < BATCH_ENTRIES && bytes < BATCH_BYTES)
				bytes += index.lens[need[b++] as number] as number;
			const batch = need.slice(a, b);
			const texts = readEntries(fd, index, batch);
			for (let k = 0; k < batch.length; k++) {
				const i = batch[k] as number;
				const text = texts[k] as string;
				if (index.types[i] === "model_usage") {
					const obj = text.includes('"usage"') ? parseObject(text) : null;
					if (obj && isRecord(obj.usage)) {
						addUsage(state.usage, obj.usage);
						// A request omp made on the side (a judge, a reviewer): its model is in By model too, as its cost is in the total.
						byModelAdd(state.byModel, obj.provider, obj.model, obj.usage);
					}
					continue;
				}
				if (index.roles[i] === Role.ASSISTANT && !text.includes('"usage"')) continue;
				const obj = parseObject(text);
				if (!obj) continue;
				index.learn(i, obj);
				const m = obj.message;
				if (!isRecord(m) || typeof m.role !== "string") continue;
				if (m.role === "assistant") {
					if (!isRecord(m.usage)) continue;
					addUsage(state.usage, m.usage);
					byModelAdd(state.byModel, m.provider, m.model, m.usage);
				} else if ((m.role === "user" || m.role === "developer") && m.attribution !== "agent") {
					bounds.set(i, { prompt: true, sentAt: positive(m.timestamp) });
				} else if (m.role === "bashExecution" || m.role === "pythonExecution") {
					bounds.set(i, { prompt: false, sentAt: undefined });
				}
			}
			a = b;
		}
	} finally {
		closeSync(fd);
	}
	const clock = state.clock;
	for (let i = from; i < to; i++) {
		const at = Date.parse(index.stamps[i] as string);
		const bound = bounds.get(i);
		if (bound) {
			if (clock.start !== null) clock.total += clock.end - clock.start;
			clock.start = bound.prompt ? (bound.sentAt ?? positive(at) ?? null) : null;
			clock.end = clock.start ?? 0;
		} else if (clock.start !== null && Number.isFinite(at)) {
			clock.end = Math.max(clock.end, at);
		}
	}
	state.folded = to;
}
