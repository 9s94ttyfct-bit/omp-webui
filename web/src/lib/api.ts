import type { ApprovalMode } from "@shared/approval.ts";
import type { CompactAt, CompactSettings } from "@shared/compact-at.ts";
import type { DirListing } from "@shared/dirs.ts";
import type { ErrorParams } from "@shared/error-info.ts";
import type { SavedMac } from "@shared/macs.ts";
import type { ConversationModels } from "@shared/model-config.ts";
import type { ProjectGroups } from "@shared/project-groups.ts";
import type {
	CliHelp,
	CliInventory,
	FamilyStats,
	FamilyStatsDocument,
	SearchHit,
	SessionFileData,
	SessionSummary,
	SubagentFile,
	UsageReport,
} from "@shared/protocol.ts";
import type { ClaudeSlowMode, ConfigValue, SessionDefault, SessionSettings } from "@shared/session-defaults.ts";
import type { FileTransfer } from "@shared/transfer.ts";
import type { QuestionCounts } from "@shared/unattended.ts";
import type { UsageRange } from "@shared/usage-range.ts";
import type { ModelInfo } from "../store/live.ts";
import { type Answer, answerOf } from "./answer.ts";
import { isBlobHash } from "./blob.ts";

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
		readonly params?: ErrorParams,
	) {
		super(message);
	}
}

async function fail(res: Response): Promise<never> {
	const body = await res.json().catch(() => ({ error: res.statusText }));
	throw new ApiError(body.error ?? res.statusText, res.status, body.code, body.params);
}

async function get<T>(path: string): Promise<T> {
	const res = await fetch(path);
	if (!res.ok) return fail(res);
	return res.json();
}

export interface SearchAnswer {
	hits: SearchHit[];
	indexing: { indexed: number; total: number } | null;
	/**
	 * How much of the conversation the search named is in the server's index: null when the search named none, or when
	 * that conversation is wholly in the index (the answer is then everything in it).
	 */
	file: { indexed: number; total: number } | null;
}

/** omp's figures, when they were had (null: not said), and whether the server is bringing them up to date (#690). */
export interface StatsAnswer {
	stats: OmpStats;
	at: number | null;
	refreshing: boolean;
	/** The range asked could not be read from omp's database: these are omp's own last 24 hours (#714). */
	fallback: boolean;
}

export type SessionsAnswer =
	| { kind: "full"; sessions: SessionSummary[]; cursor: string | null }
	| { kind: "delta"; changed: SessionSummary[]; removed: string[]; cursor: string | null };

/** One window of a conversation's history (see `FamilyViewKind`). */
export type HistoryRequest =
	| { kind: "tail"; leaf?: string | null }
	| { kind: "before"; at: string }
	| { kind: "after"; at: string; leaf?: string | null }
	| { kind: "around"; at: string; leaf?: string | null };

/**
 * The latest ends of conversations the server sent with an ETag, oldest first. Asked again, the server is given the ETag, and
 * an end that did not change comes back as a 304 without a body: the very same answer is returned, so nothing downloads,
 * parses or renders again.
 */
const tails = new Map<string, { etag: string; answer: Answer }>();
/** An end is a window, not a conversation: a few are kept, for the conversation the reader goes back to. */
const KEPT_TAILS = 4;

/**
 * The end of a conversation that was asked for before the page that shows it was ready to ask: by the document, for a page
 * opened on a conversation's address (`web/index.html`), or by a click on a conversation in the list, before the code that
 * shows it is loaded. One at a time, and only for a moment: the question the page asks next, for the same end, is answered
 * with the response that is already on its way, so the time the page spent starting up is not spent waiting for the server.
 */
interface Early {
	url: string;
	/** Null: the request failed; the page asks again. */
	res: Promise<Response | null>;
	at: number;
	/** The end the browser held when it asked: a 304 is the answer to that one. */
	known: { etag: string; answer: Answer } | undefined;
}
declare global {
	/** Set by the document's own script (`web/index.html`): what it asked for, without `known`. */
	var __ompwEarly: Omit<Early, "known"> | undefined;
}
/** An early request nobody asked for in this long is forgotten (the page went elsewhere); a response is not kept for a later visit. */
const EARLY_MS = 30_000;
let early: Early | undefined;

