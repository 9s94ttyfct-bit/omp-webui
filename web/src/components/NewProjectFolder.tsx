import { type ProjectsInfo, projectNameProblem } from "@shared/projects.ts";
import { FolderPlus } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useT } from "../i18n/index.ts";
import { shortPath } from "../lib/format.ts";
import { useImeGuard } from "../lib/ime.ts";
import { problemText, projectsApi, projectsErrorText } from "../lib/projects-api.ts";
import { useProjectsStrings } from "../lib/projects-strings.ts";
import { useApp } from "../store/app.ts";
import { Button, Spinner } from "./ui.tsx";

/**
 * "New project folder" in the folder picker of a new chat: a name, made into a folder in the projects folder (Settings ›
 * Projects folder), which the new chat then starts in. The name is checked as it is typed (`projectNameProblem`, which the
 * server checks again), and a folder that exists is never touched: that is told, and the name is left to be changed. A chunk
 * of its own with its own strings, loaded when the picker is first opened (see `DirBrowser`).
 */
export default function NewProjectFolder({
	onCreated,
	onFormOpen,
}: {
	onCreated: (path: string) => void;
	/** The form is open (or closed again): the picker's own "Use this folder" steps aside while it is, so there is one way on (C4). */
	onFormOpen?: (open: boolean) => void;
}) {
	const t = useT();
	const ready = useProjectsStrings();
	const home = useApp((s) => s.meta?.home);
	const [open, setOpenState] = useState(false);
	const setOpen = (next: boolean) => {
		setOpenState(next);
		onFormOpen?.(next);
	};
	const [name, setName] = useState("");
	const [info, setInfo] = useState<ProjectsInfo | null>(null);
	/** Why the server did not make the folder, in words; cleared by the next edit of the name. */
	const [refused, setRefused] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const ime = useImeGuard();
	const nameId = useId();

	// Where the folder will be made is read when the form opens, so that what the person sees is what the server will use.
	useEffect(() => {
		if (!open) return;
		let alive = true;
		projectsApi
			.info()
			.then((i) => alive && setInfo(i))
			// Without it the line that says where the folder will be made is absent: making one tells what is wrong.
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [open]);

	if (!ready) return null;
	if (!open) {
		return (
			<div className="mt-3">
				<Button size="sm" data-testid="new-project" onClick={() => setOpen(true)}>
					<FolderPlus size={14} /> {t("projects.newProject")}
				</Button>
			</div>
		);
	}

	const problem = name === "" ? null : projectNameProblem(name);
	const create = async () => {
		const bad = projectNameProblem(name);
		if (bad) {
			setRefused(problemText(t, bad, name));
			return;
		}
		setCreating(true);
		setRefused(null);
		try {
			const made = await projectsApi.create(name);
			onCreated(made.path);
		} catch (e) {
			setRefused(projectsErrorText(t, e, name));
			setCreating(false);
		}
	};
	const shown = refused ?? (problem ? problemText(t, problem, name) : null);
	return (
		<form
			className="mt-3 rounded-lg border border-border bg-bg-soft p-3"
			data-testid="new-project-form"
			onSubmit={(e) => {
				e.preventDefault();
				if (!creating) void create();
			}}
		>
			<label htmlFor={nameId} className="mb-1 block text-xs font-medium">
				{t("projects.nameLabel")}
			</label>
			<input
				id={nameId}
				// biome-ignore lint/a11y/noAutofocus: the person just asked for this field.
				autoFocus
				data-testid="new-project-name"
				value={name}
				placeholder={t("projects.namePlaceholder")}
				aria-invalid={shown !== null}
				aria-describedby={`${nameId}-note`}
				spellCheck={false}
				autoCapitalize="off"
				autoComplete="off"
				onChange={(e) => {
					setName(e.target.value);
					setRefused(null);
				}}
				onCompositionEnd={ime.onCompositionEnd}
				onKeyDown={(e) => {
					// The Enter that confirms an input method's word is not the person making the folder.
					if (e.key === "Enter" && ime.imeKey(e)) e.preventDefault();
				}}
				className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 font-mono text-xs outline-none focus:border-faint"
			/>
			<div id={`${nameId}-note`} className="mt-1 min-h-4 text-xs" role="status">
				{shown ? (
					<span className="text-danger" data-testid="new-project-problem">
						{shown}
					</span>
				) : info ? (
					<span className="break-all text-muted" data-testid="new-project-in">
						{t("projects.newIn", { folder: shortPath(info.folder, home) })}
					</span>
				) : null}
			</div>
			<div className="mt-2 flex justify-end gap-2">
				<Button
					size="sm"
					variant="ghost"
					onClick={() => {
						setOpen(false);
						setName("");
						setRefused(null);
					}}
				>
					{t("projects.back")}
				</Button>
				<Button
					size="sm"
					variant="primary"
					type="submit"
					data-testid="new-project-create"
					disabled={creating || name === "" || problem !== null}
				>
					{creating ? <Spinner size={12} /> : null}
					{creating ? t("projects.creating") : t("projects.create")}
				</Button>
			</div>
		</form>
	);
}
