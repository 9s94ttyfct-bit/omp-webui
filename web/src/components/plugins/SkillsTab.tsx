import type { InstalledSkill, PluginScope, SkillSearch } from "@shared/plugins.ts";
import { WEB_CATALOGS } from "@shared/plugins-catalogs.ts";
import { BookOpen, Download, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { type JobRequest, pluginsApi } from "../../lib/plugins-api.ts";
import { LoadError } from "../LoadError.tsx";
import { Badge, Button, Spinner, WithCode } from "../ui.tsx";
import { Confirm, FIELD, ScopePicker, Section, WebLinks } from "./parts.tsx";

/**
 * The Skills tab of the Plugins page: every skill omp discovers in the folder (`omp skill list --json`: from plugins, the
 * agent directory, `~/.claude/skills`, omp's registry…), and omp's own skill registry, skills.omp.sh (`omp skill search`,
 * `install`, `uninstall`). An install or an uninstall is a job of the page, as a plugin's is; a skill that ships scripts is
 * installed only after the person agreed to them (the page's outcome asks).
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
	const [skills, setSkills] = useState<InstalledSkill[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const read = useCallback(() => {
		setError(null);
		pluginsApi
			.skills(cwd)
			.then(setSkills)
			.catch((e: Error) => setError(e.message));
	}, [cwd]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `changes` is the signal to read the list again
	useEffect(read, [read, changes]);
	const fromRegistry = useMemo(
		() => new Set(skills?.flatMap((s) => (s.registry ? [s.registry.id] : [])) ?? []),
		[skills],
	);
	return (
		<>
			<InstalledSkills skills={skills} error={error} onRetry={read} busy={busy} onJob={onJob} />
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

function InstalledSkills({
	skills,
	error,
	onRetry,
	busy,
	onJob,
}: {
	skills: InstalledSkill[] | null;
	error: string | null;
	onRetry: () => void;
	busy: boolean;
	onJob: (request: JobRequest) => void;
}) {
	const t = useT();
	const [q, setQ] = useState("");
	const [removing, setRemoving] = useState<InstalledSkill | null>(null);
	const shown = useMemo(() => {
		const needle = q.trim().toLowerCase();
		const sorted = [...(skills ?? [])].sort((a, b) => a.name.localeCompare(b.name));
		if (!needle) return sorted;
		return sorted.filter((s) =>
			[s.name, s.description ?? "", s.provider].some((x) => x.toLowerCase().includes(needle)),
		);
	}, [skills, q]);
	return (
		<Section
			id="skills-installed"
			title={t("plugins.skillsInstalledTitle")}
			icon={<BookOpen size={16} className="text-accent" />}
			hint={skills ? <WithCode text={t("plugins.skillsInstalledHint", { count: skills.length })} /> : undefined}
		>
			{error ? <LoadError title={t("plugins.skillsInstalledTitle")} error={error} onRetry={onRetry} /> : null}
			{!skills && !error ? <Spinner /> : null}
			{skills && skills.length === 0 ? <p className="text-sm text-muted">{t("plugins.skillsInstalledEmpty")}</p> : null}
			{skills && skills.length > 0 ? (
				<>
					<input
						type="search"
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder={t("plugins.skillsFilter")}
						aria-label={t("plugins.skillsFilter")}
						className={`${FIELD} w-full`}
						data-testid="skills-filter"
					/>
					{shown.length === 0 ? <p className="mt-3 text-sm text-muted">{t("plugins.discoverNone")}</p> : null}
					<ul className="mt-1 max-h-[32rem] divide-y divide-border overflow-y-auto">
						{shown.map((s) => (
							<li
								key={`${s.name}\u0000${s.path ?? s.provider}`}
								className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5"
								data-testid="skill-row"
								data-skill={s.name}
							>
								<div className="min-w-0 flex-1 basis-56">
									<div className="flex flex-wrap items-center gap-1.5">
										<span className="break-all font-mono text-sm font-medium">{s.name}</span>
										<Badge>{s.registry ? t("plugins.skillsFromRegistry") : s.provider}</Badge>
										{s.level ? <Badge>{s.level}</Badge> : null}
										{s.registry ? <Badge>{s.registry.version}</Badge> : null}
										{s.hidden ? <Badge tone="warning">{t("plugins.skillsHidden")}</Badge> : null}
									</div>
									{s.description ? <p className="mt-1 line-clamp-2 text-xs text-muted">{s.description}</p> : null}
								</div>
								{s.registry ? (
									<Button size="sm" disabled={busy} onClick={() => setRemoving(s)} data-testid="skill-uninstall">
										<Trash2 size={13} /> {t("plugins.uninstall")}
									</Button>
								) : null}
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
		</Section>
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
				<ul className="mt-2 divide-y divide-border" data-testid="skills-hits">
					{found.hits.map((h) => (
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
