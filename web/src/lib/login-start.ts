/**
 * Settings › App & system › Start at login: in the macOS app the app is asked (`ompwLogin`, macos/loginitem.swift: its own
 * login item); elsewhere the server (`/api/login-start`, server/login-start.ts: the launcher's entry on Windows and Linux).
 * Where neither can (a browser on a Mac, a server run from source) the switch is not shown.
 */

/** What the switch shows: `approval` is on, waiting for the person in macOS's System Settings. */
export type LoginStartState = "on" | "off" | "approval";

export interface LoginStartAnswer {
	state: LoginStartState;
	/** Why the last change did not take, in the system's words. */
	error?: string;
}

interface Bridge {
	postMessage(message: unknown): Promise<unknown>;
}

const bridge = (): Bridge | undefined =>
	typeof window === "undefined" ? undefined : window.webkit?.messageHandlers?.ompwLogin;

const STATES: readonly string[] = ["on", "off", "approval"];

function fromApp(reply: unknown): LoginStartAnswer | null {
	const { state, error } = (reply ?? {}) as { state?: unknown; error?: unknown };
	if (typeof state !== "string" || !STATES.includes(state)) return null;
	return { state: state as LoginStartState, ...(typeof error === "string" ? { error } : {}) };
}

async function server(on?: boolean): Promise<LoginStartAnswer | null> {
	const res = await fetch(
		"/api/login-start",
		on === undefined
			? undefined
			: {
					method: "POST",
					headers: { "content-type": "application/json", "x-omp-webui": "1" },
					body: JSON.stringify({ on }),
				},
	).catch(() => null);
	const data = (await res?.json().catch(() => null)) as { available?: unknown; on?: unknown; error?: unknown } | null;
	if (!res) return null;
	if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : res.statusText);
	return data?.available === true ? { state: data.on === true ? "on" : "off" } : null;
}

/** What the switch is now; null where this page has none to show. */
export async function loadLoginStart(): Promise<LoginStartAnswer | null> {
	const app = bridge();
	if (app) return fromApp(await app.postMessage({ type: "get" }).catch(() => null));
	return server();
}

/** Turn it on or off; the answer is what it is afterwards. Throws what went wrong. */
export async function setLoginStart(on: boolean): Promise<LoginStartAnswer> {
	const app = bridge();
	const answer = app ? fromApp(await app.postMessage({ type: "set", on })) : await server(on);
	if (!answer) throw new Error("Start at login is not available here");
	return answer;
}
