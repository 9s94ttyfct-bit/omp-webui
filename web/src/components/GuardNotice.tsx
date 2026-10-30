import { ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import { useT } from "../i18n/index.ts";
import { guardApi } from "../lib/guard-api.ts";
import { useGuardStrings } from "../lib/guard-strings.ts";
import { showSettingsCard } from "../lib/shortcut-view.ts";
import { useApp } from "../store/app.ts";
import { conversationOf, useGuard } from "../store/guard.ts";
import { Button } from "./ui.tsx";

/**
 * The strip over a conversation that says "Guard dangerous commands" could not reach a reviewer model, so its risky calls are
 * being refused without being judged. `homes` are the conversations the view shows (its file and its branches' files, see
 * `conversationOf`): a notice about another conversation is not drawn. It goes when the next decision in the conversation
 * comes (whatever it says), when the mode changes, or when it is dismissed. The reason is the guard's own text, shown as text.
 */
export default function GuardNotice({ homes }: { homes: readonly string[] }) {
	const t = useT();
	const ready = useGuardStrings();
	const home = useGuard((s) => homes.find((h) => h in s.unavailable));
	const decision = useGuard((s) => (home === undefined ? undefined : s.unavailable[home]));
	const toast = useApp((s) => s.toast);
	const live = useApp((s) =>
		home === undefined
			? undefined
			: Object.values(s.lives).find(
					(l) => !l.info.exited && l.info.sessionFile !== null && conversationOf(l.info.sessionFile) === home,
				),
	);
	const [busy, setBusy] = useState(false);
	if (!decision || home === undefined || !ready) return null;
	const dismiss = () =>
		useGuard.setState((s) => {
			const { [home]: _gone, ...others } = s.unavailable;
			return { unavailable: others };
		});
	const askMe = async () => {
		setBusy(true);
		try {
			// A conversation with choices of its own (any field) is not changed by the settings: the choice is made for it alone.
			if (live?.info.guard?.own !== undefined) await guardApi.conversation(live.info.liveId, { mode: "ask" });
			else await guardApi.change({ mode: "ask" });
			dismiss();
		} catch (e) {
			toast("error", t("guard.saveFailed", { error: e instanceof Error ? e.message : String(e) }));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div
			className="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-warning/15 px-4 py-2 text-sm"
			role="alert"
			data-testid="guard-unavailable-notice"
		>
			<ShieldAlert size={16} className="shrink-0 text-warning" aria-hidden />
			<p className="min-w-0 flex-1 basis-64">
				<span className="font-medium">{t("guard.noticeTitle")}. </span>
				<span className="break-words text-muted">{t("guard.noticeBody", { reason: decision.reason })}</span>
			</p>
			<div className="flex shrink-0 flex-wrap items-center gap-2">
				<Button size="sm" data-testid="guard-ask-instead" disabled={busy} onClick={() => void askMe()}>
					{t("guard.noticeAsk")}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					data-testid="guard-notice-settings"
					onClick={() => showSettingsCard('[data-testid="guard-settings"]')}
				>
					{t("guard.noticeSettings")}
				</Button>
				<button
					type="button"
					className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-hover"
					aria-label={t("guard.noticeDismiss")}
					data-testid="guard-notice-dismiss"
					onClick={dismiss}
				>
					<X size={14} aria-hidden />
				</button>
			</div>
		</div>
	);
}
