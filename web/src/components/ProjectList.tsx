import * as Menu from "@radix-ui/react-dropdown-menu";
import { GROUP_NAME_MAX, groupNameProblem, type ProjectGroup } from "@shared/project-groups.ts";
import {
	ChevronDown,
	ChevronRight,
	ChevronUp,
	CornerLeftUp,
	Folder,
	FolderInput,
	FolderPlus,
	Pencil,
	Trash2,
} from "lucide-react";
import { type FormEvent, useMemo, useRef, useState } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import { errorText } from "../lib/error-text.ts";
import { projectGroupsApi } from "../lib/project-groups.ts";
import { useProjectGroupsStrings } from "../lib/project-groups-strings.ts";
import { type ProjectLine, type ProjectRow, projectLines, withGroups } from "../lib/project-groups-view.ts";
import { useApp } from "../store/app.ts";
import { Button, cx, Modal, Spinner } from "./ui.tsx";

const ROW =
	"flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-progress";
const ITEM =
	"flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-hover max-md:min-h-11";
const ICON = "shrink-0 text-faint";

/** What a dialog here is doing: naming a new group, renaming one, or confirming a deletion. */
type Ask = { kind: "new" } | { kind: "rename"; group: ProjectGroup } | { kind: "delete"; group: ProjectGroup };

/**
 * The sidebar's list of projects (#636), in the popover the funnel opens: *All projects*, then each group as a disclosure
 * button with the projects in it, then the projects no group names. A project's menu puts it in a group; a group's menu renames
 * it, deletes it, or moves it up or down.
 *
 * A chunk of its own: its strings come with it (`useProjectGroupsStrings`), so the menus, dialogs and their text are not in
 * the first page's load.
 *
 * The rows are buttons, not options of a listbox: a group is a real disclosure button (`aria-expanded`, `aria-controls`), as
 * the web says a fold is, and a project row is what a click chooses. Everything is in the tab order, as the funnel's own
 * `<select>` was reached by Tab once: Tab walks the list, Enter chooses, and a row's menu opens on its own button.
 */
