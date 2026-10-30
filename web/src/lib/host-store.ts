import type { HostHistory, HostInfo, HostProc } from "@shared/host.ts";
import type { ServerMessage } from "@shared/protocol.ts";
import { create } from "zustand";
import { appendRow, type HostRow, mergeRows, rowsOf } from "./host-rows.ts";

/**
 * What the page holds of the host's load (#613): the last hour (a row per look) and the last day (a row per minute) that the
 * server has told, as `GET /api/host` answered and the socket's `host_sample` added to it. Only the store library: the
 * wiring to the socket and the watch is `lib/host.ts`.
 */

/** What the server keeps, until it says (`info`): an hour of looks and a day of minutes. */
const FINE_SPAN_MS = 3_600_000;
const COARSE_SPAN_MS = 24 * 3_600_000;

export interface HostStore {
	/** What does not change while the server runs; null until the first answer of `GET /api/host`. */
	info: HostInfo | null;
	/** The last hour, a row per look, oldest first. */
	fine: HostRow[];
	/** The last day, a row per finished minute. */
	coarse: HostRow[];
	/** The processes' latest figures, while a page asks for them (`useHostWatch({ procs: true })`). */
	procs: HostProc[] | null;
	/** `GET /api/host` has been answered. */
	loaded: boolean;
	/** The history could not be read and there is nothing of it to show: the rows that come over the socket are all there will be. */
	failed: boolean;
}

export const useHost = create<HostStore>(() => ({
	info: null,
	fine: [],
	coarse: [],
	procs: null,
	loaded: false,
	failed: false,
}));

/** The server's answer: the history as it was when it was cut, with what the socket told since. */
export function takeHistory(h: HostHistory): void {
	useHost.setState((s) => ({
		info: h.info,
		// A look that came over the socket while the request was on its way is newer than the answer's clock: it stays.
		fine: mergeRows(
			rowsOf(h.fine),
			s.fine.filter((r) => r.t > h.now),
		),
		coarse: mergeRows(
			rowsOf(h.coarse),
			s.coarse.filter((r) => r.t > h.now),
		),
		procs: h.procs ?? s.procs,
		loaded: true,
		failed: false,
	}));
}

/**
 * One `host_sample` of the socket: the look, the minute it finished, and the processes when this page asked for them. True
 * when the page should read the history again: it learned the GPU is there after it read what the server knew.
 */
export function takeSample(msg: Extract<ServerMessage, { t: "host_sample" }>): boolean {
	const s = useHost.getState();
	useHost.setState({
		fine: appendRow(s.fine, msg.point, s.info?.fineSpanMs ?? FINE_SPAN_MS),
		coarse: msg.minute ? appendRow(s.coarse, msg.minute, s.info?.coarseSpanMs ?? COARSE_SPAN_MS) : s.coarse,
		procs: msg.procs ?? s.procs,
	});
	// The page read what the server knew before the server had read the GPU: its name and cores are in a newer answer.
	return msg.point.gpu !== null && s.info !== null && s.info.gpu === null;
}
