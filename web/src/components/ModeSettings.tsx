import {
	BACKEND_NAMES,
	BACKENDS,
	type BackendModels,
	type BaseUrlSource,
	type ContextReport,
	classifyUrl,
	DEFAULT_BASE_URLS,
	isThinkingLevel,
	type ModeState,
	OFFLINE_TOOLS,
	THINKING_LEVELS,
} from "@shared/offline.ts";
import { Boxes, Feather, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { codedText, errorText } from "../lib/error-text.ts";
import { loadMode, modeApi, saveOffline, setLightModels, setMode, useMode } from "../lib/offline.ts";
import { contextRows, formatTokens, parseList, savingPercent } from "../lib/offline-format.ts";
import { Select } from "./Select.tsx";
import { Button, CardHeader, cx, Spinner, WithCode } from "./ui.tsx";

/** omp's names for what fills a fresh context window, as this page words them; any other name is shown as omp has it. */
const ROW_LABELS: Record<string, MessageKey> = {
	"System prompt": "mode.ctxRowSystemPrompt",
	"System tools": "mode.ctxRowSystemTools",
	"System context": "mode.ctxRowSystemContext",
	Skills: "mode.ctxRowSkills",
};

/** Where a backend's address comes from, as this page says it. */
const SOURCE_HINTS = {
	default: "mode.baseUrlDefault",
	"models.yml": "mode.baseUrlModels",
	settings: "mode.baseUrlSettings",
} as const satisfies Record<BaseUrlSource, MessageKey>;

const field = "w-full rounded-xl border border-border bg-bg-soft px-3 py-2 text-sm outline-none focus:border-faint";

/** Settings › Full / Light: the mode of new conversations, what Light's models are, what Light loads, and what it saves. */
export function ModeSettings() {
	const t = useT();
	const state = useMode((s) => s.state);
	// The MCP servers and the backends' addresses are read from omp's files: look again whenever the page opens.
	useEffect(() => {
		void loadMode();
	}, []);
	if (!state) {
		return (
			<section className="rounded-2xl border border-border bg-surface p-4" data-testid="mode-settings">
				<Spinner />
			</section>
		);
	}
	const local = state.lightModels === "local";
	// Only oMLX can lack an address: its provider is the user's own, in models.yml. A models.yml that cannot be read
	// leaves every backend without one, and says why. Light on the person's own models needs no local server.
	const selected = state.backends[state.offline.backend];
	const usable = !local || selected.baseUrl !== null;
	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="mode-settings">
			<CardHeader title={t("mode.settingsTitle")} hint={t("mode.settingsIntro")} />
			<fieldset className="flex gap-2">
				<legend className="sr-only">{t("mode.defaultLegend")}</legend>
				{(
					[
						["full", Boxes, "mode.full", "mode.fullDesc"],
						["light", Feather, "mode.light", "mode.lightDesc"],
					] as const
				).map(([m, Icon, label, desc]) => (
					<label
						key={m}
						className={cx(
							"flex flex-1 cursor-pointer flex-col gap-0.5 rounded-xl border px-3 py-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
							state.mode === m ? "border-accent bg-accent-soft" : "border-border hover:bg-hover",
						)}
					>
						<input
							type="radio"
							name="mode"
							value={m}
							className="sr-only"
							data-testid={`mode-setting-${m}`}
							checked={state.mode === m}
							onChange={() => void setMode(m)}
						/>
						<span className="flex items-center gap-2 font-medium">
							<Icon size={16} aria-hidden /> {t(label)}
						</span>
						<span className="text-xs text-muted">{t(desc)}</span>
					</label>
				))}
			</fieldset>
			<fieldset className="mt-4">
				<legend className="text-xs font-medium">{t("mode.modelsLegend")}</legend>
				<div className="mt-1.5 flex gap-2">
					{(
						[
							["yours", "mode.modelsYours", "mode.modelsYoursDesc"],
							["local", "mode.modelsLocal", "mode.modelsLocalDesc"],
						] as const
					).map(([m, label, desc]) => (
						<label
							key={m}
							className={cx(
								"flex flex-1 cursor-pointer flex-col gap-0.5 rounded-xl border px-3 py-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
								state.lightModels === m ? "border-accent bg-accent-soft" : "border-border hover:bg-hover",
							)}
						>
							<input
								type="radio"
								name="light-models"
								value={m}
								className="sr-only"
								data-testid={`models-setting-${m}`}
								checked={state.lightModels === m}
								onChange={() => void setLightModels(m)}
							/>
							<span className="font-medium">{t(label)}</span>
							<span className="text-xs text-muted">{t(desc)}</span>
						</label>
					))}
				</div>
			</fieldset>
			{usable ? null : (
				<p className="mt-3 text-xs text-warning" data-testid="backend-missing">
					{selected.error ? (
						codedText(selected.error.code, selected.error.params, selected.error.message)
					) : (
						<WithCode text={t("mode.omlxMissing")} />
					)}
				</p>
			)}
			{local ? <LocalServerOptions state={state} /> : null}
			<LightOptions state={state} />
			{/* Without a backend there is no Light process on a local server to measure, and nothing to compare Full with. */}
			{usable ? <ContextSaving settingsKey={JSON.stringify([state.lightModels, state.offline])} /> : null}
		</section>
	);
}

