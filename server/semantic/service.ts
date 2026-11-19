import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SemanticFailure, SemanticHit, SemanticStatus } from "../../shared/semantic.ts";
import { ensurePrivateDir } from "../private.ts";
import { type RawSemanticHit, SemanticIndex, type SemanticRuntime } from "../semantic-index.ts";
import { UpdateCancelled } from "../update/steps.ts";
import { runtimeAsset } from "./assets.ts";
import {
	downloadBytes,
	type Installed,
	type InstallOptions,
	install,
	installed,
	removeStale,
	SemanticInstallError,
} from "./install.ts";
import { gpuDevice, Runtime, reapOrphan } from "./runtime.ts";

/**
 * Semantic search on this computer (`shared/semantic.ts`): turned on, it installs what it needs (`install.ts`), then keeps the
 * index (`semantic-index.ts`) with a `llama-server` it starts when needed (`runtime.ts`). Everything it has is under
 * `<data dir>/semantic/`, and `on` there is what says it is on: turned off, the folder goes, with the downloads, the index and
 * that file. A server that starts with it on takes up where the last one was (an install it did not finish, the messages it
 * had not embedded).
 *
 *   GET  /api/semantic          the status
 *   POST /api/semantic/on       turn it on (the person's own page)
 *   POST /api/semantic/off      turn it off and delete everything it downloaded and made (the person's own page)
 *   GET  /api/semantic/search?q&conversations=N[&folder=<cwd>][&since=<ms>]   the N conversations closest to `q`, one passage
 *   each; with `folder` and `since`, of the conversations in that folder and active since then (chosen before the N are taken)
 */

export interface SemanticDeps {
	dataDir: string;
	/** The full-text index's file, which the semantic index reads the messages from. */
	ftsPath: string;
	/** The title, folder and last activity of a conversation, or null when the session list has no such file (it was deleted). */
	describe(files: string[]): Promise<Map<string, { title: string | null; cwd: string; modifiedAt: number }>>;
	/** A test's: what installs, and the runtime and worker it uses. */
	install?: (dir: string, opts: InstallOptions) => Promise<Installed>;
	runtime?: (installed: Installed, dir: string) => SemanticRuntime & { stop(): void; stopped?(): Promise<void> };
	spawnWorker?: () => Worker;
	gpuDevice?: (server: string) => Promise<string | null | undefined>;
	supported?: boolean;
	downloadBytes?: number;
}

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	});

/** Most conversations one search answers. */
const MAX_CONVERSATIONS = 200;
/** A query longer than this is cut: the model reads a passage, not a document. */
const MAX_QUERY = 2000;

export class SemanticService {
	readonly dir: string;
	private state: SemanticStatus["state"] = "off";
	private failure: SemanticFailure | undefined;
	private download: { received: number; total: number } | undefined;
	private installing: AbortController | null = null;
	/** The install under way, settled or not: turning off waits for it (an unpack is a `tar` that a signal does not stop). */
	private installRun: Promise<unknown> | null = null;
	private runtime: (SemanticRuntime & { stop(): void; stopped?(): Promise<void> }) | null = null;
	private index: SemanticIndex | null = null;
	/** A conversation is working (`setWorking`). */
	private working = false;
	private trouble: string | null = null;
	private disk: { at: number; bytes: number } | null = null;

	constructor(private readonly deps: SemanticDeps) {
		this.dir = join(deps.dataDir, "semantic");
	}

	private get flag(): string {
		return join(this.dir, "on");
	}

	/** At the server's start: carry on with what was turned on. */
	async resume(): Promise<void> {
		if (!existsSync(this.flag)) return;
		await reapOrphan(this.dir);
		this.begin();
	}

	turnOn(): void {
		if (this.state === "installing" || this.state === "on") return;
		ensurePrivateDir(this.dir);
		writeFileSync(this.flag, "");
		this.begin();
	}

