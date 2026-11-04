import { type ChatProject, PROJECT_NAME_MAX, projectNameProblem } from "@shared/chat-projects.ts";
import { type FormEvent, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { chatProjectsApi } from "../lib/chat-projects.ts";
import { useChatProjectsStrings } from "../lib/chat-projects-strings.ts";
import { errorText } from "../lib/error-text.ts";
import { askProject, type ProjectAsk, useProjectAsk } from "../lib/project-actions.ts";
import { useApp } from "../store/app.ts";
import { DirBrowser } from "./DirBrowser.tsx";
import { Button, Modal, Spinner } from "./ui.tsx";

/**
 * The dialogs of the sidebar's projects, for whatever asked (`askProject`): naming a new project (with the conversations
 * it was made for, from "Move to project › New project…"), renaming one, choosing its folder (the folder picker), and
 * confirming its deletion. A chunk of its own, drawn while a question is open.
 */
export function ProjectDialogs() {
	const ready = useChatProjectsStrings();
	const ask = useProjectAsk((s) => s.ask);
	if (!ready || !ask) return null;
	const key = ask.kind === "new" ? `new:${ask.sessions.join(",")}` : `${ask.kind}:${ask.project.id}`;
	if (ask.kind === "folder") return <FolderDialog key={key} project={ask.project} />;
	if (ask.kind === "delete") return <DeleteDialog key={key} project={ask.project} />;
	return <NameDialog key={key} ask={ask} />;
}

const close = () => askProject(null);

function NameDialog({ ask }: { ask: Extract<ProjectAsk, { kind: "new" | "rename" }> }) {
	const t = useT();
	const projects = useApp((s) => s.chatProjects);
	const editing = ask.kind === "rename" ? ask.project : null;
	// Mounted anew for each question (`key`): a rename of another project does not open on the last one's name.
	const [name, setName] = useState(editing?.name ?? "");
	const [problem, setProblem] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const field = useRef<HTMLInputElement>(null);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const which = projectNameProblem(projects, name, editing?.id ?? null);
		if (which) {
			setProblem(
				which === "taken"
					? t("chatProjects.problemTaken", { name: name.trim() })
					: which === "empty"
						? t("chatProjects.problemEmpty")
						: which === "tooLong"
							? t("chatProjects.problemTooLong", { max: PROJECT_NAME_MAX })
							: t("chatProjects.problemInvalid"),
			);
			field.current?.focus();
			return;
		}
		setBusy(true);
		try {
			if (ask.kind === "rename") await chatProjectsApi.rename(ask.project.id, name);
			else {
				const made = await chatProjectsApi.create(name, ask.sessions);
				if (ask.sessions.length && made.project)
					useApp.getState().toast("success", t("shell.sidebarProjectMoved", { name: made.project.name }));
			}
			close();
		} catch (err) {
			setProblem(t("chatProjects.saveFailed", { error: errorText(err) }));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			open
			onOpenChange={(o) => !o && !busy && close()}
			title={ask.kind === "rename" ? t("chatProjects.renameTitle") : t("chatProjects.newTitle")}
			description={ask.kind === "new" ? t("chatProjects.newHint") : undefined}
		>
			<form onSubmit={(e) => void submit(e)}>
				<label className="block text-xs font-medium text-muted" htmlFor="chat-project-name">
					{t("chatProjects.nameLabel")}
				</label>
				<input
					id="chat-project-name"
					ref={field}
					data-testid="project-name-input"
					className="mt-1 w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm outline-none focus:border-faint"
					value={name}
					maxLength={PROJECT_NAME_MAX * 2}
					placeholder={t("chatProjects.namePlaceholder")}
					onChange={(e) => {
						setName(e.target.value);
						setProblem(null);
					}}
					aria-invalid={problem ? true : undefined}
					aria-describedby={problem ? "chat-project-problem" : undefined}
				/>
				{problem ? (
					<p
						id="chat-project-problem"
						role="alert"
						className="mt-1.5 text-xs text-danger"
						data-testid="project-problem"
					>
						{problem}
					</p>
				) : null}
				<div className="mt-3 flex justify-end gap-2">
					<Button variant="ghost" type="button" disabled={busy} onClick={close}>
						{t("common.cancel")}
					</Button>
					<Button variant="primary" type="submit" data-testid="project-save" disabled={busy || !name.trim()}>
						{busy ? <Spinner size={14} /> : null}
						{ask.kind === "rename" ? t("chatProjects.save") : t("chatProjects.create")}
					</Button>
				</div>
			</form>
		</Modal>
	);
}

function DeleteDialog({ project }: { project: ChatProject }) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const remove = async () => {
		setBusy(true);
		try {
			await chatProjectsApi.remove(project.id);
			// A project's page that is open goes with it.
			const { view, setView } = useApp.getState();
			if (view.kind === "project" && view.id === project.id) setView({ kind: "new" }, { replace: true });
			close();
		} catch (e) {
			useApp.getState().toast("error", t("chatProjects.deleteFailed", { error: errorText(e) }));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal
			open
			onOpenChange={(o) => !o && !busy && close()}
			title={t("chatProjects.deleteTitle", { name: project.name })}
			description={t("chatProjects.deleteDescription")}
		>
			<div className="flex justify-end gap-2">
				<Button variant="ghost" disabled={busy} onClick={close}>
					{t("common.cancel")}
				</Button>
				<Button variant="danger" data-testid="project-delete-confirm" disabled={busy} onClick={() => void remove()}>
					{busy ? <Spinner size={14} /> : null}
					{t("chatProjects.deleteConfirm")}
				</Button>
			</div>
		</Modal>
	);
}

/** The project's folder, chosen with the folder picker every page has (a remote page's too: it lists the same folders). */
function FolderDialog({ project }: { project: ChatProject }) {
	const t = useT();
	const home = useApp((s) => s.meta?.home);
	return (
		<DirBrowser
			open
			onOpenChange={(open) => !open && close()}
			start={project.folder ?? home ?? ""}
			title={t("chatProjects.folderTitle")}
			description={t("chatProjects.folderDescription")}
			onPick={(folder) =>
				void chatProjectsApi
					.setFolder(project.id, folder)
					.then(close)
					.catch((e) => useApp.getState().toast("error", t("chatProjects.saveFailed", { error: errorText(e) })))
			}
		/>
	);
}