/** Add `name` to `list`, or take it out. */
function toggled(list: string[], name: string, on: boolean): string[] {
	return on ? [...list.filter((n) => n !== name), name] : list.filter((n) => n !== name);
}

/** The local server Light's models are, and where it listens. */
function BackendChoice({ state }: { state: ModeState }) {
	const t = useT();
	const { backend } = state.offline;
	const info = state.backends[backend];
	const name = BACKEND_NAMES[backend];
	const shownUrl = info.baseUrl ?? "";
	// Where prompts and file contents go: the one thing about the address worth a warning before anything is sent.
	const offNetwork = info.baseUrl !== null && classifyUrl(info.baseUrl) === "public";
	const [url, setUrl] = useState(shownUrl);
	// The backend whose address is being typed, from the first keystroke until the field is left: a state that arrives
	// meanwhile (another tab's change, a re-read) must not replace the text. Left, it is saved as ever.
	const [editing, setEditing] = useState<string | null>(null);
	// The field takes the address the state names in the same draw that shows it, not in an effect after it: an effect
	// resets the text a moment later, under a hand that already selected it, and what was typed then is lost (#337).
	const [shown, setShown] = useState({ backend, shownUrl });
	if (shown.backend !== backend || shown.shownUrl !== shownUrl) {
		setShown({ backend, shownUrl });
		if (editing !== backend) {
			setEditing(null);
			setUrl(shownUrl);
		}
	}
	const commit = async () => {
		const typed = url.trim();
		setEditing(null);
		if (typed !== shownUrl) await saveOffline({ baseUrls: { [backend]: typed || null } });
		// What the server made of it (or what it still has, when it refused the address).
		setUrl(useMode.getState().state?.backends[backend].baseUrl ?? "");
	};
	return (
		<div className="space-y-3">
			<fieldset>
				<legend className="text-xs font-medium">{t("mode.backendLabel")}</legend>
				<p className="mb-1.5 text-xs text-muted">{t("mode.backendHint")}</p>
				<div className="flex gap-2">
					{BACKENDS.map((b) => (
						<label
							key={b}
							className={cx(
								"flex flex-1 cursor-pointer items-center justify-center rounded-xl border px-3 py-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
								backend === b ? "border-accent bg-accent-soft font-medium" : "border-border hover:bg-hover",
							)}
						>
							<input
								type="radio"
								name="offline-backend"
								value={b}
								className="sr-only"
								data-testid={`offline-backend-${b}`}
								checked={backend === b}
								onChange={() => void saveOffline({ backend: b })}
							/>
							{BACKEND_NAMES[b]}
						</label>
					))}
				</div>
			</fieldset>
			<label className="block">
				<span className="mb-1 block text-xs font-medium">{t("mode.baseUrlLabel", { backend: name })}</span>
				<input
					className={cx(field, "font-mono text-xs")}
					data-testid="offline-base-url"
					value={url}
					onChange={(e) => {
						setEditing(backend);
						setUrl(e.target.value);
					}}
					onBlur={() => void commit()}
					onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
					placeholder={DEFAULT_BASE_URLS[backend] ?? "http://127.0.0.1:8000/v1"}
					inputMode="url"
					spellCheck={false}
				/>
				{info.source ? (
					<span className="mt-1 block text-xs text-muted" data-testid="offline-base-url-source">
						{t(SOURCE_HINTS[info.source], { backend: name })}
					</span>
				) : null}
			</label>
			{offNetwork && info.baseUrl ? (
				<p className="text-xs text-warning" role="alert" data-testid="offline-base-url-public">
					{t("mode.baseUrlPublic", { host: new URL(info.baseUrl).host })}
				</p>
			) : null}
		</div>
	);
}

