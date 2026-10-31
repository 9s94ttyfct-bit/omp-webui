import type { LiveAttached } from "@shared/protocol.ts";
import type { SettingsChange, SettingsHelpState } from "@shared/settings-help.ts";
import { t } from "../i18n/index.ts";
import { attachLive, useApp } from "../store/app.ts";
import { setSettingsHelpState } from "../store/settings-help.ts";
import "./settings-help-strings.ts";
import { socket } from "./ws.ts";

/**
 * Ask agent for help (Settings): the requests a page on this computer makes (`/api/settings-help*`, local-only), and the
 * start of the dedicated conversation. Loaded with Settings' card and with the strip of the dedicated conversation.
 */

/** A request the server refused, with what it said. */
export class SettingsHelpRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

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
	const data = (await res.json().catch(() => ({}))) as T & { error?: string; state?: SettingsHelpState };
	if (!res.ok) throw new SettingsHelpRequestError(data.error ?? res.statusText, res.status);
	return data;
}

/**
 * Read the state (the socket keeps it current while it is connected). Asked again by every card and strip as it is shown,
 * so a message missed while the socket reconnected is not missed for long; two asks at once are one request. Quiet on
 * failure: what shows it stays as it was.
 */
let loading: Promise<void> | null = null;
export function loadSettingsHelp(): Promise<void> {
	loading ??= request<SettingsHelpState>("/api/settings-help")
		.then(setSettingsHelpState)
		.catch(() => {})
		.finally(() => {
			loading = null;
		});
	return loading;
}

/** Fold the state a request answered with into the store. */
async function withState<T extends { state: SettingsHelpState }>(pending: Promise<T>): Promise<T> {
	const answer = await pending;
	setSettingsHelpState(answer.state);
	return answer;
}

export const settingsHelpApi = {
	revoke: async (liveId: string) =>
		setSettingsHelpState(await request<SettingsHelpState>("/api/settings-help/revoke", { liveId })),
	answer: async (id: string, allow: boolean) =>
		setSettingsHelpState(await request<SettingsHelpState>("/api/settings-help/answer", { id, allow })),
	undo: (id: string) =>
		withState(request<{ change: SettingsChange; state: SettingsHelpState }>("/api/settings-help/undo", { id })),
	undoAll: (liveId: string) =>
		withState(
			request<{ undone: number; failed: { key: string; error: string }[]; state: SettingsHelpState }>(
				"/api/settings-help/undo-all",
				{ liveId },
			),
		),
};

/**
 * "Ask agent for help": the server starts the conversation with its access; this opens it, names it, and sends the first
 * message, in the page's language, saying where in Settings the person was. False when it could not be started (a toast
 * says why), with nothing left running that the page does not show.
 */
export async function askAgentForHelp(where: string): Promise<boolean> {
	const { toast, setView } = useApp.getState();
	let info: LiveAttached;
	try {
		info = await request<LiveAttached>("/api/settings-help/start", {});
	} catch (e) {
		toast("error", t("settingsHelp.startFailed", { error: (e as Error).message }));
		return false;
	}
	void loadSettingsHelp();
	if (!(await attachLive(info.liveId))) return false;
	try {
		await socket.rpc(info.liveId, { type: "set_session_name", name: t("settingsHelp.conversationTitle") });
		await socket.rpc(info.liveId, { type: "prompt", message: t("settingsHelp.prompt", { where }) });
	} catch (e) {
		toast("error", (e as Error).message);
		return false;
	}
	setView({ kind: "chat", file: null, liveId: info.liveId });
	return true;
}
