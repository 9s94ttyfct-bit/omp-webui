import * as Popover from "@radix-ui/react-popover";
import type { LiveInfo } from "@shared/protocol.ts";
import { Package, RotateCw } from "lucide-react";
import { useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { errorText } from "../lib/error-text.ts";
import { forceRestart } from "../lib/force-restart.ts";
import { useApp } from "../store/app.ts";
import { Badge, Button } from "./ui.tsx";

/**
 * Marks a conversation whose process runs in an isolated project folder (`LiveInfo.isolated`, `shared/isolated-env.ts`):
 * what it has, never what the folder says. A process whose folder was switched since it started says a restart applies it,
 * and a click on that offers the restart: the person chooses when (it cuts off what runs). A paused one is resumed first.
 */
export function IsolatedBadge({ info }: { info: LiveInfo | undefined }) {
	const t = useT();
	if (!info || info.exited) return null;
	if (info.isolationStale) return <StaleBadge info={info} />;
	if (!info.isolated) return null;
	return (
		<span
			title={t("chat.isolatedBadgeTitle", { folder: info.isolated })}
			data-testid="isolated-badge"
			className="shrink-0"
		>
			<Badge tone="accent">
				<Package size={11} aria-hidden /> {t("chat.isolatedBadge")}
			</Badge>
		</span>
	);
}

function StaleBadge({ info }: { info: LiveInfo }) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const paused = Boolean(info.pausedAt);
	const restart = async () => {
		setBusy(true);
		try {
			await forceRestart(info.liveId);
			setOpen(false);
		} catch (e) {
			toast("error", t("panel.controlsRestartFailed", { error: errorText(e) }));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<button type="button" title={t("chat.isolatedStaleTitle")} data-testid="isolated-stale" className="shrink-0">
					<Badge tone="warning">
						<RotateCw size={11} aria-hidden /> {t("chat.isolatedStale")}
					</Badge>
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="start"
					sideOffset={6}
					collisionPadding={8}
					className="z-50 w-72 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-surface p-3 text-xs shadow-2xl"
					data-testid="isolated-stale-panel"
				>
					<p className="text-fg">{t("chat.isolatedStaleTitle")}</p>
					{paused ? (
						<p className="mt-2 text-muted">{t("panel.controlsRestartPaused")}</p>
					) : (
						<div className="mt-2 flex items-center gap-2">
							<span className="text-muted">{t("panel.controlsRestartConfirm")}</span>
							<Button
								size="sm"
								variant="danger"
								type="button"
								disabled={busy || !info.sessionFile}
								data-testid="isolated-stale-restart"
								onClick={() => void restart()}
							>
								{busy ? t("panel.controlsRestarting") : t("panel.controlsRestartYes")}
							</Button>
						</div>
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
