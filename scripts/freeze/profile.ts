#!/usr/bin/env bun
/**
 * Where the server's one thread spent its time, from a `.cpuprofile` that `run.ts --cpu-prof` wrote:
 *
 *   bun scripts/freeze/profile.ts <file.cpuprofile> [--top 15]
 *
 * Prints the functions with the most self time (the time spent in the function itself, not in what it called), and the share of
 * the profile that was idle (the thread waiting for work), which is what a server that is not the problem mostly does. Each
 * sample is charged as DevTools charges it (scripts/lib/cpu-profile.ts).
 */
import { readFileSync } from "node:fs";
import { type CpuProfile, selfTimeByNode } from "../lib/cpu-profile.ts";

const file = process.argv[2];
if (!file) throw new Error("usage: profile.ts <file.cpuprofile> [--top N]");
const top = Number(process.argv[process.argv.indexOf("--top") + 1] || 15);
const profile: CpuProfile = JSON.parse(readFileSync(file, "utf8"));

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map<string, number>();
let total = 0;
for (const [id, us] of selfTimeByNode(profile)) {
	const frame = byId.get(id)?.callFrame;
	const name = frame?.functionName || "(anonymous)";
	const where = frame?.url ? `${frame.url.replace(/^.*\/omp-webui[^/]*\//, "")}:${frame.lineNumber + 1}` : "";
	const key = `${name} ${where}`.trim();
	self.set(key, (self.get(key) ?? 0) + us);
	total += us;
}

const idle = (self.get("(idle)") ?? 0) + (self.get("(program)") ?? 0);
console.log(
	`${file}: ${(total / 1e6).toFixed(1)} s profiled, ${((100 * idle) / total).toFixed(1)} % idle or native waiting`,
);
for (const [key, us] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
	console.log(
		`${((us / 1e3) | 0).toString().padStart(8)} ms  ${((100 * us) / total).toFixed(1).padStart(5)} %  ${key}`,
	);
}
