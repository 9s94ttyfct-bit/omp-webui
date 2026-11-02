import { BROWSER_NOT_HERE, type BrowserState } from "@shared/browser.ts";
import { create } from "zustand";

/**
 * The built-in browser's install state as the page sees it (docs/agents/browser.md): what is installed, the newest version,
 * the job the server runs and whether this page may manage it. The server owns all of it (`server/browser/install.ts`);
 * this holds what it last said. It is in the first page's chunk (the socket's `browser_state` message lands here), so it
 * imports nothing but the store library; the Browser tab and Settings › Browser, which show it, are lazy chunks.
 */

interface BrowserStore {
	/** Null until the server has said anything. */
	state: BrowserState | null;
}

export const useBrowserState = create<BrowserStore>(() => ({ state: null }));

/**
 * Whether the next state is taken whatever its `rev`: the socket met a server again, which may be another run of it (its
 * `rev` starts over). Set by the socket's `hello`.
 */
let fresh = true;

/** The socket's `hello`: the server may be another run of it. */
export function browserServerMet(): void {
	fresh = true;
}

/**
 * Fold in a state the server told, on the socket or as the answer to a request: the state reaches the page twice over,
 * and an answer is the state as of its request, so one older than the state held (`rev`) is dropped.
 */
export function onBrowserState(state: BrowserState): void {
	const take = fresh;
	fresh = false;
	useBrowserState.setState((s) => (!take && s.state !== null && state.rev < s.state.rev ? {} : { state }));
}

/** What a refused request says; `notHere` when the page may not manage the browser. */
export class BrowserRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly notHere: boolean,
	) {
		super(message);
	}
}

async function request(path: string, post: boolean): Promise<BrowserState> {
	const res = await fetch(
		path,
		post
			? { method: "POST", headers: { "content-type": "application/json", "x-omp-webui": "1" }, body: "{}" }
			: undefined,
	);
	const data = await res.json().catch(() => ({}));
	if (!res.ok)
		throw new BrowserRequestError(data.error ?? res.statusText, res.status, data.problem === BROWSER_NOT_HERE);
	onBrowserState(data as BrowserState);
	return data as BrowserState;
}

export const browserApi = {
	load: () => request("/api/browser", false),
	/** Look up the newest version now. */
	check: () => request("/api/browser/check", true),
	/** Install the newest version, or update to it; the job's progress comes as `browser_state`. */
	install: () => request("/api/browser/install", true),
	cancel: () => request("/api/browser/cancel", true),
	/** Clear the browser's profile (the person was asked first). */
	clear: () => request("/api/browser/clear", true),
	/** Remove the browser and its profile (the person was asked first). */
	uninstall: () => request("/api/browser/uninstall", true),
};
