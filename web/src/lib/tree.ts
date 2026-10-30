import type { SessionEntry } from "@shared/protocol.ts";
import { appended } from "./lineage.ts";
import { roleOf } from "./messages.ts";

/**
 * Session tree helpers over omp's append-only `id`/`parentId` entries
 * (omp docs: session.md "Tree and Leaf Semantics").
 */

export interface TreeIndex {
	byId: Map<string, SessionEntry>;
	children: Map<string | null, SessionEntry[]>;
	order: Map<string, number>;
}

export function indexTree(entries: SessionEntry[]): TreeIndex {
	const byId = new Map<string, SessionEntry>();
	const children = new Map<string | null, SessionEntry[]>();
	const order = new Map<string, number>();
	entries.forEach((e, i) => {
		byId.set(e.id, e);
		order.set(e.id, i);
		const key = e.parentId ?? null;
		const list = children.get(key);
		if (list) list.push(e);
		else children.set(key, [e]);
	});
	return { byId, children, order };
}

/** Root → leaf path; bounded against corrupt cycles like omp's own walker. */
export function pathTo(idx: TreeIndex, leafId: string | null): SessionEntry[] {
	const out: SessionEntry[] = [];
	const seen = new Set<string>();
	let cur = leafId ? idx.byId.get(leafId) : undefined;
	while (cur && !seen.has(cur.id)) {
		seen.add(cur.id);
		out.push(cur);
		cur = cur.parentId ? idx.byId.get(cur.parentId) : undefined;
	}
	return out.reverse();
}

/**
 * `pathTo` for a leaf that moves on: the path to a leaf that came after the one before it, in the same tree, is that
 * path and the entries since (it is made with `appended`, so what is derived from the path can go on from where it
 * was). Any other leaf is walked from its own end to the root, as `pathTo` does.
 */
export class PathTracker {
	private last: { byId: Map<string, SessionEntry>; leaf: string | null; path: SessionEntry[] } | null = null;

	path(idx: TreeIndex, leafId: string | null): SessionEntry[] {
		const last = this.last;
		if (last && last.byId === idx.byId && last.leaf === leafId) return last.path;
		let path: SessionEntry[] | null = null;
		if (last && last.byId === idx.byId && last.leaf !== null && leafId !== null) {
			// Up from the new leaf: to the old one when the leaf came after it, else to the root (the whole path).
			const added: SessionEntry[] = [];
			let cur = idx.byId.get(leafId);
			// What the tree holds bounds the walk, as the cycle guard of `pathTo` does.
			let room = idx.byId.size;
			while (cur && cur.id !== last.leaf && room-- > 0) {
				added.push(cur);
				cur = cur.parentId ? idx.byId.get(cur.parentId) : undefined;
			}
			if (cur && cur.id === last.leaf) path = appended(last.path, added.reverse());
			else if (!cur && room > 0) path = added.reverse();
		}
		path ??= pathTo(idx, leafId);
		this.last = { byId: idx.byId, leaf: leafId, path };
		return path;
	}
}

/** Most recently appended entry inside the subtree rooted at `id`. */
export function latestLeafUnder(idx: TreeIndex, id: string): string {
	let best = id;
	let bestOrder = idx.order.get(id) ?? -1;
	const stack = [id];
	while (stack.length) {
		const cur = stack.pop() as string;
		for (const c of idx.children.get(cur) ?? []) {
			const o = idx.order.get(c.id) ?? -1;
			if (o > bestOrder) {
				best = c.id;
				bestOrder = o;
			}
			stack.push(c.id);
		}
	}
	return best;
}

/**
 * Alternatives for a message: entries sharing its parent with the same role
 * (an edited prompt or a regenerated reply). Sorted by append order.
 */
export function siblingsOf(idx: TreeIndex, entry: SessionEntry): SessionEntry[] {
	const r = roleOf(entry);
	if (!r) return [entry];
	const sibs = (idx.children.get(entry.parentId ?? null) ?? []).filter((e) => roleOf(e) === r);
	return sibs.length ? sibs : [entry];
}

/** Number of distinct leaves (conversation branches) in the whole tree. */
export function branchCount(idx: TreeIndex): number {
	let n = 0;
	for (const e of idx.byId.values()) if (!idx.children.get(e.id)?.length) n++;
	return n;
}
