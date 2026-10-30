import { expect, type Page, type WebSocketRoute } from "@playwright/test";
import type { HostHistory, HostInfo, HostPoint, HostProc, HostSeries } from "../../shared/host.ts";

/**
 * A stand-in for the server's sampler, at the page's boundary: `GET /api/host` answers a history made here, and the
 * `host_sample` messages the real server would send are replaced by the ones a spec pushes. The page cannot tell it from a
 * sampler that reads a computer, and every figure on screen is one the spec chose. The page's other messages go to the real
 * server, and what the page says about the load (`host_watch`) is recorded.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export const INFO: HostInfo = {
	platform: "darwin",
	cores: 12,
	memTotal: 24_000_000_000,
	gpu: { name: "Apple M4 Pro", cores: 16 },
	pressure: true,
	liveMs: 2000,
	backgroundMs: 10_000,
	fineSpanMs: HOUR,
	coarseMs: MINUTE,
	coarseSpanMs: 24 * HOUR,
};

/** A look at `t`: wavy figures that are the same for the same time, so a graph has a shape. */
export function lookAt(t: number, over: Partial<HostPoint> = {}): HostPoint {
	const x = t / MINUTE;
	return {
		t,
		cpu: Math.round((22 + 16 * Math.sin(x / 3)) * 10) / 10,
		gpu: Math.round((12 + 10 * Math.cos(x / 5)) * 10) / 10,
		mem: Math.round((61 + 3 * Math.sin(x / 9)) * 10) / 10,
		pressure: 0,
		...over,
	};
}

const columns = (points: HostPoint[]): HostSeries => ({
	t: points.map((p) => p.t),
	cpu: points.map((p) => p.cpu),
	gpu: points.map((p) => p.gpu),
	mem: points.map((p) => p.mem),
	pressure: points.map((p) => p.pressure),
});

export interface HistoryOptions {
	info?: Partial<HostInfo>;
	/** Looks in the last hour, one every `every` ms (default: an hour of 30 s). */
	fine?: number;
	every?: number;
	/** Minutes in the last day (default: all 1440). */
	coarse?: number;
	/** Looks (counted from the oldest) that were under pressure: `[from, to, level]`. */
	pressure?: [number, number, 1 | 2][];
	/** A computer with no GPU to read. */
	noGpu?: boolean;
	procs?: HostProc[] | null;
}

/** What `GET /api/host` answers at `now`. The newest look is `every` before it, as with a server that looked a moment ago. */
export function historyAt(now: number, o: HistoryOptions = {}): HostHistory {
	const every = o.every ?? 30_000;
	const n = o.fine ?? Math.floor(HOUR / every);
	const gone = (p: HostPoint, i: number, over: HostPoint[] = []): HostPoint => {
		const under = o.pressure?.find(([from, to]) => i >= from && i < to);
		return { ...p, ...(under ? { pressure: under[2] } : {}), ...(o.noGpu ? { gpu: null } : {}), ...(over[0] ?? {}) };
	};
	const fine = Array.from({ length: n }, (_, i) => gone(lookAt(now - (n - i) * every), i));
	const minutes = o.coarse ?? 1440;
	const coarse = Array.from({ length: minutes }, (_, i) => {
		const t = Math.floor(now / MINUTE) * MINUTE - (minutes - i) * MINUTE;
		return gone(lookAt(t), i);
	});
	const info: HostInfo = { ...INFO, ...(o.noGpu ? { gpu: null } : {}), ...o.info };
	return { info, now, fine: columns(fine), coarse: columns(coarse), procs: o.procs ?? null };
}

export const PROCS: HostProc[] = [
	{ id: "server", count: 1, cpu: 1.4, rss: 182_000_000 },
	{ id: "omp", count: 2, cpu: 37.5, rss: 1_240_000_000 },
	{ id: "relay", count: 2, cpu: 0.2, rss: 21_000_000 },
];

export interface StubbedHost {
	/** Every `host_watch` the page said, in order. */
	watches: { on: boolean; detail?: boolean; procs?: boolean }[];
	/** Tell the page about a look, as the server would; it is a second after the last unless `t` is given. */
	push(point: Partial<HostPoint>, extra?: { minute?: HostPoint; procs?: HostProc[] }): Promise<void>;
	/** The time of the look the next `push` makes. */
	readonly next: number;
	/** Cut the page's connection, and refuse the ones it makes after, until `reconnect`. */
	cut(): void;
	/** Let the page connect again. */
	reconnect(): void;
}

/**
 * Install before `page.goto`. `history` is what the page reads; the real server is still the page's, for everything else (its
 * own `host_sample`s are held back, so that nothing but the spec's figures reaches the page).
 */
export async function stubHost(page: Page, history: HostHistory): Promise<StubbedHost> {
	const watches: StubbedHost["watches"] = [];
	const route: { ws: WebSocketRoute | null; refuse: boolean } = { ws: null, refuse: false };
	let last = history.fine.t.at(-1) ?? history.now;
	await page.route("**/api/host", (route) => route.fulfill({ json: history }));
	await page.routeWebSocket(/\/ws$/, (ws) => {
		if (route.refuse) {
			void ws.close();
			return;
		}
		route.ws = ws;
		const server = ws.connectToServer();
		ws.onMessage((raw) => {
			const msg = JSON.parse(String(raw));
			if (msg.t === "host_watch")
				watches.push({
					on: msg.on,
					...(msg.detail ? { detail: true } : {}),
					...(msg.procs ? { procs: true } : {}),
				});
			server.send(raw);
		});
		server.onMessage((raw) => {
			if (!String(raw).includes('"t":"host_sample"')) ws.send(raw);
		});
	});
	return {
		watches,
		cut() {
			route.refuse = true;
			void route.ws?.close();
			route.ws = null;
		},
		reconnect() {
			route.refuse = false;
		},
		get next() {
			return last + 2000;
		},
		async push(point, extra = {}) {
			const t = point.t ?? last + 2000;
			last = t;
			// The page may not have connected yet: its socket is there once the app is on screen.
			await expect.poll(() => route.ws !== null).toBe(true);
			route.ws?.send(JSON.stringify({ t: "host_sample", point: lookAt(t, point), ...extra }));
		},
	};
}
