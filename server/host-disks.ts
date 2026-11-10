import { statfsSync, statSync } from "node:fs";
import { type HostDisk, MAX_DISKS } from "../shared/host.ts";
import { type DiskLook, type DiskMount, distinctDisks, sameDisk } from "./host-parse.ts";

/** How often the disks are listed again: one plugged in or taken out shows within this. */
export const DISK_LIST_MS = 60_000;

/** A disk at one look: what it is, and its free bytes (null: it could not be read this time). */
export interface DiskReading extends HostDisk {
	free: number | null;
}

/** The disks at one look, and which holds the data folder. */
export interface DisksNow {
	disks: DiskReading[];
	dataDisk: string | null;
}

/** What `stat` and `statfs` are asked; the system's unless a test says. */
export interface DiskFs {
	dev(path: string): number;
	statfs(path: string): { blocks: number; bsize: number; bfree: number; bavail: number };
}

const systemFs: DiskFs = {
	dev: (path) => statSync(path).dev,
	statfs: (path) => statfsSync(path),
};

export interface DiskWatchOptions {
	/** The server's data folder: the disk that holds it is `dataDisk`. */
	dataPath?: string;
	now?: () => number;
	fs?: DiskFs;
}

/**
 * The free space of every disk the platform lists (`HostOps.disks`), read at each look with one `statfs` each (the blocks
 * available to a user who is not root, as `df` says; macOS's Finder says more, adding what the system would purge). The
 * list is asked again after `DISK_LIST_MS`, and at the next look when a disk's mount point is no longer on the device it
 * was (taken out: the folder that is left, or none). `read` rejects when the list could not be had and there is none from
 * before.
 */
export function diskWatcher(list: () => Promise<DiskMount[]>, options: DiskWatchOptions = {}) {
	const fs = options.fs ?? systemFs;
	const now = options.now ?? Date.now;
	let listed: (HostDisk & { dev: number })[] | null = null;
	let dataDisk: string | null = null;
	let listedAt = Number.NEGATIVE_INFINITY;

	const look = (m: DiskMount): DiskLook | null => {
		try {
			const dev = fs.dev(m.mount);
			const s = fs.statfs(m.mount);
			return { ...m, dev, blocks: s.blocks, bsize: s.bsize, bfree: s.bfree };
		} catch {
			return null;
		}
	};

	async function relist(): Promise<void> {
		listedAt = now();
		const looks = (await list()).map(look).filter((l): l is DiskLook => l !== null);
		const kept = distinctDisks(looks, MAX_DISKS);
		listed = kept.map((d) => ({ id: d.mount, name: d.names.join(", "), total: d.blocks * d.bsize, dev: d.dev }));
		const data = options.dataPath === undefined ? null : look({ mount: options.dataPath, name: "" });
		dataDisk = data ? (kept.find((d) => sameDisk(d, data))?.mount ?? null) : null;
	}

	return {
		async read(): Promise<DisksNow> {
			if (listed === null || now() - listedAt >= DISK_LIST_MS) {
				try {
					await relist();
				} catch (e) {
					// The list from before stands, and is asked for again at the next look.
					listedAt = Number.NEGATIVE_INFINITY;
					if (listed === null) throw e;
				}
			}
			const disks = (listed ?? []).map((d): DiskReading => {
				try {
					// A disk taken out leaves its folder (or none): what is there now is another disk's.
					if (fs.dev(d.id) !== d.dev) throw new Error("not mounted");
					const s = fs.statfs(d.id);
					return { id: d.id, name: d.name, total: s.blocks * s.bsize, free: s.bavail * s.bsize };
				} catch {
					listedAt = Number.NEGATIVE_INFINITY;
					return { id: d.id, name: d.name, total: d.total, free: null };
				}
			});
			return { disks, dataDisk };
		},
	};
}