/** Light's local server: which one, its address, the model and the thinking level. */
function LocalServerOptions({ state }: { state: ModeState }) {
	const t = useT();
	const { offline } = state;
	const { backend } = offline;
	const name = BACKEND_NAMES[backend];
	const baseUrl = state.backends[backend].baseUrl;
	const [models, setModels] = useState<BackendModels | null>(null);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const [checking, setChecking] = useState(false);
	/** Which check the page is waiting for: the answer of an older one (another backend, another address) is not shown. */
	const latest = useRef(0);
	const check = useCallback(() => {
		const mine = ++latest.current;
		setChecking(true);
		setModelsError(null);
		setModels(null);
		modeApi
			.models(backend)
			.then((answer) => {
				if (mine === latest.current) setModels(answer);
			})
			.catch((e: Error) => {
				if (mine === latest.current) setModelsError(errorText(e));
			})
			.finally(() => {
				if (mine === latest.current) setChecking(false);
			});
	}, [backend]);
	useEffect(() => {
		if (baseUrl) check();
		else {
			latest.current++;
			setChecking(false);
			setModels(null);
			setModelsError(null);
		}
		return () => {
			latest.current++;
		};
	}, [baseUrl, check]);

	const served = models?.models ?? [];
	const chosenId = offline.model?.slice(backend.length + 1) ?? null;
	return (
		<div className="mt-4 space-y-4 rounded-xl border border-border p-3" data-testid="local-server-options">
			<h3 className="text-sm font-semibold">{t("mode.localTitle")}</h3>

			<BackendChoice state={state} />

			<div>
				<label className="block">
					<span className="mb-1 block text-xs font-medium">{t("mode.modelLabel", { backend: name })}</span>
					<Select
						data-testid="offline-model"
						value={offline.model ?? ""}
						onValueChange={(model) => void saveOffline({ model: model || null })}
					>
						<option value="">{t("mode.modelAuto", { backend: name })}</option>
						{served.map((id) => (
							<option key={id} value={`${backend}/${id}`}>
								{id}
							</option>
						))}
						{chosenId !== null && !served.includes(chosenId) ? (
							<option value={offline.model ?? ""}>
								{models ? t("mode.modelMissing", { id: chosenId, backend: name }) : chosenId}
							</option>
						) : null}
					</Select>
				</label>
				<div className="mt-1 flex items-center gap-2 text-xs" aria-live="polite">
					{checking ? (
						<span className="inline-flex items-center gap-1.5 text-muted">
							<Spinner size={12} /> {t("mode.modelsLoading", { backend: name })}
						</span>
					) : modelsError ? (
						<span className="text-danger" role="alert" data-testid="backend-error">
							{modelsError}
						</span>
					) : models ? (
						<span className="text-muted" data-testid="backend-models">
							{t("mode.modelsServed", { backend: name, url: models.baseUrl, n: models.models.length })}
						</span>
					) : null}
					{baseUrl && !checking ? (
						<button type="button" className="shrink-0 whitespace-nowrap text-accent hover:underline" onClick={check}>
							{t("mode.modelsRetry")}
						</button>
					) : null}
				</div>
			</div>

			<label className="block">
				<span className="mb-1 block text-xs font-medium">{t("mode.thinkingLabel")}</span>
				<Select
					data-testid="offline-thinking"
					value={offline.thinking}
					onValueChange={(level) => {
						if (isThinkingLevel(level)) void saveOffline({ thinking: level });
					}}
				>
					{THINKING_LEVELS.map((level) => (
						<option key={level} value={level}>
							{level}
						</option>
					))}
				</Select>
			</label>
		</div>
	);
}