export function ProjectList({
	project,
	total,
	projects,
	groups,
	home,
	onChoose,
	onClose,
}: {
	/** The chosen project's folder (null: all projects). */
	project: string | null;
	total: number;
	/** Each project (its folder) with its number of conversations, as the sidebar's list has it. */
	projects: [string, number][];
	groups: ProjectGroup[];
	home: string | undefined;
	/** Choose a project (its folder), or null for all projects. The popover closes after it. */
	onChoose: (cwd: string | null) => void;
	onClose: () => void;
}) {
	const ready = useProjectGroupsStrings();
	const t = useT();
	const toast = useApp((s) => s.toast);
	const damaged = useApp((s) => s.projectGroupsProblem) === "damaged";
	// The lines: the groups with the projects in them, then the projects no group names.
	const lines = useMemo<ProjectLine[]>(() => projectLines(withGroups(projects, groups), groups), [projects, groups]);
	const [ask, setAsk] = useState<Ask | null>(null);
	const [busy, setBusy] = useState(false);
	if (!ready) return null;

	const nameOf = (cwd: string) => (home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd) || "/";
	/** The last part of the path: a row says the project's name, its tooltip the whole folder. */
	const shortOf = (cwd: string) => {
		const shown = nameOf(cwd);
		const parts = shown.split("/").filter(Boolean);
		return parts[parts.length - 1] ?? shown;
	};
	const countOf = (n: number) =>
		n === 1 ? t("projectGroups.projectCountOne") : t("projectGroups.projectCount", { n });

	/**
	 * One change. The server answers the whole list, and the page then reads it as every other page does (`loadSessions`
	 * carries the groups): what this popover shows is what the sidebar and the other tabs show.
	 */
	const run = async (work: () => Promise<unknown>, failure: MessageKey) => {
		setBusy(true);
		try {
			await work();
			await useApp.getState().loadSessions();
		} catch (e) {
			toast("error", t(failure, { error: errorText(e) }));
		} finally {
			setBusy(false);
		}
	};

	const move = (row: ProjectRow, group: string | null) => {
		if (row.group === group) return;
		void run(() => projectGroupsApi.move(row.cwd, group), "projectGroups.moveFailed");
	};

	const groupLines = lines.filter((l): l is Extract<ProjectLine, { kind: "group" }> => l.kind === "group");

	return (
		<div className="flex max-h-[min(70vh,32rem)] flex-col" data-testid="project-list">
			<p className="px-2.5 pt-1 pb-1 text-xs font-medium text-faint">{t("projectGroups.title")}</p>
			{damaged ? (
				<p className="mx-1 mb-1 rounded-md bg-warning/10 px-2.5 py-1.5 text-xs text-muted" data-testid="groups-damaged">
					{t("projectGroups.damaged")}
				</p>
			) : null}
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="project-scroll">
				<button
					type="button"
					className={cx(ROW, project === null && "bg-hover font-medium")}
					aria-current={project === null ? "true" : undefined}
					data-testid="project-all"
					onClick={() => onChoose(null)}
				>
					<span className="min-w-0 flex-1 truncate">{t("projectGroups.allProjects")}</span>
					<span className="shrink-0 text-xs tabular-nums text-faint">{total}</span>
				</button>
				{lines.length ? null : <p className="px-2.5 py-3 text-xs text-muted">{t("projectGroups.empty")}</p>}
				<ul className="mt-1 space-y-0.5">
					{lines.map((line) =>
						line.kind === "project" ? (
							<ProjectRowLine
								key={`p:${line.project.cwd}`}
								row={line.project}
								label={shortOf(line.project.cwd)}
								path={nameOf(line.project.cwd)}
								count={line.project.count}
								countLabel={countOf(line.project.count)}
								chosen={project === line.project.cwd}
								targets={groups}
								onChoose={() => onChoose(line.project.cwd)}
								onMove={move}
							/>
						) : (
							<GroupLine
								key={`g:${line.group.id}`}
								group={line.group}
								rows={line.projects.map((row) => ({ row, label: shortOf(row.cwd), path: nameOf(row.cwd) }))}
								countLabel={countOf}
								chosen={project}
								at={groupLines.indexOf(line)}
								groupCount={groupLines.length}
								targets={groups}
								busy={busy}
								onChoose={onChoose}
								onMove={move}
								onFold={() =>
									void run(
										() => projectGroupsApi.setCollapsed(line.group.id, !line.group.collapsed),
										"projectGroups.saveFailed",
									)
								}
								onReorder={(delta) =>
									void run(() => projectGroupsApi.reorder(line.group.id, delta), "projectGroups.saveFailed")
								}
								onAsk={setAsk}
							/>
						),
					)}
				</ul>
			</div>
			<div className="mt-1 flex items-center gap-1 border-t border-border px-1 pt-1">
				<button type="button" className={ROW} data-testid="new-project-group" onClick={() => setAsk({ kind: "new" })}>
					<FolderPlus size={14} className={ICON} aria-hidden /> {t("projectGroups.newGroup")}
				</button>
				<span className="flex-1" />
				<Button size="sm" variant="ghost" className="shrink-0" onClick={onClose}>
					{t("projectGroups.close")}
				</Button>
			</div>
			<GroupDialog
				key={
					ask === null
						? "none"
						: ask.kind === "delete"
							? `del:${ask.group.id}`
							: ask.kind === "rename"
								? `ren:${ask.group.id}`
								: "new"
				}
				ask={ask}
				groups={groups}
				busy={busy}
				onClose={() => setAsk(null)}
				onCreate={(name) =>
					void run(async () => {
						await projectGroupsApi.create(name);
						setAsk(null);
					}, "projectGroups.saveFailed")
				}
				onRename={(group, name) =>
					void run(async () => {
						await projectGroupsApi.rename(group.id, name);
						setAsk(null);
					}, "projectGroups.saveFailed")
				}
				onDelete={(group) =>
					void run(async () => {
						await projectGroupsApi.remove(group.id);
						setAsk(null);
					}, "projectGroups.deleteFailed")
				}
			/>
		</div>
	);
}

/** One project: choose it, and its menu to put it in a group or take it out of one. */
function ProjectRowLine({
	row,
	label,
	path,
	count,
	countLabel,
	chosen,
	targets,
	onChoose,
	onMove,
}: {
	row: ProjectRow;
	label: string;
	path: string;
	count: number;
	countLabel: string;
	chosen: boolean;
	targets: ProjectGroup[];
	onChoose: () => void;
	onMove: (row: ProjectRow, group: string | null) => void;
}) {
	const t = useT();
	return (
		<li className="flex items-center">
			<button
				type="button"
				className={cx(ROW, chosen && "bg-hover font-medium")}
				title={path}
				aria-current={chosen ? "true" : undefined}
				data-testid="project-row"
				data-cwd={row.cwd}
				onClick={onChoose}
			>
				<span className="min-w-0 flex-1 truncate">{label}</span>
				<span className="shrink-0 text-xs tabular-nums text-faint" title={countLabel}>
					{count}
				</span>
			</button>
			{/* It moves the project into a group: the icon says so (a folder with an arrow into it), and so does its tooltip. */}
			<Menu.Root>
				<Menu.Trigger asChild>
					<button
						type="button"
						aria-label={t("projectGroups.moveToGroupAria", { name: label })}
						title={t("projectGroups.moveToGroupAria", { name: label })}
						data-testid="project-menu"
						className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg"
					>
						<FolderInput size={13} aria-hidden />
					</button>
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Content
						align="start"
						sideOffset={4}
						className="z-50 min-w-48 rounded-xl border border-border bg-surface p-1 shadow-2xl"
					>
						<Menu.Label className="px-2 pt-1 pb-0.5 text-xs text-faint">
							{t("projectGroups.moveToGroupAria", { name: label })}
						</Menu.Label>
						{targets.map((g) => (
							<Menu.Item
								key={g.id}
								className={ITEM}
								disabled={row.group === g.id}
								data-testid="move-to-group"
								onSelect={() => onMove(row, g.id)}
							>
								<Folder size={14} className={ICON} /> <span className="truncate">{g.name}</span>
								{row.group === g.id ? (
									<span className="ml-auto text-xs text-faint">{t("projectGroups.inThisGroup")}</span>
								) : null}
							</Menu.Item>
						))}
						{row.group === null ? null : (
							<>
								<Menu.Separator className="my-1 h-px bg-border" />
								<Menu.Item className={ITEM} data-testid="move-out" onSelect={() => onMove(row, null)}>
									<CornerLeftUp size={14} /> {t("projectGroups.moveToTop")}
								</Menu.Item>
							</>
						)}
					</Menu.Content>
				</Menu.Portal>
			</Menu.Root>
		</li>
	);
}

