import {
	formatSelector,
	type ModelPreset,
	parseSelector,
	presetPatternProblem,
	SELECTOR_LEVELS,
	selectorProblem,
} from "@shared/model-config.ts";
import { Plus, X } from "lucide-react";
import { useId, useState } from "react";
import "../i18n/later.ts";
import { registerStrings, useT } from "../i18n/index.ts";
import { en } from "../i18n/preset-agents.ts";
import { presetActions } from "../lib/preset-actions.ts";
import { useApp } from "../store/app.ts";
import type { ModelInfo } from "../store/live.ts";
import { LEVELS } from "./ModelRolesEditor.tsx";
import { ModelSelect } from "./ModelSelect.tsx";
import { Button, IconButton, Modal, Select, Spinner } from "./ui.tsx";

// Part of the Settings chunk: its strings are not in the first page.
registerStrings("presetAgents", en);

/** How long a name we let a person add may be; omp checks no agent name, so one already in the config is kept as it is. */
const AGENT_NAME_MAX = 48;

/** The agents omp ships (`omp agents unpack` writes them out): offered by name when adding a subagent. */
const BUNDLED_AGENTS = ["reviewer", "scout", "seance", "security-reviewer", "sonic", "task"];

export interface AgentRow {
	agent: string;
	selector: string;
}

export const agentRowsOf = (agents: Record<string, string> | undefined): AgentRow[] =>
	Object.entries(agents ?? {}).map(([agent, selector]) => ({ agent, selector }));

/** Whether two lists hold the same agents with the same selectors in the same order. */
export const sameAgentRows = (a: AgentRow[], b: AgentRow[]): boolean =>
	a.length === b.length && a.every((r, i) => r.agent === b[i].agent && r.selector === b[i].selector);

/**
 * One row per subagent (its model and the thinking level of its own) and the way to add one. Controlled: the caller keeps the
 * draft and saves it. `fallback` is the model a subagent that is added starts on (the preset's default model).
 */
