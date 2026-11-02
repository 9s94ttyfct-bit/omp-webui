import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Which conversation each page of the built-in browser is, and each conversation's token for its CDP proxy URL
 * (`/browser-cdp/<token>`, given to its omp as `browser.cdpUrl`). A conversation is its session file: pages outlive the
 * omp process that opened them (idle reaper, Reopen).
 *
 * Kept in `owners.json` with the engine's generation (a random id the engine gets at each start). A registry read back by
 * a server that restarted while the engine ran (CEF in the app) keeps every page's owner; one read after the engine
 * itself restarted drops them (those pages are gone) and keeps the tokens, which the conversations' overlays hold.
 *
 * Chrome wraps each page in a `tab` target (Puppeteer attaches to tabs, and finds the page inside): a tab is the owner of
 * the page it holds. Which page that is, CDP says only to a session attached to the tab, so the engine finds out
 * (`requestLink`) and the tab's events wait for it.
 */

/** What CDP says of a target (`Target.TargetInfo`), as far as owners need it. */
export interface TargetInfo {
	targetId: string;
	type: string;
	url?: string;
	title?: string;
	openerId?: string;
}

interface Saved {
	generation: string | null;
	tokens: Record<string, string>;
	targets: Record<string, string>;
}

export class PageRegistry {
	private generation: string | null = null;
	/** owner → token, and back. */
	private readonly tokens = new Map<string, string>();
	private readonly owners = new Map<string, string>();
	/** page targetId → owner. */
	private readonly targets = new Map<string, string>();
	/** Targets the engine has now (from its target discovery). */
	private readonly alive = new Map<string, TargetInfo>();
	/** tab targetId → the page it holds. */
	private readonly tabs = new Map<string, string>();
	/** Tabs whose page is being found. */
	private readonly linking = new Set<string>();
	/** Tabs found to hold no page (closing, crashed): nobody's, and not asked about again. */
	private readonly empty = new Set<string>();
	/** Pages being created whose id is not known yet: a target seen now may be one of them. */
	private creating = 0;
	private readonly settledFns = new Set<() => void>();
	private closer: ((targetId: string) => Promise<void>) | null = null;
	private linker: ((tabId: string) => Promise<void>) | null = null;

	constructor(private readonly file: string) {
		let saved: Saved | null = null;
		try {
			saved = JSON.parse(readFileSync(file, "utf8")) as Saved;
		} catch {
			saved = null;
		}
		for (const [owner, token] of Object.entries(saved?.tokens ?? {})) this.setToken(owner, token);
		for (const [targetId, owner] of Object.entries(saved?.targets ?? {})) this.targets.set(targetId, owner);
		this.generation = saved?.generation ?? null;
	}

	/**
	 * An engine started as `generation` (or the server met one that was running): the target owners are kept when it is
	 * the engine they were recorded for, dropped when it is a new one (their pages are gone). Tokens always stay.
	 */
	load(generation: string): void {
		if (this.generation !== generation) this.targets.clear();
		this.alive.clear();
		this.tabs.clear();
		this.linking.clear();
		this.empty.clear();
		this.generation = generation;
		this.save();
	}

	/** How the registry closes a page, and finds a tab's page, in the engine; null while no engine runs. */
	setEngine(engine: { close(targetId: string): Promise<void>; link(tabId: string): Promise<void> } | null): void {
		this.closer = engine ? (id) => engine.close(id) : null;
		this.linker = engine ? (id) => engine.link(id) : null;
	}

	tokenFor(owner: string): string {
		const known = this.tokens.get(owner);
		if (known) return known;
		const token = randomBytes(32).toString("base64url");
		this.setToken(owner, token);
		this.save();
		return token;
	}

	ownerOf(token: string): string | null {
		return this.owners.get(token) ?? null;
	}

	/** The conversation's pages the engine has now, in the order they were seen. */
	pagesOf(owner: string): string[] {
		return [...this.alive.values()]
			.filter((t) => t.type === "page" && this.targets.get(t.targetId) === owner)
			.map((t) => t.targetId);
	}

	/** The owner of a page, or of the tab that holds it. */
	ownerOfTarget(targetId: string): string | null {
		const page = this.tabs.get(targetId) ?? targetId;
		return this.targets.get(page) ?? null;
	}

	adopt(targetId: string, owner: string): void {
		if (this.targets.get(targetId) === owner) return;
		this.targets.set(targetId, owner);
		this.save();
	}

	/**
	 * The owner of a target, found now if it can be: it has one, the page that opened it does (it becomes that page's
	 * conversation's), or it is a tab whose page does. Null: nobody's, or not known yet (see `pending`; a tab's page is
	 * asked for here).
	 */
	resolve(info: TargetInfo): string | null {
		if (info.type === "tab") {
			const page = this.tabs.get(info.targetId);
			if (!page) {
				this.requestLink(info.targetId);
				return null;
			}
			const pageInfo = this.alive.get(page);
			return this.targets.get(page) ?? (pageInfo ? this.resolve(pageInfo) : null);
		}
		const known = this.targets.get(info.targetId);
		if (known) return known;
		const byOpener = info.openerId ? this.ownerOfTarget(info.openerId) : null;
		if (byOpener) {
			this.adopt(info.targetId, byOpener);
			return byOpener;
		}
		return null;
	}

