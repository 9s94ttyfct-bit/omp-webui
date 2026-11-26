import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type {
	DiskConversation,
	DiskFolderState,
	DiskRow,
	DiskScanState,
	DiskSpaceAnswer,
} from "../../shared/disk-space.ts";
import { isWithin } from "../sessions/cleanup-rules.ts";
import type { RowPlan } from "./rows.ts";

/**
 * The Disk space page's sizes (docs/superpowers/specs/2026-11-26-disk-space-page-design.md, "What is measured"): one
 * background scan at a time, one folder at a time, each in its time; what it measured kept in a cache file, by real path,
 * across restarts and across changes of the projects folder.
 */

/** How long one folder may take, a whole scan, and how old the last scan is before opening the page starts another. */
export const FOLDER_MS = 30_000;
export const SCAN_MS = 300_000;
export const STALE_MS = 600_000;
/** How long one conversation's artifacts folder may take. */
const CONVERSATION_MS = 10_000;

export interface PlannedConversation {
	title: string;
	modifiedAt: number;
	/** The transcript's size, as the store knows it. */
	size: number;
}

export interface DiskSpaceDeps {
	/** The rows as they are now, and the conversations they name. */
	plan(): Promise<{ rows: RowPlan[]; conversations: Map<string, PlannedConversation> }>;
	/** Allocated bytes at `path` (0 when nothing is there); null when not measured within `budgetMs`. */
	du(path: string, budgetMs: number): Promise<number | null>;
	/** A transcript's size now. */
	fileBytes(file: string): number;
	/** A folder's modification time; null when it cannot be read. */
	folderMtime(real: string): number | null;
	now(): number;
	free(): { free: number; total: number } | null;
}

interface Cache {
	version: 1;
	finishedAt: number | null;
	/** By real path: the folder's bytes (its conversations' files in it left out), null when it took too long. */
	folders: Record<string, { bytes: number | null; at: number }>;
	/** By transcript: its bytes and its artifacts folder's, measured while it had this modification time. */
	conversations: Record<string, { mtime: number; bytes: number }>;
}

const emptyCache = (): Cache => ({ version: 1, finishedAt: null, folders: {}, conversations: {} });

/** A conversation's artifacts folder: its transcript's path without `.jsonl`. */
const artifactsOf = (file: string) => file.replace(/\.jsonl$/, "");

const measurable = (r: RowPlan): r is RowPlan & { real: string } => r.kind !== "protected" && r.real !== null;

export class DiskSpace {
	private cache: Cache;
	private running: Promise<void> | null = null;
	private progress: DiskScanState = { running: false, startedAt: null, finishedAt: null, done: 0, total: 0 };
	/** While a scan runs, the paths forgotten (cleaned up) since it started. */
	private forgottenDuring: string[] | null = null;

	constructor(
		private readonly cacheFile: string,
		private readonly deps: DiskSpaceDeps,
	) {
		this.cache = this.load();
		this.progress.finishedAt = this.cache.finishedAt;
	}

	async answer(): Promise<DiskSpaceAnswer> {
		const { rows, conversations } = await this.deps.plan();
		return { rows: rows.map((r) => this.row(r, conversations)), scan: { ...this.progress }, disk: this.deps.free() };
	}

	/** The conversations of the row of `folder`, newest first; empty when there is no such row. */
	async conversationsOf(folder: string): Promise<DiskConversation[]> {
		const { rows, conversations } = await this.deps.plan();
		const row = rows.find((r) => r.folder === folder);
		if (!row) return [];
		const out: DiskConversation[] = [];
		for (const file of row.files) {
			const c = conversations.get(file);
			if (c) out.push({ file, title: c.title, modifiedAt: c.modifiedAt, bytes: this.conversationBytes(file, c) });
		}
		return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
	}

	/** Start a scan; false when one runs. */
	scan(): boolean {
		if (this.running) return false;
		this.progress = {
			running: true,
			startedAt: this.deps.now(),
			finishedAt: this.progress.finishedAt,
			done: 0,
			total: 0,
		};
		this.forgottenDuring = [];
		this.running = this.run()
			.catch(() => {})
			.finally(() => {
				const at = this.deps.now();
				this.progress = { ...this.progress, running: false, finishedAt: at };
				this.cache.finishedAt = at;
				this.save();
				this.running = null;
				// Something was cleaned up while it ran: what it measured there may be from before, so it is measured again.
				const again = (this.forgottenDuring?.length ?? 0) > 0;
				this.forgottenDuring = null;
				if (again) this.scan();
			});
		return true;
	}

	/** Start a scan when none ran yet or the last finished over STALE_MS ago. */
	scanIfStale(): void {
		const last = this.progress.finishedAt;
		if (last === null || this.deps.now() - last > STALE_MS) this.scan();
	}

