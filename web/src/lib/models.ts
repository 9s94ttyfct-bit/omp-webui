import { parseSelector } from "@shared/model-config.ts";
import type { LiveState, ModelInfo } from "../store/live.ts";

/** The name a model is listed under. */
export function modelLabel(m: ModelInfo): string {
	return m.name ?? m.id;
}

/** Names more than one model is listed under: a model and its dated snapshot are both "Claude Haiku 4.5". */
export function sharedLabels(models: readonly ModelInfo[]): Set<string> {
	const seen = new Set<string>();
	const shared = new Set<string>();
	for (const m of models) (seen.has(modelLabel(m)) ? shared : seen).add(modelLabel(m));
	return shared;
}

/** The thinking levels omp has for most models: what is offered when it is not running to say which this one has. */
const USUAL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * The thinking levels to offer for `model` without asking omp: its catalog entry's efforts (and `off`) when the
 * catalog is at hand, else the usual ones. omp holds a level the model lacks to the nearest one it has.
 */
export function levelsFor(model: ModelInfo | undefined, catalog: readonly ModelInfo[] | null): string[] {
	const entry = model && catalog?.find((m) => m.provider === model.provider && m.id === model.id);
	if (entry?.thinking?.efforts) return ["off", ...entry.thinking.efforts];
	return entry?.reasoning === false ? ["off"] : USUAL_LEVELS;
}

/**
 * `levels` (omp's `get_available_thinking_levels`, or the catalog's) with `auto`, which omp accepts for any model that
 * can think but never lists: after `off`, where the terminal UI has it. Not for a model that cannot think or whose levels
 * omp has not verified (the terminal UI offers none there either).
 */
export function withAuto(levels: readonly string[], model: ModelInfo | undefined): string[] {
	const thinks = model?.reasoning !== false && !model?.thinking?.unverified && levels.some((l) => l !== "off");
	if (!thinks || levels.includes("auto")) return [...levels];
	const at = levels.indexOf("off") + 1;
	return [...levels.slice(0, at), "auto", ...levels.slice(at)];
}

/** What omp reads at start to decide the thinking level, from its config: the roles' selectors and the default level. */
export interface StartConfig {
	roles: Record<string, string>;
	defaultThinkingLevel?: string;
}

/** The value of a flag among a process's arguments, in either spelling (`--flag value`, `--flag=value`). */
function flagValue(args: readonly string[], flag: string): string | undefined {
	const i = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
	return i < 0 ? undefined : args[i] === flag ? args[i + 1] : args[i].slice(flag.length + 1);
}

/**
 * Whether a process started on `auto`. omp announces nothing at start, so it is worked out from what omp reads: the
 * `--thinking` flag, else the level of the `--model` selector, else of the default role's selector (`provider/id:auto`),
 * else `defaultThinkingLevel`. Verified against omp 18.12: each of the last three makes the first prompt announce
 * `configured: "auto"`, and `--thinking` overrides them. `config` is the one the process started with, null while the
 * page has not read it.
 */
export function startedOnAuto(args: readonly string[], config?: StartConfig | null): boolean {
	const flag = flagValue(args, "--thinking");
	if (flag !== undefined) return flag === "auto";
	const model = flagValue(args, "--model");
	const role = model ?? config?.roles.default;
	const level = (role ? parseSelector(role)?.level : undefined) ?? config?.defaultThinkingLevel;
	return level === "auto";
}

/**
 * What a conversation is set to, as a person chose it: `auto` stays `auto`, and the level omp resolved it to (what
 * `get_state` calls the conversation's level) comes as `resolved`, only while it is `auto`. In order of authority:
 * what this page heard omp announce (`live.thinking`: a `thinking_level_changed` frame); the journal's newest
 * `thinking_level_change` (`saved`: omp announces nothing when it resumes a conversation, and a page that attaches
 * later has heard nothing), where a level other than `auto` does not outweigh the level omp reports; how the process
 * was started (`startedOnAuto`: `--thinking auto`, or a config that defaults to it), which says nothing once anything
 * was picked and journaled; then the level omp reports. Without a process, the journal's level is all there is.
 */
export function selectedThinking(
	live: Pick<LiveState, "thinking" | "state" | "info"> | undefined,
	saved?: string,
	config?: StartConfig | null,
): { selected?: string; resolved?: string } {
	const reported = live?.state?.thinkingLevel;
	let selected = live?.thinking;
	if (selected === undefined) {
		if (saved === "auto") selected = "auto";
		else if (saved) selected = reported ?? saved;
		else selected = live && startedOnAuto(live.info.args, config) ? "auto" : reported;
	}
	return selected === "auto" && reported ? { selected, resolved: reported } : selected ? { selected } : {};
}