function historyQuery(file: string, req: HistoryRequest): URLSearchParams {
	const q = new URLSearchParams({ file, view: req.kind });
	if ("at" in req) q.set("at", req.at);
	if ("leaf" in req && req.leaf) q.set("leaf", req.leaf);
	return q;
}

/** The end of the conversation `file`, asked for now: what `loadHistory` will be given for it a moment later. */
function prefetchTail(file: string): void {
	const q = historyQuery(file, { kind: "tail" });
	const url = `/api/family?${q}`;
	if (early?.url === url && Date.now() - early.at < EARLY_MS) return;
	const known = tails.get(q.toString());
	early = {
		url,
		res: fetch(url, { headers: known ? { "if-none-match": known.etag } : {} }).catch(() => null),
		at: Date.now(),
		known,
	};
}

/** The early response for `url`, once: from a click (`prefetchTail`) or the document's own request. Null when there is none. */
function takeEarly(url: string): { res: Promise<Response | null>; known: Early["known"] } | null {
	const mine = early ?? (globalThis.__ompwEarly ? { ...globalThis.__ompwEarly, known: undefined } : undefined);
	early = undefined;
	globalThis.__ompwEarly = undefined;
	if (!mine || mine.url !== url || Date.now() - mine.at > EARLY_MS) return null;
	return mine;
}

/**
 * A window of a conversation's history: the end of the path (`tail`), the stretch above or below an entry, or the one around
 * it. `file` is the conversation's file; the answer names its canonical path. A server that sends no ETag is simply asked in full each time.
 */
async function loadHistory(file: string, req: HistoryRequest, signal?: AbortSignal): Promise<Answer> {
	const q = historyQuery(file, req);
	const key = req.kind === "tail" ? q.toString() : null;
	const url = `/api/family?${q}`;
	let known = key ? tails.get(key) : undefined;
	let res: Response | null = null;
	const soon = key ? takeEarly(url) : null;
	if (soon) {
		res = await soon.res;
		// What a 304 means is what the browser held when it asked, which is not always what is held now.
		if (res) known = soon.known;
	}
	res ??= await fetch(url, { signal, headers: known ? { "if-none-match": known.etag } : {} });
	if (res.status === 304 && known && key) {
		// In use: the next end pushes out an older one, not this one.
		tails.delete(key);
		tails.set(key, known);
		return known.answer;
	}
	if (!res.ok) return fail(res);
	const answer = answerOf(await res.json());
	const etag = res.headers.get("etag");
	if (key) {
		tails.delete(key);
		if (etag) {
			tails.set(key, { etag, answer });
			for (const old of [...tails.keys()].slice(0, -KEPT_TAILS)) tails.delete(old);
		}
	}
	return answer;
}

/** What the whole file's entries add up to: the figures a page that holds only a stretch of it cannot sum. */
async function loadStats(file: string, signal?: AbortSignal): Promise<FamilyStats> {
	const res = await fetch(`/api/family?${new URLSearchParams({ file, view: "stats" })}`, { signal });
	if (!res.ok) return fail(res);
	return ((await res.json()) as FamilyStatsDocument).stats;
}

