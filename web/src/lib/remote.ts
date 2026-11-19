import type { RemoteSnapshot, RemoteStatus } from "@shared/remote.ts";
import type { RemoteCheck } from "@shared/remote-ai.ts";
import { create } from "zustand";

/**
 * Remote access (Cloudflare Tunnel + Access), as the page sees it: what the server says about the tunnel, and the
 * actions the card offers.
 *
 * The server owns the settings (`<dataDir>/remote.json`) and the tunnel (`server/remote-tunnel.ts`); this holds
 * what it last said and asks for changes. The routes are the person's own (`isOwnerRoute`): a page that holds only the
 * token is refused them (403), so such a page never sees the card's actions.
 */

/** What the server refused, and the code that tells the cases apart. */
export class RemoteError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message);
	}
}

/** A change the server makes only once the person confirms it: it would shut this page out (#363). */
export interface RemoteLockOut {
	action: "config" | "stop";
	/** What the server said, naming the address and the reason. */
	message: string;
	/** What is sent again, with `confirm: true`, when the person goes ahead. */
	body: Record<string, unknown>;
}

interface RemoteStore {
	/** Null until the first answer: the page does not know yet whether the tunnel is on. */
	snapshot: RemoteSnapshot | null;
	/** The first look at the server's answer is over (it came, or it could not): until then the card shows nothing. */
	loaded: boolean;
	/** The URL Cloudflare asked the browser to visit to log in, while that link is still the one to open. */
	loginUrl: string | null;
	/** The action that is running, so the card can hold the button that started it. */
	busy: string | null;
	/** Why the last action failed, in the card's own words. */
	error: string | null;
	/** What the last check of the public address found; null before one. */
	check: RemoteCheck | null;
	/** A change waiting for the person's confirmation, because it would shut this page out (#363). */
	lockOut: RemoteLockOut | null;
}

export const useRemote = create<RemoteStore>(() => ({
	snapshot: null,
	loaded: false,
	loginUrl: null,
	busy: null,
	error: null,
	check: null,
	lockOut: null,
}));

/**
 * Told when a Cloudflare login that this page did not start is waiting for the browser (the AI started it: the link is
 * for the person and never goes to the AI, so the page is where they find it). Set by the app, which has the toasts.
 */
let loginNotice: ((url: string) => void) | null = null;
export function onLoginNotice(handler: (url: string) => void): void {
	loginNotice = handler;
}

/** Fold in the server's answer: the state of the tunnel, and whatever the action was about. */
export function setRemoteSnapshot(snapshot: RemoteSnapshot): void {
	const { loginUrl, busy } = useRemote.getState();
	useRemote.setState({ snapshot });
	// A login that waits for the browser and that the card did not ask for: the card shows its link, and says so.
	if (snapshot.loginUrl && snapshot.loginUrl !== loginUrl) {
		useRemote.setState({ loginUrl: snapshot.loginUrl });
		if (busy !== "login") loginNotice?.(snapshot.loginUrl);
	}
}

/**
 * The socket's `remote` message. Its status is shown at once (while an install runs, `message` is what it last said),
 * and the whole answer is asked for again: a login or an install that ends changes `loggedIn` and `installed`,
 * which `status.state` does not say.
 */
export function onRemoteMessage(status: RemoteStatus): void {
	useRemote.setState((s) => (s.snapshot ? { snapshot: { ...s.snapshot, status } } : {}));
	void remoteApi.load();
}

/**
 * The card's actions are in `remote-actions.ts`, which only the card and the AI set-up load: the first paint needs the
 * store, `request` and `act`, and the first look at the server (`remoteApi.load`).
 */
export async function request<T>(path: string, body?: unknown): Promise<T> {
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
	if (!res.ok) throw new RemoteError(data.error ?? res.statusText, res.status, data.code);
	return data as T;
}

/**
 * Run an action: the card holds the button while it is running, and says what went wrong if it fails. What a check
 * of the address found is about the settings as they were: any other action takes it away.
 */
export async function act<T>(name: string, run: () => Promise<T>): Promise<T | null> {
	useRemote.setState({ busy: name, error: null, ...(name === "check" ? {} : { check: null }) });
	try {
		return await run();
	} catch (e) {
		useRemote.setState({ error: (e as Error).message });
		return null;
	} finally {
		useRemote.setState({ busy: null });
	}
}

export const remoteApi = {
	/** The first call of the card: whatever it answers, the card stops waiting. */
	async load(): Promise<void> {
		try {
			setRemoteSnapshot(await request<RemoteSnapshot>("/api/remote"));
		} catch {
			// A server that does not know the route (an older one) leaves the card out: nothing to show.
		} finally {
			useRemote.setState({ loaded: true });
		}
	},
};
