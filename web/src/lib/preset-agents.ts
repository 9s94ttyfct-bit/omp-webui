import type { ModelInfo } from "../store/live.ts";
import { describeSelector } from "./model-config.ts";

/** Subagent models as a person reads them: `reviewer → Haiku · low, scout → Sonnet`. */
export function agentsLine(agents: Record<string, string>, models: ModelInfo[] | null): string {
	return Object.entries(agents)
		.map(([agent, selector]) => `${agent} → ${describeSelector(selector, models)}`)
		.join(", ");
}