export interface Meta {
	ompVersion: string;
	serverVersion: string;
	agentDir: string;
	sessionsDir: string;
	home: string;
	/** The OS user name; the Feedback report leaves it out. */
	user: string;
	/** This page is not on this machine: it came in through the public hostname of the tunnel, or over a network address the server listens on (a remote page). */
	remote: boolean;
	/** What this page may do with the files of a conversation's folder (see `shared/transfer.ts`): `full` for a page on this computer, the setting on it for any other. A server of an earlier version leaves it out. */
	fileTransfer?: FileTransfer;
	/** Whether this page may open a shell in the panel's Terminal tab: always on this computer, the Remote access setting for any other. A server of an earlier version leaves it out. */
	shell?: boolean;
	/** This page is on the computer the server runs on: the server's own test for what only that computer may change. */
	local: boolean;
	/** The other Macs the server knows (#628): the sidebar's machine switcher is there once there is one. */
	macs: SavedMac[];
	/** How many questions of unattended mode wait for the person (#646), and in which conversations; kept current by the `questions` message. A server of an earlier version leaves it out. */
	questions?: QuestionCounts;
	/** Whether this machine can be held from idle sleep while a conversation works (#647): macOS's `caffeinate`. */
	keepAwakeAvailable?: boolean;
	/** The folder Ask agent for help's conversations run in (Settings, v0.13.0): told to a page on this computer only. */
	settingsHelpFolder?: string;
}

/** The permission mode new conversations start in: the user's choice, or null to follow omp's own setting (`omp`). */
export interface ApprovalDefault {
	mode: ApprovalMode | null;
	/** omp's own mode, as `omp config get` prints it (a newer omp's mode is none of `APPROVAL_MODES`); null: it did not say. */
	omp: string | null;
}

/** The permission mode a conversation without a running omp comes back in; `omp` names omp's own when it is none the page can set. */
export interface SavedApproval {
	mode: ApprovalMode | null;
	omp: string | null;
}

/**
 * Whether a failed turn waits out its provider's usage limit: omp's own `retry.waitForUsageReset` (`omp`; null when omp
 * could not be asked), and the choice made for the conversation asked about (`session`; null: it follows omp's).
 */
export interface UsageWait {
	omp: boolean | null;
	session: boolean | null;
}

/**
 * Where a conversation compacts (see `shared/compact-at.ts`): `omp` is omp's own default as its configuration has it
 * (`-1` in both settings: omp's default, the legacy reserve), `session` the point the conversation chose for itself
 * (null: it follows omp's).
 */
export interface CompactAtState {
	omp: CompactSettings | null;
	session: CompactAt | null;
}

/** What omp's configuration says for one conversation's session panel (see `controls.panelConfig`). */
export interface PanelConfigState {
	claudeSlow: ClaudeSlowMode | null;
	defaults: Record<string, ConfigValue> | null;
	/** Where omp compacts as the conversation's configuration has it, and what of its own decides over it; null where unread. */
	compact: { settings: CompactSettings; modelThreshold: string | null } | null;
}

/** What the server knows about the machine, for a bug report. */
export interface Diagnostics {
	os: string;
	mode: string;
}

/** A `/api/search` answer: the hits, and how much of the library (or of the one conversation named) they are from. */
async function searchAnswer(res: Response): Promise<SearchAnswer> {
	if (!res.ok) return fail(res);
	const progress = /^(\d+)\/(\d+)$/.exec(res.headers.get("x-search-index") ?? "");
	// A search that named one conversation says how much of it the answer is from, when it is not all of it.
	const covered = /^(\d+)\/(\d+)$/.exec(res.headers.get("x-search-file") ?? "");
	return {
		hits: await res.json(),
		indexing: progress ? { indexed: Number(progress[1]), total: Number(progress[2]) } : null,
		file: covered ? { indexed: Number(covered[1]), total: Number(covered[2]) } : null,
	};
}

const enc = encodeURIComponent;

