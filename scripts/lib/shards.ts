/**
 * Splitting a suite between CI runners by how long its parts take, not by how many there are: one runner's share of a
 * suite whose parts range from a second to ten minutes is otherwise as likely to be twice another's as equal to it.
 *
 * Every runner works the split out for itself from the same list and the same timings, so the split is deterministic:
 * the same input gives every runner the same answer, and every unit lands on exactly one runner.
 */

/** A part of a suite that one runner runs whole: a test file, or one test of a file whose tests may run apart. */
export interface Unit {
	key: string;
	/** How long it took when it was last timed (any unit of time, the same for all). */
	weight: number;
}

/**
 * `units` split into `total` shares as even in weight as a greedy split makes them: the heaviest unit first, each to the
 * share that weighs least so far (the lower index when two weigh the same). Each share lists its keys in input order.
 */
export function assignShards(units: readonly Unit[], total: number): string[][] {
	if (!Number.isInteger(total) || total < 1) throw new Error(`a split into ${total} shares`);
	const order = new Map(units.map((u, i) => [u.key, i]));
	if (order.size !== units.length) throw new Error("a unit is listed twice");
	const load = new Array<number>(total).fill(0);
	const shares: Unit[][] = Array.from({ length: total }, () => []);
	const heaviest = [...units].sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	for (const unit of heaviest) {
		let lightest = 0;
		for (let i = 1; i < total; i++) if (load[i] < load[lightest]) lightest = i;
		load[lightest] += unit.weight;
		shares[lightest].push(unit);
	}
	return shares.map((share) =>
		share.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0)).map((u) => u.key),
	);
}

/**
 * The weight of each key: its timing, or for a key that has none (a test added since the timings were taken) the median
 * of the timings there are, so that a new part counts as a usual one rather than as nothing.
 */
export function weigh(keys: readonly string[], timings: Readonly<Record<string, number>>): Unit[] {
	const known = keys.map((k) => timings[k]).filter((t): t is number => typeof t === "number" && t >= 0);
	known.sort((a, b) => a - b);
	const median = known.length ? known[Math.floor(known.length / 2)] : 1;
	return keys.map((key) => {
		const t = timings[key];
		return { key, weight: typeof t === "number" && t >= 0 ? t : median };
	});
}

/** `--shard <index>/<total>` (1-based, as Playwright spells it), checked. */
export function parseShard(arg: string | undefined): { index: number; total: number } {
	const m = /^(\d+)\/(\d+)$/.exec(arg ?? "");
	const index = Number(m?.[1]);
	const total = Number(m?.[2]);
	if (!m || index < 1 || index > total) throw new Error(`--shard wants <index>/<total>, as 3/16, not "${arg ?? ""}"`);
	return { index, total };
}
