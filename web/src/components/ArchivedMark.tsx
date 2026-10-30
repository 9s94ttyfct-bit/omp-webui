import { Archive } from "lucide-react";
import { useT } from "../i18n/index.ts";
import { setArchived } from "../lib/archive.ts";
import { Badge } from "./ui.tsx";

/**
 * In the chat header of an archived conversation: the sidebar's main list hides it, so say why it is not there
 * and offer the way back.
 */
export function ArchivedMark({ file }: { file: string }) {
	const t = useT();
	return (
		<span className="inline-flex shrink-0 items-center gap-1.5" data-testid="archived-mark">
			<Badge>
				<Archive size={11} aria-hidden /> {t("shell.sidebarArchived")}
			</Badge>
			<button
				type="button"
				data-testid="unarchive"
				className="rounded px-1 py-0.5 text-xs font-medium text-accent hover:underline"
				onClick={() => void setArchived([file], false)}
			>
				{t("shell.sessionUnarchive")}
			</button>
		</span>
	);
}
