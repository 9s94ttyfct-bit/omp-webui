import type { McpAdded } from "@shared/mcp-registry.ts";
import {
	type CatalogPlugin,
	type InstalledPlugin,
	isPluginsFailure,
	type PluginCheck,
	type PluginJob,
	type PluginReload,
	type PluginScope,
	type PluginSetting,
	type PluginsData,
} from "@shared/plugins.ts";
import {
	addedMarketplace,
	RECOMMENDED_MARKETPLACES,
	type RecommendedKind,
	type RecommendedName,
	WEB_CATALOGS,
} from "@shared/plugins-catalogs.ts";
import {
	ArrowUpCircle,
	CircleAlert,
	CircleCheck,
	Download,
	Plus,
	Puzzle,
	RefreshCw,
	Sparkles,
	Stethoscope,
	Store,
	Trash2,
	TriangleAlert,
	Wrench,
} from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	lazy,
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { type MessageKey, registerStrings, type Translate, useT } from "../i18n/index.ts";
import { en } from "../i18n/plugins.ts";
import { type JobRequest, pluginsApi } from "../lib/plugins-api.ts";
import { useApp } from "../store/app.ts";
import { LoadError } from "./LoadError.tsx";
import { Confirm, SCOPE_KEY, ScopePicker, Section, WebLinks } from "./plugins/parts.tsx";
import { Select } from "./Select.tsx";
import { Switch } from "./Switch.tsx";
import { Badge, Button, cx, Empty, Modal, Spinner, WithCode } from "./ui.tsx";

// This chunk carries its own English strings: the first page does not (see `registerStrings`).
registerStrings("plugins", en);

// The Skills and MCP tabs have requests and dialogs of their own: they load when their tab is first opened.
const SkillsTab = lazy(() => import("./plugins/SkillsTab.tsx"));
const McpTab = lazy(() => import("./plugins/McpTab.tsx"));

/**
 * The Plugins page (`#/plugins`): omp's plugins, skills and MCP servers, read and changed with omp's own `omp plugin` and
 * `omp skill` commands on the computer omp-webui runs on (`/api/plugins*`), in tabs:
 * - Installed: installed plugins with their switch, upgrade, uninstall, features and settings; omp's health check.
 * - Discover: well-known marketplaces to add with one click, the added marketplaces' catalogs, installing by package, git
 *   URL or folder.
 * - Skills: every skill omp discovers, and omp's skill registry (`omp skill search|install|uninstall`).
 * - MCP: the official MCP Registry, searched by the server, and a server of it added to omp's MCP configuration.
 * - Marketplaces: the marketplaces themselves.
 *
 * A change that takes long (an install, an upgrade, a marketplace fetched with git) runs as a job on the server: the page
 * shows what omp prints as it goes, then lists the plugins again and says which open conversations reloaded their plugins
 * and which need a restart. One change at a time: the controls wait while one runs.
 *
 * The tabs are written out here, as the Guard page's are, not taken from Radix (see `GuardPage.tsx`).
 */

const JOB_POLL_MS = 400;
/** How many recent project folders the folder picker offers. */
const RECENT_FOLDERS = 15;

/** What the last change did: a job (with what omp printed), or a quick change that answered at once. */
type Outcome = { job: PluginJob } | { error: string } | { reloads: PluginReload[] } | { mcp: McpAdded };

type Tab = "installed" | "discover" | "skills" | "mcp" | "marketplaces";
const TABS: readonly { value: Tab; label: MessageKey }[] = [
	{ value: "installed", label: "plugins.tabInstalled" },
	{ value: "discover", label: "plugins.tabDiscover" },
	{ value: "skills", label: "plugins.tabSkills" },
	{ value: "mcp", label: "plugins.tabMcp" },
	{ value: "marketplaces", label: "plugins.tabMarketplaces" },
];

