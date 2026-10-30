import { type ModelPreset, selectorProblem } from "@shared/model-config.ts";
import { useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { presetActions } from "../lib/preset-actions.ts";
import { useApp } from "../store/app.ts";
import type { ModelInfo } from "../store/live.ts";
import { RolesFields, rowsOfRoles } from "./ModelRolesEditor.tsx";
import { AgentFields, agentRowsOf, sameAgentRows } from "./PresetAgentsDialog.tsx";
import { Button, Modal, Spinner } from "./ui.tsx";

/**
 * Everything a saved global preset holds, in one dialog: the model of each role, the default thinking level (or none) and
 * the subagent models. Edits are a draft until saved; saving rewrites that preset's entry in omp's config in one call and
 * keeps whatever else the entry holds. Mounted while it is open, so the draft starts from the preset as it was then.
 */
export function PresetEditDialog({
	preset,
	models,
	onClose,
}: {
	preset: ModelPreset;
	models: ModelInfo[] | null;
	onClose: () => void;
}) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const [stored] = useState(() => ({
		roles: rowsOfRoles(preset.roles),
		thinking: preset.defaultThinkingLevel ?? "",
		agents: agentRowsOf(preset.agentModelOverrides),
	}));
	const [roles, setRoles] = useState(stored.roles);
	const [thinking, setThinking] = useState(stored.thinking);
	const [agents, setAgents] = useState(stored.agents);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const dirty =
		thinking !== stored.thinking ||
		!sameAgentRows(agents, stored.agents) ||
		roles.length !== stored.roles.length ||
		roles.some((r, i) => r.role !== stored.roles[i].role || r.selector !== stored.roles[i].selector);
	// A preset needs a role; every model, role and subagent alike, must be one omp could read.
	const incomplete =
		roles.length === 0 ||
		roles.some((r) => selectorProblem(r.selector) !== null) ||
		agents.some((r) => selectorProblem(r.selector) !== null);

	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			await presetActions.edit(preset.name, {
				roles: Object.fromEntries(roles.map((r) => [r.role, r.selector])),
				defaultThinkingLevel: thinking === "" ? null : thinking,
				agentModelOverrides: Object.fromEntries(agents.map((r) => [r.agent, r.selector])),
			});
			toast("success", t("presets.editSaved", { name: preset.name }));
			onClose();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			open
			wide
			onOpenChange={(o) => !o && !busy && onClose()}
			title={t("presets.editTitle", { name: preset.name })}
			description={t("presets.editDescription")}
		>
			<div data-testid="preset-edit-dialog" data-preset={preset.name}>
				<RolesFields
					rows={roles}
					thinking={thinking}
					models={models}
					allowUnsetThinking
					onRows={setRoles}
					onThinking={setThinking}
				/>
				<h3 className="mb-1 mt-4 border-t border-border pt-3 text-sm font-medium">{t("presets.editSubagents")}</h3>
				<AgentFields
					rows={agents}
					models={models}
					fallback={roles.find((r) => r.role === "default")?.selector ?? ""}
					onRows={setAgents}
				/>
				{error ? (
					<p className="mt-3 text-sm text-danger" role="alert" data-testid="preset-edit-error">
						{error}
					</p>
				) : null}
				<div className="mt-4 flex items-center justify-end gap-2">
					{dirty ? (
						<span className="mr-auto text-xs text-warning" data-testid="edit-unsaved">
							{t("presets.rolesUnsaved")}
						</span>
					) : null}
					<Button variant="ghost" disabled={busy} onClick={onClose}>
						{t("common.cancel")}
					</Button>
					<Button
						variant="primary"
						disabled={!dirty || busy || incomplete}
						onClick={() => void save()}
						data-testid="save-preset-edit"
					>
						{busy ? <Spinner size={14} /> : null} {t("common.save")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}
