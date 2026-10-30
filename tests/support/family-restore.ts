import type { KeptMember, SessionEntry, SessionFileData } from "../../shared/protocol.ts";

/**
 * The reference decoder of the whole-lineage answer of `/api/family` (a request without `view`): the page asks for windows
 * of the history now and no longer reads that answer, but the server still sends it to a client that does not know `view`
 * (a tab left open across an upgrade), and its tests check it can be put back together.
 *
 * A member the client held and the server found as it was comes only by name and `tag` (`KeptMember`): it is the one in `held`.
 *
 * A file that has an `order` (it shares entries with the files before it, which were sent once, or are held) gets its
 * entries from those, in the file's order, as the very same objects. A family in which no file has an `order` is returned
 * as it came, and no entry is looked at.
 */
export function restoreMembers(
	members: (SessionFileData | KeptMember)[],
	held: ReadonlyMap<string, SessionFileData> = new Map(),
): SessionFileData[] {
	const whole = members.every(isWhole) ? members : members.map((m) => (isWhole(m) ? m : heldMember(m, held)));
	if (!whole.some((m) => m.order)) return whole;
	const sent = new Map<string, SessionEntry>();
	for (const m of whole) for (const e of m.entries) if (!sent.has(e.id)) sent.set(e.id, e);
	return whole.map((m) => {
		if (!m.order) return m;
		const { order, ...file } = m;
		const entries: SessionEntry[] = [];
		for (const id of order) {
			const entry = sent.get(id);
			if (entry) entries.push(entry);
		}
		return { ...file, entries };
	});
}

function isWhole(m: SessionFileData | KeptMember): m is SessionFileData {
	return !("kept" in m);
}

function heldMember(m: KeptMember, held: ReadonlyMap<string, SessionFileData>): SessionFileData {
	const file = held.get(m.tag);
	if (!file) throw new Error(`The server kept ${m.file} (${m.tag}), which this page does not hold`);
	return file;
}
