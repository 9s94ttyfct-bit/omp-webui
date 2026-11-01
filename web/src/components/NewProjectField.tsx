import { autoProjectName, type ProjectsInfo, projectNameProblem } from "@shared/projects.ts";
import { FolderOpen, FolderPlus } from "lucide-react";
import { useId } from "react";
import { useT } from "../i18n/index.ts";
import { shortPath } from "../lib/format.ts";
import { useImeGuard } from "../lib/ime.ts";
import { problemText, projectsErrorText } from "../lib/projects-api.ts";
import { useProjectsStrings } from "../lib/projects-strings.ts";

/**
 * New chat's default (v0.17.0): the name of the new project its conversation starts in, the projects folder it is made in
 * (Settings › Projects folder; "Change" sets that same setting, on this computer only), and the way to an existing folder
 * instead. The folder is made by New chat when the first message is sent, not here. A chunk of its own with the projects
 * folder's strings, like "New project folder" in the folder picker.
 */
export default function NewProjectField({
	name,
	onName,
	root,
	home,
	failure,
	remote,
	onChangeRoot,
	onUseExisting,
	onEnter,
}: {
	name: string;
	onName: (name: string) => void;
	/** The projects folder; null while it is read. */
	root: ProjectsInfo | null;
	home: string | undefined;
	/** Why the last send could not make the folder (cleared by the next edit of the name). */
	failure: unknown;
	/** A page not on this computer cannot change the projects folder (the server refuses it). */
	remote: boolean;
	onChangeRoot: () => void;
	onUseExisting: () => void;
	/** Enter in the name: on to the message box. */
	onEnter: () => void;
}) {
	const t = useT();
	const ready = useProjectsStrings();
	const ime = useImeGuard();
	const id = useId();
	if (!ready) return null;
	const typed = name === "" ? null : projectNameProblem(name);
	const shown = typed ? problemText(t, typed, name) : failure ? projectsErrorText(t, failure, name) : null;
	return (
		<div className="flex min-w-0 flex-1 flex-col gap-1" data-testid="new-project">
			<div className="flex min-w-0 items-center gap-1.5">
				<FolderPlus size={14} className="shrink-0 text-accent" aria-hidden />
				<label htmlFor={id} className="sr-only">
					{t("projects.nameLabel")}
				</label>
				<input
					id={id}
					// biome-ignore lint/a11y/noAutofocus: New chat opens on the project's name; Enter goes on to the message.
					autoFocus
					data-testid="new-project-name"
					value={name}
					placeholder={t("projects.autoPlaceholder", { name: autoProjectName(new Date()) })}
					aria-invalid={shown !== null}
					aria-describedby={`${id}-note`}
					spellCheck={false}
					autoCapitalize="off"
					autoComplete="off"
					onChange={(e) => onName(e.target.value)}
					onCompositionEnd={ime.onCompositionEnd}
					onKeyDown={(e) => {
						if (e.key !== "Enter") return;
						e.preventDefault();
						// The Enter that confirms an input method's word is not the person moving on.
						if (!ime.imeKey(e)) onEnter();
					}}
					className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 font-mono text-xs outline-none focus:border-faint"
				/>
				<button
					type="button"
					data-testid="use-existing-folder"
					className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-hover hover:text-fg"
					onClick={onUseExisting}
				>
					<FolderOpen size={13} /> {t("projects.useExisting")}
				</button>
			</div>
			<div id={`${id}-note`} className="min-h-4 px-1 text-xs" role="status">
				{shown ? (
					<span className="text-danger" data-testid="new-project-problem">
						{shown}
					</span>
				) : root ? (
					<span className="break-all text-muted" data-testid="new-project-root">
						{t("projects.newIn", { folder: shortPath(root.folder, home) })}
						{remote ? null : (
							<>
								{" · "}
								<button
									type="button"
									data-testid="new-project-root-change"
									className="text-accent hover:underline"
									onClick={onChangeRoot}
								>
									{t("projects.change")}
								</button>
							</>
						)}
					</span>
				) : null}
			</div>
		</div>
	);
}
