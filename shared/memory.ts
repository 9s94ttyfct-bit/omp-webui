/**
 * omp's long-term memory (Mnemopi: the `memory.backend` omp's `retain`, `recall` and `memory_edit` tools work on), as the
 * Memory page and its server routes (`server/memory/`) speak of it.
 *
 * omp keeps it in SQLite files under its agent directory: one database for the memories every project recalls (the
 * shared bank, "global") and one per project (a bank, "project"). A database has two tables of memories: `working_memory`
 * (what the agent saved or retained: notes, and excerpts of conversations) and `episodic_memory` (what omp's sleep
 * consolidation made of the working ones). Words used here: a *bank* is one database, a *store* is one of its two tables.
 */

/** The memories every project recalls, or those of one project. */
export type MemoryScope = "global" | "project";

/** The table a memory is in. Only `working` ones can be rewritten or deleted (omp's own `memory_edit` is the same). */
export type MemoryStore = "working" | "episodic";

/**
 * What a memory is for the person reading the list: a `note` is something that was saved on purpose (the agent's `learn`
 * and `retain`, `/memory`'s save, this page), a `conversation` is an excerpt of a conversation that omp kept by itself,
 * and `consolidated` is what omp's sleep consolidation made of working ones.
 */
export type MemoryKind = "note" | "conversation" | "consolidated";
export const MEMORY_KINDS: readonly MemoryKind[] = ["note", "conversation", "consolidated"];

/** Who wrote it, from its `source`. `other` is a source this page does not know (its own text is shown). */
export type MemoryOrigin = "learn" | "retain" | "saved" | "web" | "conversation" | "consolidated" | "other";

/** The `source` omp's automatic retention gives the excerpts of a conversation. */
export const SOURCE_CONVERSATION = "coding-agent-transcript";
/** The `source` omp's consolidation gives the episodic memories it makes. */
export const SOURCE_CONSOLIDATED = "sleep_consolidation";
/** The `source` of a memory added on this page. */
export const SOURCE_WEB = "omp-webui";

export function originOf(source: string | null): MemoryOrigin {
	switch (source) {
		case "coding-agent-learn":
			return "learn";
		case "coding-agent-retain":
			return "retain";
		case "coding-agent-memory-command":
			return "saved";
		case SOURCE_WEB:
			return "web";
		case SOURCE_CONVERSATION:
			return "conversation";
		case SOURCE_CONSOLIDATED:
			return "consolidated";
		default:
			return "other";
	}
}

export function kindOf(store: MemoryStore, source: string | null): MemoryKind {
	if (store === "episodic") return "consolidated";
	return source === SOURCE_CONVERSATION ? "conversation" : "note";
}

/** A bank's name, and a memory's id: what omp makes them from, nothing else may reach a file path. */
export const MEMORY_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The longest text a memory may hold (omp keeps conversation excerpts of up to about 40,000 characters). */
export const MEMORY_CONTENT_MAX = 64_000;
/** How many characters of a memory the list shows; the whole text is asked for when one is opened. */
export const MEMORY_PREVIEW_CHARS = 600;
/** How many memories one answer lists, and the most a page may ask for. */
export const MEMORY_PAGE = 50;
export const MEMORY_PAGE_MAX = 200;

/** One database of memories. */
export interface MemoryBank {
	/** omp's name for it. The shared bank is named `default`, unless `mnemopi.bank` says another. */
	bank: string;
	scope: MemoryScope;
	/** What to call it: the folder's name for a project's bank (from the memories' own `cwd`), else the bank's name. */
	label: string;
	/** The folders the memories in it were made in, most used first. */
	cwds: string[];
	working: number;
	episodic: number;
	/** Of those, how many omp no longer recalls (retired by `memory_edit invalidate` or past their `valid_until`). */
	retired: number;
	bytes: number;
	/** Why this page will not write to it (a layout of omp's it does not know), or null when it will. */
	writeProblem: string | null;
	/** Why it could not be read at all (damaged, locked); counts above are 0 then. */
	error?: string;
}

