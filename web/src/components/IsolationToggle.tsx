import type { IsolationRefusal as IsolationRefused } from "@shared/isolated-env.ts";
import { Package } from "lucide-react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { cx } from "./ui.tsx";

const REFUSED = {
	protected: "chat.isolationRefusedProtected",
	projectsFolder: "chat.isolationRefusedProjectsFolder",
	containsOther: "chat.isolationRefusedContainsOther",
	linked: "chat.isolationRefusedLinked",
} as const;

/**
 * New chat's switch for the folder's isolated environment (`shared/isolated-env.ts`), in the rules of its settings bar.
 * It is the folder's, not the conversation's: for an existing folder it shows what the folder is and a flip changes the
 * folder (New chat starts its warm-up process again), for a new project it is the new folder's, off until flipped.
 */
export default function IsolationToggle({
	on,
	folder,
	refused,
	notOwner,
	onToggle,
}: {
	on: boolean;
	/** The existing folder it is about; null for a new project's folder. */
	folder: string | null;
	refused: IsolationRefused | null;
	notOwner: boolean;
	onToggle: (on: boolean) => void;
}) {
	const t = useT();
	const blocked = notOwner ? t("chat.isolationNotOwner") : refused && !on ? t(REFUSED[refused]) : null;
	const title = [
		blocked ?? t(on ? "chat.isolationToggleOn" : "chat.isolationToggleOff"),
		folder ? t("chat.isolationToggleFolder", { folder }) : null,
	]
		.filter(Boolean)
		.join("\n");
	return (
		<button
			type="button"
			role="switch"
			aria-checked={on}
			aria-label={t("chat.isolationToggle")}
			aria-disabled={blocked !== null || undefined}
			title={title}
			data-testid="isolation-toggle"
			data-state={on ? "on" : "off"}
			className={cx(
				"inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
				// On is a shape as well as a tint (a ring), as the advisor's and unattended mode's switches beside it.
				on ? "bg-accent-soft text-accent ring-1 ring-accent/60" : "text-muted hover:bg-hover hover:text-fg",
				blocked !== null && "cursor-not-allowed opacity-50",
			)}
			onClick={() => {
				if (blocked === null) onToggle(!on);
			}}
		>
			<Package size={14} aria-hidden />
		</button>
	);
}
