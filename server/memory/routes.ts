import { isAbsolute, relative, sep } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import {
	looksLikeSecret,
	MEMORY_CONTENT_MAX,
	MEMORY_KINDS,
	MEMORY_NAME,
	MEMORY_PAGE,
	MEMORY_PAGE_MAX,
	type MemoryDeleted,
	type MemoryDetail,
	type MemoryItem,
	type MemoryKind,
	type MemoryOverview,
	type MemoryQuery,
	type MemoryScope,
	parseImportance,
	type RetiredFilter,
} from "../../shared/memory.ts";
import type { ConfigRead } from "../omp/config-read.ts";
import { type MemorySettings, UNKNOWN_SETTINGS } from "./config.ts";
import {
	type BankFile,
	bankFiles,
	bankInfo,
	findBank,
	layoutOf,
	listMemories,
	MemoryError,
	type MemoryLayout,
	MemoryWriter,
	readMemory,
} from "./store.ts";

/**
 * `/api/memory*`: omp's long-term memory for the Memory page. Everything here is for a page on this computer: the route
 * refuses a page that came through the tunnel (`server/main.ts`), because what omp remembers is private (the paths of the
 * projects, what was said in conversations), and what it is made to remember is put into every later conversation's prompt.
 *
 *   GET  /api/memory                 the banks (global and per project), counts, and omp's own settings that matter
 *   GET  /api/memory/items?…         a page of memories, newest first (`q`, `scope`, `bank`, `kinds`, `retired`, `limit`, `offset`)
 *   GET  /api/memory/item?bank&id    one memory in full
 *   POST /api/memory/add             { scope, bank?, content, importance?, context? }
 *   POST /api/memory/update          { bank, id, etag, content?, importance? }
 *   POST /api/memory/retire          { bank, id, etag? }     omp stops recalling it; it stays in the bank
 *   POST /api/memory/restore         { bank, id, etag? }
 *   POST /api/memory/delete          { bank, id, etag }      working memories only
 *
 * How the store is read and changed, and why it is not through an omp command, is in `store.ts`.
 */

export interface MemoryDeps {
	agentDir: string;
	dataDir: string;
	/** omp's settings that locate and scope the store (`config.ts`); a function so that a test needs no omp. */
	settings: ConfigRead<MemorySettings> | { get(): Promise<MemorySettings | null> };
	writer?: MemoryWriter;
	clock?: () => Date;
}

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	});

/** A request body is a few thousand characters of text at most (a memory is capped at `MEMORY_CONTENT_MAX`). */
const BODY_MAX = 4 * MEMORY_CONTENT_MAX + 4096;

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);

export function parseQuery(params: URLSearchParams): MemoryQuery {
	const scope = params.get("scope");
	const kinds = params.has("kinds")
		? (params.get("kinds") ?? "")
				.split(",")
				.filter((k): k is MemoryKind => (MEMORY_KINDS as readonly string[]).includes(k))
		: [...MEMORY_KINDS];
	const retired = params.get("retired");
	const bank = params.get("bank") ?? "";
	const limit = Math.trunc(Number(params.get("limit")));
	const offset = Math.trunc(Number(params.get("offset")));
	return {
		q: (params.get("q") ?? "").trim().slice(0, 200),
		scope: scope === "global" || scope === "project" ? scope : "all",
		bank: MEMORY_NAME.test(bank) ? bank : "",
		kinds,
		retired: (retired === "retired" || retired === "all" ? retired : "active") satisfies RetiredFilter,
		limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MEMORY_PAGE_MAX) : MEMORY_PAGE,
		offset: Number.isFinite(offset) && offset > 0 ? Math.min(offset, 100_000) : 0,
	};
}

export class MemoryService {
	readonly #deps: MemoryDeps;
	readonly #writer: MemoryWriter;

	constructor(deps: MemoryDeps) {
		this.#deps = deps;
		this.#writer = deps.writer ?? new MemoryWriter(deps.dataDir, { clock: deps.clock });
	}

	#now(): string {
		return (this.#deps.clock?.() ?? new Date()).toISOString();
	}

