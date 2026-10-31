import {
	DEFAULT_THINKING_LEVELS,
	formatSelector,
	type ModelConfig,
	parseSelector,
	roleKeyProblem,
	SELECTOR_LEVELS,
	selectorProblem,
} from "@shared/model-config.ts";
import { BookmarkPlus, Cpu, Plus, Undo2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { describeSelector, modelConfig } from "../lib/model-config.ts";
import { useApp } from "../store/app.ts";
import type { ModelInfo } from "../store/live.ts";
import { ModelSelect } from "./ModelSelect.tsx";
import { Select } from "./Select.tsx";
import { Badge, Button, CardHeader, IconButton } from "./ui.tsx";

/** The roles omp knows, in the order they are listed, with their names. Others are listed after them by id. */
const ROLES: Record<string, MessageKey> = {
	default: "presets.roleDefault",
	smol: "presets.roleSmol",
	slow: "presets.roleSlow",
	plan: "presets.rolePlan",
	task: "presets.roleTask",
	commit: "presets.roleCommit",
	vision: "presets.roleVision",
	advisor: "presets.roleAdvisor",
	tiny: "presets.roleTiny",
	memory: "presets.roleMemory",
	web: "presets.roleWeb",
	image: "presets.roleImage",
	speech: "presets.roleSpeech",
	dictation: "presets.roleDictation",
	judge: "presets.roleJudge",
};
const ROLE_ORDER = Object.keys(ROLES);

/** A role as a person reads it: omp's own roles by their name, any other by its id. */
export function roleLabel(role: string, t: (key: MessageKey) => string): string {
	return Object.hasOwn(ROLES, role) ? t(ROLES[role]) : role;
}

export const LEVELS: Record<string, MessageKey> = {
	off: "panel.thinkingOff",
	minimal: "panel.thinkingMinimal",
	low: "panel.thinkingLow",
	medium: "panel.thinkingMedium",
	high: "panel.thinkingHigh",
	xhigh: "panel.thinkingXhigh",
	max: "panel.thinkingMax",
	auto: "panel.thinkingAuto",
};

export interface Row {
	role: string;
	selector: string;
}

interface Draft {
	rows: Row[];
	thinking: string;
}

function rank(role: string): number {
	const i = ROLE_ORDER.indexOf(role);
	return i < 0 ? ROLE_ORDER.length : i;
}

/** The rows of a role → selector record: omp's own roles first in their order, any other by id. */
export function rowsOfRoles(roles: Record<string, string>): Row[] {
	return Object.keys(roles)
		.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
		.map((role) => ({ role, selector: roles[role] }));
}

function draftOf(config: ModelConfig): Draft {
	return { rows: rowsOfRoles(config.roles), thinking: config.defaultThinkingLevel };
}

function sameDraft(a: Draft, b: Draft): boolean {
	return (
		a.thinking === b.thinking &&
		a.rows.length === b.rows.length &&
		a.rows.every((r, i) => r.role === b.rows[i].role && r.selector === b.rows[i].selector)
	);
}

/**
 * The editable part shared by the roles card and a preset's Edit dialog: the default thinking level, one row per role (its
 * model and the thinking level of its own) and the way to add a role. Controlled: the caller keeps the draft.
 */
export function RolesFields({
	rows,
	thinking,
	models,
	project = null,
	allowUnsetThinking = false,
	onRows,
	onThinking,
}: {
	rows: Row[];
	/** The default thinking level; "" (only with `allowUnsetThinking`) is none: the preset leaves the level as it is. */
	thinking: string;
	models: ModelInfo[] | null;
	/** The roles the project the page was last used in sets differently (see `projectOverrides`), to say so beside them. */
	project?: { name: string; roles: Record<string, string> } | null;
	allowUnsetThinking?: boolean;
	onRows: (rows: Row[]) => void;
	onThinking: (level: string) => void;
}) {
	const t = useT();
	const [newRole, setNewRole] = useState("");
	const [addError, setAddError] = useState<string | null>(null);
	const listId = useId();
	const levelLabel = (level: string) => (Object.hasOwn(LEVELS, level) ? t(LEVELS[level]) : level);
	const setRow = (i: number, selector: string) => onRows(rows.map((r, j) => (j === i ? { ...r, selector } : r)));

	const addRole = () => {
		const role = newRole.trim();
		if (roleKeyProblem(role)) return setAddError(t("presets.roleAddInvalid"));
		if (rows.some((r) => r.role === role)) return setAddError(t("presets.roleAddExists"));
		// Starts on the default role's model, so the new role is usable as it is.
		const start = rows.find((r) => r.role === "default")?.selector ?? "";
		onRows(
			[...rows, { role, selector: start }].sort((a, b) => rank(a.role) - rank(b.role) || a.role.localeCompare(b.role)),
		);
		setNewRole("");
		setAddError(null);
	};

	const thinkingChoices: string[] = [...DEFAULT_THINKING_LEVELS];
	if (thinking !== "" && !thinkingChoices.includes(thinking)) thinkingChoices.unshift(thinking);

	return (
		<>
			<label className="mb-1 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3 text-sm">
				<span>{t("presets.defaultThinking")}</span>
				<Select data-testid="default-thinking" value={thinking} onValueChange={onThinking}>
					{allowUnsetThinking ? <option value="">{t("presets.editThinkingUnset")}</option> : null}
					{thinkingChoices.map((level) => (
						<option key={level} value={level}>
							{levelLabel(level)}
						</option>
					))}
				</Select>
			</label>
			{rows.length === 0 ? <p className="py-3 text-sm text-muted">{t("presets.rolesNone")}</p> : null}
			<ul className="divide-y divide-border">
				{rows.map((row, i) => {
					const parsed = parseSelector(row.selector);
					const name = roleLabel(row.role, t);
					return (
						<li
							key={row.role}
							data-testid="role-row"
							data-role={row.role}
							className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-center sm:gap-3"
						>
							<div className="flex min-w-0 items-baseline gap-2 sm:w-36 sm:shrink-0 sm:flex-col sm:items-start sm:gap-0.5">
								<span className="truncate text-sm font-medium">{name}</span>
								{name !== row.role ? <code className="truncate text-xs text-faint">{row.role}</code> : null}
								{project && Object.hasOwn(project.roles, row.role) ? (
									<span
										data-testid="role-overridden"
										title={t("presets.roleOverriddenHint", {
											folder: project.name,
											model: describeSelector(project.roles[row.role], models),
										})}
									>
										<Badge tone="warning">{t("presets.roleOverridden")}</Badge>
									</span>
								) : null}
							</div>
							<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
								<div className="min-w-0 flex-1 basis-48">
									<ModelSelect
										testid="role-model"
										label={t("presets.roleModelAria", { role: name })}
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
									data-testid="role-thinking"
									aria-label={t("presets.roleThinkingAria", { role: name })}
									disabled={!parsed}
									value={parsed?.level ?? ""}
									onValueChange={(v) => {
										if (parsed) setRow(i, formatSelector({ ...parsed, level: SELECTOR_LEVELS.find((l) => l === v) }));
									}}
									// Wide enough for "Model default" with the field's padding and chevron: at w-36 its last letters were cut.
									className="w-44 shrink-0"
								>
									<option value="">{t("presets.thinkingNone")}</option>
									{SELECTOR_LEVELS.map((level) => (
										<option key={level} value={level}>
											{levelLabel(level)}
										</option>
									))}
								</Select>
								<IconButton
									label={t("presets.roleRemove", { role: name })}
									size="sm"
									data-testid="role-remove"
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
					addRole();
				}}
			>
				<div className="min-w-0 flex-1 basis-44">
					<input
						list={listId}
						data-testid="new-role"
						aria-label={t("presets.roleAddAria")}
						placeholder={t("presets.roleAddName")}
						value={newRole}
						autoComplete="off"
						autoCapitalize="off"
						spellCheck={false}
						onChange={(e) => {
							setNewRole(e.target.value);
							setAddError(null);
						}}
						className="h-9 w-full rounded-xl border border-border bg-bg-soft px-3 text-sm outline-none focus:border-faint"
					/>
					<datalist id={listId}>
						{ROLE_ORDER.filter((r) => !rows.some((x) => x.role === r)).map((r) => (
							<option key={r} value={r} />
						))}
					</datalist>
					{addError ? (
						<p className="mt-1 text-xs text-danger" role="alert">
							{addError}
						</p>
					) : null}
				</div>
				<Button type="submit" disabled={newRole.trim() === ""} data-testid="add-role">
					<Plus size={14} /> {t("presets.roleAdd")}
				</Button>
			</form>
		</>
	);
}

/**
 * Which model each role uses (with an optional thinking level of its own) and the default thinking level. Edits are
 * a draft until saved; saving writes omp's config, the one the terminal UI reads, so it applies to new conversations.
 */
export function ModelRolesEditor({
	config,
	models,
	project,
	onSaveAsPreset,
	onDirtyChange,
}: {
	config: ModelConfig;
	models: ModelInfo[] | null;
	/** The roles the project the page was last used in sets differently (see `projectOverrides`), to say so beside them. */
	project: { name: string; roles: Record<string, string> } | null;
	onSaveAsPreset: () => void;
	/** Told whether the editor holds edits that are not saved: what saves "the current roles" elsewhere must wait for them. */
	onDirtyChange: (dirty: boolean) => void;
}) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const [draft, setDraft] = useState(() => draftOf(config));
	const aligned = useRef(draft);
	const [busy, setBusy] = useState(false);

	// Follow the config when it changes (a preset was applied, the terminal edited it), unless there are unsaved edits.
	useEffect(() => {
		const next = draftOf(config);
		if (sameDraft(next, aligned.current)) return;
		setDraft((d) => (sameDraft(d, aligned.current) ? next : d));
		aligned.current = next;
	}, [config]);

	const dirty = !sameDraft(draft, draftOf(config));
	useEffect(() => {
		onDirtyChange(dirty);
		return () => onDirtyChange(false);
	}, [dirty, onDirtyChange]);
	const incomplete = draft.rows.some((r) => selectorProblem(r.selector) !== null);

	const save = async () => {
		setBusy(true);
		try {
			await modelConfig.setRoles(Object.fromEntries(draft.rows.map((r) => [r.role, r.selector])), draft.thinking);
			toast("success", t("presets.rolesSaved"));
		} catch (e) {
			toast("error", t("presets.rolesFailed", { error: (e as Error).message }));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="model-roles">
			<CardHeader icon={<Cpu size={16} />} title={t("presets.rolesTitle")} hint={t("presets.rolesHint")} />
			<RolesFields
				rows={draft.rows}
				thinking={draft.thinking}
				models={models}
				project={project}
				onRows={(rows) => setDraft((d) => ({ ...d, rows }))}
				onThinking={(thinking) => setDraft((d) => ({ ...d, thinking }))}
			/>
			<div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
				<Button
					variant="primary"
					disabled={!dirty || busy || incomplete}
					onClick={() => void save()}
					data-testid="save-roles"
				>
					{t("common.save")}
				</Button>
				<Button
					variant="ghost"
					disabled={!dirty || busy}
					onClick={() => setDraft(draftOf(config))}
					data-testid="discard-roles"
				>
					<Undo2 size={14} /> {t("presets.rolesDiscard")}
				</Button>
				{dirty ? (
					<span className="text-xs text-warning" data-testid="roles-unsaved">
						{t("presets.rolesUnsaved")}
					</span>
				) : null}
				<span className="flex-1" />
				<Button
					disabled={dirty || draft.rows.length === 0}
					title={dirty ? t("presets.rolesSaveFirst") : undefined}
					onClick={onSaveAsPreset}
					data-testid="roles-save-preset"
				>
					<BookmarkPlus size={14} /> {t("presets.rolesSaveAsPreset")}
				</Button>
			</div>
		</section>
	);
}