	/** Forget what was measured at these paths (and of conversations in them): they are measured again. */
	forget(paths: string[]): void {
		this.forgottenDuring?.push(...paths);
		for (const p of paths) {
			for (const k of Object.keys(this.cache.folders)) if (isWithin(k, p)) delete this.cache.folders[k];
			for (const k of Object.keys(this.cache.conversations))
				if (k === p || isWithin(k, p)) delete this.cache.conversations[k];
		}
		this.save();
	}

	/** The running scan's end (tests). */
	async done(): Promise<void> {
		await this.running;
	}

	private row(r: RowPlan, conversations: Map<string, PlannedConversation>): DiskRow {
		let conversationBytes = 0;
		let newest: number | null = null;
		let count = 0;
		for (const file of r.files) {
			const c = conversations.get(file);
			if (!c) continue;
			count++;
			conversationBytes += this.conversationBytes(file, c);
			if (newest === null || c.modifiedAt > newest) newest = c.modifiedAt;
		}
		const cached = r.real === null ? undefined : this.cache.folders[r.real];
		const state: DiskFolderState =
			r.kind === "protected"
				? "notMeasured"
				: r.real === null
					? "gone"
					: !cached
						? "pending"
						: cached.bytes === null
							? "unknown"
							: "measured";
		return {
			folder: r.folder,
			real: r.real,
			name: basename(r.folder) || r.folder,
			kind: r.kind,
			folderBytes: state === "measured" ? (cached?.bytes ?? null) : null,
			folderState: state,
			measuredAt: state === "measured" || state === "unknown" ? (cached?.at ?? null) : null,
			conversations: count,
			conversationBytes,
			lastUsed: newest ?? (r.real === null ? null : this.deps.folderMtime(r.real)),
		};
	}

	/** A conversation's bytes: as the last scan measured them while it is unchanged, else its transcript's size. */
	private conversationBytes(file: string, c: PlannedConversation): number {
		const m = this.cache.conversations[file];
		return m && m.mtime === c.modifiedAt ? m.bytes : c.size;
	}

	private async run(): Promise<void> {
		const { rows, conversations } = await this.deps.plan();
		const start = this.deps.now();
		const left = () => SCAN_MS - (this.deps.now() - start);
		const folders = rows.filter(measurable);
		// Those never measured first, then those measured longest ago.
		const at = (r: { real: string }) => this.cache.folders[r.real]?.at ?? Number.NEGATIVE_INFINITY;
		folders.sort((a, b) => at(a) - at(b) || (a.real < b.real ? -1 : 1));
		this.progress.total = folders.length;
		// Every row's conversations first, those changed since they were measured: a folder's size leaves out the transcripts
		// kept in it, whichever row they are of.
		for (const r of [...folders, ...rows.filter((r) => !measurable(r))]) {
			for (const file of r.files) {
				const c = conversations.get(file);
				if (!c) continue;
				const m = this.cache.conversations[file];
				if (m && m.mtime === c.modifiedAt) continue;
				const budget = Math.min(CONVERSATION_MS, left());
				if (budget <= 0) return;
				const artifacts = await this.deps.du(artifactsOf(file), budget);
				// Not measured in time: it is measured again by the next scan (one with no artifacts folder measures 0).
				if (artifacts === null) {
					if (budget < CONVERSATION_MS) return;
					continue;
				}
				this.cache.conversations[file] = { mtime: c.modifiedAt, bytes: this.deps.fileBytes(file) + artifacts };
			}
		}
		for (const r of folders) {
			const budget = Math.min(FOLDER_MS, left());
			if (budget <= 0) return;
			const bytes = await this.deps.du(r.real, budget);
			// Cut by the scan's end, not by its own time: it keeps what it had.
			if (bytes === null && budget < FOLDER_MS) return;
			// Cleaned up while it was measured: the size is from before (the scan after this one measures it again).
			if (this.forgottenDuring?.some((p) => isWithin(p, r.real) || isWithin(r.real, p))) continue;
			this.cache.folders[r.real] = {
				bytes: bytes === null ? null : this.ownBytes(r.real, bytes, conversations),
				at: this.deps.now(),
			};
			this.progress.done++;
			this.save();
		}
	}

	/** A folder's bytes less those of the conversations kept inside it (they count under conversations). */
	private ownBytes(real: string, bytes: number, conversations: Map<string, PlannedConversation>): number {
		let inside = 0;
		for (const file of conversations.keys()) {
			const m = this.cache.conversations[file];
			if (!m || !isWithin(file, real)) continue;
			inside += m.bytes;
		}
		return Math.max(0, bytes - inside);
	}

	private load(): Cache {
		try {
			const c = JSON.parse(readFileSync(this.cacheFile, "utf8")) as Cache;
			if (c?.version === 1 && typeof c.folders === "object" && typeof c.conversations === "object") return c;
		} catch {}
		return emptyCache();
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.cacheFile), { recursive: true });
			const tmp = `${this.cacheFile}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.cache));
			renameSync(tmp, this.cacheFile);
		} catch {}
	}
}
