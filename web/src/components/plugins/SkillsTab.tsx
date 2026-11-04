import {
	type InstalledSkill,
	type PluginScope,
	type SkillFile,
	type SkillSearch,
	type SkillSwitchScope,
	type SkillsData,
	skillOn,
} from "@shared/plugins.ts";
import { WEB_CATALOGS } from "@shared/plugins-catalogs.ts";
import { BookOpen, Download, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type Translate, useT } from "../../i18n/index.ts";
import { type JobRequest, pluginsApi } from "../../lib/plugins-api.ts";
import { LoadError } from "../LoadError.tsx";
import { Select } from "../Select.tsx";
import { Switch } from "../Switch.tsx";
import { Badge, Button, Modal, Spinner, WithCode } from "../ui.tsx";
import { Confirm, FIELD, FilterSelect, facets, ScopePicker, Section, WebLinks } from "./parts.tsx";

/**
 * The Skills tab of the Plugins page: every skill omp discovers in the folder (`omp skill list --json`: from plugins, the
 * agent directory, `~/.claude/skills`, omp's registry…), on and off, and omp's own skill registry, skills.omp.sh
 * (`omp skill search`, `install`, `uninstall`). A skill is switched for every folder (omp's global `disabledExtensions`)
 * or, with a project folder chosen, for that project only (its own list, which replaces the global one there). An
 * install or an uninstall is a job of the page, as a plugin's is; a skill that ships scripts is installed only after the
 * person agreed to them (the page's outcome asks).
 */
