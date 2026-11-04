import { ChevronLeft, ChevronRight, Settings } from "lucide-react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import type { SettingsPageId } from "../lib/settings-pages.ts";
import { useApp } from "../store/app.ts";

/**
 * The row over a page that is a page of Settings (Commands & terminal, Memory): it says so, and goes back to the Settings
 * page that opens it.
 */
export function SettingsCrumb({ page, label, testId }: { page: SettingsPageId; label: MessageKey; testId: string }) {
	const t = useT();
	const setView = useApp((s) => s.setView);
	return (
		<nav
			aria-label={t("pages.settingsTitle")}
			className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2 text-sm"
		>
			<button
				type="button"
				data-testid={testId}
				aria-label={t("pages.settingsCliBack")}
				className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted hover:bg-hover hover:text-fg"
				onClick={() => setView({ kind: "settings", page })}
			>
				<ChevronLeft size={14} aria-hidden />
				<Settings size={14} aria-hidden /> {t("pages.settingsTitle")}
			</button>
			<ChevronRight size={14} aria-hidden className="text-faint" />
			<span aria-current="page" className="font-medium">
				{t(label)}
			</span>
		</nav>
	);
}
