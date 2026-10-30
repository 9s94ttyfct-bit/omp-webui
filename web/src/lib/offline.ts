import type {
	Backend,
	BackendModels,
	ContextReport,
	LightModels,
	Mode,
	ModeState,
	OfflinePatch,
	OfflineSettings,
} from "@shared/offline.ts";
import { create } from "zustand";
import { t } from "../i18n/index.ts";
import { useApp } from "../store/app.ts";
import { ApiError } from "./api.ts";
import { errorText } from "./error-text.ts";
import { modeSuperseded } from "./offline-format.ts";
import { socket } from "./ws.ts";

/**
 * The mode new conversations start in (Full or Light) and what Light's models are, as the server holds them. One state for
 * every tab, so a change made in one is announced to the others (`mode_settings` message) and they load it again. A
 * conversation's own mode is its process's (`LiveInfo.mode`).
 */

async function call<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status, data.code, data.params);
	return data as T;
}

export const modeApi = {
	state: () => call<ModeState>("/api/mode"),
	update: (patch: { mode?: Mode; lightModels?: LightModels; offline?: OfflinePatch }) =>
		call<ModeState>("/api/mode", {
			method: "POST",
			headers: { "content-type": "application/json", "x-omp-webui": "1" },
			body: JSON.stringify(patch),
		}),
	/** The models a backend (default: the selected one) serves; rejects with what is wrong when it does not answer. */
	models: (backend?: Backend) => call<BackendModels>(`/api/offline/models${backend ? `?backend=${backend}` : ""}`),
	/** Measures a process of each mode (kept until something it depends on changes; `force`: again), so it is a POST. */
	context: (force = false) =>
		call<ContextReport>(`/api/offline/context${force ? "?force=1" : ""}`, {
			method: "POST",
			headers: { "x-omp-webui": "1" },
		}),
};

interface ModeStore {
	/** Null until the server has answered. */
	state: ModeState | null;
}

export const useMode = create<ModeStore>(() => ({ state: null }));

/** The mode new conversations start in; Full until the server says otherwise. */
export const selectMode = (s: ModeStore): Mode => s.state?.mode ?? "full";

/**
 * Show a state the server said, unless the page holds one it said later (`ModeState.rev`): a read answers with the
 * state of the moment the server handled it, which can be older than an announcement that reached the page first.
 */
function take(next: ModeState): void {
	useMode.setState((s) => (modeSuperseded(s.state, next) ? s : { state: next }));
}

export async function loadMode(): Promise<void> {
	try {
		const next = await modeApi.state();
		// While this page's saves are out it shows their change before the server has answered, and the revision of
		// that state is still the old one: a read handled before the save would replace it (the field and the
		// backend flip back, and what was typed meanwhile is lost). It is read again when the last save is done.
		if (saving > 0) missed = true;
		else take(next);
	} catch {
		// the next (re)connect tries again
	}
}

function report(e: unknown): void {
	useApp.getState().toast("error", errorText(e));
}

/** Saves started and not answered yet: only the last answer is the state the page shows. */
let saving = 0;
/** Another tab changed something while this page's saves were out: their answers may not include it. */
let missed = false;

/**
 * Send a change. The state the server answers with is the page's, unless another save of this page is still out
 * (whose answer is newer).
 */
async function send(patch: { mode?: Mode; lightModels?: LightModels; offline?: OfflinePatch }): Promise<ModeState> {
	saving++;
	try {
		const next = await modeApi.update(patch);
		if (saving === 1) take(next);
		return next;
	} finally {
		saving--;
		// What another tab changed meanwhile was not applied (see the handler below): look at the server's state now.
		if (saving === 0 && missed) {
			missed = false;
			void loadMode();
		}
	}
}

/**
 * Select the mode new conversations start in (New chat's Full / Light). Choosing Light with a local server's models also says
 * at once if the server is not answering, and which of the MCP servers chosen for Light are not in mcp.json.
 */
export async function setMode(mode: Mode): Promise<void> {
	let next: ModeState;
	try {
		next = await send({ mode });
	} catch (e) {
		report(e);
		return;
	}
	if (mode !== "light") return;
	// Once per choosing: servers the user selected for Light that mcp.json no longer has load nowhere.
	if (next.missingMcp.length)
		useApp.getState().toast("warning", t("mode.mcpMissingToast", { names: next.missingMcp.join(", ") }));
	if (next.lightModels === "local")
		void modeApi.models().catch((e: Error) => useApp.getState().toast("warning", errorText(e)));
}

/** Choose what Light's models are: the person's own, or a local server's (which is checked at once, as choosing Light on it is). */
export async function setLightModels(lightModels: LightModels): Promise<void> {
	try {
		await send({ lightModels });
	} catch (e) {
		report(e);
		return;
	}
	if (lightModels === "local")
		void modeApi.models().catch((e: Error) => useApp.getState().toast("warning", errorText(e)));
}

/**
 * What the page shows of `patch` before the server has answered. The addresses wait for the answer (the server
 * completes them), and another backend's model is not one of the new one's.
 */
function applied(offline: OfflineSettings, patch: OfflinePatch): OfflineSettings {
	const { baseUrls: _, ...fields } = patch;
	const next = { ...offline, ...fields };
	if (patch.backend && patch.backend !== offline.backend && !("model" in patch)) next.model = null;
	return next;
}

/**
 * Change offline settings. The page shows the change at once; the server's answer (or, when it refuses, what the
 * server has) replaces it. A list (MCP servers, tools, skills) is sent whole, so it is built from what this tab
 * shows: which is why every change anywhere is announced to every tab (`mode_settings`).
 */
export async function saveOffline(patch: OfflinePatch): Promise<void> {
	const current = useMode.getState().state;
	if (current) useMode.setState({ state: { ...current, offline: applied(current.offline, patch) } });
	try {
		await send({ offline: patch });
	} catch (e) {
		report(e);
		await loadMode();
	}
}

socket.on((msg) => {
	if (msg.t !== "mode_settings") return;
	// A change of this page's own is answered with the state it produced; applying this now would undo what is shown.
	if (saving > 0) missed = true;
	else take(msg.state);
});
socket.onStatus((connected) => {
	if (connected) void loadMode();
});
