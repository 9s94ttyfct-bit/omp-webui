import type { ErrorParams } from "@shared/error-info.ts";
import type { AppUpdateState, UpdateSnapshot } from "@shared/update.ts";
import { create } from "zustand";

/**
 * The app's own updates as the page sees them (#571): whether a newer release exists, and the install the server is
 * running. The server owns all of it (`server/update/`); this holds what it last said and offers the actions. It is in
 * the first page's chunk (the socket's `app_update` message lands here, and the sidebar's indicator reads it), so it
 * imports nothing but the store library; the card that shows the rest is loaded with Settings.
 */

interface AppUpdateStore {
	/** Null until the server has said anything: it says nothing on a page that came in through the tunnel. */
	state: AppUpdateState | null;
	/** The page's own first request is over (it was answered, or it could not be). */
	loaded: boolean;
}

export const useAppUpdate = create<AppUpdateStore>(() => ({ state: null, loaded: false }));

/**
 * Whether `incoming` is older than the state held: the server's state reaches the page twice over, on the socket and as
 * the answer to a request, and the answer is the state as of the request (the same order `OmpState` is kept in, see
 * `store/omp.ts`). A state of another run of the server is never older.
 */
export function supersededUpdate(held: AppUpdateState | null, incoming: AppUpdateState): boolean {
	return held !== null && held.boot === incoming.boot && incoming.rev < held.rev;
}

/** Fold in an answer of `GET /api/update` or of one of its actions. */
export function setAppUpdateSnapshot(snap: UpdateSnapshot): void {
	useAppUpdate.setState((s) => (supersededUpdate(s.state, snap.state) ? {} : { state: snap.state }));
}

/** The socket's `app_update` message. */
export function onAppUpdateMessage(state: AppUpdateState): void {
	useAppUpdate.setState((s) => (supersededUpdate(s.state, state) ? {} : { state }));
}

/** What a refused request says, and the `code` that tells the cases apart (`replying`, `busy`, `blocked`…). */
export class AppUpdateRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
		readonly params?: ErrorParams,
	) {
		super(message);
	}
}

async function request(path: string, body?: unknown): Promise<UpdateSnapshot> {
	const res = await fetch(
		path,
		body === undefined
			? undefined
			: {
					method: "POST",
					headers: { "content-type": "application/json", "x-omp-webui": "1" },
					body: JSON.stringify(body),
				},
	);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new AppUpdateRequestError(data.error ?? res.statusText, res.status, data.code, data.params);
	setAppUpdateSnapshot(data);
	return data;
}

export const appUpdateApi = {
	/** When the Updates card opens: whatever it answers, the card no longer waits for it. */
	load: () => request("/api/update").finally(() => useAppUpdate.setState({ loaded: true })),
	/** Look at GitHub now (the server answers from what it knows while rate limited, or within ten seconds of its last look). */
	check: () => request("/api/update/check", {}),
	/** Install `tag`, the release the user was shown; `anyway`: the user was told which conversations are replying and went on. */
	install: (tag: string, anyway = false) => request("/api/update/install", anyway ? { tag, anyway } : { tag }),
	/** Stop a download or a check of it. */
	cancel: () => request("/api/update/cancel", {}),
	/** Put away the failure and the outcome that are shown. */
	dismiss: () => request("/api/update/dismiss", {}),
};
