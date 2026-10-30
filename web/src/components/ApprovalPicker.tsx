import * as Menu from "@radix-ui/react-dropdown-menu";
import { APPROVAL_MODES, type ApprovalMode } from "@shared/approval.ts";
import {
	Check,
	ChevronDown,
	type LucideIcon,
	Shield,
	ShieldAlert,
	ShieldCheck,
	ShieldPlus,
	ShieldQuestion,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import { agentFullOpen } from "../lib/agent-full.ts";
import type { SavedApproval } from "../lib/api.ts";
import { matches, useShortcutLabel, withKeys } from "../lib/shortcuts.ts";
import type { StartLive } from "../lib/start-live.ts";
import { setApprovalMode, useApp } from "../store/app.ts";
import { cx, Kbd } from "./ui.tsx";

/** How each mode is named and described; the settings page lists the same words. */
export const APPROVAL_META: Record<ApprovalMode, { label: MessageKey; hint: MessageKey; Icon: LucideIcon }> = {
	"always-ask": { label: "panel.approvalAlways", hint: "panel.approvalAlwaysHint", Icon: ShieldQuestion },
	"always-ask-cached": { label: "panel.approvalCached", hint: "panel.approvalCachedHint", Icon: ShieldPlus },
	write: { label: "panel.approvalWrite", hint: "panel.approvalWriteHint", Icon: ShieldCheck },
	yolo: { label: "panel.approvalYolo", hint: "panel.approvalYoloHint", Icon: ShieldAlert },
};

/**
 * What omp asks the user about before it runs a tool, for this conversation: one switch in the composer's
 * footer. A change reaches omp's next tool call, also in the middle of a turn. `onChange` tells a page that
 * keeps the choice for conversations it has yet to start (New chat). Without a running omp (`liveId` null: a
 * saved conversation) `saved` is the mode the conversation comes back in, and choosing one starts omp (`start`)
 * and sets it. A mode of omp's own that the page cannot set (a newer omp's) is shown as omp names it, and picking
 * one of ours replaces it.
 */
export function ApprovalPicker({
	liveId,
	saved,
	start,
	onChange,
}: {
	liveId: string | null;
	saved?: SavedApproval | null;
	start?: StartLive;
	onChange?: (mode: ApprovalMode) => void;
}) {
	const t = useT();
	const shortcutHint = useShortcutLabel("approval");
	const toast = useApp((s) => s.toast);
	const info = useApp((s) => (liveId ? s.lives[liveId]?.info : undefined));
	const current = info?.approvalMode ?? saved?.mode ?? undefined;
	const ompOwn = info?.approvalOmp ?? saved?.omp ?? undefined;
	const working = useApp((s) => {
		const live = liveId ? s.lives[liveId] : undefined;
		return Boolean(live && (live.streaming || live.uiRequests.length));
	});
	/** The mode asked for and not confirmed yet: the button shows it at once. */
	const [asked, setAsked] = useState<ApprovalMode | null>(null);
	const [open, setOpen] = useState(false);
	const isOpen = useRef(open);
	isOpen.current = open;
	/** Where focus was when the shortcut opened the menu, to put it back (the composer, mostly). */
	const returnTo = useRef<HTMLElement | null>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const shown = asked ?? current;

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!matches("approval", e) || agentFullOpen()) return;
			e.preventDefault();
			const active = document.activeElement;
			// Only when it opens: the key that closes it again is pressed inside the menu.
			if (!isOpen.current && active instanceof HTMLElement && active !== document.body && active !== trigger.current)
				returnTo.current = active;
			setOpen((o) => !o);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	if (!shown && !ompOwn) return null;
	const shownMeta = shown ? APPROVAL_META[shown] : null;
	const Icon = shownMeta?.Icon ?? Shield;
	const name = shownMeta ? t(shownMeta.label) : t("panel.approvalOmp", { mode: ompOwn ?? "" });
	const risky = shown === "yolo";

	const choose = async (next: ApprovalMode) => {
		if (next === shown) return;
		setAsked(next);
		try {
			const id = liveId ?? (await start?.());
			if (!id) return;
			await setApprovalMode(id, next);
			onChange?.(next);
			if (working) toast("info", t("panel.approvalApplies", { mode: t(APPROVAL_META[next].label) }));
		} catch (e) {
			toast("error", t("panel.approvalFailed", { error: (e as Error).message }));
		} finally {
			setAsked(null);
		}
	};

	return (
		<Menu.Root open={open} onOpenChange={setOpen}>
			<Menu.Trigger asChild>
				<button
					ref={trigger}
					type="button"
					data-testid="approval-picker"
					data-mode={shown ?? ompOwn}
					aria-label={`${t("panel.approvalTrigger")}: ${name}`}
					title={withKeys(t("panel.approvalTrigger"), shortcutHint)}
					className={cx(
						"inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs composer-narrow:w-8 composer-narrow:justify-center composer-narrow:px-0",
						// A hover rings the warning tint rather than deepening it: a deeper tint under the same text falls under 4.5:1.
						risky
							? "bg-warning/15 text-warning hover:ring-1 hover:ring-warning/40"
							: "text-muted hover:bg-hover hover:text-fg",
					)}
				>
					<Icon size={14} className="shrink-0" />
					<span className="composer-narrow:sr-only">{name}</span>
					<ChevronDown size={12} className="shrink-0 composer-narrow:hidden" />
				</button>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Content
					align="start"
					sideOffset={6}
					collisionPadding={8}
					data-testid="approval-menu"
					className="z-50 w-72 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-surface p-1 shadow-2xl"
					onCloseAutoFocus={(e) => {
						// Back to what the user was typing in, not to the button.
						const el = returnTo.current;
						returnTo.current = null;
						if (el?.isConnected) {
							e.preventDefault();
							el.focus();
						}
					}}
				>
					<Menu.Label className="px-2 pt-1.5 pb-1 text-xs font-medium text-faint">{t("panel.approvalMenu")}</Menu.Label>
					<Menu.RadioGroup value={shown} onValueChange={(v) => void choose(v as ApprovalMode)}>
						{APPROVAL_MODES.map((mode) => {
							const meta = APPROVAL_META[mode];
							return (
								<Menu.RadioItem
									key={mode}
									value={mode}
									data-testid={`approval-${mode}`}
									className={cx(
										"flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-hover",
										mode === "yolo" && "text-warning",
									)}
								>
									<meta.Icon size={15} className="mt-0.5 shrink-0" />
									<span className="min-w-0 flex-1">
										<span className="block font-medium">{t(meta.label)}</span>
										<span className={cx("block text-xs", mode === "yolo" ? "text-warning" : "text-muted")}>
											{t(meta.hint)}
										</span>
									</span>
									<Menu.ItemIndicator className="mt-0.5">
										<Check size={14} />
									</Menu.ItemIndicator>
								</Menu.RadioItem>
							);
						})}
					</Menu.RadioGroup>
					{shortcutHint ? (
						<div className="mt-1 flex items-center justify-end border-t border-border px-2 pt-1.5 pb-1">
							<Kbd>{shortcutHint}</Kbd>
						</div>
					) : null}
				</Menu.Content>
			</Menu.Portal>
		</Menu.Root>
	);
}
