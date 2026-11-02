import { Glasses } from "lucide-react";
import { type MutableRefObject, useEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import { sessionActions } from "../lib/api.ts";
import { useApp } from "../store/app.ts";
import { cx } from "./ui.tsx";

/**
 * New chat's switch for omp's advisor (see `shared/advisor.ts`), in the rules of its settings bar: whether a second model
 * reviews the turns of the conversation about to start. It starts at omp's own setting (`advisor.enabled`, which the
 * session panel's star changes) until the person flips it; a flip acts on the warm-up process at once (its overlay) and is
 * kept in `pick` for the processes started after the folder or options change.
 */
export function AdvisorToggle({
	liveId,
	pick,
}: {
	liveId: string;
	/** What New chat has picked (null: nothing, omp's setting decides), written when the switch is flipped. */
	pick: MutableRefObject<boolean | null>;
}) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const own = useApp((s) => s.lives[liveId]?.info.advisor);
	const [omp, setOmp] = useState<boolean | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let live = true;
		sessionActions.advisor().then(
			(r) => live && setOmp(r.omp),
			() => {},
		);
		return () => {
			live = false;
		};
	}, []);
	const on = own ?? pick.current ?? omp ?? false;
	const toggle = async () => {
		if (busy) return;
		const next = !on;
		setBusy(true);
		try {
			await sessionActions.setAdvisor(liveId, next);
			pick.current = next;
		} catch (e) {
			toast("error", t("panel.controlsAdvisorFailed", { error: (e as Error).message }));
		} finally {
			setBusy(false);
		}
	};
	return (
		<button
			type="button"
			role="switch"
			aria-checked={on}
			aria-busy={busy || undefined}
			aria-label={t("panel.controlsAdvisor")}
			title={t(on ? "panel.advisorToggleOn" : "panel.advisorToggleOff")}
			data-testid="advisor-toggle"
			data-state={on ? "on" : "off"}
			disabled={busy}
			className={cx(
				"inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
				// On is a shape as well as a tint (a ring), as the unattended switch beside it.
				on ? "bg-accent-soft text-accent ring-1 ring-accent/60" : "text-muted hover:bg-hover hover:text-fg",
			)}
			onClick={() => void toggle()}
		>
			<Glasses size={14} aria-hidden />
		</button>
	);
}