export function PluginsPage() {
	const t = useT();
	const { sessions, home } = useApp(useShallow((s) => ({ sessions: s.sessions, home: s.meta?.home ?? null })));
	/** The folder omp's CLI runs in; null: the home folder. */
	const [cwd, setCwd] = useState<string | null>(null);
	const [data, setData] = useState<PluginsData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	/** A quick change in flight (a switch, features, a setting): what it is about, for its spinner. */
	const [pending, setPending] = useState<string | null>(null);
	/** Counts the changes that ended: the tabs that read lists of their own (Skills) read them again. */
	const [changes, setChanges] = useState(0);
	const [tab, setTab] = useState<Tab>("installed");
	/** The last job asked for: a skill install omp refused for its scripts is asked again from it, with `yes`. */
	const asked = useRef<JobRequest | null>(null);
	const loads = useRef(0);
	const ids = useId();
	const triggers = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

	const load = useCallback(() => {
		const mine = ++loads.current;
		setLoading(true);
		setError(null);
		setChanges((n) => n + 1);
		pluginsApi
			.list(cwd)
			.then((d) => mine === loads.current && setData(d))
			.catch((e: Error) => mine === loads.current && setError(e.message))
			.finally(() => mine === loads.current && setLoading(false));
	}, [cwd]);
	useEffect(load, [load]);

	const job = outcome && "job" in outcome ? outcome.job : null;
	const running = job?.state === "running";
	const busy = running || pending !== null;

	// A job that runs is followed until it ends; then the list is read again.
	const jobId = running ? job.id : null;
	useEffect(() => {
		if (!jobId) return;
		let gone = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = () => {
			pluginsApi
				.job(jobId)
				.then((next) => {
					if (gone) return;
					setOutcome({ job: next });
					if (next.state === "running") timer = setTimeout(poll, JOB_POLL_MS);
					else load();
				})
				.catch(() => {
					if (!gone) timer = setTimeout(poll, JOB_POLL_MS * 4);
				});
		};
		timer = setTimeout(poll, JOB_POLL_MS);
		return () => {
			gone = true;
			clearTimeout(timer);
		};
	}, [jobId, load]);
	// A page opened while a change runs (in another tab) follows it.
	useEffect(() => {
		pluginsApi
			.running()
			.then((r) => r && setOutcome((o) => o ?? { job: r }))
			.catch(() => {});
	}, []);

	const start = useCallback(
		(request: JobRequest) => {
			asked.current = request;
			pluginsApi
				.startJob(request, cwd)
				.then((started) => setOutcome({ job: started }))
				.catch((e: Error) => setOutcome({ error: e.message }));
		},
		[cwd],
	);
	/** A change that answers at once; the list is read again after it, failed or not. */
	const quick = useCallback(
		(key: string, work: () => Promise<{ reloads: PluginReload[] }>) => {
			setPending(key);
			return work()
				.then((r) => {
					setOutcome({ reloads: r.reloads });
					return true;
				})
				.catch((e: Error) => {
					setOutcome({ error: e.message });
					return false;
				})
				.finally(() => {
					setPending(null);
					load();
				});
		},
		[load],
	);
	// A skill install omp refused because the skill ships scripts: asked again with `--yes`, once the person agreed.
	const retry = asked.current;
	const confirmScripts =
		job?.confirm === "scripts" && retry?.action === "skill-install" ? () => start({ ...retry, yes: true }) : undefined;

	// The folders the person works in, newest first: a project's own plugins are listed and installed there.
	const folders = useMemo(() => {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const s of [...sessions].sort((a, b) => b.modifiedAt - a.modifiedAt)) {
			if (!s.cwd || s.cwd === home || seen.has(s.cwd)) continue;
			seen.add(s.cwd);
			out.push(s.cwd);
			if (out.length >= RECENT_FOLDERS) break;
		}
		if (cwd && !seen.has(cwd)) out.unshift(cwd);
		return out;
	}, [sessions, home, cwd]);

	const installed = data && !isPluginsFailure(data.installed) ? data.installed : null;
	const projectAllowed = data ? !data.home : cwd !== null;

	// Left and Right move between the tabs, Home and End go to the first and last: the keys of a tab list.
	const onTabKey = (e: KeyboardEvent, at: number) => {
		const last = TABS.length - 1;
		const keys: Record<string, number> = {
			ArrowRight: at === last ? 0 : at + 1,
			ArrowLeft: at === 0 ? last : at - 1,
			Home: 0,
			End: last,
		};
		const to = keys[e.key];
		if (to === undefined) return;
		e.preventDefault();
		setTab(TABS[to].value);
		triggers.current[TABS[to].value]?.focus();
	};

	const needsList = tab === "installed" || tab === "discover" || tab === "marketplaces";
	return (
		<div className="h-full min-w-0 flex-1 overflow-y-auto" data-testid="plugins-page">
			<div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pt-4 pb-6 sm:px-6 sm:py-8">
				<div className="flex flex-wrap items-center gap-3">
					<h1 className="flex min-w-0 flex-1 items-center gap-2 text-xl font-semibold">
						<Puzzle className="shrink-0 text-accent" /> {t("plugins.title")}
					</h1>
					<Button onClick={load} disabled={loading} data-testid="plugins-refresh">
						<RefreshCw size={14} className={cx(loading && "animate-spin")} /> {t("plugins.refresh")}
					</Button>
				</div>
				<p className="-mt-3 text-sm text-muted">
					<WithCode text={t("plugins.intro")} />
				</p>
				<label className="flex flex-col gap-1 text-sm">
					<span className="font-medium">{t("plugins.folder")}</span>
					<Select
						data-testid="plugins-folder"
						aria-label={t("plugins.folder")}
						value={cwd ?? ""}
						onValueChange={(v) => {
							setCwd(v === "" ? null : v);
							setData(null);
						}}
					>
						<option value="">{t("plugins.folderHome")}</option>
						{folders.map((f) => (
							<option key={f} value={f}>
								{home && f.startsWith(`${home}/`) ? `~/${f.slice(home.length + 1)}` : f}
							</option>
						))}
					</Select>
					<span className="text-xs text-muted">{t("plugins.folderHint")}</span>
				</label>

				{outcome ? (
					<OutcomePanel outcome={outcome} onDismiss={() => setOutcome(null)} onConfirmScripts={confirmScripts} />
				) : null}

				<div>
					<div
						role="tablist"
						aria-label={t("plugins.sections")}
						className="flex gap-1 overflow-x-auto border-b border-border"
						data-testid="plugins-tabs"
					>
						{TABS.map((x, at) => (
							<button
								key={x.value}
								type="button"
								role="tab"
								id={`${ids}-tab-${x.value}`}
								ref={(el) => {
									triggers.current[x.value] = el;
								}}
								aria-selected={tab === x.value}
								aria-controls={`${ids}-panel-${x.value}`}
								tabIndex={tab === x.value ? 0 : -1}
								data-testid={`plugins-tab-${x.value}`}
								className={cx(
									"-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent",
									tab === x.value ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
								)}
								onClick={() => setTab(x.value)}
								onKeyDown={(e) => onTabKey(e, at)}
							>
								{t(x.label)}
							</button>
						))}
					</div>
				</div>

				<div
					role="tabpanel"
					id={`${ids}-panel-${tab}`}
					aria-labelledby={`${ids}-tab-${tab}`}
					className="-mt-2 flex flex-col gap-6"
					data-testid={`plugins-panel-${tab}`}
				>
					{needsList && error ? <LoadError title={t("plugins.loadError")} error={error} onRetry={load} /> : null}
					{needsList && !data && !error ? (
						<div className="flex justify-center py-12">
							<Spinner />
						</div>
					) : null}

					{data && tab === "installed" ? (
						<>
							<InstalledSection
								data={data}
								busy={busy}
								pending={pending}
								cwd={cwd}
								onToggle={(p, on) =>
									void quick(`enable:${p.id}:${p.scope}`, () =>
										pluginsApi.setEnabled(p.id, p.source === "marketplace" ? p.scope : null, on, cwd),
									)
								}
								onUpgrade={(p) =>
									start({
										action: "upgrade",
										id: p.id,
										scope: p.source === "marketplace" ? p.scope : null,
									})
								}
								onUpgradeAll={() => start({ action: "upgrade" })}
								onUninstall={(p) =>
									start({ action: "uninstall", id: p.id, scope: p.source === "marketplace" ? p.scope : null })
								}
								quick={quick}
							/>
							<DoctorSection
								cwd={cwd}
								busy={busy}
								onFix={() => start({ action: "doctor-fix" })}
								installed={installed}
							/>
						</>
					) : null}
					{data && tab === "discover" ? (
						<>
							<RecommendedSection
								data={data}
								busy={busy}
								onAdd={(source) => start({ action: "marketplace-add", source })}
							/>
							<DiscoverSection
								data={data}
								busy={busy}
								projectAllowed={projectAllowed}
								onInstall={(p, scope) => start({ action: "install", spec: `${p.name}@${p.marketplace}`, scope })}
							/>
							<ManualSection
								busy={busy}
								projectAllowed={projectAllowed}
								onInstall={(spec, scope) => start({ action: "install", spec, scope })}
							/>
						</>
					) : null}
					{data && tab === "marketplaces" ? (
						<MarketplacesSection
							data={data}
							busy={busy}
							onAdd={(source) => start({ action: "marketplace-add", source })}
							onUpdate={(name) => start({ action: "marketplace-update", name })}
							onRemove={(name) => start({ action: "marketplace-remove", name })}
						/>
					) : null}
					<Suspense
						fallback={
							<div className="flex justify-center py-12">
								<Spinner />
							</div>
						}
					>
						{tab === "skills" ? (
							<SkillsTab
								cwd={cwd}
								busy={busy}
								projectAllowed={projectAllowed}
								changes={changes}
								onJob={start}
								onShowLibraries={() => setTab("discover")}
							/>
						) : null}
						{tab === "mcp" ? <McpTab cwd={cwd} busy={busy} onAdded={(added) => setOutcome({ mcp: added })} /> : null}
					</Suspense>
				</div>
			</div>
		</div>
	);
}

