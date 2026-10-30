import type { SessionEntry } from "@shared/protocol.ts";
import type { ModelInfo } from "../store/live.ts";
import { Fold } from "./lineage.ts";

/**
 * What a conversation without a running omp comes back with: the model and thinking level its transcript leaves.
 * The controls show them until omp runs and says (it restores exactly these when it resumes the conversation).
 */
export interface SavedSettings {
	model?: ModelInfo;
	thinking?: string;
}

/**
 * The settings the entries of one branch (root first) leave, read the way omp reads them to resume: the last
 * thinking-level change, and the last default-role model change; a conversation older than model changes has the
 * model of its last reply.
 */
export function savedSettings(path: readonly SessionEntry[]): SavedSettings {
	return settingsFold.run(path as SessionEntry[]).out;
}

interface SettingsState {
	thinking: string | undefined;
	model: string | undefined;
	explicit: boolean;
	out: SavedSettings;
}

/** The settings change rarely: the same object is returned while they did not, and the path is read from where it was last. */
const settingsFold = new Fold<SessionEntry, SettingsState>(
	() => ({ thinking: undefined, model: undefined, explicit: false, out: {} }),
	(state, path, from) => {
		let { thinking, model, explicit } = state;
		for (let i = from; i < path.length; i++) {
			const e = path[i];
			if (e.type === "thinking_level_change") {
				// `configured` is the selector the user chose when it is not the level itself (`auto`); an explicit level has none.
				thinking =
					typeof e.configured === "string"
						? e.configured
						: typeof e.thinkingLevel === "string"
							? e.thinkingLevel
							: "off";
			} else if (e.type === "model_change") {
				if (typeof e.model !== "string" || !e.model) continue;
				if ((typeof e.role === "string" ? e.role : "default") !== "default") continue;
				model = e.model;
				explicit = true;
			} else if (!explicit && e.type === "message") {
				const m = e.message as { role?: string; provider?: string; model?: string } | undefined;
				if (m?.role === "assistant" && m.provider && m.model) model = `${m.provider}/${m.model}`;
			}
		}
		if (thinking === state.thinking && model === state.model)
			return explicit === state.explicit ? state : { ...state, explicit };
		const slash = model?.indexOf("/") ?? -1;
		const out: SavedSettings = {
			...(model && slash > 0 ? { model: { provider: model.slice(0, slash), id: model.slice(slash + 1) } } : {}),
			...(thinking ? { thinking } : {}),
		};
		return { thinking, model, explicit, out };
	},
);