export function AgentFields({
	rows,
	models,
	fallback,
	onRows,
}: {
	rows: AgentRow[];
	models: ModelInfo[] | null;
	fallback: string;
	onRows: (rows: AgentRow[]) => void;
}) {
	const t = useT();
	const [newAgent, setNewAgent] = useState("");
	const [addError, setAddError] = useState<string | null>(null);
	const listId = useId();
	const levelLabel = (level: string) => (Object.hasOwn(LEVELS, level) ? t(LEVELS[level]) : level);
	const setRow = (i: number, selector: string) => onRows(rows.map((r, j) => (j === i ? { ...r, selector } : r)));

	const add = () => {
		const agent = newAgent.trim();
		// The name as omp's own agents spell it (a letter, then letters, digits, - or _): what `presetPatternProblem` checks.
		if (agent.length > AGENT_NAME_MAX || presetPatternProblem(agent)) return setAddError(t("presetAgents.addInvalid"));
		if (rows.some((r) => r.agent === agent)) return setAddError(t("presetAgents.addExists"));
		// Starts on the preset's default model, so the new subagent is usable as it is.
		onRows([...rows, { agent, selector: fallback }]);
		setNewAgent("");
		setAddError(null);
	};

	return (
		<>
			{rows.length === 0 ? <p className="py-3 text-sm text-muted">{t("presetAgents.none")}</p> : null}
			<ul className="divide-y divide-border">
				{rows.map((row, i) => {
					const parsed = parseSelector(row.selector);
					return (
						<li
							key={row.agent}
							data-testid="agent-row"
							data-agent={row.agent}
							className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-center sm:gap-3"
						>
							<code className="min-w-0 truncate text-sm font-medium sm:w-36 sm:shrink-0">{row.agent}</code>
							<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
								<div className="min-w-0 flex-1 basis-48">
									<ModelSelect
										testid="agent-model"
										label={t("presetAgents.modelAria", { agent: row.agent })}
										models={models}
										// A selector that names one model is chosen without its thinking level, which has its own control.
										value={parsed ? `${parsed.provider}/${parsed.id}` : row.selector}
										onChange={(chosen) => {
											const next = parseSelector(chosen);
											setRow(i, next ? formatSelector({ ...next, level: next.level ?? parsed?.level }) : chosen);
										}}
									/>
								</div>
								<Select
									data-testid="agent-thinking"
									aria-label={t("presetAgents.thinkingAria", { agent: row.agent })}
									disabled={!parsed}
									value={parsed?.level ?? ""}
									onChange={(e) => {
										if (parsed)
											setRow(
												i,
												formatSelector({ ...parsed, level: SELECTOR_LEVELS.find((l) => l === e.target.value) }),
											);
									}}
									className="w-36 shrink-0"
								>
									<option value="">{t("presets.thinkingNone")}</option>
									{SELECTOR_LEVELS.map((level) => (
										<option key={level} value={level}>
											{levelLabel(level)}
										</option>
									))}
								</Select>
								<IconButton
									label={t("presetAgents.remove", { agent: row.agent })}
									size="sm"
									data-testid="agent-remove"
									onClick={() => onRows(rows.filter((_, j) => j !== i))}
								>
									<X size={14} />
								</IconButton>
							</div>
						</li>
					);
				})}
			</ul>
			<form
				className="mt-2 flex flex-wrap items-start gap-2 border-t border-border pt-3"
				onSubmit={(e) => {
					e.preventDefault();
					add();
				}}
			>
				<div className="min-w-0 flex-1 basis-44">
					<input
						list={listId}
						data-testid="new-agent"
						aria-label={t("presetAgents.addAria")}
						placeholder={t("presetAgents.addName")}
						value={newAgent}
						maxLength={AGENT_NAME_MAX}
						autoComplete="off"
						autoCapitalize="off"
						spellCheck={false}
						onChange={(e) => {
							setNewAgent(e.target.value);
							setAddError(null);
						}}
						className="h-9 w-full rounded-xl border border-border bg-bg-soft px-3 text-sm outline-none focus:border-faint"
					/>
					<datalist id={listId}>
						{BUNDLED_AGENTS.filter((a) => !rows.some((r) => r.agent === a)).map((a) => (
							<option key={a} value={a} />
						))}
					</datalist>
					{addError ? (
						<p className="mt-1 text-xs text-danger" role="alert">
							{addError}
						</p>
					) : null}
				</div>
				<Button type="submit" disabled={newAgent.trim() === ""} data-testid="add-agent">
					<Plus size={14} /> {t("presetAgents.add")}
				</Button>
			</form>
		</>
	);
}

/**
 * The subagent models of one preset (omp's `task.agentModelOverrides` as the preset carries it): which agent runs on which
 * model, with an optional thinking level of its own. Edits are a draft until saved; saving writes the preset's entry in omp's
 * config and nothing else. Mounted while it is open, so the draft starts from the preset as it was then.
 */
export function PresetAgentsDialog({
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
	const stored = agentRowsOf(preset.agentModelOverrides);
	const [rows, setRows] = useState(stored);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const dirty = !sameAgentRows(rows, stored);
	const incomplete = rows.some((r) => selectorProblem(r.selector) !== null);

	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			await presetActions.setAgents(preset.name, Object.fromEntries(rows.map((r) => [r.agent, r.selector])));
			toast("success", t(rows.length > 0 ? "presetAgents.saved" : "presetAgents.savedNone", { name: preset.name }));
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
			title={t("presetAgents.title", { name: preset.name })}
			description={t("presetAgents.description")}
		>
			<div data-testid="preset-agents-dialog" data-preset={preset.name}>
				<AgentFields rows={rows} models={models} fallback={preset.roles.default ?? ""} onRows={setRows} />
				{error ? (
					<p className="mt-3 text-sm text-danger" role="alert" data-testid="preset-agents-error">
						{error}
					</p>
				) : null}
				<div className="mt-4 flex items-center justify-end gap-2">
					{dirty ? (
						<span className="mr-auto text-xs text-warning" data-testid="agents-unsaved">
							{t("presetAgents.unsaved")}
						</span>
					) : null}
					<Button variant="ghost" disabled={busy} onClick={onClose}>
						{t("common.cancel")}
					</Button>
					<Button
						variant="primary"
						disabled={!dirty || busy || incomplete}
						onClick={() => void save()}
						data-testid="save-agents"
					>
						{busy ? <Spinner size={14} /> : null} {t("common.save")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}