/** What `GET /api/memory` says. */
export interface MemoryOverview {
	/** omp's `memory.backend`, or null when omp could not be asked. */
	backend: string | null;
	/** omp's `mnemopi.scoping`, or null when omp could not be asked. */
	scoping: string | null;
	/**
	 * Whether omp's settings could be read. When they could not, the store shown is the one omp is guessed to use (its agent
	 * directory), so the banks and paths below may be another than omp's: nothing is written until omp can be asked.
	 */
	settingsKnown: boolean;
	/** Whether the store's shared database exists: where it has never been written there is nothing to show. */
	present: boolean;
	/** The shared database's path (the banks of the projects are beside it). Shown to the person at this computer. */
	dbPath: string;
	/** Why the store cannot be shown at all (`mnemopi.dbPath` is a relative path, which omp resolves from its own folder). */
	unsupported: "relativePath" | null;
	banks: MemoryBank[];
	/** Banks that are not shown: the scratch ones of this app's own helper conversations, and the ones holding nothing. */
	hiddenBanks: number;
	/** Whether a memory can be added to the memories every project recalls (omp's `retain` can, with its own limit). */
	canAddGlobal: boolean;
}

/** Where a memory came from, as far as its own record says. */
export interface MemoryProvenance {
	source: string | null;
	origin: MemoryOrigin;
	/** The agent tool that saved it (`learn`, `retain`), for those. */
	tool: string | null;
	/** omp's own id of the conversation it was saved in; a page matches it with its list of conversations. */
	sessionId: string | null;
	/** The folder that conversation worked in. */
	cwd: string | null;
	/** Why the agent saved it, in its own words. */
	context: string | null;
}

/** One memory in a list: its text is cut to `MEMORY_PREVIEW_CHARS`. */
export interface MemoryItem {
	bank: string;
	id: string;
	store: MemoryStore;
	kind: MemoryKind;
	scope: MemoryScope;
	/** The text, or its beginning (see `truncated`). */
	content: string;
	/** The whole text's length in characters. */
	length: number;
	truncated: boolean;
	importance: number | null;
	/** When it was made (ISO), as omp recorded it. */
	createdAt: string | null;
	/** omp no longer recalls it. */
	retired: boolean;
	provenance: MemoryProvenance;
}

/** One memory as opened: the whole text and everything omp keeps of it. */
export interface MemoryDetail extends MemoryItem {
	veracity: string | null;
	memoryType: string | null;
	trustTier: string | null;
	author: string | null;
	consolidatedAt: string | null;
	validUntil: string | null;
	supersededBy: string | null;
	recallCount: number | null;
	lastRecalled: string | null;
	/** For a consolidated memory, the working ones it was made of (`exists`: still in the bank). */
	summaryOf: { id: string; exists: boolean }[];
	/** For a working memory, the consolidated ones made of it. */
	consolidatedInto: string[];
	/** The token a change must carry: it names the state this was read in, so a change made meanwhile is not overwritten. */
	etag: string;
	/** Whether this page can rewrite or delete it (working memories only, in a bank it will write to). */
	editable: boolean;
	/** Whether it can be retired or brought back (any memory, in a bank it will write to). */
	retirable: boolean;
}

export interface MemoryList {
	items: MemoryItem[];
	/** How many memories match (all pages). */
	total: number;
	/** The same filters but for the kind: how many of each kind match, so the chips can say what they would show. */
	counts: Record<MemoryKind, number>;
	/** Banks that could not be read (damaged, locked for too long): what they hold is not in the list. */
	unreadable: string[];
}

export type RetiredFilter = "active" | "retired" | "all";

/** What a page may ask the list for. */
export interface MemoryQuery {
	q: string;
	scope: MemoryScope | "all";
	bank: string;
	kinds: MemoryKind[];
	retired: RetiredFilter;
	limit: number;
	offset: number;
}

