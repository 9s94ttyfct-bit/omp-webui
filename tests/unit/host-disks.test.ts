import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISK_LIST_MS, type DiskFs, diskWatcher } from "../../server/host-disks.ts";
import {
	type DiskLook,
	type DiskMount,
	distinctDisks,
	parseMacMounts,
	parseProcMounts,
} from "../../server/host-parse.ts";
import { PrefsError, UiPrefs } from "../../server/prefs.ts";
import { PREF } from "../../shared/prefs.ts";
import { hostDisksOf, lineDisks, shownDisks } from "../../web/src/lib/host-disks.ts";

/**
 * Every disk's free space (#613): which volumes the system's listing counts, a disk listed twice counted once, the watcher
 * that lists them again and reads them each look, and the preference that chooses the ones the pane shows.
 */

// `mount` on a Mac with an external APFS disk of two volumes (Storage, TimeMachine), its user's paths left out.
const MAC_MOUNT = `/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
devfs on /dev (devfs, local, nobrowse)
/dev/disk3s6 on /System/Volumes/VM (apfs, local, noexec, journaled, noatime, nobrowse)
/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)
map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)
/dev/disk3s3 on /Volumes/Recovery (apfs, local, journaled, nobrowse)
/dev/disk5s1 on /Volumes/Storage (apfs, local, nodev, nosuid, journaled, noowners)
/dev/disk5s2 on /Volumes/TimeMachine (apfs, local, nodev, nosuid, journaled)
/dev/disk6s1 on /Volumes/Some Installer (hfs, local, nodev, nosuid, read-only, noowners, mounted by someone)
//guest@nas.local/share on /Volumes/share (smbfs, nodev, nosuid, mounted by someone)
com.apple.TimeMachine.2026-11-09-195715.local@/dev/disk3s5 on /Volumes/com.apple.TimeMachine.localsnapshots/Backups.backupdb/Mac/2026-11-09-195715/Data (apfs, local, read-only, journaled, nobrowse, protect)
`;

const PROC_MOUNTS = `sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
/dev/nvme0n1p2 / ext4 rw,relatime 0 0
/dev/nvme0n1p1 /boot/efi vfat rw,relatime 0 0
tmpfs /run tmpfs rw,nosuid,nodev 0 0
/dev/loop3 /snap/core22/1380 squashfs ro,nodev,relatime 0 0
/dev/sda1 /mnt/My\\040Data ext4 rw,relatime 0 0
/dev/sda1 /srv/bound ext4 rw,relatime 0 0
/dev/sr0 /media/cdrom iso9660 ro,nosuid,nodev 0 0
/dev/zram0 /var/compress ext4 rw 0 0
`;

describe("which volumes are disks to watch", () => {
	test("macOS: `/` and the volumes Finder shows; not the system's own, a read-only image or a share", () => {
		expect(parseMacMounts(MAC_MOUNT)).toEqual([
			{ mount: "/", name: "/" },
			{ mount: "/Volumes/Storage", name: "Storage" },
			{ mount: "/Volumes/TimeMachine", name: "TimeMachine" },
		]);
		expect(parseMacMounts("")).toEqual([]);
	});

	test("Linux: each block device once, its octal escapes read; not a loop, RAM or snap mount, nor a read-only one", () => {
		expect(parseProcMounts(PROC_MOUNTS)).toEqual([
			{ mount: "/", name: "/" },
			{ mount: "/boot/efi", name: "efi" },
			{ mount: "/mnt/My Data", name: "My Data" },
		]);
	});

	test("two volumes of one container (same size, the same free space a moment apart) are one disk with both names", () => {
		const look = (name: string, dev: number, blocks: number, bfree: number): DiskLook => ({
			mount: `/Volumes/${name}`,
			name,
			dev,
			blocks,
			bsize: 4096,
			bfree,
		});
		const out = distinctDisks([
			look("Storage", 10, 1_000_000_000, 400_000_000),
			look("TimeMachine", 11, 1_000_000_000, 400_000_050),
			look("Other", 12, 1_000_000_000, 300_000_000),
			look("Again", 12, 5, 1),
		]);
		expect(out.map((d) => [d.mount, d.names])).toEqual([
			["/Volumes/Storage", ["Storage", "TimeMachine"]],
			["/Volumes/Other", ["Other", "Again"]],
		]);
		// Every distinct disk is kept, however many there are.
		const many = Array.from({ length: 40 }, (_, i) => look(`D${i}`, 100 + i, 1000 + i, 1));
		expect(distinctDisks(many)).toHaveLength(40);
	});
});

/** A system of mount points: each a device, its size and free blocks; a test changes them between looks. */
function fakeFs(
	disks: Record<string, { dev: number; blocks: number; bavail: number }>,
): DiskFs & { statfsCalls: number } {
	const fs = {
		statfsCalls: 0,
		dev(path: string) {
			const d = disks[path];
			if (!d) throw new Error("ENOENT");
			return d.dev;
		},
		statfs(path: string) {
			fs.statfsCalls++;
			const d = disks[path];
			if (!d) throw new Error("ENOENT");
			return { blocks: d.blocks, bsize: 1000, bfree: d.bavail, bavail: d.bavail };
		},
	};
	return fs;
}

