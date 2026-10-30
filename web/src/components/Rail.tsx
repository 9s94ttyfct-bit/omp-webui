import { MessageSquarePlus, PanelLeftOpen, Search } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useT } from "../i18n/index.ts";
import { RAIL_WIDTH } from "../lib/panel-widths.ts";
import { useShortcutLabel } from "../lib/shortcuts.ts";
import { useApp } from "../store/app.ts";
import { HostChip } from "./HostChip.tsx";
import { NavGroup } from "./NavDock.tsx";
import { IconButton } from "./ui.tsx";

/**
 * What stays of the sidebar when it is put away (where it is a column; a phone has its drawer): a narrow strip with the
 * toggle on the page header's line and one click to the pages the person put on it (#654: their own arrangement, apart
 * from the sidebar's). The page it is on carries the accent bar (`aria-current`), as in the sidebar.
 */
export function Rail() {
	const t = useT();
	const searchHint = useShortcutLabel("search");
	const { set, setView, remote } = useApp(
		useShallow((s) => ({ set: s.set, setView: s.setView, remote: s.meta?.remote === true })),
	);
	return (
		<nav
			aria-label={t("shell.railAria")}
			className="flex h-full shrink-0 flex-col items-center gap-1 border-r border-border bg-bg-soft pt-2.5 pb-2"
			style={{ width: RAIL_WIDTH }}
		>
			<IconButton
				label={t("shell.appShowSidebar")}
				onClick={() => set({ sidebarOpen: true })}
				data-testid="show-sidebar"
			>
				<PanelLeftOpen size={16} />
			</IconButton>
			<div className="mt-2 flex flex-col items-center gap-1">
				<IconButton label={t("shell.sidebarNewChat")} onClick={() => setView({ kind: "new" })} data-testid="new-chat">
					<MessageSquarePlus size={16} className="text-accent" />
				</IconButton>
				<IconButton
					label={searchHint ? t("shell.sidebarSearch", { keys: searchHint }) : t("shell.paletteTitle")}
					onClick={() => set({ paletteOpen: true })}
				>
					<Search size={16} />
				</IconButton>
				<NavGroup variant="icons" surface="rail" group="top" remote={remote} />
			</div>
			<div className="mt-auto flex flex-col items-center gap-1">
				<NavGroup variant="icons" surface="rail" group="hidden" remote={remote} />
				<HostChip variant="rail" />
				<NavGroup variant="icons" surface="rail" group="bottom" remote={remote} />
			</div>
		</nav>
	);
}
