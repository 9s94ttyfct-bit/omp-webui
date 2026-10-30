import type { ProjectsInfo } from "@shared/projects.ts";
import { Check, FolderCog, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import { shortPath } from "../lib/format.ts";
import { useImeGuard } from "../lib/ime.ts";
import { projectsApi, projectsErrorText } from "../lib/projects-api.ts";
import { useProjectsStrings } from "../lib/projects-strings.ts";
import { useApp } from "../store/app.ts";
import { DirBrowser } from "./DirBrowser.tsx";
import { Badge, Button, CardHeader, Spinner } from "./ui.tsx";

type Outcome =
	| { state: "idle" }
	| { state: "saving" }
	| { state: "saved" }
	| { state: "error"; why: "projects.loadFailed" | "projects.saveFailed"; error: unknown };

/**
 * Settings › Projects folder: where "New project folder" in a new chat's folder picker makes a project. Nothing chosen is
 * `~/omp`, made when the first project folder is. It is changed at the computer the server runs on only (`meta.local`,
 * the server's own test for its 403): a page that came through the tunnel, or from the network, shows it, and can still
 * make a project folder in it (see `/api/projects` in `server/main.ts`). A card of its own chunk, with its own strings.
 */
export function ProjectsSettings() {
	const t = useT();
	const ready = useProjectsStrings();
	const home = useApp((s) => s.meta?.home);
	// Until the server has said, a page is taken to be elsewhere: nothing is offered that its 403 would refuse.
	const remote = useApp((s) => s.meta?.local !== true);
	const [info, setInfo] = useState<ProjectsInfo | null>(null);
	/** What is typed and not saved yet; null: the field shows the folder the server has. */
	const [draft, setDraft] = useState<string | null>(null);
	const [outcome, setOutcome] = useState<Outcome>({ state: "idle" });
	const [browsing, setBrowsing] = useState(false);
	const ime = useImeGuard();

	useEffect(() => {
		let alive = true;
		projectsApi
			.info()
			.then((i) => alive && setInfo(i))
			.catch((error) => alive && setOutcome({ state: "error", why: "projects.loadFailed", error }));
		return () => {
			alive = false;
		};
	}, []);

	if (!ready) return null;

	const save = async (folder: string | null) => {
		setOutcome({ state: "saving" });
		try {
			setInfo(await projectsApi.set(folder));
			setDraft(null);
			setOutcome({ state: "saved" });
		} catch (e) {
			setOutcome({ state: "error", why: "projects.saveFailed", error: e });
		}
	};
	const shown = draft ?? (info ? shortPath(info.folder, home) : "");
	const dirty = draft !== null && draft.trim() !== "" && draft.trim() !== shortPath(info?.folder ?? "", home);

	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="projects-settings">
			<CardHeader title={t("projects.title")} icon={<FolderCog size={16} />} hint={t("projects.hint")} />
			<form
				className="flex flex-wrap items-center gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (!remote && dirty && draft !== null) void save(draft);
				}}
			>
				<input
					aria-label={t("projects.pathAria")}
					data-testid="projects-folder"
					value={shown}
					readOnly={remote}
					spellCheck={false}
					onChange={(e) => {
						setDraft(e.target.value);
						setOutcome({ state: "idle" });
					}}
					onCompositionEnd={ime.onCompositionEnd}
					onKeyDown={(e) => {
						if (e.key === "Enter" && ime.imeKey(e)) e.preventDefault();
					}}
					className="min-w-0 flex-1 rounded-lg border border-border bg-bg-soft px-2.5 py-1.5 font-mono text-xs outline-none focus:border-faint read-only:text-muted"
				/>
				{info?.isDefault ? (
					<span data-testid="projects-is-default">
						<Badge>{t("projects.isDefault")}</Badge>
					</span>
				) : null}
				{remote ? null : (
					<>
						<Button size="sm" data-testid="projects-choose" onClick={() => setBrowsing(true)}>
							{t("projects.choose")}
						</Button>
						<Button size="sm" variant="primary" type="submit" data-testid="projects-save" disabled={!dirty}>
							{t("projects.save")}
						</Button>
						{info && !info.isDefault ? (
							<Button size="sm" variant="ghost" data-testid="projects-default" onClick={() => void save(null)}>
								{t("projects.useDefault")}
							</Button>
						) : null}
					</>
				)}
			</form>
			<p className="mt-2 text-xs text-muted">{remote ? t("projects.remoteNote") : t("projects.defaultNote")}</p>
			{info && !info.exists ? (
				<p className="mt-2 flex items-start gap-1.5 text-xs text-warning" data-testid="projects-missing">
					<TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden /> {t("projects.missing")}
				</p>
			) : null}
			<div className="mt-2 min-h-5 text-xs" role="status" data-testid="projects-status" data-state={outcome.state}>
				{outcome.state === "saving" ? (
					<span className="inline-flex items-center gap-1.5 text-muted">
						<Spinner size={12} /> {t("projects.saving")}
					</span>
				) : outcome.state === "saved" ? (
					<span className="inline-flex items-center gap-1.5 text-success">
						<Check size={12} aria-hidden /> {t("projects.saved")}
					</span>
				) : outcome.state === "error" ? (
					<span className="text-danger" data-testid="projects-error">
						{t(outcome.why, { error: projectsErrorText(t, outcome.error) })}
					</span>
				) : null}
			</div>
			{remote ? null : (
				<DirBrowser
					open={browsing}
					onOpenChange={setBrowsing}
					start={info?.folder ?? home ?? ""}
					title={t("projects.chooseTitle")}
					description={t("projects.chooseDesc")}
					onPick={(folder) => void save(folder)}
				/>
			)}
		</section>
	);
}
