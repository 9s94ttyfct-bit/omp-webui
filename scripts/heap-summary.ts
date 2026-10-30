/**
 * What a heap snapshot (`.heapsnapshot`, from `scripts/long-run.ts --heap` or DevTools) holds, in a few lines:
 * the constructors that take the most memory, and the objects with the most properties or elements (a map that
 * grows without bound shows there by its size and its first keys).
 *
 *   bun scripts/heap-summary.ts <snapshot> [<other snapshot>]
 *
 * With two snapshots, the second is compared with the first: what grew.
 */
import { readFileSync } from "node:fs";

interface Summary {
	bySize: Map<string, { count: number; bytes: number }>;
	wide: { name: string; edges: number; keys: string[]; bytes: number }[];
	nodes: number;
}

function summarize(path: string): Summary {
	const raw = JSON.parse(readFileSync(path, "utf8")) as {
		snapshot: {
			meta: {
				node_fields: string[];
				node_types: (string[] | string)[];
				edge_fields: string[];
				edge_types: (string[] | string)[];
			};
		};
		nodes: number[];
		edges: number[];
		strings: string[];
	};
	const { meta } = raw.snapshot;
	const nf = meta.node_fields.length;
	const ef = meta.edge_fields.length;
	const field = (name: string) => meta.node_fields.indexOf(name);
	const [iType, iName, iSelf, iEdges] = [field("type"), field("name"), field("self_size"), field("edge_count")];
	const nodeTypes = meta.node_types[0] as string[];
	const edgeTypes = meta.edge_types[0] as string[];
	const eType = meta.edge_fields.indexOf("type");
	const eName = meta.edge_fields.indexOf("name_or_index");
	const bySize = new Map<string, { count: number; bytes: number }>();
	const wide: Summary["wide"] = [];
	let edgeAt = 0;
	const count = raw.nodes.length / nf;
	for (let n = 0; n < count; n++) {
		const base = n * nf;
		const type = nodeTypes[raw.nodes[base + iType]];
		const name = raw.strings[raw.nodes[base + iName]];
		const self = raw.nodes[base + iSelf];
		const edges = raw.nodes[base + iEdges];
		const key =
			type === "object" ? name : type === "string" || type === "concatenated string" ? "(string)" : `(${type})`;
		const slot = bySize.get(key) ?? { count: 0, bytes: 0 };
		slot.count++;
		slot.bytes += self;
		bySize.set(key, slot);
		if ((type === "object" || type === "array") && edges > 200) {
			const keys: string[] = [];
			for (let e = 0; e < Math.min(edges, 400) && keys.length < 4; e++) {
				const at = (edgeAt + e) * ef;
				if (edgeTypes[raw.edges[at + eType]] === "property") keys.push(raw.strings[raw.edges[at + eName]]);
			}
			wide.push({ name, edges, keys, bytes: self });
		}
		edgeAt += edges;
	}
	wide.sort((a, b) => b.edges - a.edges);
	return { bySize, wide: wide.slice(0, 12), nodes: count };
}

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
const [first, second] = process.argv.slice(2);
if (!first) throw new Error("usage: bun scripts/heap-summary.ts <snapshot> [<later snapshot>]");
const a = summarize(first);
const b = second ? summarize(second) : null;
const shown = b ?? a;
console.log(`${b ? second : first}: ${shown.nodes} nodes`);
const rows = [...shown.bySize.entries()]
	.map(([name, v]) => ({ name, ...v, before: a.bySize.get(name) }))
	.sort((x, y) => y.bytes - x.bytes)
	.slice(0, 14);
console.log(`\n${"constructor".padEnd(34)}${"count".padStart(10)}${"self size".padStart(12)}${b ? "   (was)" : ""}`);
for (const r of rows)
	console.log(
		`${r.name.slice(0, 33).padEnd(34)}${String(r.count).padStart(10)}${mb(r.bytes).padStart(12)}${b ? `   ${r.before ? `${r.before.count} / ${mb(r.before.bytes)}` : "-"}` : ""}`,
	);
console.log("\nobjects with the most properties or elements:");
for (const w of shown.wide)
	console.log(
		`  ${w.name.padEnd(16)} ${String(w.edges).padStart(7)} edges  ${mb(w.bytes).padStart(9)} self  e.g. ${w.keys.join(", ")}`,
	);
