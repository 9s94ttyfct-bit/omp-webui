import { Send } from "lucide-react";
import { useEffect, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { onUsageChange, setStarPrompt, starPromptEnabled } from "../lib/usage-days.ts";
import { useApp } from "../store/app.ts";
import { Button, CardHeader } from "./ui.tsx";

/**
 * Settings › Feedback (#660): *Send feedback* opens the dialog (it was a button in the sidebar's foot; the command palette
 * and the shortcuts card still open it too), and whether the sidebar may ask for a GitHub star after sustained use.
 * Off also stops the page asking the server to look the repository's visibility up (which is a request to api.github.com),
 * and it is the same answer as "Don't ask again".
 */
export function StarPromptSetting() {
	const t = useT();
	const set = useApp((s) => s.set);
	const [, setVersion] = useState(0);
	useEffect(() => onUsageChange(() => setVersion((v) => v + 1)), []);
	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="feedback-settings">
			<CardHeader title={t("feedback.settingsTitle")} />
			<div className="mb-3 flex flex-wrap items-center gap-3">
				<Button data-testid="settings-feedback" className="shrink-0" onClick={() => set({ feedbackOpen: true })}>
					<Send size={14} /> {t("feedback.navFeedback")}
				</Button>
				{/* `basis-48`: on a phone the explanation goes under the button rather than into a narrow column beside it. */}
				<span className="min-w-0 flex-1 basis-48 text-xs text-muted">{t("feedback.settingsSendHint")}</span>
			</div>
			<label className="flex cursor-pointer items-start gap-3 text-sm">
				<input
					type="checkbox"
					className="mt-1 accent-[var(--accent)]"
					data-testid="star-prompt-setting"
					checked={starPromptEnabled(localStorage)}
					onChange={(e) => setStarPrompt(e.target.checked)}
				/>
				<span>
					{t("feedback.settingsStar")}
					<span className="block text-xs text-muted">{t("feedback.settingsStarHint")}</span>
				</span>
			</label>
		</section>
	);
}
