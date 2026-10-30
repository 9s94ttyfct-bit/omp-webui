import { TriangleAlert } from "lucide-react";
import { useT } from "../i18n/index.ts";
import { showShortcutsSettings } from "../lib/shortcut-view.ts";
import { type WebEquivalent, webEquivalent } from "../lib/slash.ts";
import { useApp } from "../store/app.ts";
import { Button } from "./ui.tsx";

/** Go to where the web UI has what a terminal-only command does. */
function goTo(to: NonNullable<WebEquivalent["action"]>["to"]): void {
	const app = useApp.getState();
	if (to === "new") app.setView({ kind: "new" });
	else if (to === "settings") app.setView({ kind: "settings" });
	else if (to === "panel") app.set({ panelOpen: true });
	else if (to === "search") app.set({ paletteOpen: true });
	// The shortcuts are a card of Settings now (#639), and the key that opens them opens it there too.
	else showShortcutsSettings();
}

/**
 * Shown over the composer when it holds a `/name` omp would hand to the model as ordinary text. The message stays in
 * the composer: fix it, go where the web UI has that command, or send it to the model anyway.
 */
export function SlashNotice({
	name,
	onSendAnyway,
	onDismiss,
}: {
	name: string;
	onSendAnyway: () => void;
	onDismiss: () => void;
}) {
	const t = useT();
	const equivalent = webEquivalent(name);
	return (
		<div
			role="status"
			className="mb-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
			data-testid="slash-unknown"
		>
			<div className="flex items-center gap-2 font-medium">
				<TriangleAlert size={15} className="shrink-0 text-warning" aria-hidden />
				{t("chat.slashUnknownTitle", { name })}
			</div>
			<p className="mt-0.5 text-xs text-muted">{t(equivalent ? equivalent.hint : "chat.slashUnknownBody")}</p>
			<div className="mt-2 flex flex-wrap items-center gap-2">
				{equivalent?.action ? (
					<Button
						size="sm"
						variant="primary"
						data-testid="slash-equivalent"
						onClick={() => equivalent.action && goTo(equivalent.action.to)}
					>
						{t(equivalent.action.label)}
					</Button>
				) : null}
				<Button size="sm" variant="outline" data-testid="slash-send-anyway" onClick={onSendAnyway}>
					{t("chat.slashSendAnyway")}
				</Button>
				<Button size="sm" variant="ghost" data-testid="slash-dismiss" onClick={onDismiss}>
					{t("common.close")}
				</Button>
			</div>
		</div>
	);
}
