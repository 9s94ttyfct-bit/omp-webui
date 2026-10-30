import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UsageReport } from "../../../shared/protocol.ts";
import type { QuotaFloorSettings } from "../../../shared/quota-floor.ts";
import { type HoldFields, holdFileText, QUOTA_SUFFIX } from "../../../shared/quota-hold.ts";
import { DEFAULT_TIMINGS, type QuotaTimings } from "./decide.ts";
import { installQuotaExtension, quotaPaths } from "./install.ts";
import { QuotaFloorStore } from "./store.ts";

/**
 * What the pool needs of the quota floor (#652), as `UnattendedHooks` is what it needs of unattended mode: the extension omp is
 * started with, the file it reads, the floors the person set, and the provider's usage.
 *
 * `LivePool.quotaFloor` is null where the app has none (a server that started without a data dir): a conversation then has no
 * floor, and the routes are not there.
 */
export interface QuotaFloorHooks {
	/** The extension omp is started with (`--extension`). */
	readonly extension: string;
	/** Make sure the extension's files are as the server has them, before a process is started with it. False when they cannot be. */
	ensure(): boolean;
	/** The file the conversation `liveId`'s omp reads its hold from (`overlay`: its settings overlay, whose folder goes with it). */
	fileFor(liveId: string, overlay: string | null): string;
	/** Write the hold, or take the file away when there is none (a process that reads it is then not held). Throws when it cannot. */
	write(file: string, hold: HoldFields | null): void;
	/** The provider's floor (percent left), or null when it has none. */
	floorOf(provider: string): number | null;
	/** The provider's usage as omp reports it, through the cache every page's quota pill shares: at most one `omp usage` per interval. */
	reports(provider: string, force: boolean): Promise<UsageReport[]>;
	/** How the quota is looked at. */
	readonly timings: QuotaTimings;
}

const envMs = (name: string, fallback: number): number => {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * The quota floor of this server: the floors (`store.ts`), the extension omp is started with (`install.ts`, `extension.ts`),
 * and the look at the quota (`usage.ts`), as one thing the pool and the routes ask.
 *
 * A conversation's hold file is written beside its settings overlay, in the temp folder the overlays are made in
 * (`server/omp/approval.ts`), because it is that process's alone and goes with it. A process that has no overlay (modes are not
 * managed, as in some tests) gets a file under `<data dir>/quota-floor/live/`, a path that follows from the process's id: a
 * conversation taken over by the next server is then told the same file.
 */
export class QuotaFloorService implements QuotaFloorHooks {
	private readonly store: QuotaFloorStore;
	private readonly fallback: string;
	readonly timings: QuotaTimings;

	constructor(
		private readonly dataDir: string,
		/** The provider's usage through the shared cache (`omp/usage.ts`); handed in, so that this module does not load the usage family at start. */
		private readonly usage: (provider: string, force: boolean) => Promise<UsageReport[]>,
	) {
		this.store = new QuotaFloorStore(dataDir);
		this.fallback = join(dataDir, "quota-floor", "live");
		// The environment variables are for the tests, which cannot wait for a reset a minute away.
		this.timings = {
			graceMs: envMs("OMP_WEBUI_QUOTA_GRACE_MS", DEFAULT_TIMINGS.graceMs),
			workingLookMs: envMs("OMP_WEBUI_QUOTA_LOOK_MS", DEFAULT_TIMINGS.workingLookMs),
			heldLookMs: envMs("OMP_WEBUI_QUOTA_HELD_LOOK_MS", DEFAULT_TIMINGS.heldLookMs),
		};
	}

	get extension(): string {
		return quotaPaths(this.dataDir).extension;
	}

	ensure(): boolean {
		try {
			installQuotaExtension(this.dataDir);
			return true;
		} catch (e) {
			console.warn(`omp-webui: could not set up the quota floor for a conversation: ${(e as Error).message}`);
			return false;
		}
	}

	fileFor(liveId: string, overlay: string | null): string {
		return overlay ? `${overlay}${QUOTA_SUFFIX}` : join(this.fallback, `${liveId}${QUOTA_SUFFIX}`);
	}

	write(file: string, hold: HoldFields | null): void {
		if (hold === null) {
			rmSync(file, { force: true });
			return;
		}
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, holdFileText(hold), { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, file);
	}

	floorOf(provider: string): number | null {
		return this.store.floorOf(provider);
	}

	reports(provider: string, force: boolean): Promise<UsageReport[]> {
		return this.usage(provider, force);
	}

	/** The floors as the page shows them. */
	settings(): QuotaFloorSettings {
		return this.store.settings();
	}

	/** Give `provider` a floor, or take it away (null). Throws `FloorError` for what it refuses. */
	set(provider: unknown, floor: unknown): QuotaFloorSettings {
		return this.store.set(provider, floor);
	}
}
