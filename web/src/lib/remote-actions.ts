import type { LiveAttached } from "@shared/protocol.ts";
import { REMOTE_LOCKS_OUT, type RemoteConfig, type RemoteLogin, type RemoteSnapshot } from "@shared/remote.ts";
import type { RemoteCheck } from "@shared/remote-ai.ts";
import {
	act,
	remoteApi as first,
	RemoteError,
	type RemoteLockOut,
	request,
	setRemoteSnapshot,
	useRemote,
} from "./remote.ts";

/**
 * The actions of the Remote access card and of "Set up with AI". They are apart from the store (`remote.ts`) because the first
 * paint does not need them: only the card's page and the AI set-up import this file, so they are not in the first load. Each
 * one answers with the whole snapshot, so the page never has to guess what the server did: the settings it kept, the state of
 * the tunnel, and whether `cloudflared` is there and signed in.
 */

/** An action of the card whose whole answer is the snapshot. */
function snapshotAction(name: string, path: string): Promise<RemoteSnapshot | null> {
	return act(name, async () => {
		const snapshot = await request<RemoteSnapshot>(path, {});
		setRemoteSnapshot(snapshot);
		return snapshot;
	});
}

const GUARDED_PATH: Record<RemoteLockOut["action"], string> = {
	config: "/api/remote/config",
	stop: "/api/remote/stop",
};

/**
 * A change that may shut this page out (a page signed in through Access): the server refuses it with `REMOTE_LOCKS_OUT`
 * until the person confirms it (#363). The card then asks (`lockOut`), and `confirmLockOut` sends it again with
 * `confirm: true`.
 */
function guarded(action: RemoteLockOut["action"], body: Record<string, unknown>): Promise<RemoteSnapshot | null> {
	return act(action, async () => {
		try {
			const snapshot = await request<RemoteSnapshot>(GUARDED_PATH[action], body);
			setRemoteSnapshot(snapshot);
			return snapshot;
		} catch (e) {
			if (!(e instanceof RemoteError) || e.code !== REMOTE_LOCKS_OUT) throw e;
			useRemote.setState({ lockOut: { action, message: e.message, body } });
			return null;
		}
	});
}

export const remoteApi = {
	...first,

	/** Change the settings: the fields that are given, and only those. */
	setConfig: (patch: Partial<RemoteConfig>) => guarded("config", patch),

	/** Put `cloudflared` on this machine (Homebrew on macOS, Cloudflare's own build elsewhere). Long: the card holds the button until it has ended. */
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

	/** Stop the tunnel; this turns remote access off. */
	stop: () => guarded("stop", {}),

	/** Go ahead with the change that would shut this page out (`lockOut`): the person said so. */
	confirmLockOut(): Promise<RemoteSnapshot | null> {
		const pending = useRemote.getState().lockOut;
		if (!pending) return Promise.resolve(null);
		useRemote.setState({ lockOut: null });
		return guarded(pending.action, { ...pending.body, confirm: true });
	},

	/** Leave the change that would shut this page out unmade. */
	cancelLockOut(): void {
		useRemote.setState({ lockOut: null });
	},

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
			await first.load();
			return info;
		}),
};
