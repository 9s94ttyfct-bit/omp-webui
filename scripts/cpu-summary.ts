/**
 * Where a CPU profile (`.cpuprofile`, from `scripts/long-run.ts --profile` or DevTools) spent its time: the functions
 * with the most self time, and the ones with the most time including what they call.
 *
 *   bun scripts/cpu-summary.ts <profile> [rows]
 */
import { readFileSync } from "node:fs";

interface Node {
	id: number;
	callFrame: { functionName: string; url: string; lineNumber: number };
	children?: number[];
}
const [path, rowsArg] = process.argv.slice(2);
if (!path) throw new Error("usage: bun scripts/cpu-summary.ts <profile> [rows]");
const profile = JSON.parse(readFileSync(path, "utf8")) as { nodes: Node[]; samples: number[]; timeDeltas: number[] };
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map<number, number>();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const self = new Map<number, number>();
for (const [i, id] of profile.samples.entries()) self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
const label = (n: Node) =>
	`${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url.split("/").at(-1)}:${n.callFrame.lineNumber}`;
const selfBy = new Map<string, number>();
const totalBy = new Map<string, number>();
for (const [id, us] of self) {
	const node = byId.get(id) as Node;
	selfBy.set(label(node), (selfBy.get(label(node)) ?? 0) + us);
	const seen = new Set<string>();
	for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
		const l = label(byId.get(cur) as Node);
		if (seen.has(l)) continue;
		seen.add(l);
		totalBy.set(l, (totalBy.get(l) ?? 0) + us);
	}
}
const wall = profile.timeDeltas.reduce((a, b) => a + b, 0);
const idle = selfBy.get("(idle) :-1") ?? 0;
const rows = Number(rowsArg ?? 22);
const show = (title: string, m: Map<string, number>) => {
	console.log(`\n${title} (profile ${(wall / 1e6).toFixed(1)} s, busy ${((wall - idle) / 1e6).toFixed(1)} s)`);
	for (const [l, us] of [...m]
		.filter(([k]) => !k.startsWith("(idle)"))
		.sort((a, b) => b[1] - a[1])
		.slice(0, rows))
		console.log(`${(us / 1000).toFixed(0).padStart(8)} ms  ${l}`);
};
show("self time", selfBy);
show("total time", totalBy);
