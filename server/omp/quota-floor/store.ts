import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../../shared/guards.ts";
import { floorOf, isFloorProvider, type QuotaFloorSettings } from "../../../shared/quota-floor.ts";

/**
 * What the person set for the quota floor (#652), in `<data dir>/quota-floor.json`: for each provider that has one, the
 * share of a usage window that may be left before the work is held. A provider with no floor is not held. It travels with
 * Move to another computer (a `webui` data file: `server/migrate/layout.ts`).
 *
 * The file, not this object, is the truth, as for the other stores of the data dir: it is read again when it looks different
 * from what this store last wrote. A file that cannot be read is kept aside (`quota-floor.json.damaged`, never written over)
 * and no provider has a floor: the safe reading of a setting that cannot be read is that it holds nothing.
 */

/** Providers with a floor at once; omp has a handful, so this only bounds a file that was made by hand. */
const MAX_FLOORS = 64;
/** A file this large is not this store's. */
const MAX_FILE_BYTES = 64 * 1024;

/** A change the store refuses: a provider id omp cannot know, or a floor outside 1–99. */
export class FloorError extends Error {
	constructor(
		readonly problem: "provider" | "floor" | "many",
		message: string,
	) {
		super(message);
	}
}

export class QuotaFloorStore {
	private readonly file: string;
	private floors: Record<string, number> = {};
	/** How the file looked when this store last read or wrote it. */
	private seen = "";

	constructor(private readonly dataDir: string) {
		this.file = join(dataDir, "quota-floor.json");
		this.read();
		this.seen = this.stamp();
	}

	private read(): void {
		const problem = this.load();
		if (problem) this.keepAside(problem);
	}

	/** Take the file's state. What is wrong with it when it cannot be taken; null when it was, or when there is no file (yet). */
	private load(): Error | null {
		this.floors = {};
		let info: Stats;
		try {
			info = statSync(this.file);
		} catch (e) {
			return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : (e as Error);
		}
		if (!info.isFile()) return new Error("it is not a regular file");
		if (info.size > MAX_FILE_BYTES) return new Error("it is far larger than these settings can be");
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.file, "utf8"));
		} catch {
			return new Error("it is not JSON");
		}
		if (!isRecord(parsed)) return new Error("it is not an object");
		// A floor that cannot be read is dropped alone, not the file: the others still hold.
		if (isRecord(parsed.floors)) {
			for (const [provider, value] of Object.entries(parsed.floors)) {
				const floor = floorOf(value);
				if (isFloorProvider(provider) && floor !== null && Object.keys(this.floors).length < MAX_FLOORS)
					this.floors[provider] = floor;
			}
		}
		return null;
	}

	private keepAside(why: unknown): void {
		this.floors = {};
		let aside = `${this.file}.damaged`;
		for (let n = 0; existsSync(aside); n++) aside = `${this.file}.${Date.now()}${n ? `-${n}` : ""}.damaged`;
		try {
			renameSync(this.file, aside);
			console.warn(
				`omp-webui: ${this.file} could not be read (${why instanceof Error ? why.message : String(why)}); it was moved to ${aside}, and no provider has a floor`,
			);
		} catch {
			// Nothing to move: it went while this was read.
		}
	}

	private writeFile(): void {
		mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ floors: this.floors }, null, "\t")}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.file);
		this.seen = this.stamp();
	}

	private stamp(): string {
		try {
			const st = statSync(this.file);
			return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
		} catch {
			return "";
		}
	}

	private fresh(): void {
		const now = this.stamp();
		if (now === this.seen) return;
		this.seen = now;
		this.read();
	}

	/** The floor of each provider that has one. */
	settings(): QuotaFloorSettings {
		this.fresh();
		return { floors: { ...this.floors } };
	}

	/** The provider's floor (percent left), or null when it has none. */
	floorOf(provider: string): number | null {
		this.fresh();
		return this.floors[provider] ?? null;
	}

	/** Give `provider` a floor, or take it away (null). Throws `FloorError` for what it refuses. */
	set(provider: unknown, floor: unknown): QuotaFloorSettings {
		this.fresh();
		if (!isFloorProvider(provider)) throw new FloorError("provider", "That is not a provider omp knows");
		if (floor === null) {
			if (!(provider in this.floors)) return this.settings();
			delete this.floors[provider];
		} else {
			const value = floorOf(floor);
			if (value === null) throw new FloorError("floor", "A floor is a whole number from 1 to 99, in percent");
			if (!(provider in this.floors) && Object.keys(this.floors).length >= MAX_FLOORS)
				throw new FloorError("many", `At most ${MAX_FLOORS} providers can have a floor`);
			if (this.floors[provider] === value) return this.settings();
			this.floors[provider] = value;
		}
		this.writeFile();
		return this.settings();
	}
}