/** A group: its disclosure button, its menu, and the projects in it while it is open. */
function GroupLine({
	group,
	rows,
	countLabel,
	chosen,
	at,
	groupCount,
	targets,
	busy,
	onChoose,
	onMove,
	onFold,
	onReorder,
	onAsk,
}: {
	group: ProjectGroup;
	rows: { row: ProjectRow; label: string; path: string }[];
	countLabel: (n: number) => string;
	chosen: string | null;
	at: number;
	groupCount: number;
	targets: ProjectGroup[];
	busy: boolean;
	onChoose: (cwd: string | null) => void;
	onMove: (row: ProjectRow, group: string | null) => void;
	onFold: () => void;
	onReorder: (delta: -1 | 1) => void;
	onAsk: (ask: Ask) => void;
}) {
	const t = useT();
	const id = `project-group-${group.id}`;
	const count = group.projects.length;
	const label =
		count === 1
			? t("projectGroups.groupAriaOne", { name: group.name })
			: t("projectGroups.groupAria", { name: group.name, n: count });
	return (
		<li className="pt-1 first:pt-0">
			<div className="flex items-center">
				<button
					type="button"
					// A real disclosure button: the web's own way of saying a fold is open, and which rows it folds.
					aria-expanded={!group.collapsed}
					aria-controls={id}
					aria-label={group.collapsed ? t("projectGroups.groupAriaCollapsed", { name: group.name, n: count }) : label}
					data-testid="project-group"
					data-group={group.id}
					className={cx(ROW, "font-medium")}
					onClick={onFold}
					disabled={busy}
				>
					{group.collapsed ? (
						<ChevronRight size={14} className={ICON} aria-hidden />
					) : (
						<ChevronDown size={14} className={ICON} aria-hidden />
					)}
					<span className="min-w-0 flex-1 truncate">{group.name}</span>
					<span className="shrink-0 text-xs tabular-nums text-faint">{count}</span>
				</button>
				<Menu.Root>
					<Menu.Trigger asChild>
						<button
							type="button"
							aria-label={t("projectGroups.groupMenu", { name: group.name })}
							data-testid="group-menu"
							className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg"
						>
							<Folder size={13} aria-hidden />
						</button>
					</Menu.Trigger>
					<Menu.Portal>
						<Menu.Content
							align="start"
							sideOffset={4}
							className="z-50 min-w-48 rounded-xl border border-border bg-surface p-1 shadow-2xl"
						>
							<Menu.Item className={ITEM} data-testid="rename-group" onSelect={() => onAsk({ kind: "rename", group })}>
								<Pencil size={14} /> {t("projectGroups.renameGroup")}
							</Menu.Item>
							<Menu.Item className={ITEM} disabled={at === 0} data-testid="group-up" onSelect={() => onReorder(-1)}>
								<ChevronUp size={14} /> {t("projectGroups.moveUp")}
							</Menu.Item>
							<Menu.Item
								className={ITEM}
								disabled={at >= groupCount - 1}
								data-testid="group-down"
								onSelect={() => onReorder(1)}
							>
								<ChevronDown size={14} /> {t("projectGroups.moveDown")}
							</Menu.Item>
							<Menu.Separator className="my-1 h-px bg-border" />
							<Menu.Item
								className={cx(ITEM, "text-danger")}
								data-testid="delete-group"
								onSelect={() => onAsk({ kind: "delete", group })}
							>
								<Trash2 size={14} /> {t("projectGroups.deleteGroup")}
							</Menu.Item>
						</Menu.Content>
					</Menu.Portal>
				</Menu.Root>
			</div>
			{group.collapsed ? null : (
				<ul id={id} className="mt-0.5 ml-4 space-y-0.5 border-l border-border pl-1" data-testid="group-projects">
					{rows.length ? (
						rows.map(({ row, label: name, path }) => (
							<ProjectRowLine
								key={row.cwd}
								row={row}
								label={name}
								path={path}
								count={row.count}
								countLabel={countLabel(row.count)}
								chosen={chosen === row.cwd}
								targets={targets}
								onChoose={() => onChoose(row.cwd)}
								onMove={onMove}
							/>
						))
					) : (
						<li className="px-2 py-1 text-xs text-muted">{t("projectGroups.groupEmpty")}</li>
					)}
				</ul>
			)}
		</li>
	);
}

