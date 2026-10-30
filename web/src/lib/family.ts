import type { SessionEntry, SessionFileData, SessionSummary } from "@shared/protocol.ts";
import { extension, track } from "./lineage.ts";
import { ToolResultLog, type ToolResults, toolResultsById } from "./messages.ts";
import { indexTree, latestLeafUnder, type TreeIndex } from "./tree.ts";

/**
 * A conversation family: the session files linked by `parentSession`
 * (created by omp's `branch`/`fork`). Their shared prefixes keep entry ids,
 * so the union is one tree whose sibling branches may live in different files.
 *
 * The page holds a stretch of the viewed file's path (see `lib/history.ts`), not the whole of it: the tree is what that
 * stretch, the other versions the server named and the live process's entries make. An entry whose parent is not in it
 * is where the stretch begins.
 */
export interface Family {
	idx: TreeIndex;
	/** Files containing each entry id (of the entries the page holds). */
	filesOf: Map<string, string[]>;
	/** Last physical entry of each file (omp rebuilds the leaf from it on load). */
	headOf: Map<string, string>;
	files: SessionFileData[];
	/** The saved result of each tool call of the family. */
	toolResults: ToolResults;
	/** Where each version of an entry leads: the newest entry under it and the files that hold that (see `VersionGroup.leads`). */
	leads: ReadonlyMap<string, Lead>;
}

/** The newest entry under an entry, and the files that hold it. */
export interface Lead {
	leaf: string;
	files: string[];
}

/** What the tree holds besides the files' entries: the other versions of the entries the server named, and where they lead. */
export interface Extras {
	entries: SessionEntry[];
	leads: ReadonlyMap<string, Lead>;
}

const NO_EXTRAS: Extras = { entries: [], leads: new Map() };

/**
 * The entries of a file as the page has them when a process is running on it: what it sent, from where it sent it. A
 * process that was continued from the stretch the page held sends the stretch's last entries again, which is where it
 * joins; one that sent the whole file replaces what the page held; one whose first entry the stretch does not hold (the
 * stretch is a window far from the end, which the process, that sent the end, does not reach) is added to it, the stretch
 * staying as the reader has it.
 */
function withLive(held: SessionEntry[], live: SessionEntry[]): SessionEntry[] {
	const first = live[0];
	const at = first ? held.findIndex((e) => e.id === first.id) : -1;
	if (at === 0) return live;
	return at < 0 ? held.concat(live) : held.slice(0, at).concat(live);
}

/** The first of two timestamps, by the order the family sorts by. */
const before = (a: string, b: string): boolean => a < b;

/**
 * Builds a family, and builds it again as the live file grows: the entries appended to it since the last build are added
 * to the tree where they belong (after everything there is: they are the newest) instead of sorting and indexing
 * all of them again. Whatever else changes (another family, a rewritten entry, an entry that is not simply the
 * newest, or one that forks the tree) is built from the start, exactly as `buildFamily` always did.
 */
export class FamilyBuilder {
	private built: {
		files: SessionFileData[];
		liveFile: string | null;
		liveEntries: SessionEntry[];
		extras: Extras;
		family: Family;
		log: ToolResultLog;
		/** The newest timestamp in the tree: what an appended entry must not be older than. */
		newest: string;
	} | null = null;

	update(
		files: SessionFileData[],
		liveFile: string | null,
		liveEntries: SessionEntry[],
		extras: Extras = NO_EXTRAS,
	): Family {
		const prev = this.built;
		if (
			prev &&
			prev.files === files &&
			prev.liveFile === liveFile &&
			prev.extras === extras &&
			prev.liveEntries.length > 0
		) {
			const from = extension(prev.liveEntries, liveEntries);
			if (from === liveEntries.length) return prev.family;
			if (from !== null) {
				const grown = this.extend(prev, liveEntries, from);
				if (grown) return grown;
			}
		}
		return this.rebuild(files, liveFile, liveEntries, extras);
	}

