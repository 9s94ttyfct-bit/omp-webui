import { projectOverrides } from "@shared/model-config.ts";
import { PREF } from "@shared/prefs.ts";
import { Cpu } from "lucide-react";
import { useEffect, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { refreshModelConfigs, useModelCatalog, useModelConfig } from "../lib/model-config.ts";
import { loadMode, useMode } from "../lib/offline.ts";
import { ModelRolesEditor } from "./ModelRolesEditor.tsx";
import { PresetsSettings } from "./PresetsSettings.tsx";
import { ProjectRolesLayer } from "./ProjectRolesLayer.tsx";
import { Button, CardHeader, Spinner } from "./ui.tsx";

/**
 * Settings: the model each role uses and the model presets, both in omp's own config (so the terminal UI shares
 * them). Reads the global config, which is what is edited; the folder of the last conversation started from the
 * new-chat page is read too, to show what its project config overrides (roles, thinking level, where omp saves role
 * changes) and the presets it defines, which cannot be changed from here.
 */
export function ModelConfigSettings() {
	const t = useT();
	const { config, error } = useModelConfig("");
	const projectFolder = localStorage.getItem(PREF.cwd) ?? "";
	const project = useModelConfig(projectFolder);
	const models = useModelCatalog(true, "omp");
	const [saveOpen, setSaveOpen] = useState(false);
	/** The roles editor holds edits that are not saved. */
	const [rolesDirty, setRolesDirty] = useState(false);
	// Only processes on the person's own models read these roles and presets: one on a local server runs on the local model chosen under Full / Light.
	const local = useMode((s) => s.state?.mode === "light" && s.state.lightModels === "local");
	useEffect(() => {
		if (!useMode.getState().state) void loadMode();
	}, []);

	if (!config) {
		return (
			<section className="rounded-2xl border border-border bg-surface p-4" data-testid="model-roles">
				<CardHeader icon={<Cpu size={16} />} title={t("presets.rolesTitle")} />
				{error ? (
					<div className="flex flex-wrap items-center gap-3 break-words text-sm text-danger">
						{t("presets.listFailed", { error })}
						<Button size="sm" onClick={refreshModelConfigs}>
							{t("common.retry")}
						</Button>
					</div>
				) : (
					<Spinner />
				)}
			</section>
		);
	}

	const projectName = projectFolder.split("/").filter(Boolean).pop() ?? projectFolder;
	const projectPresets = project.config?.presets.filter((p) => p.source === "project") ?? [];
	const overrides = project.config ? projectOverrides(config, project.config) : null;
	const overridden = overrides && (Object.keys(overrides.roles).length > 0 || overrides.defaultThinkingLevel);
	// What omp does in the project's folder when it is known (the project's config can set it), else globally.
	const roleStorage = (project.config ?? config).roleStorage;
	return (
		<>
			{local ? (
				<p
					className="rounded-2xl border border-warning/40 bg-surface p-3 text-sm text-warning"
					data-testid="presets-local-note"
				>
					{t("presets.localSettingsNote")}
				</p>
			) : null}
			{config.movedAside ? (
				<p
					className="break-words rounded-2xl border border-warning/40 bg-surface p-3 text-sm text-warning"
					data-testid="config-moved-aside"
				>
					{t("presets.movedAside", { path: config.movedAside })}
				</p>
			) : null}
			{roleStorage === "project" ? (
				<p className="rounded-2xl border border-border bg-surface p-3 text-sm text-muted" data-testid="role-storage">
					{t("presets.storageProject")}
				</p>
			) : null}
			<ModelRolesEditor
				config={config}
				models={models}
				project={overrides ? { name: projectName, roles: overrides.roles } : null}
				onSaveAsPreset={() => setSaveOpen(true)}
				onDirtyChange={setRolesDirty}
			/>
			{overrides && overridden ? <ProjectRolesLayer name={projectName} overrides={overrides} models={models} /> : null}
			<PresetsSettings
				config={config}
				models={models}
				project={projectFolder ? { folder: projectFolder, presets: projectPresets } : null}
				saveOpen={saveOpen}
				onSaveOpenChange={setSaveOpen}
				rolesDirty={rolesDirty}
			/>
		</>
	);
}
