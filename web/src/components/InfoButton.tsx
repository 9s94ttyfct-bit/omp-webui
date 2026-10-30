import { Info } from "lucide-react";
import { useT } from "../i18n/index.ts";
import { IconButton } from "./ui.tsx";

/**
 * The button that opens a setting's explanation under its row in the session panel (#716). A disclosure: it says whether
 * the text is open (`aria-expanded`) and which element holds it (`aria-controls`, while it is there).
 */
export function InfoButton({
	label,
	testid,
	open,
	controls: controlled,
	onToggle,
}: {
	label: string;
	testid: string;
	open: boolean;
	controls: string;
	onToggle: () => void;
}) {
	const t = useT();
	return (
		<IconButton
			size="xs"
			label={t("panel.controlsInfo", { label })}
			data-testid={`${testid}-info`}
			aria-expanded={open}
			aria-controls={open ? controlled : undefined}
			active={open}
			onClick={onToggle}
		>
			<Info size={13} />
		</IconButton>
	);
}

/** The box an `InfoButton` opens, as the panel's rows show their explanations. */
export const INFO_BOX = "w-full space-y-1.5 rounded-lg bg-bg-soft px-2.5 py-2 text-xs text-muted";