// ------------------------------------------------------------------ recommended marketplaces

/** What each recommended marketplace offers, in the page's words (`shared/plugins-catalogs.ts` has the list). */
const RECOMMENDED_TEXT: Record<RecommendedName, MessageKey> = {
	"claude-plugins-official": "plugins.rec_claudePluginsOfficial",
	"claude-community": "plugins.rec_claudeCommunity",
	"knowledge-work-plugins": "plugins.rec_knowledgeWork",
	"claude-code-workflows": "plugins.rec_codeWorkflows",
	"superpowers-marketplace": "plugins.rec_superpowers",
	"compound-engineering-plugin": "plugins.rec_compoundEngineering",
	"claude-code-plugins-plus": "plugins.rec_pluginsPlus",
	"chrome-devtools-plugins": "plugins.rec_chromeDevtools",
	"anthropic-agent-skills": "plugins.rec_anthropicSkills",
	trailofbits: "plugins.rec_trailOfBits",
	"addy-web-quality-skills": "plugins.rec_webQuality",
};

const KIND_TITLE: Record<RecommendedKind, MessageKey> = {
	plugins: "plugins.recPluginsTitle",
	skills: "plugins.recSkillsTitle",
};

function RecommendedSection({
	data,
	busy,
	onAdd,
}: {
	data: PluginsData;
	busy: boolean;
	onAdd: (source: string) => void;
}) {
	const t = useT();
	const configured = isPluginsFailure(data.marketplaces) ? null : data.marketplaces;
	return (
		<Section
			id="recommended"
			title={t("plugins.recTitle")}
			icon={<Sparkles size={16} className="text-accent" />}
			hint={<WithCode text={t("plugins.recHint")} />}
		>
			{(["plugins", "skills"] as const).map((kind) => (
				<div key={kind} className="mt-2 first:mt-0">
					<h3 className="text-xs font-semibold uppercase tracking-wide text-faint">{t(KIND_TITLE[kind])}</h3>
					<ul className="divide-y divide-border">
						{RECOMMENDED_MARKETPLACES.filter((m) => m.kind === kind).map((m) => {
							const added = configured ? addedMarketplace(m, configured) : null;
							return (
								<li
									key={m.name}
									className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5"
									data-testid="recommended-marketplace"
									data-marketplace={m.name}
									data-added={added !== null}
								>
									<div className="min-w-0 flex-1 basis-56">
										<div className="flex flex-wrap items-center gap-1.5">
											<a
												href={`https://github.com/${m.repo}`}
												target="_blank"
												rel="noopener noreferrer"
												className="break-all font-mono text-sm font-medium hover:underline"
											>
												{m.repo}
											</a>
											{m.official ? <Badge tone="accent">{t("plugins.recOfficial")}</Badge> : null}
											{m.anthropic ? <Badge>{t("plugins.recAnthropic")}</Badge> : null}
										</div>
										<p className="mt-1 text-xs text-muted">{t(RECOMMENDED_TEXT[m.name])}</p>
									</div>
									{added ? (
										<Badge tone="success">{t("plugins.recAdded", { name: added.name })}</Badge>
									) : (
										<Button
											size="sm"
											variant="primary"
											disabled={busy || configured === null}
											onClick={() => onAdd(m.repo)}
											data-testid="recommended-add"
										>
											<Plus size={13} /> {t("plugins.recAdd")}
										</Button>
									)}
								</li>
							);
						})}
					</ul>
				</div>
			))}
			<div className="mt-3">
				<WebLinks label={t("plugins.webPlugins")} catalogs={WEB_CATALOGS.plugins} testId="plugins-web-catalogs" />
			</div>
		</Section>
	);
}

// ------------------------------------------------------------------ what a change did