/** The name of a group, or the confirmation of its deletion. */
function GroupDialog({
	ask,
	groups,
	busy,
	onClose,
	onCreate,
	onRename,
	onDelete,
}: {
	ask: Ask | null;
	groups: readonly ProjectGroup[];
	busy: boolean;
	onClose: () => void;
	onCreate: (name: string) => void;
	onRename: (group: ProjectGroup, name: string) => void;
	onDelete: (group: ProjectGroup) => void;
}) {
	const t = useT();
	const editing = ask?.kind === "rename" ? ask.group : null;
	const own = editing?.id ?? null;
	// The field starts with the group's name when renaming, empty when making one: the caller mounts this anew for each
	// question (`key`), which is what keeps a rename of another group from opening on the last one's name.
	const [name, setName] = useState(editing?.name ?? "");
	const [problem, setProblem] = useState<string | null>(null);
	const field = useRef<HTMLInputElement>(null);

	const messageOf = (which: NonNullable<ReturnType<typeof groupNameProblem>>): string => {
		if (which === "taken") {
			const folded = name.trim().toLowerCase();
			const other = groups.find((g) => g.id !== own && g.name.trim().toLowerCase() === folded);
			return t("projectGroups.problemTaken", { name: other?.name ?? name.trim() });
		}
		if (which === "empty") return t("projectGroups.problemEmpty");
		if (which === "tooLong") return t("projectGroups.problemTooLong", { max: GROUP_NAME_MAX });
		return t("projectGroups.problemInvalid");
	};

	const submit = (e: FormEvent) => {
		e.preventDefault();
		const which = groupNameProblem(groups, name, own);
		if (which) {
			setProblem(messageOf(which));
			field.current?.focus();
			return;
		}
		if (ask?.kind === "new") onCreate(name);
		else if (ask?.kind === "rename") onRename(ask.group, name);
	};

	if (ask?.kind === "delete") {
		return (
			<Modal
				open
				onOpenChange={(o) => !o && !busy && onClose()}
				title={t("projectGroups.deleteTitle", { name: ask.group.name })}
				description={t("projectGroups.deleteDescription")}
			>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" disabled={busy} onClick={onClose}>
						{t("common.cancel")}
					</Button>
					<Button
						variant="danger"
						data-testid="confirm-delete-group"
						disabled={busy}
						onClick={() => onDelete(ask.group)}
					>
						{busy ? <Spinner size={14} /> : null}
						{t("projectGroups.deleteConfirm")}
					</Button>
				</div>
			</Modal>
		);
	}

	return (
		<Modal
			open={ask !== null}
			onOpenChange={(o) => !o && !busy && onClose()}
			title={ask?.kind === "rename" ? t("projectGroups.renameGroupTitle") : t("projectGroups.newGroupTitle")}
		>
			<form onSubmit={submit}>
				<label className="block text-xs font-medium text-muted" htmlFor="project-group-name">
					{t("projectGroups.nameLabel")}
				</label>
				<input
					id="project-group-name"
					ref={field}
					data-testid="group-name"
					className="mt-1 w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm outline-none focus:border-faint"
					value={name}
					maxLength={GROUP_NAME_MAX}
					placeholder={t("projectGroups.namePlaceholder")}
					onChange={(e) => {
						setName(e.target.value);
						setProblem(null);
					}}
					aria-invalid={problem ? true : undefined}
					aria-describedby={problem ? "project-group-problem" : undefined}
				/>
				{problem ? (
					<p id="project-group-problem" role="alert" className="mt-1.5 text-xs text-danger" data-testid="group-problem">
						{problem}
					</p>
				) : null}
				<div className="mt-3 flex justify-end gap-2">
					<Button variant="ghost" type="button" disabled={busy} onClick={onClose}>
						{t("common.cancel")}
					</Button>
					<Button variant="primary" type="submit" data-testid="save-group" disabled={busy || !name.trim()}>
						{busy ? <Spinner size={14} /> : null}
						{ask?.kind === "rename" ? t("projectGroups.rename") : t("projectGroups.create")}
					</Button>
				</div>
			</form>
		</Modal>
	);
}
