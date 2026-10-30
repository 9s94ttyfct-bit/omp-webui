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
}

/** A run of points, as columns (a day of them is a few hundred KB as objects and a fifth of that as columns), oldest first. */
export interface HostSeries {
	t: number[];
	cpu: number[];
	gpu: (number | null)[];
	mem: (number | null)[];
	pressure: (Pressure | null)[];
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
