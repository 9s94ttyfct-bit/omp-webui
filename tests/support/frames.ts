import { partOf } from "../../shared/reply-parts.ts";
/** A frame omp sent, as the server forwards it. */
export type Frame = { type: string; [key: string]: unknown };

/**
 * What one tab (a WebSocket) is told about a process's frames: every frame so far, and a way to wait for the one a
 * test needs. A wait has no timer of its own: a frame that never comes ends the test at the test's timeout.
 */
export function watchFrames(ws: WebSocket, liveId: string) {
	const seen: Frame[] = [];
	const waiting: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
	ws.addEventListener("message", (ev) => {
		// A part of a big reply is no frame (see `shared/reply-parts.ts`).
		if (partOf(String(ev.data)) !== null) return;
		const m = JSON.parse(String(ev.data));
		if (m.t !== "frame" || m.liveId !== liveId) return;
		const frame = m.frame as Frame;
		seen.push(frame);
		for (const w of waiting.filter((x) => x.match(frame))) {
			waiting.splice(waiting.indexOf(w), 1);
			w.resolve(frame);
		}
	});
	/** The first frame at or after `from` that satisfies `match`, whether it has come already or is still to come. */
	const next = (match: (f: Frame) => boolean, from = 0): Promise<Frame> => {
		const found = seen.slice(from).find(match);
		if (found) return Promise.resolve(found);
		const { promise, resolve } = Promise.withResolvers<Frame>();
		waiting.push({ match: (f) => seen.indexOf(f) >= from && match(f), resolve });
		return promise;
	};
	return {
		seen,
		next: (match: (f: Frame) => boolean) => next(match),
		/** The first frame of this type that comes after this call. */
		after: (type: string) => next((f) => f.type === type, seen.length),
	};
}

/** A message from the server, whatever its kind. */
export type ServerMsg = { t: string; [key: string]: unknown };

/** The first message from now on that satisfies `match` (register it before doing what causes it). */
export function messageWhere(ws: WebSocket, match: (m: ServerMsg) => boolean): Promise<ServerMsg> {
	const { promise, resolve } = Promise.withResolvers<ServerMsg>();
	const listener = (ev: MessageEvent) => {
		if (partOf(String(ev.data)) !== null) return;
		const m = JSON.parse(String(ev.data)) as ServerMsg;
		if (!match(m)) return;
		ws.removeEventListener("message", listener);
		resolve(m);
	};
	ws.addEventListener("message", listener);
	return promise;
}