	/** The family with `liveEntries` from `from` on added; null when they do not simply go after the tree (nothing is changed then). */
	private extend(prev: NonNullable<FamilyBuilder["built"]>, liveEntries: SessionEntry[], from: number): Family | null {
		const { idx, filesOf, headOf } = prev.family;
		const liveFile = prev.liveFile;
		if (liveFile === null) return null;
		// Checked before anything is added: an entry that does not belong at the end leaves the tree as it was.
		let newest = prev.newest;
		const ids = new Set<string>();
		const parents = new Set<string | null>();
		for (let i = from; i < liveEntries.length; i++) {
			const e = liveEntries[i];
			const parent = e.parentId ?? null;
			if (idx.byId.has(e.id) || ids.has(e.id) || before(e.timestamp, newest)) return null;
			// An entry whose parent has children already (or two with one parent) is another version of one: the segments around it change.
			if (idx.children.get(parent)?.length || parents.has(parent)) return null;
			ids.add(e.id);
			parents.add(parent);
			newest = e.timestamp;
		}
		for (let i = from; i < liveEntries.length; i++) {
			const e = liveEntries[i];
			if (!prev.log.add(e)) {
				// The log took some of them and cannot take this one: it is no good for what follows.
				this.built = null;
				return null;
			}
			idx.byId.set(e.id, e);
			idx.order.set(e.id, idx.order.size);
			const key = e.parentId ?? null;
			const list = idx.children.get(key);
			if (list) list.push(e);
			else idx.children.set(key, [e]);
			filesOf.set(e.id, [liveFile]);
		}
		const last = liveEntries.at(-1);
		if (last) headOf.set(liveFile, last.id);
		const family: Family = { ...prev.family, idx: { ...idx }, toolResults: prev.log.snapshot() };
		this.built = { ...prev, liveEntries, newest, family };
		return family;
	}

	private rebuild(
		files: SessionFileData[],
		liveFile: string | null,
		liveEntries: SessionEntry[],
		extras: Extras,
	): Family {
		const merged = new Map<string, SessionEntry>();
		const filesOf = new Map<string, string[]>();
		const headOf = new Map<string, string>();
		const add = (file: string, entries: SessionEntry[]) => {
			for (const e of entries) {
				if (!merged.has(e.id)) merged.set(e.id, e);
				const list = filesOf.get(e.id);
				if (!list) filesOf.set(e.id, [file]);
				else if (!list.includes(file)) list.push(file);
			}
			const last = entries.at(-1);
			if (last) headOf.set(file, last.id);
		};
		const running = liveFile !== null && liveEntries.length > 0;
		for (const f of files) {
			// The file a process runs on: what it sent, from where it sent it, after the stretch the page held above.
			add(f.file, f.file === liveFile && running ? withLive(f.entries, liveEntries) : f.entries);
			// The server says which entry ends a file; the page holds a stretch of the path, which need not end there.
			if (f.head && !(f.file === liveFile && running)) headOf.set(f.file, f.head);
		}
		if (running && !files.some((f) => f.file === liveFile)) add(liveFile, liveEntries);
		for (const e of extras.entries) if (!merged.has(e.id)) merged.set(e.id, e);
		// Chronological order so `latestLeafUnder` prefers the most recent work across files.
		const ordered = [...merged.values()].sort((a, b) =>
			a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
		);
		const log = new ToolResultLog();
		let consistent = true;
		for (const e of ordered) consistent = log.add(e) && consistent;
		// Two results for one call: the one `toolResultsById` keeps (the last), which a log cannot say beside the other.
		const toolResults: ToolResults = consistent ? log.snapshot() : toolResultsById(ordered);
		const family: Family = { idx: indexTree(ordered), filesOf, headOf, files, toolResults, leads: extras.leads };
		const newest = ordered.at(-1)?.timestamp ?? "";
		// A live file that gave no entries yet, or a log that cannot take more: the next update builds again.
		track(liveEntries);
		this.built = consistent ? { files, liveFile, liveEntries, extras, family, log, newest } : null;
		return family;
	}
}