	/** Whether a page is being created, or a tab's page found: a target with no owner may still get one. */
	get pending(): boolean {
		return this.creating > 0 || this.linking.size > 0;
	}

	/** A page is being created: until `created`, targets with no owner are held, not dropped. */
	creatingPage(): void {
		this.creating++;
	}

	/** The page asked for is made (`targetId`, owned by `owner`), or failed (null). */
	created(targetId: string | null, owner: string | null): void {
		if (targetId && owner) this.adopt(targetId, owner);
		this.creating = Math.max(0, this.creating - 1);
		this.settled();
	}

	/** Has the engine find which page a tab holds (once per tab). */
	requestLink(tabId: string): void {
		const link = this.linker;
		if (!link || this.tabs.has(tabId) || this.linking.has(tabId) || this.empty.has(tabId)) return;
		this.linking.add(tabId);
		void link(tabId)
			.catch(() => {})
			.finally(() => {
				this.linking.delete(tabId);
				if (!this.tabs.has(tabId)) this.empty.add(tabId);
				this.settled();
			});
	}

	/** The tab holds this page. */
	linkTab(tabId: string, page: TargetInfo): void {
		this.tabs.set(tabId, page.targetId);
		this.track(page);
	}

	/** Called whenever a creation or a tab's link settles: held targets can be decided. */
	onSettled(fn: () => void): () => void {
		this.settledFns.add(fn);
		return () => this.settledFns.delete(fn);
	}

	/** Called (once per tick) after the pages, their owners or their titles may have changed. */
	onChange(fn: () => void): () => void {
		this.changeFns.add(fn);
		return () => this.changeFns.delete(fn);
	}

	private readonly changeFns = new Set<() => void>();
	private changeQueued = false;

	private changed(): void {
		if (this.changeQueued) return;
		this.changeQueued = true;
		queueMicrotask(() => {
			this.changeQueued = false;
			for (const fn of [...this.changeFns]) fn();
		});
	}

	/** The engine has this target (discovery: created or changed). */
	track(info: TargetInfo): void {
		const before = this.alive.get(info.targetId);
		// A tab found empty is asked about again once it changes (it may hold a page by now).
		if (info.type === "tab" && before && before.url !== info.url) this.empty.delete(info.targetId);
		this.alive.set(info.targetId, { ...before, ...info });
		this.resolve(info);
		this.changed();
	}

	/** The engine's target is gone. */
	untrack(targetId: string): void {
		this.alive.delete(targetId);
		this.tabs.delete(targetId);
		// A tab whose page is gone no longer holds it: the page that replaces it is found again.
		for (const [tab, page] of this.tabs) if (page === targetId) this.tabs.delete(tab);
		this.empty.delete(targetId);
		if (this.targets.delete(targetId)) this.save();
		this.changed();
	}

	info(targetId: string): TargetInfo | null {
		return this.alive.get(targetId) ?? null;
	}

	/** The conversation's session file moved (omp `/move`): its pages and token are the new file's. */
	rekey(oldOwner: string, newOwner: string): void {
		const token = this.tokens.get(oldOwner);
		if (token) {
			this.tokens.delete(oldOwner);
			this.owners.delete(token);
			this.setToken(newOwner, token);
		}
		for (const [targetId, owner] of this.targets) if (owner === oldOwner) this.targets.set(targetId, newOwner);
		this.save();
	}

	/**
	 * The conversation was deleted or archived: its pages are closed. `forget` (deleted): its token goes too; an archived one
	 * keeps it, for its omp may still run.
	 */
	async closeOwner(owner: string, forget = true): Promise<void> {
		const mine = [...this.targets].filter(([, o]) => o === owner).map(([id]) => id);
		const token = forget ? this.tokens.get(owner) : undefined;
		if (token) {
			this.tokens.delete(owner);
			this.owners.delete(token);
		}
		for (const id of mine) this.targets.delete(id);
		this.save();
		const close = this.closer;
		if (close) await Promise.all(mine.filter((id) => this.alive.has(id)).map((id) => close(id).catch(() => {})));
	}

	private settled(): void {
		for (const fn of [...this.settledFns]) fn();
	}

	private setToken(owner: string, token: string): void {
		this.tokens.set(owner, token);
		this.owners.set(token, owner);
	}

	private save(): void {
		const saved: Saved = {
			generation: this.generation,
			tokens: Object.fromEntries(this.tokens),
			targets: Object.fromEntries(this.targets),
		};
		mkdirSync(dirname(this.file), { recursive: true });
		writeFileSync(`${this.file}.tmp`, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
		renameSync(`${this.file}.tmp`, this.file);
		this.changed();
	}
}
