/**
 * How the cost of `work` grows with the size of its input, for tests of "linear, not quadratic". An absolute time bound
 * fails on a busy machine and passes a slow enough regression on an idle one; the growth between two sizes of the same
 * input does not depend on how fast or busy the machine is. Cost is the process's CPU time (not the wall clock, which a
 * busy machine stretches by whatever it was doing elsewhere), the best of `runs` after one warm-up, for the input made at
 * `small` and at `big` times that size. Linear gives about `big / small`, quadratic about its square.
 */
export function growth(
	make: (size: number) => () => void,
	{ small, big, runs = 7 }: { small: number; big: number; runs?: number },
): number {
	const cost = (size: number): number => {
		const work = make(size);
		work();
		let best = Number.POSITIVE_INFINITY;
		for (let i = 0; i < runs; i++) {
			const from = process.cpuUsage();
			work();
			const used = process.cpuUsage(from);
			best = Math.min(best, (used.user + used.system) / 1000);
		}
		// A clock tick is a millisecond or so: below it the ratio would be noise.
		return Math.max(best, 1);
	};
	return cost(big) / cost(small);
}
