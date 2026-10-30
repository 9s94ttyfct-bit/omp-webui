import { ClipboardList } from "lucide-react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { Badge } from "./ui.tsx";

/** Marks a conversation whose omp is in the read-only plan mode `--plan-yolo` started it in (see `LiveState.planMode`). */
export function PlanBadge() {
	const t = useT();
	return (
		<span title={t("chat.planBadgeTitle")} data-testid="plan-badge" className="shrink-0">
			<Badge tone="accent">
				<ClipboardList size={11} aria-hidden /> {t("chat.planBadge")}
			</Badge>
		</span>
	);
}