/** The names of the conversations a change reached: their titles, else a new conversation's name. */
function useConversationNames(): (reloads: PluginReload[]) => string {
	const t = useT();
	const sessions = useApp((s) => s.sessions);
	return (reloads) =>
		reloads
			.map(
				(r) =>
					(r.sessionFile ? sessions.find((s) => s.file === r.sessionFile)?.title : null) ?? t("plugins.conversation"),
			)
			.join(", ");
}

function ReloadSummary({ reloads }: { reloads: PluginReload[] }) {
	const t = useT();
	const names = useConversationNames();
	const by = (state: PluginReload["state"]) => reloads.filter((r) => r.state === state);
	const lines: [MessageKey, PluginReload[]][] = [
		["plugins.reloaded", by("reloaded")],
		["plugins.restart", by("restart")],
		["plugins.paused", by("paused")],
	];
	return (
		<ul className="space-y-0.5 text-xs text-muted" data-testid="plugins-reloads">
			{lines
				.filter(([, list]) => list.length > 0)
				.map(([key, list]) => (
					<li key={key} data-reload={key.slice("plugins.".length)}>
						{t(key, { names: names(list) })}
					</li>
				))}
		</ul>
	);
}

function OutcomePanel({
	outcome,
	onDismiss,
	onConfirmScripts,
}: {
	outcome: Outcome;
	onDismiss: () => void;
	/** A skill omp did not install because it ships scripts: install it with them, once the person agrees. */
	onConfirmScripts?: () => void;
}) {
	const t = useT();
	const [scripts, setScripts] = useState(false);
	const job = "job" in outcome ? outcome.job : null;
	const mcp = "mcp" in outcome ? outcome.mcp : null;
	const failed = "error" in outcome || job?.state === "failed";
	const error = "error" in outcome ? outcome.error : (job?.error ?? null);
	const reloads = "reloads" in outcome ? outcome.reloads : (job?.reloads ?? []);
	const output = useRef<HTMLPreElement>(null);
	// The newest of what omp printed stays in view.
	const printed = job?.output;
	useEffect(() => {
		if (printed !== undefined && output.current) output.current.scrollTop = output.current.scrollHeight;
	}, [printed]);
	return (
		<section
			className={cx("rounded-2xl border p-4", failed ? "border-danger/40 bg-danger/5" : "border-border bg-surface")}
			data-testid="plugins-outcome"
			data-state={job ? job.state : failed ? "failed" : "done"}
		>
			<div className="flex flex-wrap items-center gap-2" role="status" aria-live="polite">
				{job?.state === "running" ? (
					<Spinner />
				) : failed ? (
					<CircleAlert size={16} className="text-danger" />
				) : (
					<CircleCheck size={16} className="text-success" />
				)}
				<span className="min-w-0 flex-1 text-sm font-medium">
					{job?.state === "running" ? t("plugins.jobRunning") : failed ? t("plugins.jobFailed") : t("plugins.jobDone")}
				</span>
				{job?.state === "running" ? null : (
					<Button size="sm" variant="ghost" onClick={onDismiss} data-testid="plugins-outcome-dismiss">
						{t("plugins.jobDismiss")}
					</Button>
				)}
			</div>
			{job ? <code className="mt-2 block break-all font-mono text-xs text-muted">{job.command}</code> : null}
			{error ? (
				<p className="mt-2 whitespace-pre-wrap break-words text-sm text-danger" data-testid="plugins-outcome-error">
					{error}
				</p>
			) : null}
			{job?.output ? (
				<details className="mt-2" open={job.state === "running"}>
					<summary className="cursor-pointer text-xs text-muted">{t("plugins.jobOutput")}</summary>
					<pre
						ref={output}
						className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code p-2 font-mono text-xs"
						data-testid="plugins-outcome-output"
					>
						{job.output}
					</pre>
				</details>
			) : null}
			{mcp ? (
				<p className="mt-2 text-sm text-muted" data-testid="plugins-outcome-mcp">
					{t("plugins.mcpAddedOutcome", { name: mcp.name, file: mcp.file })}
				</p>
			) : null}
			{onConfirmScripts ? (
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<p className="min-w-0 flex-1 text-xs text-warning">{t("plugins.skillScriptsHint")}</p>
					<Button size="sm" onClick={() => setScripts(true)} data-testid="skill-scripts-review">
						<TriangleAlert size={13} /> {t("plugins.skillScriptsReview")}
					</Button>
					<Confirm
						open={scripts}
						onOpenChange={setScripts}
						title={t("plugins.skillScriptsTitle")}
						body={
							<>
								<p>{t("plugins.skillScriptsBody")}</p>
								<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code p-2 font-mono text-xs">
									{error}
								</pre>
							</>
						}
						action={t("plugins.skillScriptsInstall")}
						danger
						testId="skill-scripts-confirm"
						onConfirm={onConfirmScripts}
					/>
				</div>
			) : null}
			{!failed && reloads.length > 0 ? (
				<div className="mt-2">
					<ReloadSummary reloads={reloads} />
				</div>
			) : null}
		</section>
	);
}

function sourceLabel(p: InstalledPlugin, t: Translate): string {
	if (p.source === "marketplace") return p.marketplace ?? "";
	return p.source === "linked" ? t("plugins.sourceLinked") : t("plugins.sourceNpm");
}

