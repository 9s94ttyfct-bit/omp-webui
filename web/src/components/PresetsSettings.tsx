import { activeFirst, type ModelConfig, type ModelPreset } from "@shared/model-config.ts";
import { BookmarkPlus, Bot, Copy, Layers, Lock, Pencil, SlidersHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { describePreset, modelConfig } from "../lib/model-config.ts";
import { presetActions } from "../lib/preset-actions.ts";
import { agentsLine } from "../lib/preset-agents.ts";
import { useApp } from "../store/app.ts";
import type { ModelInfo } from "../store/live.ts";
import { DeletePresetDialog } from "./DeletePresetDialog.tsx";
import { PresetAgentsDialog } from "./PresetAgentsDialog.tsx";
import PresetAgentsNote from "./PresetAgentsNote.tsx";
import { PresetNameDialog } from "./PresetDialogs.tsx";
import { PresetEditDialog } from "./PresetEditDialog.tsx";
import { Badge, Button, CardHeader, cx, IconButton } from "./ui.tsx";

/** A name for a copy of `name` that nothing else has: `fast-copy`, then `fast-copy2`… */
function freeCopyName(name: string, taken: ModelPreset[], suggest: (name: string) => string): string {
	const first = suggest(name);
	let candidate = first;
	for (let n = 2; taken.some((p) => p.name === candidate); n++) candidate = `${first}${n}`;
	return candidate;
}

type Naming = { kind: "rename" | "duplicate"; name: string } | null;

/**
 * The presets of the global config — apply (without a conversation: it sets the roles and the default thinking
 * level), rename, duplicate, delete — and, read-only, the ones the current project's own config defines.
 */
export function PresetsSettings({
	config,
	models,
	project,
	saveOpen,
	onSaveOpenChange,
	rolesDirty,
}: {
	config: ModelConfig;
	models: ModelInfo[] | null;
	/** Presets a project defines, with the folder they are for; they cannot be changed from the global config. */
	project: { folder: string; presets: ModelPreset[] } | null;
	saveOpen: boolean;
	onSaveOpenChange: (open: boolean) => void;
	/** The roles editor holds edits that are not saved: "Save current" would store the roles as omp has them, not these. */
	rolesDirty: boolean;
}) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const [busy, setBusy] = useState<string | null>(null);
	const [naming, setNaming] = useState<Naming>(null);
	const [deleting, setDeleting] = useState<string | null>(null);
	const [agentsOf, setAgentsOf] = useState<string | null>(null);
	const [editing, setEditing] = useState<string | null>(null);

	const run = async (name: string, action: () => Promise<unknown>, done: string, failed: (error: string) => string) => {
		setBusy(name);
		try {
			await action();
			toast("success", done);
		} catch (e) {
			toast("error", failed((e as Error).message));
		} finally {
			setBusy(null);
		}
	};

	const details = (p: ModelPreset) => (
		<>
			<span className={cx("block truncate text-xs", p.problem ? "text-danger" : "text-muted")}>
				{p.problem ? t("presets.unusable", { problem: p.problem }) : describePreset(p, models)}
			</span>
			{p.agentModelOverrides && !p.problem ? (
				<span
					className="block truncate text-xs text-muted"
					data-testid="preset-agents-summary"
					title={agentsLine(p.agentModelOverrides, models)}
				>
					{t("presetAgents.summary", { models: agentsLine(p.agentModelOverrides, models) })}
				</span>
			) : null}
		</>
	);
	// Names in use where it matters: the global presets, and the ones the project defines — a global preset of such a name
	// would be shadowed in that project, which omp itself says when it saves one.
	const taken = [...config.presets, ...(project?.presets ?? [])];

	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="model-presets">
			<CardHeader
				icon={<Layers size={16} />}
				title={t("presets.listTitle")}
				hint={t("presets.listHint")}
				action={
					<Button
						size="sm"
						disabled={rolesDirty}
						title={rolesDirty ? t("presets.rolesSaveFirst") : undefined}
						onClick={() => onSaveOpenChange(true)}
						data-testid="save-current-preset"
					>
						<BookmarkPlus size={13} /> {t("presets.saveCurrent")}
					</Button>
				}
			/>
			{config.presets.length === 0 ? <p className="py-2 text-sm text-muted">{t("presets.listEmpty")}</p> : null}
			<ul className="divide-y divide-border">
				{activeFirst(config.presets, config.active).map((p) => (
					<li
						key={p.name}
						data-testid="preset-row"
						data-preset={p.name}
						className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5"
					>
						<div className="min-w-0 flex-1 basis-44">
							<span className="flex items-center gap-1.5">
								<span className="truncate text-sm font-medium">{p.name}</span>
								{config.active === p.name ? (
									<Badge tone="accent" className="shrink-0">
										{t("presets.active")}
									</Badge>
								) : null}
							</span>
							{details(p)}
						</div>
						<div className="ml-auto flex items-center gap-0.5">
							<Button
								size="sm"
								disabled={busy !== null || Boolean(p.problem)}
								aria-label={t("presets.applyAria", { name: p.name })}
								data-testid="apply-preset"
								onClick={() =>
									void run(
										p.name,
										() => presetActions.apply(p.name),
										t("presets.applied", { name: p.name }),
										(error) => t("presets.applyFailed", { name: p.name, error }),
									)
								}
							>
								{t("presets.apply")}
							</Button>
							<IconButton
								label={t("presets.editAria", { name: p.name })}
								size="sm"
								data-testid="edit-preset"
								disabled={busy !== null || Boolean(p.problem)}
								onClick={() => setEditing(p.name)}
							>
								<SlidersHorizontal size={14} />
							</IconButton>
							<IconButton
								label={t("presetAgents.editAria", { name: p.name })}
								size="sm"
								data-testid="edit-preset-agents"
								disabled={busy !== null || Boolean(p.problem)}
								onClick={() => setAgentsOf(p.name)}
							>
								<Bot size={14} />
							</IconButton>
							<IconButton
								label={t("presets.renameAria", { name: p.name })}
								size="sm"
								data-testid="rename-preset"
								disabled={busy !== null}
								onClick={() => setNaming({ kind: "rename", name: p.name })}
							>
								<Pencil size={14} />
							</IconButton>
							<IconButton
								label={t("presets.duplicateAria", { name: p.name })}
								size="sm"
								data-testid="duplicate-preset"
								disabled={busy !== null || Boolean(p.problem)}
								onClick={() => setNaming({ kind: "duplicate", name: p.name })}
							>
								<Copy size={14} />
							</IconButton>
							<IconButton
								label={t("presets.deleteAria", { name: p.name })}
								size="sm"
								data-testid="delete-preset"
								disabled={busy !== null}
								onClick={() => setDeleting(p.name)}
							>
								<Trash2 size={14} />
							</IconButton>
						</div>
					</li>
				))}
			</ul>
			{project && project.presets.length > 0 ? (
				<div className="mt-3 border-t border-border pt-3" data-testid="project-presets">
					<p className="mb-1 text-xs text-muted">
						{t("presets.projectNote", { folder: project.folder.split("/").filter(Boolean).pop() ?? project.folder })}
					</p>
					<ul className="divide-y divide-border">
						{project.presets.map((p) => (
							<li
								key={p.name}
								data-testid="project-preset-row"
								data-preset={p.name}
								className="flex items-center gap-2 py-2"
							>
								<div className="min-w-0 flex-1">
									<span className="flex items-center gap-1.5">
										<span className="truncate text-sm font-medium">{p.name}</span>
										<Badge className="shrink-0">
											<Lock size={10} /> {t("presets.project")}
										</Badge>
									</span>
									{details(p)}
								</div>
							</li>
						))}
					</ul>
				</div>
			) : null}
			<p className="mt-3 border-t border-border pt-3 text-xs text-muted" data-testid="preset-agents-rule">
				{t("presetAgents.rule")}
			</p>

			<PresetNameDialog
				open={saveOpen}
				onOpenChange={onSaveOpenChange}
				title={t("presets.saveTitle")}
				description={t("presets.saveDescription")}
				initial=""
				submitLabel={t("common.save")}
				existing={taken}
				allowReplace
				onSubmit={async (name, replace) => {
					await modelConfig.save({ name, overwrite: replace });
					toast("success", t("presets.saved", { name }));
				}}
				extra={<PresetAgentsNote agents={config.agentModelOverrides} models={models} />}
			/>
			<PresetNameDialog
				open={naming !== null}
				onOpenChange={(o) => !o && setNaming(null)}
				title={naming?.kind === "duplicate" ? t("presets.duplicateTitle") : t("presets.renameTitle")}
				initial={
					naming?.kind === "duplicate"
						? freeCopyName(naming.name, taken, (n) => t("presets.duplicateSuggestion", { name: n }))
						: (naming?.name ?? "")
				}
				submitLabel={naming?.kind === "duplicate" ? t("common.copy") : t("common.rename")}
				existing={taken}
				onSubmit={async (to) => {
					if (!naming) return;
					if (naming.kind === "duplicate") {
						await presetActions.duplicate(naming.name, to);
						toast("success", t("presets.duplicated", { name: to }));
					} else {
						await presetActions.rename(naming.name, to);
						toast("success", t("presets.renamed", { name: to }));
					}
				}}
			/>
			<DeletePresetDialog
				name={deleting}
				onClose={() => setDeleting(null)}
				onConfirm={(name) =>
					presetActions.remove(name).then(
						() => toast("success", t("presets.deleted", { name })),
						(e: Error) => toast("error", t("presets.actionFailed", { error: e.message })),
					)
				}
			/>
			{agentsOf !== null && config.presets.some((p) => p.name === agentsOf) ? (
				<PresetAgentsDialog
					key={agentsOf}
					preset={config.presets.find((p) => p.name === agentsOf) as ModelPreset}
					models={models}
					onClose={() => setAgentsOf(null)}
				/>
			) : null}
			{editing !== null && config.presets.some((p) => p.name === editing && p.source === "global") ? (
				<PresetEditDialog
					key={editing}
					preset={config.presets.find((p) => p.name === editing) as ModelPreset}
					models={models}
					onClose={() => setEditing(null)}
				/>
			) : null}
		</section>
	);
}