/** What Light loads: the MCP servers, the tools and the skills, and whether the person's own AGENTS.md. */
function LightOptions({ state }: { state: ModeState }) {
	const t = useT();
	const { offline } = state;
	const savedSkills = offline.skills.join(", ");
	const [skills, setSkills] = useState(savedSkills);
	useEffect(() => setSkills(savedSkills), [savedSkills]);
	return (
		<div className="mt-4 space-y-4 rounded-xl border border-border p-3" data-testid="offline-options">
			<h3 className="text-sm font-semibold">{t("mode.lightTitle")}</h3>

			<fieldset>
				<legend className="text-xs font-medium">{t("mode.mcpLabel")}</legend>
				<p className="mb-1.5 text-xs text-muted">{t("mode.mcpHint")}</p>
				{state.mcpServers.length ? (
					<div className="flex flex-wrap gap-x-4 gap-y-1.5">
						{state.mcpServers.map((name) => (
							<label key={name} className="inline-flex cursor-pointer items-center gap-1.5 text-sm">
								<input
									type="checkbox"
									className="accent-[var(--accent)]"
									data-testid={`offline-mcp-${name}`}
									checked={offline.mcp.includes(name)}
									onChange={(e) => void saveOffline({ mcp: toggled(offline.mcp, name, e.target.checked) })}
								/>
								{name}
								{state.mcpOff.includes(name) ? (
									<span
										className="text-xs text-warning"
										title={t("mode.mcpOffTip")}
										data-testid={`offline-mcp-off-${name}`}
									>
										{t("mode.mcpOff")}
									</span>
								) : null}
							</label>
						))}
					</div>
				) : (
					<p className="text-sm text-muted">{t("mode.mcpNone")}</p>
				)}
				{state.missingMcp.length ? (
					<p
						className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-warning"
						data-testid="offline-mcp-missing"
					>
						{t("mode.mcpMissing", { names: state.missingMcp.join(", ") })}
						<button
							type="button"
							className="text-accent hover:underline"
							data-testid="offline-mcp-forget"
							onClick={() => void saveOffline({ mcp: offline.mcp.filter((n) => !state.missingMcp.includes(n)) })}
						>
							{t("mode.mcpMissingForget")}
						</button>
					</p>
				) : null}
			</fieldset>

			<fieldset>
				<legend className="text-xs font-medium">{t("mode.toolsLabel")}</legend>
				<p className="mb-1.5 text-xs text-muted">{t("mode.toolsHint")}</p>
				<div className="flex flex-wrap gap-x-4 gap-y-1.5">
					{OFFLINE_TOOLS.map((name) => {
						const on = offline.tools.includes(name);
						return (
							<label key={name} className="inline-flex cursor-pointer items-center gap-1.5 text-sm">
								<input
									type="checkbox"
									className="accent-[var(--accent)]"
									data-testid={`offline-tool-${name}`}
									checked={on}
									// omp needs at least one tool; the last one stays.
									disabled={on && offline.tools.length === 1}
									onChange={(e) =>
										void saveOffline({
											tools: OFFLINE_TOOLS.filter((n) => (n === name ? e.target.checked : offline.tools.includes(n))),
										})
									}
								/>
								<code className="font-mono text-xs">{name}</code>
							</label>
						);
					})}
				</div>
			</fieldset>

			<label className="block">
				<span className="mb-1 block text-xs font-medium">{t("mode.skillsLabel")}</span>
				<input
					className={cx(field, "font-mono text-xs")}
					data-testid="offline-skills"
					value={skills}
					onChange={(e) => setSkills(e.target.value)}
					onBlur={() => {
						const list = parseList(skills);
						if (list.join(", ") !== savedSkills) void saveOffline({ skills: list });
					}}
					onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
					spellCheck={false}
				/>
				<span className="mt-1 block text-xs text-muted">
					<WithCode text={t("mode.skillsHint")} />
				</span>
			</label>

			<label className="flex cursor-pointer items-start gap-3 text-sm">
				<input
					type="checkbox"
					className="mt-1 accent-[var(--accent)]"
					data-testid="offline-agents-md"
					checked={offline.agentsMd}
					onChange={(e) => void saveOffline({ agentsMd: e.target.checked })}
				/>
				<span>
					{t("mode.agentsMdLabel")}
					<span className="block text-xs text-muted">{t("mode.agentsMdHint")}</span>
				</span>
			</label>
		</div>
	);
}