export const api = {
	meta: () => get<Meta>("/api/meta"),
	/**
	 * The sidebar's project groups (#636), kept by the server in this app's data. It is read with the session list on
	 * every page (`store.loadSessions`), so it lives here with the other reads the first page makes; changing one is the
	 * lazy list's (`lib/project-groups.ts`).
	 */
	projectGroups: () => get<ProjectGroups>("/api/project-groups"),
	diagnostics: () => get<Diagnostics>("/api/diagnostics"),
	/** Whether the project repository is public (the server asks GitHub, cached); null when it cannot tell. */
	repoPublic: () => get<{ public: boolean | null }>("/api/repo"),
	/**
	 * The session list. With the cursor of an earlier answer the server sends only what changed since; an answer
	 * without a cursor (or one that is a plain array, as from any server that does not know cursors) is the whole list.
	 */
	sessions: async (since: string | null = null): Promise<SessionsAnswer> => {
		const res = await fetch("/api/sessions", since ? { headers: { "x-sessions-since": since } } : undefined);
		if (!res.ok) return fail(res);
		const body: SessionSummary[] | { changed?: SessionSummary[]; removed?: string[] } = await res.json();
		const cursor = res.headers.get("x-sessions-cursor");
		if (Array.isArray(body)) return { kind: "full", sessions: body, cursor };
		return { kind: "delta", changed: body.changed ?? [], removed: body.removed ?? [], cursor };
	},
	session: (file: string) => get<SessionFileData>(`/api/session?file=${enc(file)}`),
	subagents: (file: string) => get<SubagentFile[]>(`/api/subagents?file=${enc(file)}`),
	/**
	 * Without `file` the server caps hits per conversation; with it, that one conversation's hits come uncapped.
	 * `indexing` is set while the server is still building its search index: the hits are those of the files
	 * indexed so far. Aborting `signal` drops the request: the server skips a search nobody waits for.
	 */
	search: async (q: string, file?: string, signal?: AbortSignal): Promise<SearchAnswer> =>
		searchAnswer(await fetch(`/api/search?q=${enc(q)}${file ? `&file=${enc(file)}&limit=200` : ""}`, { signal })),
	/**
	 * The sidebar's search by what was said (#717): the best message of each of up to `limit` conversations, every word
	 * of `q` in any order.
	 */
	searchConversations: async (q: string, limit: number, signal?: AbortSignal): Promise<SearchAnswer> =>
		searchAnswer(await fetch(`/api/search?q=${enc(q)}&conversations=${limit}&all=1`, { signal })),
	/**
	 * omp's figures over `range` (#714). A plain ask is answered at once from what the server kept, `refreshing` while omp
	 * brings them up to date (#690); `wait` waits for that run; `force` runs `omp stats` again, which is a POST.
	 */
	stats: async (how: "kept" | "wait" | "force", range: UsageRange): Promise<StatsAnswer> => {
		const query = `range=${range}${how === "force" ? "&force=1" : how === "wait" ? "&wait=1" : ""}`;
		const res = await fetch(
			`/api/stats?${query}`,
			how === "force"
				? { method: "POST", headers: { "content-type": "application/json", "x-omp-webui": "1" }, body: "{}" }
				: undefined,
		);
		if (!res.ok) return fail(res);
		const at = Number(res.headers.get("x-stats-at"));
		return {
			stats: await res.json(),
			at: Number.isFinite(at) && at > 0 ? at : null,
			refreshing: res.headers.get("x-stats-refreshing") === "1",
			fallback: res.headers.get("x-stats-fallback") !== null,
		};
	},
	/** A window of a conversation's history: its end, the stretch above or below an entry, the one around it. */
	history: loadHistory,
	/** Ask for the end of a conversation now, before the page that shows it is up to ask: `history` takes the response. */
	prefetchTail,
	/** What the whole file's entries add up to (the cost and the time worked of a conversation of which a window is held). */
	historyStats: loadStats,
	/** omp's own list of models, which is what roles and presets are made of; `local`: the models the local server of Light's models serves. */
	models: (local = false) => get<ModelInfo[]>(`/api/models${local ? "?scope=local" : ""}`),
	usage: (provider: string, force = false) =>
		force
			? post<UsageReport[]>(`/api/usage?provider=${enc(provider)}&force=1`, {})
			: get<UsageReport[]>(`/api/usage?provider=${enc(provider)}`),
	files: (cwd: string, q: string) => get<string[]>(`/api/files?cwd=${enc(cwd)}&q=${enc(q)}`),
	cli: () => get<CliInventory>("/api/cli"),
	cliHelp: (cmd: string) => get<CliHelp>(`/api/cli/help?cmd=${enc(cmd)}`),
	dirs: (path: string) => get<DirListing>(`/api/dirs?path=${enc(path)}`),
	exportUrl: (file: string) => `/api/export?file=${enc(file)}`,
	blobUrl: (hash: string) => `/api/blob/${hash}`,
};