function InstalledSection({
	data,
	busy,
	pending,
	cwd,
	onToggle,
	onUpgrade,
	onUpgradeAll,
	onUninstall,
	quick,
}: {
	data: PluginsData;
	busy: boolean;
	pending: string | null;
	cwd: string | null;
	onToggle: (p: InstalledPlugin, on: boolean) => void;
	onUpgrade: (p: InstalledPlugin) => void;
	onUpgradeAll: () => void;
	onUninstall: (p: InstalledPlugin) => void;
	quick: (key: string, work: () => Promise<{ reloads: PluginReload[] }>) => Promise<boolean>;
}) {
	const t = useT();
	const [removing, setRemoving] = useState<InstalledPlugin | null>(null);
	const [upgradingAll, setUpgradingAll] = useState(false);
	const [features, setFeatures] = useState<InstalledPlugin | null>(null);
	const [settings, setSettings] = useState<InstalledPlugin | null>(null);
	const list = isPluginsFailure(data.installed) ? null : data.installed;
	const upgradable = list?.filter((p) => p.upgrade) ?? [];
	return (
		<Section
			id="installed"
			title={t("plugins.installedTitle")}
			icon={<Puzzle size={16} className="text-accent" />}
			action={
				upgradable.length > 0 ? (
					<Button size="sm" disabled={busy} onClick={() => setUpgradingAll(true)} data-testid="plugins-upgrade-all">
						<ArrowUpCircle size={13} /> {t("plugins.upgradeAll", { count: upgradable.length })}
					</Button>
				) : undefined
			}
		>
			{isPluginsFailure(data.installed) ? (
				<p role="alert" className="text-sm text-danger">
					{data.installed.error}
				</p>
			) : null}
			{data.upgradeError ? (
				<p className="mb-2 text-xs text-warning">{t("plugins.upgradeCheckFailed", { error: data.upgradeError })}</p>
			) : null}
			{list && list.length === 0 ? (
				<Empty icon={<Puzzle size={24} className="text-faint" />} title={t("plugins.installedEmpty")}>
					{t("plugins.installedEmptyHint")}
				</Empty>
			) : null}
			{list && list.length > 0 ? (
				<ul className="flex flex-col gap-2">
					{list.map((p) => (
						<li
							key={`${p.id}\u0000${p.scope}`}
							className="rounded-xl border border-border p-3"
							data-testid="plugin-card"
							data-plugin={p.id}
							data-scope={p.scope}
							data-enabled={p.enabled}
						>
							<div className="flex items-start gap-3">
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-1.5">
										<span className="break-all font-mono text-sm font-medium">{p.name}</span>
										{p.version ? <Badge>{p.version}</Badge> : null}
										<Badge>{t(SCOPE_KEY[p.scope])}</Badge>
										<Badge>{sourceLabel(p, t)}</Badge>
										{p.upgrade ? <Badge tone="accent">{t("plugins.newer", { version: p.upgrade.to })}</Badge> : null}
									</div>
									{p.description ? <p className="mt-1 text-xs text-muted">{p.description}</p> : null}
									{p.shadowedBy ? <p className="mt-1 text-xs text-warning">{t("plugins.shadowed")}</p> : null}
								</div>
								<Switch
									checked={p.enabled}
									onCheckedChange={(on) => onToggle(p, on)}
									label={t("plugins.enabledLabel", { name: p.name })}
									busy={pending === `enable:${p.id}:${p.scope}`}
									disabled={busy}
									data-testid="plugin-switch"
								/>
							</div>
							<div className="mt-2 flex flex-wrap gap-2">
								{p.source !== "linked" ? (
									<Button
										size="sm"
										disabled={busy}
										onClick={() => onUpgrade(p)}
										data-testid="plugin-upgrade"
										variant={p.upgrade ? "primary" : "outline"}
									>
										<ArrowUpCircle size={13} />{" "}
										{p.upgrade ? t("plugins.upgradeTo", { version: p.upgrade.to }) : t("plugins.upgrade")}
									</Button>
								) : null}
								{p.features.length > 0 ? (
									<Button size="sm" disabled={busy} onClick={() => setFeatures(p)} data-testid="plugin-features">
										{t("plugins.features")}
									</Button>
								) : null}
								{p.hasSettings ? (
									<Button size="sm" disabled={busy} onClick={() => setSettings(p)} data-testid="plugin-settings">
										{t("plugins.settings")}
									</Button>
								) : null}
								<Button size="sm" disabled={busy} onClick={() => setRemoving(p)} data-testid="plugin-uninstall">
									<Trash2 size={13} /> {t("plugins.uninstall")}
								</Button>
							</div>
						</li>
					))}
				</ul>
			) : null}
			<Confirm
				open={removing !== null}
				onOpenChange={(o) => !o && setRemoving(null)}
				title={t("plugins.uninstallTitle", { name: removing?.name ?? "" })}
				body={t("plugins.uninstallBody", { scope: removing ? t(SCOPE_KEY[removing.scope]) : "" })}
				action={t("plugins.uninstall")}
				danger
				testId="plugin-uninstall-confirm"
				onConfirm={() => removing && onUninstall(removing)}
			/>
			<Confirm
				open={upgradingAll}
				onOpenChange={setUpgradingAll}
				title={t("plugins.upgradeAllTitle")}
				body={
					<>
						<p>{t("plugins.upgradeAllBody")}</p>
						<ul className="mt-2 space-y-0.5 font-mono text-xs">
							{upgradable.map((p) => (
								<li key={`${p.id}\u0000${p.scope}`}>
									{p.id} ({t(SCOPE_KEY[p.scope])}): {p.upgrade?.from ?? "?"} → {p.upgrade?.to}
								</li>
							))}
						</ul>
					</>
				}
				action={t("plugins.upgrade")}
				testId="plugins-upgrade-all-confirm"
				onConfirm={onUpgradeAll}
			/>
			{features ? (
				<FeaturesDialog plugin={features} cwd={cwd} onClose={() => setFeatures(null)} quick={quick} busy={busy} />
			) : null}
			{settings ? <SettingsDialog plugin={settings} cwd={cwd} onClose={() => setSettings(null)} quick={quick} /> : null}
		</Section>
	);
}

