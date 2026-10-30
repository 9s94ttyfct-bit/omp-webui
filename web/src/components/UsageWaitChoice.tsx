import { useT } from "../i18n/index.ts";
import { useApp } from "../store/app.ts";
import { setConversationUsageWait, useUsageWait } from "../store/usage-wait.ts";
import { cx, WithCode } from "./ui.tsx";

/**
 * What this conversation does when its provider's usage limit is reached: follow omp's own setting
 * (`retry.waitForUsageReset`), sleep until the reset and retry by itself, or fail the turn. Shown beside the quota it
 * concerns; its process is told through its own settings overlay, like the permission mode. Nothing until the server
 * has said what the settings are.
 */
export function UsageWaitChoice({ file }: { file: string }) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const { loaded, omp, session } = useUsageWait(file);
	if (!loaded) return null;
	const current = session === null ? "default" : session ? "on" : "off";
	const choices: { value: string; label: string; enabled: boolean | null }[] = [
		{
			value: "default",
			label:
				omp === null
					? t("chat.usageWaitChoiceDefaultUnknown")
					: t("chat.usageWaitChoiceDefault", {
							state: t(omp ? "chat.usageWaitStateOn" : "chat.usageWaitStateOff"),
						}),
			enabled: null,
		},
		{ value: "on", label: t("chat.usageWaitChoiceOn"), enabled: true },
		{ value: "off", label: t("chat.usageWaitChoiceOff"), enabled: false },
	];
	return (
		<fieldset className="space-y-0.5 border-t border-border pt-2" data-testid="usage-wait-choice">
			<legend className="float-left mb-1 w-full font-medium">{t("chat.usageWaitChoiceTitle")}</legend>
			{choices.map((c) => (
				<label
					key={c.value}
					className={cx(
						"flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
						current === c.value ? "bg-accent-soft text-accent" : "text-muted hover:text-fg",
					)}
				>
					<input
						type="radio"
						className="accent-[var(--accent)]"
						name={`usage-wait-${file}`}
						value={c.value}
						data-testid={`usage-wait-choice-${c.value}`}
						checked={current === c.value}
						onChange={() =>
							void setConversationUsageWait(file, c.enabled).catch((e) =>
								toast("error", t("chat.usageWaitFailed", { error: (e as Error).message })),
							)
						}
					/>
					{c.label}
				</label>
			))}
			<p className="pt-1 text-xs leading-snug text-muted" data-testid="usage-wait-choice-hint">
				<WithCode text={t("chat.usageWaitChoiceHint")} />
			</p>
		</fieldset>
	);
}