export const MEMORY_ERROR_CODES = [
	/** The store is not there (omp never saved a memory), or the bank is unknown. */
	"notFound",
	/** The request is not one this page's code would make. */
	"badRequest",
	/** The memory changed since the page read it (omp's consolidation, another change): read it again. */
	"stale",
	/** omp has the database locked for longer than a change may wait: try again. */
	"busy",
	/** The database's layout is not one this version knows how to change safely. */
	"layout",
	/** The memory is one omp itself does not rewrite or delete (a consolidated one): retire it instead. */
	"notEditable",
	/** The text is longer than a memory may be. */
	"tooLong",
	/** The memories every project recalls cannot be added to under this omp setting. */
	"noGlobal",
	/** The backup that must precede a change could not be made, so nothing was changed. */
	"backup",
	/** The database could not be read (damaged, or it is not a database). */
	"unreadable",
	/** omp's settings could not be read, so which store omp uses is not known: nothing is written. */
	"settings",
	/** The text looks like a key or token and was not explicitly acknowledged. */
	"secret",
] as const;
export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

/** What a change answers: the memory as it is now. */
export interface MemoryChanged {
	item: MemoryDetail;
	/** A copy of the bank's database was made before the change (always before a delete, and before an edit of a memory no copy holds yet). */
	backedUp: boolean;
}

export interface MemoryDeleted {
	deleted: true;
	backedUp: boolean;
}

/** `GET /api/memory/items` as a URL's query. */
export function queryString(query: Partial<MemoryQuery>): string {
	const p = new URLSearchParams();
	if (query.q) p.set("q", query.q);
	if (query.scope && query.scope !== "all") p.set("scope", query.scope);
	if (query.bank) p.set("bank", query.bank);
	if (query.kinds) p.set("kinds", query.kinds.join(","));
	if (query.retired && query.retired !== "active") p.set("retired", query.retired);
	if (query.limit) p.set("limit", String(query.limit));
	if (query.offset) p.set("offset", String(query.offset));
	return p.toString();
}

/**
 * What looks like a credential: omp's own redactor for memory writes (`memory-backend/redact.ts`: the fixed-prefix provider
 * tokens, and a keyword such as `password`, `token` or `key` followed by a long run of letters and digits) and the prefixes
 * its stream redactor adds, a JWT, a connection URL with a password, and a PEM private key.
 */
const KEYWORDS = "password|secret|token|key|tok|sk|pk|rk";
const SECRET_PATTERNS: readonly RegExp[] = [
	/(?:AKIA|ASIA)[A-Z0-9]{16}/,
	/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
	/github_pat_[A-Za-z0-9_]{20,}/,
	/glpat-[A-Za-z0-9_-]{16,}/,
	/npm_[A-Za-z0-9]{30,}/,
	/xox[baprs]-[A-Za-z0-9-]{10,}/,
	/AIza[A-Za-z0-9_-]{30,}/,
	/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/,
	/(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
	/\bwhsec_[A-Za-z0-9]{16,}/,
	/\bhf_[A-Za-z0-9]{30,}/,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	// The scheme is bounded (32 characters, as a scheme's may be): an unbounded one is quadratic on a long run of `a.a.`.
	/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^/:@?#\s]*:[^/?#@\s]+@/i,
	new RegExp(`(?<![A-Za-z0-9])(?:${KEYWORDS})[-_](?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{12,}`, "i"),
	new RegExp(`(?<![A-Za-z0-9])(?:${KEYWORDS})[-_][A-Za-z]{16,}`, "i"),
];

/**
 * Whether `text` holds something shaped like a credential (omp's own writes redact these; this page does not rewrite
 * what a person typed, so it warns). A memory is put into the prompt of every later conversation, and so is sent to the
 * model's provider each time.
 */
export function looksLikeSecret(text: string): boolean {
	return SECRET_PATTERNS.some((p) => p.test(text));
}

/** `text` as a number from 0 to 1 (omp's importance), or null when it is none. */
export function parseImportance(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.min(1, Math.max(0, value));
}