export default function SkillsTab({
	cwd,
	busy,
	projectAllowed,
	changes,
	onJob,
	onShowLibraries,
}: {
	cwd: string | null;
	busy: boolean;
	projectAllowed: boolean;
	/** Counts the page's finished changes: the list is read again after each. */
	changes: number;
	onJob: (request: JobRequest) => void;
	/** Show the skill libraries (the Discover tab's recommended marketplaces). */
	onShowLibraries: () => void;
}) {
	const [data, setData] = useState<SkillsData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const read = useCallback(() => {
		setError(null);
		pluginsApi
			.skills(cwd)
			.then(setData)
			.catch((e: Error) => setError(e.message));
	}, [cwd]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `changes` is the signal to read the list again
	useEffect(read, [read, changes]);
	const fromRegistry = useMemo(
		() => new Set(data?.installed.flatMap((s) => (s.registry ? [s.registry.id] : [])) ?? []),
		[data],
	);
	return (
		<>
			<InstalledSkills cwd={cwd} data={data} onData={setData} error={error} onRetry={read} busy={busy} onJob={onJob} />
			<RegistrySection
				cwd={cwd}
				busy={busy}
				projectAllowed={projectAllowed}
				installed={fromRegistry}
				onJob={onJob}
				onShowLibraries={onShowLibraries}
			/>
		</>
	);
}

/** Where a skill comes from, as the Skills filter names it: omp's registry, else the provider omp names. */
const providerOf = (s: InstalledSkill, t: Translate): string | null =>
	s.registry ? t("plugins.skillsFromRegistry") : s.provider || null;

function InstalledSkills({
	cwd,
	data,
	onData,
	error,
	onRetry,
	busy,
	onJob,
}: {
	cwd: string | null;
	data: SkillsData | null;
	onData: (data: SkillsData) => void;
	error: string | null;
	onRetry: () => void;
	busy: boolean;
	onJob: (request: JobRequest) => void;
}) {
	const t = useT();
	const [q, setQ] = useState("");
	const [provider, setProvider] = useState("");
	const [level, setLevel] = useState("");
	const [state, setState] = useState("");
	const [removing, setRemoving] = useState<InstalledSkill | null>(null);
	const [viewing, setViewing] = useState<InstalledSkill | null>(null);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	/** The switch being changed (`<scope>:<name>`, `bulk` or `use-global`), and why the last change failed. */
	const [pending, setPending] = useState<string | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const skills = data?.installed ?? null;
	const project = data?.project === true && cwd !== null;
	const { shown, choices } = useMemo(() => {
		const needle = q.trim().toLowerCase();
		const { kept, choices } = facets(
			skills ?? [],
			{
				provider: { value: provider, of: (s) => providerOf(s, t) },
				level: { value: level, of: (s) => s.level || null },
				state: { value: state, of: (s) => (skillOn(s) ? "on" : "off") },
			},
			(s) => !needle || [s.name, s.description ?? "", s.provider].some((x) => x.toLowerCase().includes(needle)),
		);
		return { shown: kept.sort((a, b) => a.name.localeCompare(b.name)), choices };
	}, [skills, q, provider, level, state, t]);
	// What is selected and still listed: a skill gone after a refresh is no longer selected.
	const chosen = (skills ?? []).filter((s) => selected.has(s.name)).map((s) => s.name);
	const change = (key: string, work: () => Promise<SkillsData>, after?: () => void) => {
		setPending(key);
		setFailed(null);
		work()
			.then((d) => {
				onData(d);
				after?.();
			})
			.catch((e: Error) => setFailed(e.message))
			.finally(() => setPending(null));
	};
	const toggle = (names: string[], on: boolean, scope: SkillSwitchScope, key: string, after?: () => void) =>
		change(key, () => pluginsApi.setSkillsEnabled(names, on, scope, cwd), after);
	const pick = (name: string, on: boolean) =>
		setSelected((was) => {
			const next = new Set(was);
			if (on) next.add(name);
			else next.delete(name);
			return next;
		});
	const off = skills?.filter((s) => !skillOn(s)).length ?? 0;
	const locked = busy || pending !== null;
	const bulk = (on: boolean, scope: SkillSwitchScope) =>
		toggle(chosen, on, scope, "bulk", () => setSelected(new Set()));
	return (
		<Section
			id="skills-installed"
			title={t("plugins.skillsInstalledTitle")}
			icon={<BookOpen size={16} className="text-accent" />}
			hint={skills ? <WithCode text={t("plugins.skillsInstalledHint", { count: skills.length, off })} /> : undefined}
		>
			{error ? <LoadError title={t("plugins.skillsInstalledTitle")} error={error} onRetry={onRetry} /> : null}
			{!skills && !error ? <Spinner /> : null}
			{skills && skills.length === 0 ? <p className="text-sm text-muted">{t("plugins.skillsInstalledEmpty")}</p> : null}
			{project ? (
				<div
					className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg-soft px-3 py-2 text-xs text-muted"
					data-testid="skills-project-list"
					data-own={data.projectList}
				>
					<p className="min-w-0 flex-1 basis-64">
						<WithCode text={t(data.projectList ? "plugins.skillsProjectOwn" : "plugins.skillsProjectGlobal")} />
					</p>
					{data.projectList ? (
						<Button
							size="sm"
							disabled={locked}
							onClick={() => change("use-global", () => pluginsApi.globalSkillsHere(cwd))}
							data-testid="skills-use-global"
						>
							{pending === "use-global" ? <Spinner size={12} /> : null} {t("plugins.skillsUseGlobal")}
						</Button>
					) : null}
				</div>
			) : null}
			{failed ? (
				<p role="alert" className="mb-2 text-xs text-danger" data-testid="skills-switch-error">
					{failed}
				</p>
			) : null}
			{skills && skills.length > 0 ? (
				<>
					<div className="flex flex-wrap items-center gap-2">
						<input
							type="search"
							value={q}
							onChange={(e) => setQ(e.target.value)}
							placeholder={t("plugins.skillsFilter")}
							aria-label={t("plugins.skillsFilter")}
							className={`${FIELD} min-w-40 flex-1`}
							data-testid="skills-filter"
						/>
						<FilterSelect
							label={t("plugins.filterSource")}
							all={t("plugins.filterAllSources")}
							value={provider}
							choices={choices.provider}
							onChange={setProvider}
							testId="skills-filter-provider"
						/>
						<FilterSelect
							label={t("plugins.filterLevel")}
							all={t("plugins.filterAnyLevel")}
							value={level}
							choices={choices.level}
							onChange={setLevel}
							testId="skills-filter-level"
						/>
						<FilterSelect
							label={t("plugins.filterState")}
							all={t("plugins.filterAnyState")}
							value={state}
							choices={choices.state}
							labelOf={(v) => t(v === "on" ? "plugins.filterOn" : "plugins.filterOff")}
							onChange={setState}
							testId="skills-filter-state"
						/>
					</div>
					<div className="mt-1.5 flex min-h-8 flex-wrap items-center gap-2 text-xs text-faint">
						<label className="flex items-center gap-1.5">
							<input
								type="checkbox"
								checked={shown.length > 0 && shown.every((s) => selected.has(s.name))}
								onChange={(e) =>
									setSelected(e.target.checked ? new Set([...selected, ...shown.map((s) => s.name)]) : new Set())
								}
								data-testid="skills-select-all"
							/>
							{t("plugins.filterShown", { shown: shown.length, total: skills.length })}
						</label>
						{chosen.length > 0 ? (
							<span className="flex flex-wrap items-center gap-1.5" data-testid="skills-bulk">
								<span className="text-muted">{t("plugins.skillsSelected", { count: chosen.length })}</span>
								<Button size="sm" disabled={locked} onClick={() => bulk(false, "global")} data-testid="skills-bulk-off">
									{t("plugins.skillsBulkOffEverywhere")}
								</Button>
								<Button size="sm" disabled={locked} onClick={() => bulk(true, "global")} data-testid="skills-bulk-on">
									{t("plugins.skillsBulkOnEverywhere")}
								</Button>
								{project ? (
									<>
										<Button
											size="sm"
											disabled={locked}
											onClick={() => bulk(false, "project")}
											data-testid="skills-bulk-off-project"
										>
											{t("plugins.skillsBulkOffProject")}
										</Button>
										<Button
											size="sm"
											disabled={locked}
											onClick={() => bulk(true, "project")}
											data-testid="skills-bulk-on-project"
										>
											{t("plugins.skillsBulkOnProject")}
										</Button>
									</>
								) : null}
								{pending === "bulk" ? <Spinner size={12} /> : null}
							</span>
						) : null}
					</div>
					{shown.length === 0 ? <p className="mt-3 text-sm text-muted">{t("plugins.discoverNone")}</p> : null}
					<ul className="mt-1 max-h-[32rem] divide-y divide-border overflow-y-auto">
						{shown.map((s) => (
							<li
								key={`${s.name}\u0000${s.path ?? s.provider}`}
								className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5"
								data-testid="skill-row"
								data-skill={s.name}
								data-enabled={skillOn(s)}
							>
								<input
									type="checkbox"
									className="mt-1"
									checked={selected.has(s.name)}
									onChange={(e) => pick(s.name, e.target.checked)}
									aria-label={t("plugins.skillsSelect", { name: s.name })}
									data-testid="skill-select"
								/>
								<div className={`min-w-0 flex-1 basis-56 ${skillOn(s) ? "" : "opacity-70"}`}>
									<div className="flex flex-wrap items-center gap-1.5">
										<span className="break-all font-mono text-sm font-medium">{s.name}</span>
										{providerOf(s, t) ? <Badge>{providerOf(s, t)}</Badge> : null}
										{s.level ? <Badge>{s.level}</Badge> : null}
										{s.registry ? <Badge>{s.registry.version}</Badge> : null}
										{s.hidden ? <Badge tone="warning">{t("plugins.skillsHidden")}</Badge> : null}
										{s.nameOnly ? <Badge tone="warning">{t("plugins.skillsNameOnly")}</Badge> : null}
									</div>
									{s.description ? <p className="mt-1 line-clamp-2 text-xs text-muted">{s.description}</p> : null}
									{s.path ? (
										<button
											type="button"
											className="mt-0.5 max-w-full truncate text-left font-mono text-xs text-faint underline decoration-dotted hover:text-muted"
											title={t("plugins.skillsView")}
											onClick={() => setViewing(s)}
											data-testid="skill-view"
										>
											{s.path}
										</button>
									) : null}
								</div>
								<div className="flex shrink-0 items-center gap-3">
									{s.registry ? (
										<Button size="sm" disabled={busy} onClick={() => setRemoving(s)} data-testid="skill-uninstall">
											<Trash2 size={13} /> {t("plugins.uninstall")}
										</Button>
									) : null}
									<SkillSwitch
										label={t("plugins.skillsEverywhere")}
										aria={t("plugins.skillsEverywhereLabel", { name: s.name })}
										checked={!s.offGlobally}
										busy={pending === `global:${s.name}`}
										disabled={locked}
										onChange={(on) => toggle([s.name], on, "global", `global:${s.name}`)}
										testId="skill-switch-global"
									/>
									{project ? (
										<SkillSwitch
											label={t("plugins.skillsThisProject")}
											aria={t("plugins.skillsThisProjectLabel", { name: s.name })}
											checked={skillOn(s)}
											busy={pending === `project:${s.name}`}
											disabled={locked}
											onChange={(on) => toggle([s.name], on, "project", `project:${s.name}`)}
											testId="skill-switch-project"
										/>
									) : null}
								</div>
							</li>
						))}
					</ul>
				</>
			) : null}
			<Confirm
				open={removing !== null}
				onOpenChange={(o) => !o && setRemoving(null)}
				title={t("plugins.uninstallTitle", { name: removing?.registry?.id ?? "" })}
				body={t("plugins.skillsUninstallBody")}
				action={t("plugins.uninstall")}
				danger
				testId="skill-uninstall-confirm"
				onConfirm={() =>
					removing?.registry &&
					onJob({
						action: "skill-uninstall",
						id: removing.registry.id,
						scope: removing.level === "project" ? "project" : "user",
					})
				}
			/>
			<SkillFileDialog skill={viewing} cwd={cwd} onClose={() => setViewing(null)} />
		</Section>
	);
}

/** A skill's `SKILL.md`, read only, as the server reads it from where omp found the skill. */
function SkillFileDialog({
	skill,
	cwd,
	onClose,
}: {
	skill: InstalledSkill | null;
	cwd: string | null;
	onClose: () => void;
}) {
	const t = useT();
	const [file, setFile] = useState<SkillFile | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		setFile(null);
		setError(null);
		if (!skill) return;
		let live = true;
		pluginsApi
			.skillFile(skill.name, cwd)
			.then((f) => live && setFile(f))
			.catch((e: Error) => live && setError(e.message));
		return () => {
			live = false;
		};
	}, [skill, cwd]);
	return (
		<Modal
			open={skill !== null}
			onOpenChange={(o) => !o && onClose()}
			title={skill?.name ?? ""}
			description={file?.path ?? skill?.path ?? undefined}
			wide
		>
			{error ? (
				<p role="alert" className="text-sm text-danger">
					{error}
				</p>
			) : null}
			{!file && !error ? <Spinner /> : null}
			{file ? (
				<pre
					className="max-h-[56vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg-soft p-3 font-mono text-xs"
					data-testid="skill-file"
				>
					{file.text}
					{file.cut ? `\n… ${t("plugins.skillsFileCut")}` : ""}
				</pre>
			) : null}
		</Modal>
	);
}

