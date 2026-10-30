import { finite, isRecord, usageCost } from "@shared/guards.ts";
import type { FamilyStats, SessionEntry, UsageTotals } from "@shared/protocol.ts";
import { entriesAfter } from "./answer.ts";
import { Fold } from "./lineage.ts";
import { messageOf } from "./messages.ts";
import { type AgentRow, rowSpend } from "./subagents.ts";

/**
 * What a conversation has used: its own requests, its subagents' (the finished and nested ones from their
 * transcripts, the running ones from omp's progress frames) and its advisors' (from the session list: omp writes
 * them to a transcript of their own and sends no frame for them), each with its share. The chat header, its tooltip
 * and the status line read this one account.
 */

/** Tokens by kind, and what they cost. */
export interface UsageParts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface Spend {
	/** Input, output, cache reads and cache writes together. */
	tokens: number;
	/** US dollars. */
	cost: number;
}

export type SubagentSpend = Spend & { count: number; running: number };

/** What the advisors spent, and in how many requests. */
export type AdvisorSpend = Spend & { requests: number };

/** What the session list says the advisors of a conversation spent. */
export interface AdvisorUsage extends UsageParts {
	requests: number;
}

/** What the header's cost chip and its tooltip show. */
export interface HeaderUsage extends UsageParts {
	/** Tokens running subagents report that no transcript shows yet; they have no kind (see `rowSpend`). */
	pending: number;
	/** The shares, when the conversation has subagents or advisors. */
	split: { main: Spend; subagents: SubagentSpend; advisor: AdvisorSpend } | null;
	/** The figures are of the part of the conversation the page holds: those of the whole file have not arrived (or could not be had). */
	partial?: boolean;
}

export interface ConversationTotals {
	/** The conversation's own requests. */
	main: Spend;
	/** Every subagent, nested ones included. */
	subagents: SubagentSpend;
	/** Every advisor, a subagent's own ones included. */
	advisor: AdvisorSpend;
	/** `main`, `subagents` and `advisor` together. */
	total: Spend;
	usage: HeaderUsage;
	mainUsage: UsageParts;
	subagentUsage: UsageParts & { pending: number };
	advisorUsage: UsageParts;
	/** How long the subagents worked (#692), nested ones included: what their saved transcripts count (`SubagentFile.activeMs`). */
	subagentActiveMs: number;
}

const NO_ADVISOR: AdvisorUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 };

/** The advisors' figures of a session list entry; an entry without them (or with ones that are no numbers) spent nothing. */
export function advisorUsageOf(usage: UsageTotals | undefined): AdvisorUsage {
	if (!isRecord(usage)) return NO_ADVISOR;
	return {
		input: finite(usage.input),
		output: finite(usage.output),
		cacheRead: finite(usage.cacheRead),
		cacheWrite: finite(usage.cacheWrite),
		cost: finite(usage.cost),
		requests: finite(usage.requests),
	};
}

/** What `entries[from..]` add to `usage`: a new object when anything is added, else `usage` itself. */
function addUsage(usage: UsageParts, entries: readonly SessionEntry[], from: number): UsageParts {
	let t: UsageParts | null = null;
	for (let i = from; i < entries.length; i++) {
		const e = entries[i];
		const m = messageOf(e);
		const u =
			e.type === "model_usage"
				? (e.usage as NonNullable<typeof m>["usage"])
				: m?.role === "assistant"
					? m.usage
					: undefined;
		if (!isRecord(u)) continue;
		t ??= { ...usage };
		t.input += finite(u.input);
		t.output += finite(u.output);
		t.cacheRead += finite(u.cacheRead);
		t.cacheWrite += finite(u.cacheWrite);
		t.cost += usageCost(u);
	}
	return t ?? usage;
}

const sums = new Fold<SessionEntry, UsageParts>(
	() => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
	addUsage,
);

/**
 * What the entries' requests used. Entries a call has seen are not read again when more are appended (see `Fold`).
 *
 * A page that holds only the end of a long conversation has the server's figures for the whole file (`base`, as of the
 * entry it names) and adds the requests of the entries after that one.
 */
export function sumEntries(entries: SessionEntry[], base?: Pick<FamilyStats, "through" | "usage"> | null): UsageParts {
	const rest = base ? entriesAfter(entries, base.through) : null;
	if (!base || !rest) return sums.run(entries);
	const more = sums.run(rest);
	const { usage } = base;
	return {
		input: usage.input + more.input,
		output: usage.output + more.output,
		cacheRead: usage.cacheRead + more.cacheRead,
		cacheWrite: usage.cacheWrite + more.cacheWrite,
		cost: usage.cost + more.cost,
	};
}