function FeaturesDialog({
	plugin,
	cwd,
	onClose,
	quick,
	busy,
}: {
	plugin: InstalledPlugin;
	cwd: string | null;
	onClose: () => void;
	quick: (key: string, work: () => Promise<{ reloads: PluginReload[] }>) => Promise<boolean>;
	busy: boolean;
}) {
	const t = useT();
	const [on, setOn] = useState(() => new Set(plugin.features.filter((f) => f.enabled).map((f) => f.name)));
	return (
		<Modal
			open
			onOpenChange={(o) => !o && onClose()}
			title={t("plugins.featuresTitle", { name: plugin.name })}
			description={t("plugins.featuresHint")}
		>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void quick(`features:${plugin.id}`, () => pluginsApi.setFeatures(plugin.name, [...on], cwd)).then(
						(ok) => ok && onClose(),
					);
				}}
			>
				<fieldset className="flex flex-col gap-2">
					<legend className="sr-only">{t("plugins.featuresTitle", { name: plugin.name })}</legend>
					{plugin.features.map((f) => (
						<label key={f.name} className="flex cursor-pointer items-start gap-3 text-sm">
							<input
								type="checkbox"
								className="mt-1 accent-[var(--accent)]"
								checked={on.has(f.name)}
								data-testid="plugin-feature"
								data-feature={f.name}
								onChange={(e) =>
									setOn((s) => {
										const next = new Set(s);
										if (e.target.checked) next.add(f.name);
										else next.delete(f.name);
										return next;
									})
								}
							/>
							<span>
								<span className="font-mono">{f.name}</span>
								{f.default ? <span className="ml-2 text-xs text-faint">{t("plugins.featureDefault")}</span> : null}
								{f.description ? <span className="block text-xs text-muted">{f.description}</span> : null}
							</span>
						</label>
					))}
				</fieldset>
				<div className="mt-4 flex justify-end gap-2">
					<Button onClick={onClose}>{t("common.cancel")}</Button>
					<Button type="submit" variant="primary" disabled={busy} data-testid="plugin-features-save">
						{t("plugins.save")}
					</Button>
				</div>
			</form>
		</Modal>
	);
}

