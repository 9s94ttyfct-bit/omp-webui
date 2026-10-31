import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { setToolTimerMode, TOOL_TIMERS, type ToolTimerMode, toolTimerOf, useToolTimerMode } from "../lib/tool-timer.ts";
import { Select } from "./Select.tsx";
import { WithCode } from "./ui.tsx";

const LABELS: Record<ToolTimerMode, MessageKey> = {
	all: "pages.settingsToolTimerAll",
	shell: "pages.settingsToolTimerShell",
	off: "pages.settingsToolTimerOff",
};

/**
 * Settings › Conversations: which tool calls show how long they run (#657). The choice follows the person, as the other
 * preferences do (`ompw.toolTimer`, `lib/prefs.ts`), and is the same for the cards in the transcript, the `!commands` that
 * run, and a subagent's tools.
 */
export function ToolTimerSetting() {
	const t = useT();
	const mode = useToolTimerMode();
	return (
		<div className="mt-3 text-sm" data-testid="tool-timer-setting">
			<label className="block">
				{t("pages.settingsToolTimer")}
				<span className="block text-xs text-muted">
					<WithCode text={t("pages.settingsToolTimerHint")} />
				</span>
				<Select
					className="mt-1.5"
					data-testid="tool-timer-mode"
					value={mode}
					onValueChange={(v) => setToolTimerMode(toolTimerOf(v))}
				>
					{TOOL_TIMERS.map((m) => (
						<option key={m} value={m}>
							{t(LABELS[m])}
						</option>
					))}
				</Select>
			</label>
		</div>
	);
}