	/** Off, and everything it downloaded and made deleted. */
	async turnOff(): Promise<void> {
		this.installing?.abort();
		this.installing = null;
		// Nothing of an install may land in the folder after it is deleted (an unpack moving its build in).
		await this.installRun?.catch(() => {});
		this.installRun = null;
		this.index?.close();
		this.index = null;
		const runtime = this.runtime;
		this.runtime = null;
		runtime?.stop();
		await runtime?.stopped?.();
		this.state = "off";
		this.failure = undefined;
		this.download = undefined;
		this.trouble = null;
		this.disk = null;
		rmSync(this.dir, { recursive: true, force: true });
	}

	/**
	 * Whether a conversation is working now (the server looks every second): the indexing waits while one is, so that the
	 * model is not loaded beside an agent at work, and takes up what was written meanwhile once none is.
	 */
	setWorking(on: boolean): void {
		this.working = on;
		this.index?.pause(on);
	}

	/** The server is stopping: the index closed, `llama-server` stopped; what is on stays on. */
	stop(): void {
		this.installing?.abort();
		this.index?.close();
		this.index = null;
		this.runtime?.stop();
		this.runtime = null;
	}

	private begin(): void {
		this.failure = undefined;
		const ready = installed(this.dir);
		if (ready) {
			// Files an older build or an install cut short left (#210).
			removeStale(this.dir);
			this.startIndex(ready);
			return;
		}
		this.state = "installing";
		const abort = new AbortController();
		this.installing = abort;
		this.download = { received: 0, total: 0 };
		const run = (this.deps.install ?? install)(this.dir, {
			signal: abort.signal,
			onProgress: (received, total) => {
				this.download = { received, total };
			},
		});
		this.installRun = run;
		void run.then(
			(done) => {
				if (this.installing !== abort) return;
				this.installing = null;
				this.download = undefined;
				this.disk = null;
				this.startIndex(done);
			},
			(e: unknown) => {
				if (this.installing !== abort) return;
				this.installing = null;
				this.download = undefined;
				if (e instanceof UpdateCancelled) return;
				this.state = "failed";
				this.failure =
					e instanceof SemanticInstallError
						? e.failure
						: { code: "download", detail: e instanceof Error ? e.message : String(e) };
				console.error(`omp-webui: semantic search: install failed: ${this.failure.code} ${this.failure.detail ?? ""}`);
			},
		);
	}

	private startIndex(ready: Installed): void {
		this.state = "on";
		this.runtime =
			this.deps.runtime?.(ready, this.dir) ??
			new Runtime({
				server: ready.server,
				model: ready.model,
				dir: this.dir,
				onCrash: (detail) => console.error(`omp-webui: semantic search: llama-server stopped: ${detail}`),
			});
		this.index = new SemanticIndex({
			dbPath: join(this.dir, "index.db"),
			ftsPath: this.deps.ftsPath,
			runtime: this.runtime,
			onTrouble: (message) => {
				this.trouble = message;
			},
			...(this.deps.spawnWorker ? { spawn: this.deps.spawnWorker } : {}),
			paused: this.working,
		});
		void this.detectDevice(ready.server);
	}

	/** What llama.cpp runs the model on, asked once after the install and kept (`device.json`). */
	private async detectDevice(server: string): Promise<void> {
		const file = join(this.dir, "device.json");
		if (existsSync(file)) return;
		const device = await (this.deps.gpuDevice ?? gpuDevice)(server);
		if (device === undefined || this.state !== "on") return;
		writeFileSync(file, JSON.stringify({ device }));
	}

	private device(): string | null | undefined {
		try {
			const saved = JSON.parse(readFileSync(join(this.dir, "device.json"), "utf8")) as { device?: unknown };
			return typeof saved.device === "string" ? saved.device : null;
		} catch {
			return undefined;
		}
	}