describe("the disk watcher", () => {
	test("lists the disks, reads each look's free bytes, marks the data folder's, and lists again after a while", async () => {
		const disks = {
			"/": { dev: 1, blocks: 500, bavail: 100 },
			"/Volumes/Backup": { dev: 2, blocks: 2000, bavail: 1500 },
			"/srv/data": { dev: 2, blocks: 2000, bavail: 1500 },
		};
		const fs = fakeFs(disks);
		let clock = 0;
		let lists = 0;
		let listing: DiskMount[] = [{ mount: "/", name: "Macintosh HD" }];
		const w = diskWatcher(
			async () => {
				lists++;
				return listing;
			},
			{ dataPath: "/srv/data", now: () => clock, fs },
		);
		expect(await w.read()).toEqual({
			disks: [{ id: "/", name: "Macintosh HD", total: 500_000, free: 100_000 }],
			dataDisk: null,
		});
		// A disk plugged in shows at the next listing, not before.
		listing = [...listing, { mount: "/Volumes/Backup", name: "Backup" }];
		disks["/"].bavail = 90;
		clock = DISK_LIST_MS - 1;
		expect((await w.read()).disks).toEqual([{ id: "/", name: "Macintosh HD", total: 500_000, free: 90_000 }]);
		expect(lists).toBe(1);
		clock = DISK_LIST_MS;
		expect(await w.read()).toEqual({
			disks: [
				{ id: "/", name: "Macintosh HD", total: 500_000, free: 90_000 },
				{ id: "/Volumes/Backup", name: "Backup", total: 2_000_000, free: 1_500_000 },
			],
			dataDisk: "/Volumes/Backup",
		});
		expect(lists).toBe(2);
	});

	test("a disk taken out is no figure at that look, and the list is asked for again at the next", async () => {
		const disks: Record<string, { dev: number; blocks: number; bavail: number }> = {
			"/": { dev: 1, blocks: 500, bavail: 100 },
			"/Volumes/Backup": { dev: 2, blocks: 2000, bavail: 1500 },
		};
		const fs = fakeFs(disks);
		let listing: DiskMount[] = [
			{ mount: "/", name: "Macintosh HD" },
			{ mount: "/Volumes/Backup", name: "Backup" },
		];
		const w = diskWatcher(async () => listing, { now: () => 0, fs });
		await w.read();
		// Taken out: its folder is left on `/`'s device.
		disks["/Volumes/Backup"] = { dev: 1, blocks: 500, bavail: 100 };
		expect((await w.read()).disks[1]).toEqual({ id: "/Volumes/Backup", name: "Backup", total: 2_000_000, free: null });
		listing = [{ mount: "/", name: "Macintosh HD" }];
		expect((await w.read()).disks.map((d) => d.id)).toEqual(["/"]);
	});

	test("a listing that fails keeps the one from before; with none from before the read fails", async () => {
		const fs = fakeFs({ "/": { dev: 1, blocks: 500, bavail: 100 } });
		let fail = true;
		let clock = 0;
		const w = diskWatcher(
			async () => {
				if (fail) throw new Error("mount is gone");
				return [{ mount: "/", name: "/" }];
			},
			{ now: () => clock, fs },
		);
		await expect(w.read()).rejects.toThrow("mount is gone");
		fail = false;
		expect((await w.read()).disks).toHaveLength(1);
		fail = true;
		clock = DISK_LIST_MS;
		expect((await w.read()).disks).toEqual([{ id: "/", name: "/", total: 500_000, free: 100_000 }]);
	});
});

describe("the disks chosen", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "omp-webui-host-disks-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("the preference is a list of mount points: the server keeps one and refuses anything else", () => {
		const prefs = new UiPrefs(dir);
		expect(prefs.apply({ [PREF.hostDisks]: '["/","/Volumes/Backup"]' }).values[PREF.hostDisks]).toBe(
			'["/","/Volumes/Backup"]',
		);
		// Any number of disks a computer may have can be chosen.
		const forty = JSON.stringify(Array.from({ length: 40 }, (_, i) => `/d${i}`));
		expect(prefs.apply({ [PREF.hostDisks]: forty }).values[PREF.hostDisks]).toBe(forty);
		for (const v of ['"/"', "[1]", '[""]', "not json"])
			expect(() => prefs.apply({ [PREF.hostDisks]: v }), v).toThrow(PrefsError);
	});

	test("the page reads it as a list (anything else: every disk), and shows the chosen ones, or every one", () => {
		expect(hostDisksOf('["/","/Volumes/Backup"]')).toEqual(["/", "/Volumes/Backup"]);
		expect(hostDisksOf(null)).toEqual([]);
		expect(hostDisksOf("{")).toEqual([]);
		expect(hostDisksOf('{"a":1}')).toEqual([]);
		const disks = [{ id: "/" }, { id: "/Volumes/Backup" }];
		expect(shownDisks(disks, [])).toEqual(disks);
		expect(shownDisks(disks, ["/Volumes/Backup", "/Volumes/Gone"])).toEqual([{ id: "/Volumes/Backup" }]);
	});

	test("the sidebar's line tells the chosen disks, or the system's alone", () => {
		const mac = [{ id: "/Volumes/Backup" }, { id: "/" }];
		expect(lineDisks(mac, [], "/Volumes/Backup")).toEqual([{ id: "/" }]);
		expect(lineDisks(mac, ["/Volumes/Backup"], "/")).toEqual([{ id: "/Volumes/Backup" }]);
		expect(lineDisks([{ id: "D:\\" }, { id: "C:\\" }], [], "D:\\")).toEqual([{ id: "C:\\" }]);
		// No `/` or `C:\` listed (a Linux that lists only `/home`): the one with the data, else the first.
		expect(lineDisks([{ id: "/home" }, { id: "/data" }], [], "/data")).toEqual([{ id: "/data" }]);
		expect(lineDisks([{ id: "/home" }, { id: "/data" }], [], null)).toEqual([{ id: "/home" }]);
		expect(lineDisks([], [], null)).toEqual([]);
	});
});