function SettingsDialog({
	plugin,
	cwd,
	onClose,
	quick,
}: {
	plugin: InstalledPlugin;
	cwd: string | null;
	onClose: () => void;
	quick: (key: string, work: () => Promise<{ reloads: PluginReload[] }>) => Promise<boolean>;
}) {
	const t = useT();
	const [settings, setSettings] = useState<PluginSetting[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const read = useCallback(() => {
		setError(null);
		pluginsApi
			.config(plugin.name, cwd)
			.then((r) => setSettings(r.settings))
			.catch((e: Error) => setError(e.message));
	}, [plugin.name, cwd]);
	useEffect(read, [read]);
	const save = (key: string, value: string | null) =>
		quick(`config:${plugin.id}:${key}`, async () => {
			const r = await pluginsApi.setConfig(plugin.name, key, value, cwd);
			setSettings(r.settings);
			return r;
		});
	return (
		<Modal open onOpenChange={(o) => !o && onClose()} title={t("plugins.settingsTitle", { name: plugin.name })} wide>
			{error ? (
				<LoadError title={t("plugins.settingsTitle", { name: plugin.name })} error={error} onRetry={read} />
			) : null}
			{!settings && !error ? <Spinner /> : null}
			{settings && settings.length === 0 ? <p className="text-sm text-muted">{t("plugins.settingsNone")}</p> : null}
			{settings && settings.length > 0 ? (
				<ul className="flex flex-col gap-3">
					{settings.map((s) => (
						<SettingRow key={s.key} setting={s} onSave={save} />
					))}
				</ul>
			) : null}
		</Modal>
	);
}

function SettingRow({
	setting,
	onSave,
}: {
	setting: PluginSetting;
	onSave: (key: string, value: string | null) => Promise<boolean>;
}) {
	const t = useT();
	const [value, setValue] = useState(setting.secret ? "" : (setting.value ?? ""));
	const shown = setting.secret
		? setting.set
			? t("plugins.settingsSecretSet")
			: t("plugins.settingsNotSet")
		: setting.set
			? null
			: setting.value === null
				? t("plugins.settingsNotSet")
				: t("plugins.settingsDefault");
	const submit = (e: FormEvent) => {
		e.preventDefault();
		void onSave(setting.key, value).then((ok) => ok && setting.secret && setValue(""));
	};
	return (
		<li className="rounded-xl border border-border p-3" data-testid="plugin-setting" data-key={setting.key}>
			<form onSubmit={submit} className="flex flex-col gap-1.5">
				<div className="flex flex-wrap items-baseline gap-2">
					<label htmlFor={`plugin-setting-${setting.key}`} className="font-mono text-sm font-medium">
						{setting.key}
					</label>
					{setting.type ? <Badge>{setting.type}</Badge> : null}
					{shown ? <span className="text-xs text-faint">{shown}</span> : null}
				</div>
				{setting.description ? <p className="text-xs text-muted">{setting.description}</p> : null}
				{setting.env ? <p className="text-xs text-faint">{t("plugins.settingsEnv", { env: setting.env })}</p> : null}
				<div className="flex flex-wrap gap-2">
					<input
						id={`plugin-setting-${setting.key}`}
						type={setting.secret ? "password" : "text"}
						autoComplete="off"
						aria-label={t("plugins.settingsValue", { key: setting.key })}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						className="min-w-0 flex-1 basis-48 rounded-lg border border-border bg-bg-soft px-2.5 py-1.5 text-sm outline-none focus:border-faint"
						data-testid="plugin-setting-input"
					/>
					<Button size="sm" type="submit" variant="primary" data-testid="plugin-setting-save">
						{t("plugins.save")}
					</Button>
					{setting.set ? (
						<Button size="sm" onClick={() => void onSave(setting.key, null)} data-testid="plugin-setting-reset">
							{t("plugins.settingsReset")}
						</Button>
					) : null}
				</div>
			</form>
		</li>
	);
}

// ------------------------------------------------------------------ discover and install

function CatalogRow({
	plugin,
	busy,
	projectAllowed,
	onInstall,
}: {
	plugin: CatalogPlugin;
	busy: boolean;
	projectAllowed: boolean;
	onInstall: (p: CatalogPlugin, scope: PluginScope) => void;
}) {
	const t = useT();
	const [scope, setScope] = useState<PluginScope>("user");
	const here = plugin.installed.includes(scope);
	return (
		<li
			className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5"
			data-testid="catalog-plugin"
			data-plugin={`${plugin.name}@${plugin.marketplace}`}
		>
			<div className="min-w-0 flex-1 basis-56">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="break-all font-mono text-sm font-medium">{plugin.name}</span>
					{plugin.version ? <Badge>{plugin.version}</Badge> : null}
					<Badge>{plugin.marketplace}</Badge>
					{plugin.installed.length > 0 ? (
						<Badge tone="success">
							{t("plugins.installedIn", {
								scopes: plugin.installed.map((s) => t(SCOPE_KEY[s])).join(", "),
							})}
						</Badge>
					) : null}
				</div>
				{plugin.description ? <p className="mt-1 text-xs text-muted">{plugin.description}</p> : null}
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<ScopePicker
					value={scope}
					onChange={setScope}
					projectAllowed={projectAllowed}
					label={t("plugins.installScopeAria", { name: plugin.name })}
					testId="catalog-scope"
				/>
				<Button
					size="sm"
					variant="primary"
					disabled={busy || here}
					onClick={() => onInstall(plugin, scope)}
					data-testid="catalog-install"
				>
					<Download size={13} /> {t("plugins.install")}
				</Button>
			</div>
		</li>
	);
}

function DiscoverSection({
	data,
	busy,
	projectAllowed,
	onInstall,
}: {
	data: PluginsData;
	busy: boolean;
	projectAllowed: boolean;
	onInstall: (p: CatalogPlugin, scope: PluginScope) => void;
}) {
	const t = useT();
	const [q, setQ] = useState("");
	const catalog = isPluginsFailure(data.catalog) ? null : data.catalog;
	const shown = useMemo(() => {
		const needle = q.trim().toLowerCase();
		if (!catalog || !needle) return catalog ?? [];
		return catalog.filter((p) =>
			[p.name, p.description ?? "", p.marketplace].some((s) => s.toLowerCase().includes(needle)),
		);
	}, [catalog, q]);
	const noMarkets = !isPluginsFailure(data.marketplaces) && data.marketplaces.length === 0;
	return (
		<Section
			id="discover"
			title={t("plugins.discoverTitle")}
			icon={<Store size={16} className="text-accent" />}
			hint={t("plugins.discoverHint")}
		>
			{isPluginsFailure(data.catalog) ? (
				<p role="alert" className="text-sm text-danger">
					{data.catalog.error}
				</p>
			) : null}
			{noMarkets ? <p className="text-sm text-muted">{t("plugins.discoverNoMarkets")}</p> : null}
			{catalog && catalog.length > 0 ? (
				<>
					<input
						type="search"
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder={t("plugins.discoverFilter")}
						aria-label={t("plugins.discoverFilterAria")}
						className="w-full rounded-lg border border-border bg-bg-soft px-2.5 py-1.5 text-sm outline-none focus:border-faint"
						data-testid="catalog-filter"
					/>
					{shown.length === 0 ? <p className="mt-3 text-sm text-muted">{t("plugins.discoverNone")}</p> : null}
					<ul className="mt-1 divide-y divide-border">
						{shown.map((p) => (
							<CatalogRow
								key={`${p.name}@${p.marketplace}`}
								plugin={p}
								busy={busy}
								projectAllowed={projectAllowed}
								onInstall={onInstall}
							/>
						))}
					</ul>
				</>
			) : null}
		</Section>
	);
}

function ManualSection({
	busy,
	projectAllowed,
	onInstall,
}: {
	busy: boolean;
	projectAllowed: boolean;
	onInstall: (spec: string, scope: PluginScope | null) => void;
}) {
	const t = useT();
	const [spec, setSpec] = useState("");
	const [scope, setScope] = useState<PluginScope>("user");
	return (
		<Section
			id="manual"
			title={t("plugins.manualTitle")}
			icon={<Download size={16} className="text-accent" />}
			hint={<WithCode text={t("plugins.manualHint")} />}
		>
			<form
				className="flex flex-wrap gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (!spec.trim()) return;
					// The scope is omp's for a marketplace plugin only: for anything else it warns and ignores it.
					onInstall(spec.trim(), scope === "project" ? "project" : null);
					setSpec("");
				}}
			>
				<input
					value={spec}
					onChange={(e) => setSpec(e.target.value)}
					aria-label={t("plugins.manualLabel")}
					placeholder="@scope/plugin, github:user/repo, ~/my-plugin"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					className="min-w-0 flex-1 basis-60 rounded-lg border border-border bg-bg-soft px-2.5 py-1.5 font-mono text-sm outline-none focus:border-faint"
					data-testid="manual-spec"
				/>
				<ScopePicker
					value={scope}
					onChange={setScope}
					projectAllowed={projectAllowed}
					label={t("plugins.scope")}
					testId="manual-scope"
				/>
				<Button type="submit" variant="primary" disabled={busy || !spec.trim()} data-testid="manual-install">
					<Download size={14} /> {t("plugins.install")}
				</Button>
			</form>
			<p className="mt-2 text-xs text-muted">
				<WithCode text={t(projectAllowed ? "plugins.scopeHint" : "plugins.scopeProjectNeedsFolder")} />
			</p>
		</Section>
	);
}

// ------------------------------------------------------------------ marketplaces