export function buildFamily(
	files: SessionFileData[],
	liveFile: string | null,
	liveEntries: SessionEntry[],
	extras?: Extras,
): Family {
	return new FamilyBuilder().update(files, liveFile, liveEntries, extras);
}

/** Where to go to show the newest conversation under `entryId`: what the server said it leads to, else the newest entry of the tree under it. */
export function destinationFor(
	fam: Family,
	entryId: string,
	preferFile: string | null,
): { file: string; leaf: string } | null {
	const lead = fam.leads.get(entryId);
	const leaf = lead?.leaf ?? latestLeafUnder(fam.idx, entryId);
	const files = lead?.files ?? fam.filesOf.get(leaf) ?? [];
	if (!files.length) return null;
	const file = preferFile && files.includes(preferFile) ? preferFile : files[files.length - 1];
	return { file, leaf };
}

/**
 * What decides whether `file`'s family has to be fetched again, read from the session list alone: the family's
 * member files (found the way the server finds them, by `parentSession`: a path, an id or a file name), each with
 * its modification time and size. A write to a conversation outside the family leaves it as it was, so does the
 * order of the list. `ownFile` is the conversation this page runs a process on: its entries arrive live, so only
 * whether its file exists counts, not what is in it.
 */
export function familySignature(sessions: readonly SessionSummary[], file: string, ownFile: string | null): string {
	const byFile = new Map(sessions.map((s) => [s.file, s]));
	const byId = new Map(sessions.map((s) => [s.id, s.file]));
	const byName = new Map(sessions.map((s) => [s.file.split(/[\\/]/).pop() ?? s.file, s.file]));
	const parentOf = (f: string): string | null => {
		const p = byFile.get(f)?.parentSession;
		if (!p) return null;
		if (byFile.has(p)) return p;
		return byId.get(p) ?? byName.get(p.split(/[\\/]/).pop() ?? p) ?? null;
	};
	let root = file;
	const climbed = new Set([root]);
	for (let p = parentOf(root); p && !climbed.has(p); p = parentOf(p)) {
		climbed.add(p);
		root = p;
	}
	const children = new Map<string, string[]>();
	for (const s of sessions) {
		const p = parentOf(s.file);
		if (p) children.set(p, [...(children.get(p) ?? []), s.file]);
	}
	const members = new Set<string>();
	const stack = [root];
	while (stack.length) {
		const f = stack.pop() as string;
		if (members.has(f)) continue;
		members.add(f);
		stack.push(...(children.get(f) ?? []));
	}
	members.add(file);
	return [...members]
		.sort()
		.map((f) => {
			const s = byFile.get(f);
			if (f === ownFile) return `${f}\t${s ? "live" : "unwritten"}`;
			return s ? `${f}\t${s.modifiedAt}:${s.size}` : `${f}\tunlisted`;
		})
		.join("\n");
}

/**
 * Whether `file` is one omp has named but not written yet: the file of a process this page runs, which omp reports as
 * soon as the process starts and writes with the first assistant message, and that the session list does not hold.
 * `/api/family` and `/api/subagents` answer 404 for such a file, and the browser logs a red error for each, so the page
 * does not ask: `familySignature` changes when the list gains the file, and that asks. Until the list has loaded nothing
 * is known, so the process's own file waits for it too. A file no process of this page runs is always asked for: a
 * link to a missing conversation shows its error.
 */
export function unwrittenOwnFile(
	sessions: readonly SessionSummary[],
	sessionsLoaded: boolean,
	file: string,
	ownsFile: boolean,
): boolean {
	return ownsFile && !(sessionsLoaded && sessions.some((s) => s.file === file));
}
