import type { LiveInfo } from "@shared/protocol.ts";
import { Package, RotateCw } from "lucide-react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { Badge } from "./ui.tsx";

/**
 * Marks a conversation whose process runs in an isolated project folder (`LiveInfo.isolated`, `shared/isolated-env.ts`):
 * what it has, never what the folder says. A process whose folder was switched since it started says a restart applies it.
 */
export function IsolatedBadge({ info }: { info: LiveInfo | undefined }) {
	const t = useT();
	if (!info || info.exited) return null;
	if (info.isolationStale)
		return (
			<span title={t("chat.isolatedStaleTitle")} data-testid="isolated-stale" className="shrink-0">
				<Badge tone="warning">
					<RotateCw size={11} aria-hidden /> {t("chat.isolatedStale")}
				</Badge>
			</span>
		);
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
