import { ANIMATION_INTENSITIES } from "@shared/prefs.ts";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import {
	type AnimationIntensity,
	intensityOf,
	setAnimationIntensity,
	setAnimations,
	useAnimationSettings,
} from "../lib/live-motion.ts";
import { Select } from "./Select.tsx";

const LABELS: Record<AnimationIntensity, MessageKey> = {
	subtle: "pages.settingsAnimationSubtle",
	normal: "pages.settingsAnimationNormal",
	lively: "pages.settingsAnimationLively",
};

/**
 * Settings › Look & layout › Appearance: live animations (v0.15.0), off unless turned on here, and how lively they are.
 * Both follow the person (`ompw.animations`, `ompw.animationIntensity`). The system's reduced motion overrides them, and
 * the card says so.
 */
export function AnimationSettings() {
	const t = useT();
	const { on, intensity, reduced } = useAnimationSettings();
	return (
		<div className="mt-3 text-sm" data-testid="animation-settings">
			<label className="flex cursor-pointer items-start gap-3">
				<input
					type="checkbox"
					className="mt-1 accent-[var(--accent)]"
					data-testid="animations"
					checked={on}
					onChange={(e) => setAnimations(e.target.checked)}
				/>
				<span>
					{t("pages.settingsAnimations")}
					<span className="block text-xs text-muted">{t("pages.settingsAnimationsHint")}</span>
					{reduced ? (
						<span className="mt-1 block text-xs text-warning" data-testid="animations-reduced">
							{t("pages.settingsAnimationsReduced")}
						</span>
					) : null}
				</span>
			</label>
			<label className="mt-2 ml-7 block">
				{t("pages.settingsAnimationIntensity")}
				<Select
					className="mt-1.5"
					data-testid="animation-intensity"
					value={intensity}
					disabled={!on}
					onValueChange={(v) => setAnimationIntensity(intensityOf(v))}
				>
					{ANIMATION_INTENSITIES.map((m) => (
						<option key={m} value={m}>
							{t(LABELS[m])}
						</option>
					))}
				</Select>
			</label>
		</div>
	);
}
