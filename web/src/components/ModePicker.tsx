import * as Menu from "@radix-ui/react-dropdown-menu";
import { BACKEND_NAMES, MODES, type Mode } from "@shared/offline.ts";
import { Boxes, Check, ChevronDown, Feather, type LucideIcon } from "lucide-react";
import { type MessageKey, useT } from "../i18n/index.ts";
import { selectMode, setMode, useMode } from "../lib/offline.ts";
import { cx } from "./ui.tsx";

const META: Record<Mode, { label: MessageKey; Icon: LucideIcon }> = {
	full: { label: "mode.full", Icon: Boxes },
	light: { label: "mode.light", Icon: Feather },
};

/**
 * Full or Light for the conversation New chat starts: a chip in the composer's footer. It sets the mode of the process
 * warming up (`NewChat` starts another in the mode chosen) and is the mode the next new chat starts in, as the server
 * keeps it (Settings › Full / Light says the same). The width is the chip's own, whichever it says, so choosing does not
 * move the controls beside it, and the placeholder of the footer's controls (`index.css`) can hold its place.
 */
export function ModePicker() {
	const t = useT();
	const mode = useMode(selectMode);
	const backend = useMode((s) => s.state?.offline.backend ?? null);
	const lightModels = useMode((s) => s.state?.lightModels ?? "yours");
	const { Icon, label } = META[mode];
	const name = t(label);
	const hint = (m: Mode) =>
		m === "full"
			? t("mode.fullHint")
			: lightModels === "local"
				? t("mode.lightHintLocal", { backend: backend ? BACKEND_NAMES[backend] : t("mode.lightHintUnknown") })
				: t("mode.lightHintYours");
	return (
		<Menu.Root>
			<Menu.Trigger asChild>
				<button
					type="button"
					data-testid="mode-picker"
					data-mode={mode}
					aria-label={t("mode.pickerLabel", { mode: name })}
					title={t("mode.pickerTitle")}
					className={cx(
						"inline-flex h-8 w-20 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs composer-narrow:w-8 composer-narrow:px-0 composer-more:w-auto",
						mode === "light"
							? "bg-accent-soft text-accent hover:bg-accent-soft"
							: "text-muted hover:bg-hover hover:text-fg",
					)}
				>
					<Icon size={14} className="shrink-0" />
					{/* In the "⋯" panel the chip says which setting it is, not only its value: "Mode: Full". Its name says the
					    same everywhere (WCAG 2.5.3: it starts with what the chip shows); what it is for is the title. */}
					<span className="hidden shrink-0 composer-more:inline">{t("mode.chipPrefix")}</span>
					<span className="min-w-0 truncate composer-narrow:sr-only">{name}</span>
					<ChevronDown size={12} className="shrink-0 composer-narrow:hidden" />
				</button>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Content
					align="start"
					sideOffset={6}
					collisionPadding={8}
					data-testid="mode-menu"
					className="z-50 w-72 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-surface p-1 shadow-2xl"
				>
					<Menu.Label className="px-2 pt-1.5 pb-1 text-xs font-medium text-faint">{t("mode.pickerMenu")}</Menu.Label>
					<Menu.RadioGroup value={mode} onValueChange={(v) => void setMode(v === "light" ? "light" : "full")}>
						{MODES.map((m) => {
							const meta = META[m];
							return (
								<Menu.RadioItem
									key={m}
									value={m}
									data-testid={`mode-picker-${m}`}
									className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-hover"
								>
									<meta.Icon size={15} className="mt-0.5 shrink-0" />
									<span className="min-w-0 flex-1">
										<span className="block font-medium">{t(meta.label)}</span>
										<span className="block text-xs text-muted">{hint(m)}</span>
									</span>
									<Menu.ItemIndicator className="mt-0.5">
										<Check size={14} />
									</Menu.ItemIndicator>
								</Menu.RadioItem>
							);
						})}
					</Menu.RadioGroup>
				</Menu.Content>
			</Menu.Portal>
		</Menu.Root>
	);
}
