import { isRecord } from "./guards.ts";

/**
 * What the session panel reads of omp's `get_state` (the rows that omp reports, the model whose provider says which tier
 * fast mode is, and the status line's model), as far as a frozen omp can no longer be asked for it. The server keeps it
 * for a paused conversation: asked of omp just before it is frozen, kept true to every change made while it is
 * (`Live.noteSettingChange`; asked by `Live.askState`), written into the record of the paused conversation (`ParkedRecord.state`) and told to a page that
 * attaches (`LiveAttached.state`), so that the panel shows what omp had when it was paused (#619).
 */
export interface PanelState {
	model?: PanelModel;
	steeringMode?: string;
	followUpMode?: string;
	interruptMode?: string;
	autoCompactionEnabled?: boolean;
	fastModeEnabled?: boolean;
	fastModeActive?: boolean;
	slowModeSupported?: boolean;
	slowModeEnabled?: boolean;
	slowModeScope?: "global" | "session";
}

/** The active model as `get_state` names it: what the rows and the status line read of it. */
export interface PanelModel {
	id: string;
	provider: string;
	name?: string;
	/** The API the model speaks: with the provider, what omp's service tiers go by. */
	api?: string;
	reasoning?: boolean;
	contextWindow?: number;
	thinking?: { efforts?: string[]; unverified?: boolean };
}

/** The longest word a mode or a model's name is kept at: a record is the server's own, but a damaged one is not trusted with more. */
const WORD_MAX = 200;

const word = (v: unknown): string | undefined =>
	typeof v === "string" && v.length > 0 && v.length <= WORD_MAX ? v : undefined;
const flag = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const count = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

function modelOf(v: unknown): PanelModel | undefined {
	if (!isRecord(v)) return undefined;
	const id = word(v.id);
	const provider = word(v.provider);
	if (!id || !provider) return undefined;
	const thinking = isRecord(v.thinking)
		? {
				...(Array.isArray(v.thinking.efforts) && v.thinking.efforts.every((e) => word(e) !== undefined)
					? { efforts: v.thinking.efforts as string[] }
					: {}),
				...(flag(v.thinking.unverified) !== undefined ? { unverified: v.thinking.unverified as boolean } : {}),
			}
		: undefined;
	return {
		id,
		provider,
		...(word(v.name) ? { name: word(v.name) } : {}),
		...(word(v.api) ? { api: word(v.api) } : {}),
		...(flag(v.reasoning) !== undefined ? { reasoning: v.reasoning as boolean } : {}),
		...(count(v.contextWindow) !== undefined ? { contextWindow: v.contextWindow as number } : {}),
		...(thinking && Object.keys(thinking).length > 0 ? { thinking } : {}),
	};
}

/**
 * What `value` (omp's `get_state` answer, a record on disk, a reply) says of the panel's settings, as far as it says
 * them in the right words: a field that is missing or damaged is left out, never the rest. Undefined when it says none
 * of them (or is not a record).
 */
export function panelStateOf(value: unknown): PanelState | undefined {
	if (!isRecord(value)) return undefined;
	const out: PanelState = {};
	const model = modelOf(value.model);
	if (model) out.model = model;
	for (const key of ["steeringMode", "followUpMode", "interruptMode"] as const) {
		const w = word(value[key]);
		if (w !== undefined) out[key] = w;
	}
	for (const key of [
		"autoCompactionEnabled",
		"fastModeEnabled",
		"fastModeActive",
		"slowModeSupported",
		"slowModeEnabled",
	] as const) {
		const f = flag(value[key]);
		if (f !== undefined) out[key] = f;
	}
	if (value.slowModeScope === "global" || value.slowModeScope === "session") out.slowModeScope = value.slowModeScope;
	return Object.keys(out).length > 0 ? out : undefined;
}
