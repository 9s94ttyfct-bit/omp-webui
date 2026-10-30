import { fuzzyMatch } from "@shared/fuzzy.ts";

/**
 * What the model picker's field matches, and the order the list comes in: the models a person loves first, then what
 * they used recently, then the rest; and with a query typed, the best match first.
 */

/** What of a model the query can match: the name a person reads, the provider, the id, and the names people call it. */
export interface ModelLike {
	provider: string;
	id: string;
	name?: string;
}

/** A model and how it came to be listed. */
export interface ModelRank<M> {
	model: M;
	/** 0 when nothing was typed. */
	score: number;
	/**
	 * Where the query matched, by what it matched: the name a person reads (`label`), and the same characters in the
	 * row's other parts. The picker marks `label`'s positions in the name it draws.
	 */
	positions: { label: number[]; provider: number[]; id: number[] };
}

const keyOf = (m: ModelLike) => `${m.provider}/${m.id}`;

/**
 * Names people use for a model that are not in its own name or id: a family (`sonnet`, `opus`, `haiku` are in Claude's
 * names already, so the ones here are what the row does not say), a provider's short name, a maker's name.
 */
export const MODEL_ALIASES: Record<string, readonly string[]> = {
	anthropic: ["claude", "anthropic"],
	openai: ["gpt", "openai", "chatgpt"],
	google: ["gemini", "google"],
	deepseek: ["ds", "deepseek"],
	moonshot: ["kimi", "moonshot"],
	alibaba: ["qwen", "alibaba", "tongyi"],
	zhipu: ["glm", "zhipu", "chatglm"],
	"x-ai": ["grok", "xai"],
	xai: ["grok", "xai"],
	mistral: ["mistral"],
	meta: ["llama", "meta"],
	ollama: ["ollama", "local"],
	omlx: ["omlx", "local"],
	lmstudio: ["lmstudio", "lm-studio", "local"],
};

/** The names a model answers to besides its own: its provider's aliases, and its own when they add anything. */
export function aliasesOf(m: ModelLike): string[] {
	const out = new Set<string>(MODEL_ALIASES[m.provider.toLowerCase()] ?? []);
	const label = m.name ?? m.id;
	// A dated snapshot answers to its family's name: `claude-haiku-4-5-20251001` to `claude-haiku-4-5`.
	const family = m.id.replace(/-?\d{8}$/, "").replace(/-latest$/, "");
	if (family !== m.id) out.add(family);
	out.add(label);
	return [...out].filter((alias) => alias !== "" && alias !== label);
}

/**
 * How well one model answers `query`: the best of its name (counted twice: it is what the row shows), its provider, its
 * id and its aliases. Null when none of them matches.
 */
export function matchModel(m: ModelLike, query: string): Omit<ModelRank<ModelLike>, "model"> | null {
	const label = m.name ?? m.id;
	const best: ModelRank<ModelLike>["positions"] = { label: [], provider: [], id: [] };
	let score = 0;
	let found = false;
	const labelMatch = fuzzyMatch(query, label);
	if (labelMatch) {
		score = labelMatch.score * 2;
		best.label = labelMatch.positions;
		found = true;
	}
	const providerMatch = fuzzyMatch(query, m.provider);
	if (providerMatch && (!found || providerMatch.score > score)) {
		score = providerMatch.score;
		best.label = [];
		best.provider = providerMatch.positions;
		found = true;
	}
	const idMatch = fuzzyMatch(query, m.id);
	if (idMatch && (!found || idMatch.score > score)) {
		score = idMatch.score;
		best.label = [];
		best.provider = [];
		best.id = idMatch.positions;
		found = true;
	}
	for (const alias of aliasesOf(m)) {
		const aliasMatch = fuzzyMatch(query, alias);
		if (aliasMatch && (!found || aliasMatch.score > score)) {
			// An alias is not drawn: the match is real but has no place in the row to mark.
			score = aliasMatch.score;
			best.label = [];
			best.provider = [];
			best.id = [];
			found = true;
		}
	}
	return found ? { score, positions: best } : null;
}

/**
 * The models to list for `query`, in the order to list them: with nothing typed, the loved ones in the order they were
 * loved (newest first), then the recently used ones (most recent first), then every other model as the caller had them.
 * With a query, the best match first, and among equal matches the same loved / recent / rest order.
 *
 * `loved` and `recent` are `provider/id` keys. A model is listed once, at its first place.
 */
export function rankModels<M extends ModelLike>(
	models: readonly M[],
	query: string,
	o: { loved?: readonly string[]; recent?: readonly string[] } = {},
): ModelRank<M>[] {
	const typed = query.trim();
	const byKey = new Map(models.map((m) => [keyOf(m), m]));
	const loved = (o.loved ?? []).map((key) => byKey.get(key)).filter((m): m is M => Boolean(m));
	const recent = (o.recent ?? []).map((key) => byKey.get(key)).filter((m): m is M => Boolean(m));
	const rest = models;
	// The first place a model is listed is the one it keeps.
	const order = new Map<M, number>();
	for (const m of [...loved, ...recent, ...rest]) if (!order.has(m)) order.set(m, order.size);
	const all = [...order.keys()];
	if (!typed) return all.map((model) => ({ model, score: 0, positions: { label: [], provider: [], id: [] } }));
	const out: ModelRank<M>[] = [];
	for (const model of all) {
		const found = matchModel(model, typed);
		if (found) out.push({ model, ...found });
	}
	// Loved and recent models come first among equal matches: their place in the order above is that, and the sort is
	// stable on it (`order` is an index of the whole list, so the comparison never reads the sort's own arrangement).
	return out.sort((a, b) => b.score - a.score || (order.get(a.model) ?? 0) - (order.get(b.model) ?? 0));
}
