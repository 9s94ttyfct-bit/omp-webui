import { runsLocal } from "@shared/offline.ts";
import type { LiveInfo } from "@shared/protocol.ts";
import { Feather } from "lucide-react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { Badge } from "./ui.tsx";

/**
 * Marks a conversation whose omp process was started in Light mode (the mode it runs in, whatever new chats start in):
 * "Light", or "Light · local" when its models are a local server's. Nothing for Full.
 */
export function ModeBadge({ info }: { info: Pick<LiveInfo, "mode" | "lightModels"> | undefined }) {
	const t = useT();
	if (info?.mode !== "light") return null;
	const local = runsLocal(info);
	return (
		<span
			title={t(local ? "mode.badgeTitleLocal" : "mode.badgeTitle")}
			data-testid="mode-badge"
			data-models={local ? "local" : "yours"}
			className="shrink-0"
		>
			<Badge tone="accent">
				<Feather size={11} aria-hidden /> {t(local ? "mode.badgeLocal" : "mode.badge")}
			</Badge>
		</span>
	);
}