/** One of a skill's switches, with the words that say where it applies beside it. */
function SkillSwitch({
	label,
	aria,
	checked,
	busy,
	disabled,
	onChange,
	testId,
}: {
	label: string;
	aria: string;
	checked: boolean;
	busy: boolean;
	disabled: boolean;
	onChange: (on: boolean) => void;
	testId: string;
}) {
	return (
		<span className="flex items-center gap-1.5">
			<span aria-hidden className="text-xs text-faint">
				{label}
			</span>
			<Switch
				checked={checked}
				onCheckedChange={onChange}
				label={aria}
				busy={busy}
				disabled={disabled}
				data-testid={testId}
			/>
		</span>
	);
}

function RegistrySection({
	cwd,
	busy,
	projectAllowed,
	installed,
	onJob,
	onShowLibraries,
}: {
	cwd: string | null;
	busy: boolean;
	projectAllowed: boolean;
	installed: ReadonlySet<string>;
	onJob: (request: JobRequest) => void;
	onShowLibraries: () => void;
}) {
	const t = useT();
	const [q, setQ] = useState("");
	const [found, setFound] = useState<(SkillSearch & { query: string }) | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [searching, setSearching] = useState(false);
	const [scope, setScope] = useState<PluginScope>("user");
	const [order, setOrder] = useState<"relevance" | "downloads" | "name">("relevance");
	const [hideDeprecated, setHideDeprecated] = useState(false);
	const hits = useMemo(() => {
		const kept = (found?.hits ?? []).filter((h) => !hideDeprecated || !h.deprecated);
		if (order === "downloads") return [...kept].sort((a, b) => (b.weeklyDownloads ?? -1) - (a.weeklyDownloads ?? -1));
		if (order === "name") return [...kept].sort((a, b) => a.id.localeCompare(b.id));
		return kept;
	}, [found, order, hideDeprecated]);
	const search = (query: string) => {
		setSearching(true);
		setError(null);
		pluginsApi
			.searchSkills(query, cwd)
			.then((r) => setFound({ ...r, query }))
			.catch((e: Error) => setError(e.message))
			.finally(() => setSearching(false));
	};
	return (
		<Section
			id="skills-registry"
			title={t("plugins.skillsRegistryTitle")}
			icon={<Search size={16} className="text-accent" />}
			hint={<WithCode text={t("plugins.skillsRegistryHint")} />}
		>
			<form
				className="flex flex-wrap gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (q.trim()) search(q.trim());
				}}
			>
				<input
					type="search"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					aria-label={t("plugins.skillsSearchLabel")}
					placeholder={t("plugins.skillsSearchPlaceholder")}
					className={`${FIELD} flex-1 basis-60`}
					data-testid="skills-search"
				/>
				<ScopePicker
					value={scope}
					onChange={setScope}
					projectAllowed={projectAllowed}
					label={t("plugins.scope")}
					testId="skills-scope"
				/>
				<Button type="submit" disabled={searching || !q.trim()} data-testid="skills-search-run">
					{searching ? <Spinner size={13} /> : <Search size={13} />} {t("plugins.search")}
				</Button>
			</form>
			{error ? (
				<p role="alert" className="mt-2 whitespace-pre-wrap text-sm text-danger" data-testid="skills-search-error">
					{error}
				</p>
			) : null}
			{found && found.hits.length === 0 ? (
				<div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted" data-testid="skills-search-empty">
					<span className="min-w-0 flex-1">{t("plugins.skillsSearchNone", { query: found.query })}</span>
					<Button size="sm" onClick={onShowLibraries} data-testid="skills-show-libraries">
						{t("plugins.skillsShowLibraries")}
					</Button>
				</div>
			) : null}
			{found && found.hits.length > 0 ? (
				<div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
					<Select
						tone="compact"
						aria-label={t("plugins.skillsSort")}
						title={t("plugins.skillsSort")}
						value={order}
						onValueChange={(v) => setOrder(v === "downloads" || v === "name" ? v : "relevance")}
						className="w-40 shrink-0"
						data-testid="skills-hits-sort"
					>
						<option value="relevance">{t("plugins.skillsSortRelevance")}</option>
						<option value="downloads">{t("plugins.skillsSortDownloads")}</option>
						<option value="name">{t("plugins.skillsSortName")}</option>
					</Select>
					{found.hits.some((h) => h.deprecated) ? (
						<label className="flex items-center gap-1.5">
							<input
								type="checkbox"
								checked={hideDeprecated}
								onChange={(e) => setHideDeprecated(e.target.checked)}
								data-testid="skills-hide-deprecated"
							/>
							{t("plugins.skillsHideDeprecated")}
						</label>
					) : null}
				</div>
			) : null}
			{found && found.hits.length > 0 ? (
				<ul className="mt-2 divide-y divide-border" data-testid="skills-hits">
					{hits.map((h) => (
						<li
							key={h.id}
							className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5"
							data-testid="skill-hit"
							data-skill={h.id}
						>
							<div className="min-w-0 flex-1 basis-56">
								<div className="flex flex-wrap items-center gap-1.5">
									<span className="break-all font-mono text-sm font-medium">{h.id}</span>
									{h.version ? <Badge>{h.version}</Badge> : null}
									{installed.has(h.id) ? <Badge tone="success">{t("plugins.skillsInstalled")}</Badge> : null}
									{h.deprecated ? <Badge tone="warning">{t("plugins.skillsDeprecated")}</Badge> : null}
								</div>
								{h.description ? <p className="mt-1 text-xs text-muted">{h.description}</p> : null}
								<p className="mt-0.5 text-xs text-faint">
									{[
										h.publisher ? t("plugins.skillsBy", { name: h.publisher }) : null,
										h.weeklyDownloads !== null ? t("plugins.skillsWeekly", { count: h.weeklyDownloads }) : null,
									]
										.filter(Boolean)
										.join(" · ")}
								</p>
							</div>
							<Button
								size="sm"
								variant="primary"
								disabled={busy || installed.has(h.id)}
								onClick={() => onJob({ action: "skill-install", spec: h.id, scope })}
								data-testid="skill-install"
							>
								<Download size={13} /> {t("plugins.install")}
							</Button>
						</li>
					))}
				</ul>
			) : null}
			<div className="mt-3">
				<WebLinks label={t("plugins.webSkills")} catalogs={WEB_CATALOGS.skills} testId="skills-web-catalogs" />
			</div>
		</Section>
	);
}