	async #resolved(): Promise<{ settings: MemorySettings; known: boolean; layout: MemoryLayout }> {
		const read = await this.#deps.settings.get().catch(() => null);
		const settings = read ?? UNKNOWN_SETTINGS;
		return { settings, known: read !== null, layout: layoutOf(this.#deps.agentDir, settings.dbPath, settings.bank) };
	}

	async handle(req: Request, url: URL): Promise<Response> {
		try {
			return await this.#route(req, url);
		} catch (e) {
			if (e instanceof MemoryError) return json({ error: e.message, code: e.code }, e.status);
			return json({ error: `The memory could not be read or changed: ${(e as Error).message}` }, 500);
		}
	}

	async #route(req: Request, url: URL): Promise<Response> {
		const path = url.pathname;
		if (req.method === "GET") {
			if (path === "/api/memory") return json(await this.#overview());
			if (path === "/api/memory/items") return json(await this.#items(parseQuery(url.searchParams)));
			if (path === "/api/memory/item") return json(await this.#item(url.searchParams));
			return json({ error: "Not found" }, 404);
		}
		if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
		const declared = Number(req.headers.get("content-length") ?? 0);
		if (declared > BODY_MAX) throw new MemoryError("That request is too large.", "tooLong", 413);
		const body: unknown = await req.json().catch(() => null);
		if (!isRecord(body)) throw bad("The request has no JSON body.");
		switch (path) {
			case "/api/memory/add":
				return json(await this.#add(body));
			case "/api/memory/update":
				return json(await this.#update(body));
			case "/api/memory/retire":
				return json(await this.#retire(body, true));
			case "/api/memory/restore":
				return json(await this.#retire(body, false));
			case "/api/memory/delete":
				return json(await this.#delete(body));
			default:
				return json({ error: "Not found" }, 404);
		}
	}

	async #overview(): Promise<MemoryOverview> {
		const { settings, known, layout } = await this.#resolved();
		const now = this.#now();
		const files = bankFiles(layout);
		const banks = [];
		let hidden = 0;
		for (const file of files) {
			if (file.scratch) {
				hidden++;
				continue;
			}
			const info = bankInfo(file, now);
			// A project's bank with nothing in it has no folder to name it by and nothing to show.
			if (file.scope === "project" && info.error === undefined && info.working + info.episodic === 0) {
				hidden++;
				continue;
			}
			banks.push(info);
		}
		const shared = banks.find((b) => b.scope === "global");
		return {
			backend: settings.backend,
			scoping: settings.scoping,
			settingsKnown: known,
			present: files.some((f) => f.scope === "global"),
			dbPath: layout.sharedDb,
			unsupported: settings.relativePath ? "relativePath" : null,
			banks,
			hiddenBanks: hidden,
			canAddGlobal: shared !== undefined && shared.writeProblem === null && settings.scoping !== "per-project",
		};
	}

	async #items(query: MemoryQuery) {
		const { layout } = await this.#resolved();
		return listMemories(layout, query, this.#now());
	}

	/** The bank a body names, or throws the 404 for an unknown one. */
	async #bank(name: unknown): Promise<{ file: BankFile; layout: MemoryLayout }> {
		const { layout } = await this.#resolved();
		const file = findBank(layout, name);
		if (!file) throw new MemoryError("That bank is not in the store.", "notFound", 404);
		return { file, layout };
	}

	async #item(params: URLSearchParams): Promise<{ item: MemoryDetail }> {
		const id = params.get("id") ?? "";
		if (!MEMORY_NAME.test(id)) throw bad("Name the memory by its id.");
		const { file } = await this.#bank(params.get("bank"));
		const item = readMemory(file, id, this.#now());
		if (!item) throw new MemoryError("That memory is not in the store (any more).", "notFound", 404);
		return { item };
	}

	/**
	 * The memories omp keeps for the project in `cwd`, newest first, at most `limit` (the guidance conflict check reads
	 * them): every active note and consolidated memory of a project's bank whose memories were made in that folder, one
	 * inside it or one it is inside, and the shared bank's notes made there. Not the excerpts of conversations: they say
	 * what was said, not what holds.
	 */
	async forFolder(cwd: string, limit: number): Promise<MemoryItem[]> {
		const { layout } = await this.#resolved();
		const now = this.#now();
		const within = (parent: string, child: string): boolean => {
			const rel = relative(parent, child);
			return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
		};
		const related = (dir: string): boolean => within(dir, cwd) || within(cwd, dir);
		const items: MemoryItem[] = [];
		for (const file of bankFiles(layout)) {
			if (file.scratch) continue;
			const query: MemoryQuery = {
				q: "",
				scope: file.scope,
				bank: file.bank,
				kinds: ["note", "consolidated"],
				retired: "active",
				limit: MEMORY_PAGE_MAX,
				offset: 0,
			};
			if (file.scope === "project") {
				if (bankInfo(file, now).cwds.some(related)) items.push(...listMemories(layout, query, now).items);
			} else {
				const made = listMemories(layout, { ...query, kinds: ["note"] }, now).items;
				items.push(...made.filter((m) => m.provenance.cwd !== null && related(m.provenance.cwd)));
			}
		}
		items.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
		return items.slice(0, limit);
	}

	/** The memory as the body names it, read now. */
	async #current(body: Record<string, unknown>): Promise<{ file: BankFile; id: string; detail: MemoryDetail }> {
		const id = typeof body.id === "string" ? body.id : "";
		if (!MEMORY_NAME.test(id)) throw bad("Name the memory by its id.");
		const { file } = await this.#bank(body.bank);
		const detail = readMemory(file, id, this.#now());
		if (!detail) throw new MemoryError("That memory is not in the store (any more).", "notFound", 404);
		return { file, id, detail };
	}

	/** The token a change must carry, when it must carry one. */
	#etag(body: Record<string, unknown>, required: boolean): string | null {
		const etag = str(body.etag, 64);
		if (etag === null || etag === "") {
			if (required) throw bad("The change must carry the etag of the memory it was made on.");
			return null;
		}
		return etag;
	}

	/** A change is made only when omp could be asked where its store is and how it is scoped: a guess could write to the wrong store. */
	async #writable(): Promise<void> {
		if (!(await this.#resolved()).known) {
			throw new MemoryError(
				"omp's settings could not be read, so it is not known which store omp uses: nothing was changed. Try again in a moment.",
				"settings",
				503,
			);
		}
	}

	/** A text that looks like a key or token is saved only when the page says it was meant (omp's own writes redact them). */
	#noSecret(body: Record<string, unknown>, ...texts: string[]): void {
		if (body.acknowledgeSecret !== true && texts.some((t) => looksLikeSecret(t))) {
			throw new MemoryError(
				"The text looks like a key or token. A memory is put into the prompt of every later conversation: say that it is meant, or take it out.",
				"secret",
				409,
			);
		}
	}

	async #add(body: Record<string, unknown>): Promise<{ item: MemoryDetail; backedUp: boolean }> {
		await this.#writable();
		const scope: MemoryScope | null = body.scope === "global" || body.scope === "project" ? body.scope : null;
		if (scope === null) throw bad("Say whether the memory is global or a project's.");
		if (typeof body.content !== "string") throw bad("A memory needs some text.");
		if (body.content.length > MEMORY_CONTENT_MAX) throw tooLong();
		const content = body.content.trim();
		if (content === "") throw bad("A memory needs some text.");
		const importance = body.importance === undefined ? 0.75 : parseImportance(body.importance);
		if (importance === null) throw bad("Importance is a number from 0 to 1.");
		const context = body.context === undefined || body.context === null ? null : str(body.context, 400)?.trim() || null;
		this.#noSecret(body, content, context ?? "");
		let file: BankFile;
		let cwd: string | null = null;
		if (scope === "global") {
			const { layout: where, settings } = await this.#resolved();
			const shared = bankFiles(where).find((f) => f.scope === "global");
			if (!shared || settings.scoping === "per-project") {
				throw new MemoryError(
					"With omp's per-project scoping no memory is recalled by every project, so there is nowhere global to add one.",
					"noGlobal",
					409,
				);
			}
			file = shared;
		} else {
			file = (await this.#bank(body.bank)).file;
			if (file.scope !== "project") throw bad("That bank holds the global memories.");
			cwd = bankInfo(file, this.#now()).cwds[0] ?? null;
		}
		const { id, backedUp } = await this.#writer.add(file, { content, importance, context, cwd });
		return { item: this.#readBack(file, id), backedUp };
	}

	/** The memory as it is now, after a change (a change that cannot be read back is reported, not hidden). */
	#readBack(file: BankFile, id: string): MemoryDetail {
		const item = readMemory(file, id, this.#now());
		if (!item) throw new MemoryError("The memory was changed, but could not be read back.", "unreadable", 500);
		return item;
	}

	async #update(body: Record<string, unknown>) {
		await this.#writable();
		const etag = this.#etag(body, true) as string;
		const { file, id, detail } = await this.#current(body);
		if (!detail.editable) throw notEditable(detail, "rewritten");
		const change: { content?: string; importance?: number } = {};
		if (body.content !== undefined) {
			const content = str(body.content, MEMORY_CONTENT_MAX);
			if (content === null) throw tooLong();
			if (content.trim() === "") throw bad("A memory needs some text; delete it instead of emptying it.");
			if (content !== detail.content) change.content = content;
		}
		if (body.importance !== undefined) {
			const importance = parseImportance(body.importance);
			if (importance === null) throw bad("Importance is a number from 0 to 1.");
			if (importance !== detail.importance) change.importance = importance;
		}
		if (body.content === undefined && body.importance === undefined) throw bad("Nothing to change.");
		if (change.content !== undefined) this.#noSecret(body, change.content);
		if (detail.etag !== etag) throw stale();
		if (change.content === undefined && change.importance === undefined) return { item: detail, backedUp: false };
		const { backedUp } = await this.#writer.update(file, id, etag, change);
		return { item: this.#readBack(file, id), backedUp };
	}

	async #retire(body: Record<string, unknown>, retire: boolean) {
		await this.#writable();
		const etag = this.#etag(body, false);
		const { file, id, detail } = await this.#current(body);
		if (!detail.retirable) throw layout();
		if (etag !== null && detail.etag !== etag) throw stale();
		if (detail.retired === retire) return { item: detail, backedUp: false };
		const { backedUp } = await (retire ? this.#writer.retire(file, id, etag) : this.#writer.restore(file, id, etag));
		return { item: this.#readBack(file, id), backedUp };
	}

	async #delete(body: Record<string, unknown>): Promise<MemoryDeleted> {
		await this.#writable();
		const etag = this.#etag(body, true) as string;
		const { file, id, detail } = await this.#current(body);
		if (!detail.editable) throw notEditable(detail, "deleted");
		if (detail.etag !== etag) throw stale();
		const { backedUp } = await this.#writer.remove(file, id, etag, {
			retireConsolidated: body.retireConsolidated === true,
		});
		return { deleted: true, backedUp };
	}
}

function bad(message: string): MemoryError {
	return new MemoryError(message, "badRequest", 400);
}

const tooLong = () => new MemoryError(`A memory may hold at most ${MEMORY_CONTENT_MAX} characters.`, "tooLong", 413);

const stale = () =>
	new MemoryError(
		"That memory changed since it was opened here. Read it again, look at it, and try again.",
		"stale",
		409,
	);

const layout = () =>
	new MemoryError(
		"This memory database is in a layout this page does not change. Change it in omp, with its memory_edit tool.",
		"layout",
		409,
	);

/** Why a memory cannot be `verb`ed: a consolidated one is never (as in omp), and any in a layout this does not write. */
function notEditable(detail: MemoryDetail, verb: "rewritten" | "deleted"): MemoryError {
	return detail.store === "episodic"
		? new MemoryError(
				`A consolidated memory is not ${verb} (omp's own memory_edit does not either). Retire it instead.`,
				"notEditable",
				409,
			)
		: layout();
}
