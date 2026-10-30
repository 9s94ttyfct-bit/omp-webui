import type { FamilyDocument, FamilyView, SessionEntry, SessionFileData } from "@shared/protocol.ts";

/**
 * What the first page load needs of a conversation's history: the shape of the server's answer to a window, the check that
 * an answer is one, and where the server's figures of a file stand to the entries a page holds. The rest of the history
 * (`history.ts`, the stretch the page holds and how it grows) belongs to the conversation view, which is loaded later.
 */

/** A window the server answered: the document and the view it carries. */
export interface Answer {
	file: string;
	members: SessionFileData[];
	view: FamilyView;
}

/** The answer to a request with `view`, checked: a server that answered the lineage whole (it does not know `view`) is an error here. */
export function answerOf(doc: FamilyDocument): Answer {
	const members = doc.members.filter((m): m is SessionFileData => !("kept" in m));
	if (!doc.view || members.length !== doc.members.length)
		throw new Error("The server did not answer with a window of the history");
	return { file: doc.file, members, view: doc.view };
}

/**
 * What follows the entry `through` in `entries`: the entries the server's figures of a file (`FamilyStats`) do not include.
 * Null when `through` is not among them: the figures are of a file this list is not of, and are not used.
 */
export function entriesAfter(entries: readonly SessionEntry[], through: string | null): SessionEntry[] | null {
	if (through === null) return entries.slice();
	for (let i = entries.length - 1; i >= 0; i--) if (entries[i].id === through) return entries.slice(i + 1);
	return null;
}
