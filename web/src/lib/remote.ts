import type { LiveAttached } from "@shared/protocol.ts";
import type { RemoteConfig, RemoteLogin, RemoteSnapshot, RemoteStatus } from "@shared/remote.ts";
import type { RemoteCheck } from "@shared/remote-ai.ts";
import { create } from "zustand";

/**
 * Remote access (Cloudflare Tunnel + Access), as the page sees it: what the server says about the tunnel, and the
 * actions the card offers.
 *
 * The server owns the settings (`<dataDir>/remote.json`) and the tunnel (`server/remote-tunnel.ts`); this holds
 * what it last said and asks for changes. The routes are local-only: a page that came in through the tunnel is
 * refused them (403), so a remote page never sees the card's actions.
 */

/** What the server refused, and the code that tells the cases apart. */
export class RemoteError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
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
}

export const useRemote = create<RemoteStore>(() => ({
	snapshot: null,
	loaded: false,
	loginUrl: null,
	busy: null,
	error: null,
	check: null,
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
 * The socket's `remote` message. Its status is shown at once (while `brew install` runs, `message` is the line it last
 * printed), and the whole answer is asked for again: a login or an install that ends changes `loggedIn` and `installed`,
 * which `status.state` does not say.
 */
export function onRemoteMessage(status: RemoteStatus): void {
	useRemote.setState((s) => (s.snapshot ? { snapshot: { ...s.snapshot, status } } : {}));
	void remoteApi.load();
}

/**
 * The card's actions. Each one answers with the whole snapshot, so the page never has to guess what the server
 * did: the settings it kept, the state of the tunnel, and whether `cloudflared` is there and signed in.
 */
async function request<T>(path: string, body?: unknown): Promise<T> {
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
	if (!res.ok) throw new RemoteError(data.error ?? res.statusText, res.status);
	return data as T;
}

/**
 * Run an action: the card holds the button while it is running, and says what went wrong if it fails. What a check
 * of the address found is about the settings as they were: any other action takes it away.
 */
async function act<T>(name: string, run: () => Promise<T>): Promise<T | null> {
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

/** An action of the card whose whole answer is the snapshot. */
function snapshotAction(name: string, path: string): Promise<RemoteSnapshot | null> {
	return act(name, async () => {
		const snapshot = await request<RemoteSnapshot>(path, {});
		setRemoteSnapshot(snapshot);
		return snapshot;
	});
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

	/** Change the settings: the fields that are given, and only those. */
	async setConfig(patch: Partial<RemoteConfig>): Promise<RemoteSnapshot | null> {
		return act("config", async () => {
			const snapshot = await request<RemoteSnapshot>("/api/remote/config", patch);
			setRemoteSnapshot(snapshot);
			return snapshot;
		});
	},

	/** Put `cloudflared` on this machine (Homebrew). Long: the card holds the button until it has ended. */
	install: () => snapshotAction("install", "/api/remote/install"),

	/**
	 * Log this machine in to Cloudflare. The server answers with the URL the browser has to visit: it is kept here
	 * until the page has opened it (the user signs in there, and the server notices the certificate afterwards).
	 */
	async login(): Promise<RemoteLogin | null> {
		return act("login", async () => {
			const answer = await request<RemoteLogin>("/api/remote/login", {});
			setRemoteSnapshot(answer);
			useRemote.setState({ loginUrl: answer.loginUrl });
			return answer;
		});
	},

	/** Create the tunnel (if there is none), point the hostname at it and write its config. */
	setup: () => snapshotAction("setup", "/api/remote/setup"),

	/** Start the tunnel (this turns remote access on); the server says what is missing when it cannot. */
	start: () => snapshotAction("start", "/api/remote/start"),

	/** Stop the tunnel; remote access stays turned on. */
	stop: () => snapshotAction("stop", "/api/remote/stop"),

	/** Look at the public address from outside; what was found is kept for the card to show. */
	async check(): Promise<RemoteCheck | null> {
		return act("check", async () => {
			const found = await request<RemoteCheck>("/api/remote/check", {});
			useRemote.setState({ check: found });
			return found;
		});
	},

	/** The switch "Let the AI help with remote access". Off takes the tools away from every conversation at once. */
	setAi: (enabled: boolean) =>
		act("ai", async () => {
			const snapshot = await request<RemoteSnapshot>("/api/remote/ai", { enabled });
			setRemoteSnapshot(snapshot);
			return snapshot;
		}),

	/**
	 * "Set up with AI": turns the help on and starts a conversation whose agent has the remote access tools. The
	 * answer is that conversation's process; the page opens it (see `setUpWithAi`).
	 */
	startAi: () =>
		act("ai", async () => {
			const info = await request<LiveAttached>("/api/remote/ai/start", {});
			// The switch is on now, and the conversation holds the tools: the card shows both.
			await remoteApi.load();
			return info;
		}),
};
