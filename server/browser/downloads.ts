import type { BrowserDownload } from "../../shared/browser-protocol.ts";
import type { AppDownload } from "./cef.ts";

/**
 * The built-in browser's downloads (docs/agents/browser.md, "Downloads"): each is the conversation's whose page started
 * it, decided at the first word of it, so that it stays that conversation's after its page closed. Kept in memory for
 * the server's run; a conversation keeps its newest `KEPT_PER_CONVERSATION`, never dropping one that is still running.
 * Where a download is saved stays here: pages are told its name only.
 */

/** Downloads kept per conversation. */
export const KEPT_PER_CONVERSATION = 50;

interface Entry {
	owner: string;
	path: string;
	item: BrowserDownload;
}

export class DownloadList {
	/** In the order first heard of. */
	private readonly entries = new Map<string, Entry>();

	/** `ownerOf`: the conversation of a page now (null: nobody's). `changed`: a conversation's list changed. */
	constructor(
		private readonly ownerOf: (targetId: string) => string | null,
		private readonly changed: (owner: string) => void,
	) {}

	update(d: AppDownload): void {
		let entry = this.entries.get(d.id);
		if (!entry) {
			const owner = this.ownerOf(d.targetId) ?? (d.openerId ? this.ownerOf(d.openerId) : null);
			if (!owner) return;
			entry = {
				owner,
				path: d.path,
				item: { id: d.id, name: d.name, state: d.state, received: 0, total: null, startedAt: Date.now() },
			};
			this.entries.set(d.id, entry);
		} else if (entry.item.state !== "progress") return;
		entry.path = d.path || entry.path;
		entry.item = {
			...entry.item,
			name: d.name || entry.item.name,
			state: d.state,
			received: d.received,
			total: d.total > 0 ? d.total : null,
			...(d.error ? { error: d.error } : {}),
		};
		this.trim(entry.owner);
		this.changed(entry.owner);
	}

	/** A conversation's downloads, newest first. */
	of(owner: string): BrowserDownload[] {
		const out: BrowserDownload[] = [];
		for (const e of this.entries.values()) if (e.owner === owner) out.push(e.item);
		return out.reverse();
	}

	get(id: string): Entry | null {
		return this.entries.get(id) ?? null;
	}

	/** The conversation's session file moved (omp `/move`): its downloads are the new file's. */
	rekey(from: string, to: string): void {
		for (const e of this.entries.values()) if (e.owner === from) e.owner = to;
	}

	/** The conversation is gone: its downloads are no page's to show (the files stay where they are). */
	forget(owner: string): void {
		for (const [id, e] of this.entries) if (e.owner === owner) this.entries.delete(id);
	}

	/** Past the limit, the conversation's oldest finished ones go. */
	private trim(owner: string): void {
		let over = -KEPT_PER_CONVERSATION;
		for (const e of this.entries.values()) if (e.owner === owner) over++;
		for (const [id, e] of this.entries) {
			if (over <= 0) return;
			if (e.owner !== owner || e.item.state === "progress") continue;
			this.entries.delete(id);
			over--;
		}
	}
}