export async function downloadExport(file: string): Promise<void> {
	const res = await fetch(api.exportUrl(file), { method: "POST", headers: { "x-omp-webui": "1" } });
	if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
	const blob = await res.blob();
	const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "session.html";
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = name;
	a.click();
	URL.revokeObjectURL(a.href);
}

/** An image the session keeps outside its transcript (`blob:sha256:<hash>`), as base64 for sending it again. */
export async function blobBase64(hash: string): Promise<string> {
	// A reference is put in an address only if it is a sha256: see `lib/blob.ts`.
	if (!isBlobHash(hash)) throw new ApiError("Not a stored image", 400);
	const res = await fetch(api.blobUrl(hash));
	if (!res.ok) throw new ApiError((await res.json().catch(() => ({}))).error ?? res.statusText, res.status);
	const bytes = new Uint8Array(await res.arrayBuffer());
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
}

async function post<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json", "x-omp-webui": "1" },
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error ?? res.statusText);
	return data as T;
}

export const sessionActions = {
	pins: () => get<string[]>("/api/pins"),
	setPin: (file: string, pinned: boolean) => post<string[]>("/api/pins", { file, pinned }),
	favoriteModels: () => get<string[]>("/api/favorite-models"),
	setFavoriteModel: (model: string, on: boolean) => post<string[]>("/api/favorite-models", { model, on }),
	approvalDefault: () => get<ApprovalDefault>("/api/approval"),
	setApprovalDefault: (mode: ApprovalMode | null) => post<ApprovalDefault>("/api/approval", { mode }),
	sessionApproval: (file: string) => get<SavedApproval>(`/api/approval/session?file=${encodeURIComponent(file)}`),
	/** The model preset remembered for a conversation that has no running omp, else null. */
	sessionModels: (file: string) =>
		get<{ models: ConversationModels | null }>(`/api/model-preset/session?file=${encodeURIComponent(file)}`),
	/** omp's `retry.waitForUsageReset`, and with `file` the choice made for that conversation. */
	usageWait: (file: string | null) =>
		get<UsageWait>(`/api/usage-reset-wait${file === null ? "" : `?file=${encodeURIComponent(file)}`}`),
	setUsageWait: (enabled: boolean) => post<UsageWait>("/api/usage-reset-wait", { enabled }),
	/** `enabled` null: the conversation follows omp's setting again. */
	setSessionUsageWait: (file: string, enabled: boolean | null) =>
		post<UsageWait>("/api/usage-reset-wait/session", { file, enabled }),
	/** omp's own compaction point, and with `file` the point that conversation chose. */
	compactAt: (file: string | null) =>
		get<CompactAtState>(`/api/compact-at${file === null ? "" : `?file=${encodeURIComponent(file)}`}`),
	/** omp's own compaction point, as `omp config set` changes it; `at` null: omp's default again. */
	setCompactAt: (at: CompactAt | null) => post<CompactAtState>("/api/compact-at", { at }),
	/** `at` null: the conversation follows omp's configuration again. */
	setSessionCompactAt: (file: string, at: CompactAt | null) =>
		post<CompactAtState>("/api/compact-at/session", { file, at }),
	rename: (file: string, title: string) => post<{ ok: true }>("/api/session/rename", { file, title }),
	remove: (file: string) => post<{ ok: true }>("/api/session/delete", { file }),
	removeMany: (files: string[]) =>
		post<{ deleted: string[]; failed: { file: string; error: string }[] }>("/api/sessions/delete", { files }),
	archived: () => get<string[]>("/api/archive"),
	setArchived: (files: string[], archived: boolean) => post<string[]>("/api/archive", { files, archived }),
};

