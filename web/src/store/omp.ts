import type { ErrorParams } from "@shared/error-info.ts";
import { isRecord } from "@shared/guards.ts";
import type { InstallOptionId, OmpSnapshot, OmpState } from "@shared/omp-install.ts";
import { PREF } from "@shared/prefs.ts";
import type { ServerMessage } from "@shared/protocol.ts";
import { create } from "zustand";
import { setPref } from "../lib/prefs.ts";
import type { ModelInfo } from "./live.ts";

/**
 * omp itself as the page sees it: installed or not, how it was installed, whether a newer release exists, and
 * the install or update the server is running (with its output). The server owns all of it
 * (`server/omp/lifecycle.ts`); this holds what it last said and offers the actions.
 */

interface OmpStore {
	/** Null until the first answer: the page does not know yet whether omp is installed. */
	state: OmpState | null;
	/** The first look at the server's answer is over (it came, or it could not): until then the app is held back. */
	loaded: boolean;
	/** Output of the current job. */
	log: string;
}

export const useOmp = create<OmpStore>(() => ({ state: null, loaded: false, log: "" }));

/** The most output kept; the server keeps 256 KiB, a log pane has no use for more. */
const LOG_LIMIT = 256 * 1024;

/**
 * The server's state reaches the page twice over, on the socket and as the answer to a request, and the answer
 * is the state as of the request. An update that fails at once is `failed` on the socket before the answer that
 * says `running` is read, and taking that answer would leave the page on `running` for good. Every state carries
 * the server's order of saying them (`rev`), within one run of the server (`boot`): an older one is dropped.
 */
function superseded(held: OmpState | null, incoming: OmpState): boolean {
	return held !== null && held.boot === incoming.boot && incoming.rev < held.rev;
}

/** Fold in an answer of `GET /api/omp` or of one of its actions. */
export function setOmpSnapshot(snap: OmpSnapshot): void {
	useOmp.setState((s) => {
		if (superseded(s.state, snap.state)) return {};
		const sameJob = s.state?.job && s.state.job.id === snap.state.job?.id;
		// Output that arrived over the socket may be newer than the answer to a request made before it.
		const log = sameJob && s.log.length > snap.log.length ? s.log : snap.log;
		return { state: snap.state, log };
	});
}

/** The socket's `omp` and `omp_log` messages. */
export function onOmpMessage(msg: Extract<ServerMessage, { t: "omp" | "omp_log" }>): void {
	if (msg.t === "omp") {
		useOmp.setState((s) =>
			superseded(s.state, msg.state)
				? {}
				: {
						state: msg.state,
						// Another job: the output of the last one is not its.
						log: s.state?.job?.id === msg.state.job?.id ? s.log : "",
					},
		);
		return;
	}
	useOmp.setState((s) => (s.state?.job?.id === msg.job ? { log: (s.log + msg.text).slice(-LOG_LIMIT) } : {}));
}

/** What a refused request says, and the `code` that tells the cases apart (`outside_compat`, `busy`…). */
export class OmpRequestError extends Error {
	constructor(
		message: string,
		readonly code?: string,
		readonly params?: ErrorParams,
	) {
		super(message);
	}
}

async function request(path: string, body?: unknown): Promise<OmpSnapshot> {
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
	if (!res.ok) throw new OmpRequestError(data.error ?? res.statusText, data.code, data.params);
	setOmpSnapshot(data);
	return data;
}

export const ompApi = {
	/** The first call of the page: whatever it answers, the app no longer waits for it. */
	load: () => request("/api/omp").finally(() => useOmp.setState({ loaded: true })),
	install: (method: InstallOptionId) => request("/api/omp/install", { method }),
	/** Start an update; on one that is waiting, `anyway` stops it waiting for paused conversations and ones that need an answer. */
	update: (acknowledgeCompat: boolean, anyway = false) => request("/api/omp/update", { acknowledgeCompat, anyway }),
	/** Stop a waiting update or an install, or clear a job that has ended. */
	cancel: () => request("/api/omp/cancel", {}),
	check: () => request("/api/omp/check", {}),
	recheck: () => request("/api/omp/recheck", {}),
	setAutoUpdate: (autoUpdate: boolean) => request("/api/omp/settings", { autoUpdate }),
	setOnboarding: (pending: boolean) => request("/api/omp/onboarding", { pending }),
	/** The models omp can use, asked for again: the list of a minute ago predates a sign-in made since. */
	async models(): Promise<ModelInfo[]> {
		const res = await fetch("/api/models?force=1", { method: "POST", headers: { "x-omp-webui": "1" } });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error ?? res.statusText);
		return data;
	},
};

/**
 * What to show instead of the app: nothing yet (`loading`: the first answer is awaited, so the app does not ask
 * omp for things that cannot be answered), the screen that installs omp, the first-time setup, or nothing at all.
 */
export function ompScreen(s: Pick<OmpStore, "state" | "loaded">): "loading" | "first-run" | "onboarding" | null {
	if (!s.loaded) return "loading";
	if (!s.state) return null;
	if (s.state.status !== "ready") return "first-run";
	return s.state.onboarding ? "onboarding" : null;
}

/** Output of a log as a terminal shows it: a carriage return starts the line over, as a progress meter's does. */
export function logLines(log: string): string[] {
	return log
		.split("\n")
		.map((line) => line.split("\r").pop() ?? "")
		.filter((line, i, all) => line !== "" || i < all.length - 1);
}

// ------------------------------------------------------------------ notices the user put away

interface Dismissed {
	update?: string;
	compat?: string;
}

export function dismissedNotices(): Dismissed {
	try {
		const v: unknown = JSON.parse(localStorage.getItem(PREF.dismissed) ?? "{}");
		if (!isRecord(v)) return {};
		return {
			update: typeof v.update === "string" ? v.update : undefined,
			compat: typeof v.compat === "string" ? v.compat : undefined,
		};
	} catch {
		return {};
	}
}

/** Put a notice away until the version it names changes: `update` names the release offered, `compat` the installed omp. */
export function dismissNotice(kind: keyof Dismissed, version: string): void {
	setPref(PREF.dismissed, JSON.stringify({ ...dismissedNotices(), [kind]: version }));
}