/** What Light saves: a fresh process of each mode, measured by omp's `/context`; measured again when the settings change. */
function ContextSaving({ settingsKey }: { settingsKey: string }) {
	const t = useT();
	const [report, setReport] = useState<ContextReport | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	/** Which request the page is waiting for: an answer to an older one (settings changed meanwhile) is not shown. */
	const latest = useRef(0);
	const run = useCallback(async (force: boolean) => {
		const mine = ++latest.current;
		setBusy(true);
		try {
			const next = await modeApi.context(force);
			if (mine !== latest.current) return;
			setReport(next);
			setFailure(null);
		} catch (e) {
			if (mine === latest.current) setFailure(errorText(e));
		} finally {
			if (mine === latest.current) setBusy(false);
		}
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `settingsKey` is the trigger: measure again when it changes.
	useEffect(() => {
		// A few clicks on checkboxes are one measurement, not one each.
		const timer = setTimeout(() => void run(false), 700);
		return () => {
			clearTimeout(timer);
			latest.current++;
		};
	}, [settingsKey, run]);

	const full = report?.full.ok ? report.full.breakdown : null;
	const light = report?.light.ok ? report.light.breakdown : null;
	const percent = full && light ? savingPercent(full.startTokens, light.startTokens) : null;
	const rows = contextRows(full, light);
	const cell = (n: number | null) => (n === null ? "–" : formatTokens(n));
	const failed = (["full", "light"] as const).flatMap((side) => {
		const r = report?.[side];
		return r && !r.ok
			? [
					t("mode.ctxFailed", {
						side: t(`mode.${side}`),
						error: r.errorInfo ? codedText(r.errorInfo.code, r.errorInfo.params, r.error) : r.error,
					}),
				]
			: [];
	});
	return (
		<div className="mt-4 border-t border-border pt-4" data-testid="context-saving">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<h3 className="text-sm font-semibold">{t("mode.ctxTitle")}</h3>
				{busy ? (
					<span className="inline-flex items-center gap-1.5 text-xs text-muted" data-testid="context-measuring">
						<Spinner size={12} /> {t("mode.ctxMeasuring")}
					</span>
				) : null}
				<span className="flex-1 basis-0" />
				<Button
					size="sm"
					variant="ghost"
					disabled={busy}
					data-testid="context-remeasure"
					onClick={() => void run(true)}
				>
					<RefreshCw size={13} aria-hidden /> {t("mode.ctxMeasureAgain")}
				</Button>
			</div>
			<p className="mt-1 text-xs text-muted">{t("mode.ctxHint")}</p>
			{full && light ? (
				<p className="mt-2 text-sm" data-testid="context-summary">
					{t(percent === null ? "mode.ctxNoSaving" : "mode.ctxSaving", {
						full: formatTokens(full.startTokens),
						light: formatTokens(light.startTokens),
						percent: percent ?? 0,
					})}
				</p>
			) : null}
			{rows.length ? (
				<table className="mt-2 w-full text-sm tabular-nums" data-testid="context-table">
					<thead>
						<tr className="text-left text-xs text-muted">
							<th className="py-1 font-normal" scope="col">
								<span className="sr-only">{t("mode.ctxRowHeader")}</span>
							</th>
							<th className="py-1 text-right font-normal" scope="col">
								{t("mode.full")}
							</th>
							<th className="py-1 text-right font-normal" scope="col">
								{t("mode.light")}
							</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr key={row.label} className="border-t border-border/60">
								<th className="py-1 text-left font-normal" scope="row">
									{ROW_LABELS[row.label] ? t(ROW_LABELS[row.label]) : row.label}
								</th>
								<td className="py-1 text-right">{cell(row.full)}</td>
								<td className="py-1 text-right">{cell(row.light)}</td>
							</tr>
						))}
						<tr className="border-t border-border font-medium">
							<th className="py-1 text-left font-medium" scope="row">
								{t("mode.ctxRowTotal")}
							</th>
							<td className="py-1 text-right" data-testid="context-total-full">
								{cell(full?.startTokens ?? null)}
							</td>
							<td className="py-1 text-right" data-testid="context-total-light">
								{cell(light?.startTokens ?? null)}
							</td>
						</tr>
					</tbody>
				</table>
			) : null}
			{full?.incomplete || light?.incomplete ? (
				<p className="mt-2 text-xs text-warning">{t("mode.ctxIncomplete")}</p>
			) : null}
			{[...failed, ...(failure ? [failure] : [])].map((message) => (
				<p key={message} className="mt-2 text-xs text-danger" role="alert" data-testid="context-error">
					{message}
				</p>
			))}
		</div>
	);
}