/** The conversation a control is for: its running process and/or its saved file. */
export interface ControlTarget {
	live: string | null;
	file: string | null;
}

/** What the page asks omp to do for a conversation, which the server has omp carry out (`/api/controls/*`). */
export const controls = {
	/** Make `markdown` (omp's `/todo edit` format) the todo list of a running conversation. */
	replaceTodos: (live: string, markdown: string) => post<{ ok: true }>("/api/controls/todos", { live, markdown }),
	/** A skill on or off for every conversation; `overridden` names the settings layer that decides for this folder. */
	setSkill: (target: ControlTarget, name: string, enabled: boolean) =>
		post<{ ok: true; overridden: string | null }>("/api/controls/skill", { ...target, name, enabled }),
	/** A plugin on or off; `reloaded`: the conversation's running omp has reloaded its plugins. */
	setPlugin: (target: ControlTarget, name: string, enabled: boolean, scope: string | null) =>
		post<{ ok: true; reloaded: boolean }>("/api/controls/plugin", { ...target, name, enabled, scope }),
	/**
	 * An MCP server of a running conversation on or off in the config it is defined in (`scope`: `user`, `project`).
	 * The running omp does not connect or drop servers after it started: the change applies once it is started anew.
	 */
	setMcpServer: (live: string, name: string, enabled: boolean) =>
		post<{ ok: true; changed: boolean; scope: string | null }>("/api/controls/mcp", { live, name, enabled }),
	/** End the conversation's omp so that it can be resumed anew; refused (409) while it is working or waiting. */
	endIfIdle: (live: string) => post<{ ok: true }>("/api/controls/restart", { live }),
	/** What a session control of a running conversation says becomes omp's global default; the other conversations keep what they have. */
	setDefault: (live: string, setting: SessionDefault, value: string) =>
		post<{ ok: true }>("/api/controls/default", { live, setting, value }),
	/**
	 * What omp's configuration says of the controls omp cannot report (auto-retry, cache warming) for the conversation's
	 * process, as it reads it; the conversation's own choices (`LiveInfo.sessionSettings`) are over it.
	 */
	settings: (live: string) => post<SessionSettings>("/api/controls/settings", { live }),
	/**
	 * What omp's configuration says that the controls show beside omp's state: `claudeSlow`, Claude's slow mode, which is
	 * omp's global setting whatever model the conversation runs on; null where there is nothing to show. `defaults`: what a
	 * new conversation in the folder starts with, by omp setting, for the stars; null where it could not be read.
	 * `compact`: where omp compacts as this conversation's configuration has it, and the per-model entry that decides over
	 * it (see `shared/compact-at.ts`); null where it could not be read.
	 */
	panelConfig: (live: string) => post<PanelConfigState>("/api/controls/panel-config", { live }),
	/** Claude's slow mode on or off in omp's global configuration, for every conversation and the terminal. */
	setClaudeSlow: (live: string, enabled: boolean) => post<{ ok: true }>("/api/controls/claude-slow", { live, enabled }),
};

// ---- `omp stats --json` (omp's own accounting) ----

export interface StatsBucket {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	errorRate: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	cacheRate: number;
	totalCost: number;
	/** `null` when no request of the bucket recorded a duration (omp sends no zero for that). */
	avgDuration: number | null;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
	firstTimestamp: number;
	lastTimestamp: number;
	model?: string;
	provider?: string;
	folder?: string;
	agentType?: string;
}

export interface OmpStats {
	overall: StatsBucket;
	byModel: StatsBucket[];
	byFolder: StatsBucket[];
	byAgentType?: StatsBucket[];
	timeSeries?: Array<Record<string, number | string>>;
	costSeries?: Array<Record<string, number | string>>;
	modelSeries?: Array<Record<string, number | string>>;
	modelPerformanceSeries?: Array<Record<string, number | string>>;
}