	/** What the folder takes on disk, counted at most every few seconds (the index grows as it is made). */
	private diskBytes(): number {
		const now = Date.now();
		if (this.disk && now - this.disk.at < 5000) return this.disk.bytes;
		const walk = (dir: string): number => {
			let n = 0;
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				const st = lstatSync(path);
				n += st.isDirectory() ? walk(path) : st.size;
			}
			return n;
		};
		let bytes = 0;
		try {
			bytes = walk(this.dir);
		} catch {
			// the folder is being made, or removed
		}
		this.disk = { at: now, bytes };
		return bytes;
	}

	status(canChange: boolean): SemanticStatus {
		const supported = this.deps.supported ?? runtimeAsset() !== null;
		const out: SemanticStatus = {
			state: this.state,
			supported,
			downloadBytes: this.deps.downloadBytes ?? downloadBytes(),
			canChange,
		};
		if (this.download) out.download = this.download;
		if (this.state === "on") {
			if (this.index) out.index = this.index.progress;
			const device = this.device();
			if (device !== undefined) out.device = device;
			if (this.trouble) out.failure = { code: "runtime", detail: this.trouble };
		}
		if (this.failure) out.failure = this.failure;
		if (this.state !== "off") out.diskBytes = this.diskBytes();
		return out;
	}

	/**
	 * The `max` conversations closest to `q`; nothing while it is not on. With a `scope` (the sidebar's folder and date
	 * range) they are the closest of the conversations inside it: the index is asked for as many as it holds to give, and
	 * the ones outside are left out before the `max` are taken, not after (#211).
	 */
	async search(
		q: string,
		max: number,
		signal?: AbortSignal,
		scope: { folder?: string; since?: number } = {},
	): Promise<SemanticHit[]> {
		const query = q.trim().slice(0, MAX_QUERY);
		if (!query || !this.index) return [];
		const scoped = scope.folder !== undefined || scope.since !== undefined;
		const raw: RawSemanticHit[] = await this.index.search(query, scoped ? MAX_CONVERSATIONS : max, signal);
		const known = await this.deps.describe(raw.map((h) => h.file));
		const hits: SemanticHit[] = [];
		for (const h of raw) {
			const s = known.get(h.file);
			if (!s) continue;
			if (scope.folder !== undefined && s.cwd !== scope.folder) continue;
			if (scope.since !== undefined && s.modifiedAt < scope.since) continue;
			hits.push({ ...h, title: s.title, cwd: s.cwd });
			if (hits.length >= max) break;
		}
		return hits;
	}

	async handle(req: Request, url: URL, owner: boolean): Promise<Response> {
		const p = url.pathname;
		if (p === "/api/semantic" && req.method === "GET") return json(this.status(owner));
		if (p === "/api/semantic/search" && req.method === "GET") {
			const asked = Number(url.searchParams.get("conversations") ?? 30);
			const max = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), MAX_CONVERSATIONS) : 30;
			const folder = url.searchParams.get("folder") ?? undefined;
			const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : undefined;
			try {
				return json(
					await this.search(url.searchParams.get("q") ?? "", max, req.signal, {
						folder,
						since: since !== undefined && Number.isFinite(since) ? since : undefined,
					}),
				);
			} catch (e) {
				if (req.signal.aborted) return json([]);
				return json({ error: e instanceof Error ? e.message : String(e) }, 503);
			}
		}
		if ((p === "/api/semantic/on" || p === "/api/semantic/off") && req.method === "POST") {
			// What this computer downloads, runs and keeps is the person's to decide.
			if (!owner) return json({ error: "Only the person's own page may turn semantic search on or off" }, 403);
			if (p === "/api/semantic/on") {
				if (!(this.deps.supported ?? runtimeAsset() !== null))
					return json({ error: "Semantic search is not available on this computer" }, 409);
				this.turnOn();
			} else {
				await this.turnOff();
			}
			return json(this.status(owner));
		}
		return json({ error: "Not found" }, 404);
	}
}