/**
 * The requests of each model of the entries: its tokens, cost and how many there were; in the order models first appeared.
 * A `model_usage` entry (a request omp made on the side: a judge's, a reviewer's) names its own model, as the server's fold does.
 */
export function usageByModel(
	entries: readonly SessionEntry[],
	base?: Pick<FamilyStats, "through" | "byModel"> | null,
): [string, { tokens: number; cost: number; n: number }][] {
	const rest = base ? entriesAfter(entries, base.through) : null;
	if (!base || !rest) return [...models.run(entries)];
	const merged = new Map(base.byModel.map(([model, used]) => [model, { ...used }]));
	for (const [model, used] of models.run(rest)) {
		const into = merged.get(model);
		if (into) {
			into.tokens += used.tokens;
			into.cost += used.cost;
			into.n += used.n;
		} else merged.set(model, { ...used });
	}
	return [...merged];
}

const models = new Fold<SessionEntry, Map<string, { tokens: number; cost: number; n: number }>>(
	() => new Map(),
	(byModel, entries, from) => {
		for (let i = from; i < entries.length; i++) {
			const e = entries[i] as SessionEntry;
			const msg = messageOf(e);
			const side = e.type === "model_usage" && isRecord(e.usage);
			const used = side ? (e.usage as Record<string, unknown>) : msg?.role === "assistant" ? msg.usage : undefined;
			if (!isRecord(used)) continue;
			const k = side ? `${e.provider}/${e.model}` : `${msg?.provider}/${msg?.model}`;
			const cur = byModel.get(k) ?? { tokens: 0, cost: 0, n: 0 };
			cur.tokens += finite(used.totalTokens);
			cur.cost += usageCost(used);
			cur.n++;
			byModel.set(k, cur);
		}
		return byModel;
	},
	true,
);

const tokensOf = (u: UsageParts): number => u.input + u.output + u.cacheRead + u.cacheWrite;

/**
 * The conversation's account from its own usage, the rows of its subagents (`agentRows`) and what the session list says
 * its advisors spent (`advisorUsageOf`; none while the list does not hold the conversation).
 */
export function conversationTotals(
	mainUsage: UsageParts,
	rows: AgentRow[],
	advisorUsage: AdvisorUsage = NO_ADVISOR,
): ConversationTotals {
	const subagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, pending: 0 };
	let subagentActiveMs = 0;
	for (const row of rows) {
		subagentActiveMs += row.stat?.activeMs ?? 0;
		const { parts, pending } = rowSpend(row);
		subagentUsage.input += parts.input;
		subagentUsage.output += parts.output;
		subagentUsage.cacheRead += parts.cacheRead;
		subagentUsage.cacheWrite += parts.cacheWrite;
		subagentUsage.cost += parts.cost;
		subagentUsage.pending += pending;
	}
	const main: Spend = { tokens: tokensOf(mainUsage), cost: mainUsage.cost };
	const subagents: SubagentSpend = {
		tokens: tokensOf(subagentUsage) + subagentUsage.pending,
		cost: subagentUsage.cost,
		count: rows.length,
		running: rows.filter((r) => r.running).length,
	};
	const advisor: AdvisorSpend = {
		tokens: tokensOf(advisorUsage),
		cost: advisorUsage.cost,
		requests: advisorUsage.requests,
	};
	return {
		main,
		subagents,
		advisor,
		total: { tokens: main.tokens + subagents.tokens + advisor.tokens, cost: main.cost + subagents.cost + advisor.cost },
		usage: {
			input: mainUsage.input + subagentUsage.input + advisorUsage.input,
			output: mainUsage.output + subagentUsage.output + advisorUsage.output,
			cacheRead: mainUsage.cacheRead + subagentUsage.cacheRead + advisorUsage.cacheRead,
			cacheWrite: mainUsage.cacheWrite + subagentUsage.cacheWrite + advisorUsage.cacheWrite,
			cost: mainUsage.cost + subagentUsage.cost + advisorUsage.cost,
			pending: subagentUsage.pending,
			split: rows.length || advisor.requests ? { main, subagents, advisor } : null,
		},
		mainUsage,
		subagentUsage,
		advisorUsage: {
			input: advisorUsage.input,
			output: advisorUsage.output,
			cacheRead: advisorUsage.cacheRead,
			cacheWrite: advisorUsage.cacheWrite,
			cost: advisorUsage.cost,
		},
		subagentActiveMs,
	};
}
