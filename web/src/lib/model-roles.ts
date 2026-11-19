import "../i18n/later.ts";
import type { MessageKey } from "../i18n/index.ts";

/** The roles omp knows, in the order they are listed, with their names. Others are listed after them by id. */
export const ROLES: Record<string, MessageKey> = {
	default: "presets.roleDefault",
	smol: "presets.roleSmol",
	slow: "presets.roleSlow",
	plan: "presets.rolePlan",
	task: "presets.roleTask",
	commit: "presets.roleCommit",
	vision: "presets.roleVision",
	advisor: "presets.roleAdvisor",
	tiny: "presets.roleTiny",
	memory: "presets.roleMemory",
	widget: "presets.roleWidget",
	web: "presets.roleWeb",
	image: "presets.roleImage",
	speech: "presets.roleSpeech",
	dictation: "presets.roleDictation",
	judge: "presets.roleJudge",
};
export const ROLE_ORDER = Object.keys(ROLES);
