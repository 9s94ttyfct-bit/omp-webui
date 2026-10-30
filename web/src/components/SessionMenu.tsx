import * as Menu from "@radix-ui/react-dropdown-menu";
import type { SessionSummary } from "@shared/protocol.ts";
import { Archive, ArchiveRestore, Download, Pencil, Pin, PinOff, SquareTerminal, Trash2 } from "lucide-react";
import type { RefObject } from "react";
import { useT } from "../i18n/index.ts";
import { downloadExport } from "../lib/api.ts";
import { useApp } from "../store/app.ts";
import { cx } from "./ui.tsx";

const itemCls =
	"flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-hover";

/**
 * A conversation's actions, in the menu of its sidebar row. The menu's own contents are a chunk of their own: a
 * page of conversations shows its rows and their buttons, and only the menu that opens shows the actions.
 */
export function SessionMenu({
	session: s,
	pinned,
	archived,
	trigger,
	onAction,
	onTogglePin,
	onToggleArchive,
}: {
	session: SessionSummary;
	pinned: boolean;
	archived: boolean;
	/**
	 * The row's menu button: the dialog an action opens returns focus there when it closes. It is the button's ref,
	 * not the button: the row is not re-rendered when the menu opens, so a button read at render time would be gone.
	 */
	trigger: RefObject<HTMLButtonElement | null>;
	onAction: (session: SessionSummary, action: "rename" | "delete", trigger: HTMLElement | null) => void;
	onTogglePin: (file: string) => void;
	onToggleArchive: (file: string) => void;
}) {
	const t = useT();
	return (
		<Menu.Content
			align="start"
			sideOffset={4}
			className="z-50 min-w-48 rounded-xl border border-border bg-surface p-1 shadow-2xl"
		>
			<Menu.Item className={itemCls} onSelect={() => onAction(s, "rename", trigger.current)}>
				<Pencil size={14} /> {t("common.rename")}
			</Menu.Item>
			<Menu.Item className={itemCls} onSelect={() => onTogglePin(s.file)}>
				{pinned ? <PinOff size={14} /> : <Pin size={14} />} {pinned ? t("shell.sessionUnpin") : t("shell.sessionPin")}
			</Menu.Item>
			<Menu.Item className={itemCls} onSelect={() => onToggleArchive(s.file)}>
				{archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}{" "}
				{archived ? t("shell.sessionUnarchive") : t("shell.sessionArchive")}
			</Menu.Item>
			<Menu.Item
				className={itemCls}
				onSelect={() => void downloadExport(s.file).catch((e) => useApp.getState().toast("error", e.message))}
			>
				<Download size={14} /> {t("shell.sessionExportHtml")}
			</Menu.Item>
			<Menu.Item
				className={itemCls}
				onSelect={() => useApp.getState().setView({ kind: "cli", run: ["--resume", s.file] })}
			>
				<SquareTerminal size={14} /> {t("shell.sessionOpenTerminal")}
			</Menu.Item>
			<Menu.Separator className="my-1 h-px bg-border" />
			<Menu.Item className={cx(itemCls, "text-danger")} onSelect={() => onAction(s, "delete", trigger.current)}>
				<Trash2 size={14} /> {t("shell.sessionDelete")}
			</Menu.Item>
		</Menu.Content>
	);
}