function MarketplacesSection({
	data,
	busy,
	onAdd,
	onUpdate,
	onRemove,
}: {
	data: PluginsData;
	busy: boolean;
	onAdd: (source: string) => void;
	onUpdate: (name: string | null) => void;
	onRemove: (name: string) => void;
}) {
	const t = useT();
	const [source, setSource] = useState("");
	const [removing, setRemoving] = useState<string | null>(null);
	const list = isPluginsFailure(data.marketplaces) ? null : data.marketplaces;
	return (
		<Section
			id="marketplaces"
			title={t("plugins.marketsTitle")}
			icon={<Store size={16} className="text-accent" />}
			hint={<WithCode text={t("plugins.marketsHint")} />}
			action={
				list && list.length > 0 ? (
					<Button size="sm" disabled={busy} onClick={() => onUpdate(null)} data-testid="markets-update-all">
						<RefreshCw size={13} /> {t("plugins.marketUpdateAll")}
					</Button>
				) : undefined
			}
		>
			{isPluginsFailure(data.marketplaces) ? (
				<p role="alert" className="text-sm text-danger">
					{data.marketplaces.error}
				</p>
			) : null}
			{list && list.length === 0 ? <p className="text-sm text-muted">{t("plugins.marketsEmpty")}</p> : null}
			{list && list.length > 0 ? (
				<ul className="divide-y divide-border">
					{list.map((m) => (
						<li
							key={m.name}
							className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5"
							data-testid="marketplace"
							data-marketplace={m.name}
						>
							<div className="min-w-0 flex-1 basis-56">
								<div className="font-mono text-sm font-medium">{m.name}</div>
								<div className="break-all text-xs text-muted">{m.source}</div>
								{m.error ? (
									<div className="mt-1 text-xs text-danger">{t("plugins.marketError", { error: m.error })}</div>
								) : null}
							</div>
							<div className="flex shrink-0 gap-2">
								<Button size="sm" disabled={busy} onClick={() => onUpdate(m.name)} data-testid="marketplace-update">
									{t("plugins.marketUpdate")}
								</Button>
								<Button size="sm" disabled={busy} onClick={() => setRemoving(m.name)} data-testid="marketplace-remove">
									<Trash2 size={13} /> {t("plugins.marketRemove")}
								</Button>
							</div>
						</li>
					))}
				</ul>
			) : null}
			<form
				className="mt-3 flex flex-wrap gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (!source.trim()) return;
					onAdd(source.trim());
					setSource("");
				}}
			>
				<input
					value={source}
					onChange={(e) => setSource(e.target.value)}
					aria-label={t("plugins.marketAddLabel")}
					placeholder="owner/repo, https://…, ~/my-marketplace"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					className="min-w-0 flex-1 basis-60 rounded-lg border border-border bg-bg-soft px-2.5 py-1.5 font-mono text-sm outline-none focus:border-faint"
					data-testid="marketplace-source"
				/>
				<Button type="submit" disabled={busy || !source.trim()} data-testid="marketplace-add">
					{t("plugins.marketAdd")}
				</Button>
			</form>
			<Confirm
				open={removing !== null}
				onOpenChange={(o) => !o && setRemoving(null)}
				title={t("plugins.marketRemoveTitle", { name: removing ?? "" })}
				body={t("plugins.marketRemoveBody")}
				action={t("plugins.marketRemove")}
				danger
				testId="marketplace-remove-confirm"
				onConfirm={() => removing && onRemove(removing)}
			/>
		</Section>
	);
}

// ------------------------------------------------------------------ doctor

const STATUS_ICON: Record<PluginCheck["status"], ReactNode> = {
	ok: <CircleCheck size={14} className="mt-0.5 shrink-0 text-success" />,
	warning: <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warning" />,
	error: <CircleAlert size={14} className="mt-0.5 shrink-0 text-danger" />,
};
const STATUS_KEY: Record<PluginCheck["status"], MessageKey> = {
	ok: "plugins.statusOk",
	warning: "plugins.statusWarning",
	error: "plugins.statusError",
};

function DoctorSection({
	cwd,
	busy,
	onFix,
	installed,
}: {
	cwd: string | null;
	busy: boolean;
	onFix: () => void;
	/** The listing the checks were last run against: when it changes, the checks are run again. */
	installed: InstalledPlugin[] | null;
}) {
	const t = useT();
	const [checks, setChecks] = useState<PluginCheck[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const asked = useRef(false);
	const check = useCallback(() => {
		asked.current = true;
		setRunning(true);
		setError(null);
		pluginsApi
			.doctor(cwd)
			.then((r) => setChecks(r.checks))
			.catch((e: Error) => setError(e.message))
			.finally(() => setRunning(false));
	}, [cwd]);
	// After a change (the list is read again), checks once run are run again: what Fix did shows.
	useEffect(() => {
		if (installed && asked.current) check();
	}, [installed, check]);
	const problems = checks?.filter((c) => c.status !== "ok" && !c.fixed) ?? [];
	return (
		<Section
			id="doctor"
			title={t("plugins.doctorTitle")}
			icon={<Stethoscope size={16} className="text-accent" />}
			hint={t("plugins.doctorHint")}
			action={
				<div className="flex gap-2">
					<Button size="sm" disabled={running} onClick={check} data-testid="doctor-run">
						{running ? <Spinner size={13} /> : <Stethoscope size={13} />} {t("plugins.doctorRun")}
					</Button>
					{problems.length > 0 ? (
						<Button size="sm" disabled={busy} onClick={onFix} data-testid="doctor-fix">
							<Wrench size={13} /> {t("plugins.doctorFix")}
						</Button>
					) : null}
				</div>
			}
		>
			{error ? <LoadError title={t("plugins.doctorTitle")} error={error} onRetry={check} /> : null}
			{checks && checks.length > 0 && problems.length === 0 ? (
				<p className="mb-2 text-sm text-success">{t("plugins.doctorAllOk")}</p>
			) : null}
			{checks ? (
				<ul className="flex flex-col gap-1.5" data-testid="doctor-checks">
					{checks.map((c) => (
						<li
							key={c.name}
							className="flex items-start gap-2 text-sm"
							data-testid="doctor-check"
							data-status={c.status}
						>
							{STATUS_ICON[c.status]}
							<span className="min-w-0 flex-1">
								<span className="font-mono text-xs">{c.name}</span>
								<span className="sr-only"> ({t(STATUS_KEY[c.status])})</span>
								<span className="block break-words text-xs text-muted">
									{c.message}
									{c.fixed ? ` · ${t("plugins.doctorFixed")}` : ""}
								</span>
							</span>
						</li>
					))}
				</ul>
			) : null}
		</Section>
	);
}
