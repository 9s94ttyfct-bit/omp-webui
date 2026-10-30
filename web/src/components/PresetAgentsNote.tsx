import { registerStrings, useT } from "../i18n/index.ts";
import { en } from "../i18n/preset-agents.ts";
import { agentsLine } from "../lib/preset-agents.ts";
import type { ModelInfo } from "../store/live.ts";

// The note is a lazy chunk (the composer's save dialog loads it when it opens): its strings are not in the first page.
registerStrings("presetAgents", en);

/**
 * Under the name field of the save dialogs: the subagent models the preset will be saved with (the ones the conversation
 * or the configuration has now), or that it saves none and so leaves them as they are when it is applied. A default
 * export, as the lazy chunks of the composer have (`lazy(() => import("./PresetAgentsNote.tsx"))`).
 */
export default function PresetAgentsNote({
	agents,
	models,
}: {
	agents: Record<string, string>;
	models: ModelInfo[] | null;
}) {
	const t = useT();
	return (
		<p data-testid="preset-agents-note" className="mt-1.5 text-xs text-muted">
			{Object.keys(agents).length > 0
				? t("presetAgents.noteSet", { models: agentsLine(agents, models) })
				: t("presetAgents.noteNone")}
		</p>
	);
}
