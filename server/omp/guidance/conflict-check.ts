import {
	CONFLICT_LIMITS,
	type ConflictCheckResult,
	type ConflictFailure,
	type ConflictSource,
	type GuidanceConflict,
} from "../../../shared/guidance-conflict.ts";
import { guidanceText } from "../../../shared/model-guidance.ts";
import { type Ask, labelOf, type ModelLike } from "../gate/review.ts";
import { buildConflictPrompt, ConflictCache, conflictKey, parseConflictReply, type SourceText } from "./conflict.ts";

/**
 * The guidance conflict check as the server runs it (`POST /api/model-guidance/conflicts`, `shared/guidance-conflict.ts`):
 * the sources of the conversation's folder are read, the prompt is made (`conflict.ts`), and the model is asked through the
 * path the guard's reviewer is benchmarked through (`server/guard-reviewer.ts`: one `omp -p` with no tools, no context
 * files, no memory and no MCP servers of its own, chosen by the gate's rule, so normally omp's `smol` role or the
 * reviewer the person set for the guard). One request per check; a check of the same guidance against the same sources
 * is answered from what was kept.
 *
 * Whatever goes wrong — no model, a timeout, an error, an answer that is not the JSON asked for — is an answer of its own
 * (`failed`), never a refusal of the save: the guidance was saved before the check was asked for.
 */

export interface ConflictCheckDeps {
	/** Whether Settings has the check on (read at each check). */
	enabled(): boolean;
	/** The models to ask, in order; the first that answers is the one. */
	models(): Promise<ModelLike[]>;
	ask: Ask;
	/** The context files omp loads for the folder (`conflict-sources.ts`). Throws when the folder cannot be read. */
	files(cwd: string): Promise<SourceText[]>;
	/** The memories omp keeps for the folder's project; a store that cannot be read is no memories. */
	memories(cwd: string): Promise<SourceText[]>;
	/** The longest one check may take (`CONFLICT_LIMITS.checkMs`). */
	timeoutMs?: number;
}

/**
 * How many models one check tries: the next one only when the one before could not be asked at all (an error, no
 * credentials, its quota). A model that answered, even with something that is not the JSON asked for, ends the check: a
 * second request would cost again for what is most likely the same kind of answer.
 */
const MODELS_TRIED = 2;

const brief = (e: unknown): string =>
	(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 300);

export class GuidanceConflictCheck {
	private readonly cache = new ConflictCache<{ conflicts: GuidanceConflict[]; model: string }>();

	constructor(private readonly deps: ConflictCheckDeps) {}

	async check(cwd: string, guidance: string): Promise<ConflictCheckResult> {
		if (!this.deps.enabled()) return { state: "off" };
		const text = guidanceText(guidance);
		if (!text) return { state: "empty" };
		let all: SourceText[];
		try {
			const [files, memories] = await Promise.all([
				this.deps.files(cwd),
				this.deps.memories(cwd).catch(() => [] as SourceText[]),
			]);
			all = [...files, ...memories];
		} catch (e) {
			return { state: "failed", reason: "folder", detail: brief(e) };
		}
		const prompt = buildConflictPrompt(text, all);
		if (prompt.sources.length === 0) return { state: "nothing", sources: [] };
		// What the model was shown, and so all it can name.
		const told = new Set(prompt.sources.map((s) => s.id));
		const sources = all.filter((s) => told.has(s.id));
		const key = conflictKey(prompt, text, sources);
		const kept = this.cache.get(key);
		if (kept) return answer(prompt.sources, kept.conflicts, kept.model, true);

		let models: ModelLike[];
		try {
			models = (await this.deps.models()).slice(0, MODELS_TRIED);
		} catch (e) {
			return { state: "failed", reason: "noModel", detail: brief(e) };
		}
		if (models.length === 0) return { state: "failed", reason: "noModel" };
		const deadline = AbortSignal.timeout(this.deps.timeoutMs ?? CONFLICT_LIMITS.checkMs);
		let failure: { reason: ConflictFailure; detail?: string } = { reason: "model" };
		for (const model of models) {
			if (deadline.aborted) break;
			try {
				const reply = await this.deps.ask(model, prompt.system, prompt.user, deadline);
				if (reply.stopReason === "error") {
					failure = { reason: "model", detail: `${labelOf(model)}: ${reply.errorMessage ?? "error"}` };
					continue;
				}
				const conflicts = parseConflictReply(reply.text, text, sources);
				if (conflicts === null) return { state: "failed", reason: "malformed", detail: labelOf(model) };
				this.cache.set(key, { conflicts, model: labelOf(model) });
				return answer(prompt.sources, conflicts, labelOf(model), false);
			} catch (e) {
				failure = deadline.aborted
					? { reason: "timeout" }
					: { reason: "model", detail: `${labelOf(model)}: ${brief(e)}` };
			}
		}
		if (deadline.aborted) failure = { reason: "timeout" };
		return { state: "failed", ...failure };
	}
}

function answer(
	sources: ConflictSource[],
	conflicts: GuidanceConflict[],
	model: string,
	cached: boolean,
): ConflictCheckResult {
	return conflicts.length === 0
		? { state: "clear", sources, model, cached }
		: { state: "found", sources, conflicts, model, cached };
}
