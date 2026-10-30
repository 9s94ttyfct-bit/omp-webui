import { DEFAULT_GUARD_CONFIG } from "@shared/guard.ts";
import { PREF } from "@shared/prefs.ts";
import { EyeOff, ScanEye } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import { guardApi } from "../lib/guard-api.ts";
import { MODE_TEXT } from "../lib/guard-format.ts";
import { useGuardStrings } from "../lib/guard-strings.ts";
import {
	GUARD_OFF,
	guardIsOn,
	guardOnPatch,
	guardToggleBlock,
	onChoiceOf,
	rememberedChoice,
	withRemembered,
} from "../lib/guard-toggle.ts";
import { setPref } from "../lib/prefs.ts";
import { useApp } from "../store/app.ts";
import { useGuard } from "../store/guard.ts";
import { cx, Tip } from "./ui.tsx";

/** The room the switch takes, held while its chunk loads so the header does not move when it arrives. */
export const GUARD_TOGGLE_BAR = "h-8 w-8 shrink-0 rounded-lg";

/**
 * The guard's switch in a conversation's header, beside This session (v0.12.2): Off for this conversation alone, and back
 * on to what it was under before (`lib/guard-toggle.ts`). It is the conversation's own guard as This session shows it
 * (`LiveInfo.guard`, which every page is told), so a change made in either is shown by both, on every page. Red while the
 * guard is off. A page that may not change the guard (not this computer's) has the switch shown and not usable, and says
 * why. Drawn for a conversation whose omp runs (`ChatView`). A chunk of its own, with the guard's strings.
 */
export default function GuardToggle({ liveId }: { liveId: string }) {
	const t = useT();
	const ready = useGuardStrings();
	const toast = useApp((s) => s.toast);
	const guard = useApp((s) => s.lives[liveId]?.info.guard);
	const file = useApp((s) => s.lives[liveId]?.info.sessionFile ?? null);
	const local = useApp((s) => s.meta?.local === true);
	const settings = useGuard((s) => s.config?.mode ?? null);
	const [busy, setBusy] = useState(false);
	// A conversation's file names it across its processes; one that has none yet (a new chat) is its process.
	const key = file ?? liveId;
	const choice = guard ? onChoiceOf(guard) : null;

	// What it is under while on, kept for when the switch turns it back on: written whichever control put it there.
	useEffect(() => {
		if (!local || choice === null) return;
		const next = withRemembered(localStorage.getItem(PREF.guardBefore), key, choice);
		if (next !== null) setPref(PREF.guardBefore, next);
	}, [local, key, choice]);

	// Settings' mode, for the way back on of a conversation that followed them: asked once by a page that may read them.
	useEffect(() => {
		if (local && settings === null) void guardApi.config().catch(() => {});
	}, [local, settings]);

	if (!ready || !guard) return <span aria-hidden className={GUARD_TOGGLE_BAR} />;
	const on = guardIsOn(guard);
	const block = guardToggleBlock({ local });
	const modeName = t(MODE_TEXT[guard.config.mode].label);
	const back = guardOnPatch(rememberedChoice(localStorage.getItem(PREF.guardBefore), key), settings);
	const state = on ? t("guard.toggleStateOn", { mode: modeName }) : t("guard.toggleStateOff");
	const action =
		block === "remote"
			? t("guard.toggleRemote")
			: on
				? t("guard.toggleTurnOff")
				: back.mode
					? t("guard.toggleTurnOnPrevious", { mode: t(MODE_TEXT[back.mode].label) })
					: t("guard.toggleTurnOnSettings", { mode: t(MODE_TEXT[settings ?? DEFAULT_GUARD_CONFIG.mode].label) });
	const tip = t("guard.toggleTip", { state, action });

	const toggle = async () => {
		// The button stays focusable when it cannot be used, so the reason is read out and shown (a tap on a phone has no tooltip).
		if (block) {
			toast("info", tip);
			return;
		}
		if (busy) return;
		setBusy(true);
		try {
			if (on) {
				await guardApi.conversation(liveId, GUARD_OFF);
			} else {
				// Settings' mode as the server has it now, when the page has not been told it yet.
				const now = useGuard.getState().config?.mode ?? (await guardApi.config().catch(() => null))?.mode ?? null;
				await guardApi.conversation(
					liveId,
					guardOnPatch(rememberedChoice(localStorage.getItem(PREF.guardBefore), key), now),
				);
			}
		} catch (e) {
			toast("error", t("guard.toggleFailed", { error: e instanceof Error ? e.message : String(e) }));
		} finally {
			setBusy(false);
		}
	};

	const Icon = on ? ScanEye : EyeOff;
	return (
		<Tip label={tip} contentClassName="pointer-coarse:hidden">
			<button
				type="button"
				role="switch"
				aria-checked={on}
				aria-label={state}
				aria-disabled={block !== null || undefined}
				aria-busy={busy || undefined}
				data-testid="guard-toggle"
				data-state={on ? "on" : "off"}
				data-mode={guard.config.mode}
				data-block={block ?? undefined}
				className={cx(
					"inline-flex items-center justify-center transition-colors",
					GUARD_TOGGLE_BAR,
					// Off is a shape as well as a tint (the eye struck through, a ring): a tint alone is lost on someone who cannot tell red apart.
					on
						? "text-muted hover:bg-hover hover:text-fg"
						: "bg-danger/15 text-danger ring-1 ring-danger/40 hover:ring-danger/70",
					block !== null && "cursor-not-allowed opacity-60",
				)}
				onClick={() => void toggle()}
			>
				<Icon size={16} aria-hidden />
			</button>
		</Tip>
	);
}
