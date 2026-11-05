/**
 * A V8 CPU profile (`.cpuprofile`: `scripts/long-run.ts --profile`, `scripts/freeze/run.ts --cpu-prof`, the inspector's
 * `Profiler.stop`, DevTools), and the self time of each of its nodes: what scripts/cpu-summary.ts,
 * scripts/freeze/profile.ts and scripts/open-big.ts report, each in its own table.
 */

export interface CpuProfileNode {
	id: number;
	callFrame: { functionName: string; url: string; lineNumber: number };
	children?: number[];
}

export interface CpuProfile {
	nodes: CpuProfileNode[];
	startTime?: number;
	endTime?: number;
	samples?: number[];
	timeDeltas?: number[];
}

/**
 * The self time of each sampled node, µs, by node id. `timeDeltas[i]` is the gap before sample `i`, so a sample is charged
 * the time until the next one (how long the thread stayed in that frame), as Chrome DevTools charges it; the last sample,
 * the time until the profile's end when the profile has `startTime` and `endTime`, else nothing.
 */
export function selfTimeByNode(profile: CpuProfile): Map<number, number> {
	const samples = profile.samples ?? [];
	const deltas = profile.timeDeltas ?? [];
	// Where the last sample's time ends, when the profile says.
	const end = profile.startTime !== undefined ? profile.endTime : undefined;
	const self = new Map<number, number>();
	let at = profile.startTime ?? 0;
	for (const [i, id] of samples.entries()) {
		at += deltas[i] ?? 0;
		let us = deltas[i + 1] ?? 0;
		if (i === samples.length - 1 && end !== undefined) us = Math.max(0, end - at);
		self.set(id, (self.get(id) ?? 0) + us);
	}
	return self;
}
