import { errorText } from "./error-text.ts";

/**
 * What was chosen in the New chat footer (preset, model, thinking level). The pickers act on the process warmed up
 * for the page, and that process is replaced whenever the folder or the options change: the choices are kept here and
 * put on the next process, so they do not snap back to the defaults without a word.
 */
export interface Picks {
	preset?: string;
	model?: PickedModel;
	thinking?: string;
}

export interface PickedModel {
	provider: string;
	modelId: string;
}

/** A preset sets the default model and thinking level too: what was chosen before it is void, what comes after stands on top. */
export function pickPreset(_before: Picks, preset: string): Picks {
	return { preset };
}

export function pickModel(before: Picks, model: PickedModel): Picks {
	return { ...before, model };
}

export function pickThinking(before: Picks, thinking: string): Picks {
	return { ...before, thinking };
}

/** What a pick needs from the process it is put on. */
export interface PickIo {
	switchPreset(name: string): Promise<void>;
	setModel(model: PickedModel): Promise<void>;
	setThinking(level: string): Promise<void>;
	/**
	 * What the process runs now (null when it cannot say). `thinking` is the level it is set to as a person chose it
	 * (`selectedThinking`: `auto` stays `auto`), not the level `get_state` reports, which is the one `auto` resolved to.
	 */
	running(): Promise<{ model?: { provider: string; id: string }; thinking?: string } | null>;
}

/** A pick the new process did not take: which one, what it was, and why. */
export interface LostPick {
	pick: keyof Picks;
	what: string;
	error: string;
}

/**
 * Put `picks` on a process in the order the user chose them: the preset, then the model, then the thinking level
 * (a preset moves both, so it comes first). A model or level the process already runs is left alone: setting it
 * again would only add a model-change note. A pick that fails does not stop the others; it is returned, and the
 * caller says so. Stops as soon as `alive` says the process is no longer wanted.
 */
export async function applyPicks(picks: Picks, io: PickIo, alive: () => boolean): Promise<LostPick[]> {
	const lost: LostPick[] = [];
	const attempt = async (pick: keyof Picks, what: string, run: () => Promise<void>) => {
		if (!alive()) return;
		try {
			await run();
		} catch (e) {
			lost.push({ pick, what, error: errorText(e) });
		}
	};
	const { preset, model, thinking } = picks;
	if (preset !== undefined) await attempt("preset", preset, () => io.switchPreset(preset));
	if (model === undefined && thinking === undefined) return lost;
	// The preset moved the process off its defaults, so what it runs is asked for, not assumed.
	let running = alive() ? await io.running() : null;
	if (model !== undefined && !(running?.model?.provider === model.provider && running.model.id === model.modelId)) {
		await attempt("model", `${model.provider}/${model.modelId}`, () => io.setModel(model));
		// Another model may hold another level than the one the process had.
		if (thinking !== undefined && alive()) running = (await io.running()) ?? running;
	}
	if (thinking !== undefined && running?.thinking !== thinking) {
		await attempt("thinking", thinking, () => io.setThinking(thinking));
	}
	return lost;
}

/** The picks to keep: one a process did not take is not tried on the next one, which would only fail the same way. */
export function withoutLost(picks: Picks, lost: readonly LostPick[]): Picks {
	const kept = { ...picks };
	for (const { pick } of lost) delete kept[pick];
	return kept;
}
