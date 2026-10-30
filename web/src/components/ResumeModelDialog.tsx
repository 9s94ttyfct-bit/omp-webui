import { Command } from "cmdk";
import { Brain } from "lucide-react";
import { useEffect, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { api } from "../lib/api.ts";
import { modelLabel, sharedLabels } from "../lib/models.ts";
import type { ModelInfo } from "../store/live.ts";
import { ModelName } from "./ModelList.tsx";
import { Modal, Spinner } from "./ui.tsx";

/** Shown when omp cannot restore a session's saved model; resolves with `provider/id` or null. */
export function ResumeModelDialog({
	prompt,
}: {
	prompt: { reason: string; resolve: (model: string | null) => void } | null;
}) {
	const t = useT();
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!prompt || models) return;
		api
			.models()
			.then(setModels)
			.catch((e) => setError(e.message));
	}, [prompt, models]);
	const shared = sharedLabels(models ?? []);
	return (
		<Modal
			open={prompt !== null}
			onOpenChange={(o) => !o && prompt?.resolve(null)}
			title={t("chat.resumeTitle")}
			description={
				<>
					{t("chat.resumeDesc")} <span className="text-fg">{prompt?.reason}</span>
				</>
			}
		>
			{error ? <div className="text-sm text-danger">{error}</div> : null}
			{!models && !error ? (
				<div className="flex justify-center py-6">
					<Spinner />
				</div>
			) : null}
			{models ? (
				<Command label={t("chat.resumeAvailable")} className="flex max-h-80 flex-col" data-testid="resume-model-list">
					<Command.Input
						placeholder={t("chat.resumeSearch")}
						className="mb-2 w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm outline-none focus:border-faint"
					/>
					<Command.List className="overflow-y-auto">
						<Command.Empty className="p-3 text-sm text-muted">{t("chat.resumeNoModels")}</Command.Empty>
						{models.map((m) => (
							<Command.Item
								key={`${m.provider}/${m.id}`}
								value={`${m.provider}/${m.id} ${m.name ?? ""}`}
								className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm data-[selected=true]:bg-hover"
								onSelect={() => prompt?.resolve(`${m.provider}/${m.id}`)}
							>
								<ModelName model={m} shared={shared.has(modelLabel(m))} />
								<span className="text-xs text-faint">{m.provider}</span>
								{m.reasoning ? <Brain size={12} className="text-faint" aria-label={t("chat.resumeReasoning")} /> : null}
							</Command.Item>
						))}
					</Command.List>
				</Command>
			) : null}
		</Modal>
	);
}
