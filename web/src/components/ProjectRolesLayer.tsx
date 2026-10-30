import type { ProjectOverrides } from "@shared/model-config.ts";
import { Lock } from "lucide-react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { describeSelector } from "../lib/model-config.ts";
import type { ModelInfo } from "../store/live.ts";
import { roleLabel } from "./ModelRolesEditor.tsx";
import { Badge, CardHeader } from "./ui.tsx";

/**
 * What the project the page was last used in changes in the roles above: omp merges that project's config over the
 * global one, so a conversation there uses these models and thinking level, whatever the roles above say. Read-only:
 * the page edits the global config.
 */
export function ProjectRolesLayer({
	name,
	overrides,
	models,
}: {
	/** The project's folder name. */
	name: string;
	overrides: ProjectOverrides;
	models: ModelInfo[] | null;
}) {
	const t = useT();
	const roles = Object.entries(overrides.roles);
	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="project-layer">
			<CardHeader
				icon={<Lock size={16} />}
				title={t("presets.layerTitle", { folder: name })}
				hint={t("presets.layerHint")}
			/>
			<ul className="divide-y divide-border">
				{roles.map(([role, selector]) => (
					<li
						key={role}
						data-testid="project-role"
						data-role={role}
						className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
					>
						<span className="w-36 shrink-0 truncate text-sm font-medium">{roleLabel(role, t)}</span>
						<span className="min-w-0 flex-1 truncate text-sm text-muted">{describeSelector(selector, models)}</span>
						<Badge className="shrink-0">{t("presets.project")}</Badge>
					</li>
				))}
				{overrides.defaultThinkingLevel ? (
					<li data-testid="project-thinking" className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
						<span className="w-36 shrink-0 truncate text-sm font-medium">{t("presets.layerThinking")}</span>
						<span className="min-w-0 flex-1 truncate text-sm text-muted">{overrides.defaultThinkingLevel}</span>
						<Badge className="shrink-0">{t("presets.project")}</Badge>
					</li>
				) : null}
			</ul>
		</section>
	);
}
