/**
 * The load of the computer that runs the server (#613): what the sampler reads (`server/host.ts`), what the pages are told
 * of it over the socket (`host_sample`) and read back over HTTP (`GET /api/host`).
 */

/** How hard the operating system says memory is pressed: 0 normal, 1 warning, 2 critical (macOS's three levels). */
export type Pressure = 0 | 1 | 2;

/** One look at the computer. `null`: this platform has no such figure, or the read of it failed this time. */
export interface HostPoint {
	/** Epoch ms. A point of the coarse series is the start of the minute it averages. */
	t: number;
	/** The share of all cores' time that was not idle since the look before, 0–100 (as Activity Monitor adds user and system up). */
	cpu: number;
	/** The busiest GPU's device utilisation, 0–100. */
	gpu: number | null;
	/** Memory in use (what Activity Monitor adds up as app, wired and compressed memory) as a share of all of it, 0–100. */
	mem: number | null;
	pressure: Pressure | null;
	/** The whole computer's power draw, watts, to a tenth (macOS: the SMC's system power; null where the computer tells none). */
	power: number | null;
	/**
	 * Bytes a second received and sent by the computer's physical network interfaces since the look before (macOS: the
	 * `en` ones, Ethernet and Wi-Fi; Linux: those with a device). Null on the first look, where a counter went backwards or an
	 * interface came or went, and where the system has no figure (Windows). A server of an older version sends neither.
	 */
	rx: number | null;
	tx: number | null;
	/**
	 * Bytes free (to a user who is not root) on each disk, by its id (`HostDisk.id`); null for one that could not be read this
	 * time. A disk that was not mounted then is not in it. A server of an older version sends none.
	 */
	disks: Record<string, number | null>;
}

/** A run of points, as columns (a day of them is a few hundred KB as objects and a fifth of that as columns), oldest first. */
export interface HostSeries {
	t: number[];
	cpu: number[];
	gpu: (number | null)[];
	mem: (number | null)[];
	pressure: (Pressure | null)[];
	power: (number | null)[];
	/** Absent from a server of an older version. */
	rx: (number | null)[];
	tx: (number | null)[];
	/** Bytes free, a column per disk (by id) that was mounted in the span; null where it was not, or was not read. */
	disks: Record<string, (number | null)[]>;
}

/** A mounted volume whose free space is told: one per device. */
export interface HostDisk {
	/** Where it is mounted (`/`, `/Volumes/Backup`, `/home`, `D:\`): what the series and the preference name it by. */
	id: string;
	/** What it is called: the volume's name (`Macintosh HD`, `Backup`), the mount point's last part, or the drive (`D:`). */
	name: string;
	/** Bytes of it. */
	total: number;
}

/** What does not change while the server runs, and how the series are taken. */
export interface HostInfo {
	platform: string;
	/** Logical cores: a process using `100` of its CPU share is one core busy, `100 * cores` all of them. */
	cores: number;
	/** Bytes of memory. */
	memTotal: number;
	/** The GPU the figures are of; null while none has been read (this computer shows none: the page draws no GPU). */
	gpu: { name: string | null; cores: number | null } | null;
	/** Whether this platform tells memory pressure (a series of nulls is not drawn). */
	pressure: boolean;
	/** Whether the computer's power draw has been read (a computer that tells none shows no power). */
	power: boolean;
	/** Whether a network rate has been read (a system that has none, Windows, shows no network). */
	net: boolean;
	/** The disks mounted at the last listing (every minute at most: one plugged in or taken out shows within one). */
	disks: HostDisk[];
	/** The id of the disk that holds omp-webui's data folder; null when it is none of `disks` (or was not read). */
	dataDisk: string | null;
	/** Milliseconds between two looks while a page watches, and while none does. */
	liveMs: number;
	backgroundMs: number;
	/** What the fine series reaches back, and the coarse one: a point per `coarseMs` over `coarseSpanMs`. */
	fineSpanMs: number;
	coarseMs: number;
	coarseSpanMs: number;
}

/** A group of processes the server can name: its own, omp's (with what omp started) and the relays that hold omp's pipes. */
export type HostProcId = "server" | "omp" | "relay";

export interface HostProc {
	id: HostProcId;
	/** How many conversations' processes the group is (omp, relays); 1 for the server. */
	count: number;
	/** The group's CPU use as a share of one core (100 is one core busy, as Activity Monitor says it); null before a second look. */
	cpu: number | null;
	/** Resident memory, bytes. */
	rss: number;
}

/** What `GET /api/host` answers. */
export interface HostHistory {
	info: HostInfo;
	/** The server's clock, as the series were cut. */
	now: number;
	/** The last hour, a point per look (every `liveMs` while a page watched, every `backgroundMs` otherwise). */
	fine: HostSeries;
	/** The last day, a point per finished minute (the mean of the looks in it; pressure: the worst). */
	coarse: HostSeries;
	/** The latest per-process figures, while a page asks for them; null otherwise. */
	procs: HostProc[] | null;
}
