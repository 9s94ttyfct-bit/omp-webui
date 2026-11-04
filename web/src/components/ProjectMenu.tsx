import * as Menu from "@radix-ui/react-dropdown-menu";
import type { ChatProject } from "@shared/chat-projects.ts";
import { ChevronDown, ChevronUp, FolderInput, FolderMinus, Pencil, SquarePen, Trash2 } from "lucide-react";
import { useT } from "../i18n/index.ts";
import { chatProjectsApi } from "../lib/chat-projects.ts";
import { useChatProjectsStrings } from "../lib/chat-projects-strings.ts";
import { errorText } from "../lib/error-text.ts";
import { askProject, newChatIn } from "../lib/project-actions.ts";
import { useApp } from "../store/app.ts";
import { cx } from "./ui.tsx";

const ITEM =
	"flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-hover max-md:min-h-11";

/**
 * A sidebar project's menu: New chat in it, Rename, its folder (set, change, remove), its place in the list, and Delete
 * (which keeps its conversations: they go back to the list by date). A chunk of its own, loaded when the menu opens.
 */
export function ProjectMenu({ project: p, first, last }: { project: ChatProject; first: boolean; last: boolean }) {
	const ready = useChatProjectsStrings();
	const t = useT();
	if (!ready) return null;
	const save = (work: Promise<unknown>) =>
		void work.catch((e) => useApp.getState().toast("error", t("chatProjects.saveFailed", { error: errorText(e) })));
	return (
		<Menu.Content
			align="start"
			sideOffset={4}
			className="z-50 min-w-48 rounded-xl border border-border bg-surface p-1 shadow-2xl"
			data-testid="project-menu-content"
		>
			<Menu.Item className={ITEM} data-testid="project-menu-new-chat" onSelect={() => newChatIn(p)}>
				<SquarePen size={14} /> {t("chatProjects.newChat")}
			</Menu.Item>
			<Menu.Item
				className={ITEM}
				data-testid="project-menu-rename"
				onSelect={() => askProject({ kind: "rename", project: p })}
			>
				<Pencil size={14} /> {t("chatProjects.rename")}
			</Menu.Item>
			<Menu.Item
				className={ITEM}
				data-testid="project-menu-folder"
				onSelect={() => askProject({ kind: "folder", project: p })}
			>
				<FolderInput size={14} /> {p.folder ? t("chatProjects.changeFolder") : t("chatProjects.setFolder")}
			</Menu.Item>
			{p.folder ? (
				<Menu.Item
					className={ITEM}
					data-testid="project-menu-remove-folder"
					onSelect={() => save(chatProjectsApi.setFolder(p.id, null))}
				>
					<FolderMinus size={14} /> {t("chatProjects.removeFolder")}
				</Menu.Item>
			) : null}
			<Menu.Separator className="my-1 h-px bg-border" />
			<Menu.Item
				className={ITEM}
				disabled={first}
				data-testid="project-menu-up"
				onSelect={() => save(chatProjectsApi.reorder(p.id, -1))}
			>
				<ChevronUp size={14} /> {t("chatProjects.moveUp")}
			</Menu.Item>
			<Menu.Item
				className={ITEM}
				disabled={last}
				data-testid="project-menu-down"
				onSelect={() => save(chatProjectsApi.reorder(p.id, 1))}
			>
				<ChevronDown size={14} /> {t("chatProjects.moveDown")}
			</Menu.Item>
			<Menu.Separator className="my-1 h-px bg-border" />
			<Menu.Item
				className={cx(ITEM, "text-danger")}
				data-testid="project-menu-delete"
				onSelect={() => askProject({ kind: "delete", project: p })}
			>
				<Trash2 size={14} /> {t("chatProjects.deleteProject")}
			</Menu.Item>
		</Menu.Content>
	);
}
