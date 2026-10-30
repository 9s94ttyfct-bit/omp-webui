import {
	isFailure,
	type LoadedCommand,
	type LoadedData,
	type LoadedFailure,
	type LoadedMcpServer,
	type LoadedPlugin,
	type LoadedRule,
	type LoadedSkill,
	type LoadedTool,
	mcpSwitchable,
} from "@shared/loaded.ts";
import { ChevronRight, RefreshCw, TriangleAlert } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import {
	commandsBySource,
	matchesQuery,
	serverMatches,
	toolMatches,
	useLoaded,
	useLoadedDialog,
} from "../lib/loaded.ts";
import { isWorking, mcpKey, pluginKey, type Switches, skillKey, useLoadedSwitches } from "../lib/loaded-switches.ts";
import { useApp } from "../store/app.ts";
import type { LiveState } from "../store/live.ts";
import { Switch } from "./Switch.tsx";
import { Badge, Button, cx, Empty, IconButton, Modal, Spinner } from "./ui.tsx";

const SOURCE_LABELS: Record<string, MessageKey> = {
	builtin: "loaded.srcBuiltin",
	extension: "loaded.srcExtension",
	custom: "loaded.srcCustom",
	file: "loaded.srcFile",
	mcp_prompt: "loaded.srcMcpPrompt",
};

/** An MCP server of the list, or (`other`) the tools no listed server claims, shown as a server of their own. */
interface McpEntry extends LoadedMcpServer {
	other?: true;
}

/** What every group needs to know of the panel: the filter, and which groups are folded open. */
interface Folding {
	q: string;
	opened: Record<string, boolean>;
	toggle: (id: string) => void;
}

/**
 * A one-line description that opens to its whole text on a click or on keyboard focus. Where it fits it is plain
 * text: only a clipped one can be opened, and only that one is a tab stop.
 */
function Description({ text, className }: { text: string; className?: string }) {
	const t = useT();
	const ref = useRef<HTMLButtonElement>(null);
	const pointer = useRef(false);
	const [open, setOpen] = useState(false);
	const [clipped, setClipped] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new text is measured again; it is not an input.
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || open) return;
		const measure = () => setClipped(el.scrollWidth > el.clientWidth + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [text, open]);
	const expandable = clipped || open;
	return (
		<button
			ref={ref}
			type="button"
			disabled={!expandable}
			aria-expanded={expandable ? open : undefined}
			aria-label={
				expandable ? `${text} — ${t(open ? "loaded.descriptionCollapse" : "loaded.descriptionExpand")}` : undefined
			}
			className={cx(
				"block w-full min-w-0 text-left text-xs text-muted disabled:cursor-default",
				open ? "whitespace-normal break-words" : "truncate",
				className,
			)}
			data-testid="loaded-description"
			// A pointer press focuses the button before its click: that click, not the focus, is what opens it.
			onPointerDown={() => {
				pointer.current = true;
			}}
			onFocus={() => {
				if (!pointer.current) setOpen(true);
			}}
			onBlur={() => setOpen(false)}
			onClick={() => {
				pointer.current = false;
				setOpen((o) => !o);
			}}
		>
			{text}
		</button>
	);
}

// ------------------------------------------------------------------ rows

function ToolRow({ tool }: { tool: LoadedTool }) {
	const t = useT();
	return (
		<li
			className="flex items-baseline gap-2 px-3 py-1"
			data-testid="loaded-tool"
			data-tool={tool.name}
			data-state={tool.state}
		>
			<span className="shrink-0 font-mono text-xs">{tool.label}</span>
			{tool.state === "mounted" ? (
				<span title={t("loaded.toolMountedTip")}>
					<Badge>{t("loaded.toolMounted")}</Badge>
				</span>
			) : null}
			{tool.state === "off" ? (
				<span title={t("loaded.toolOffTip")}>
					<Badge tone="warning">{t("loaded.toolOff")}</Badge>
				</span>
			) : null}
			{tool.description ? <Description text={tool.description} className="flex-1" /> : null}
		</li>
	);
}

function ServerRow({
	server,
	tools,
	open,
	onToggle,
	switches,
	switchOff,
}: {
	server: McpEntry;
	tools: LoadedTool[];
	open: boolean;
	onToggle: () => void;
	switches: Switches;
	/** Why the switch cannot be used for every server (offline, a restart under way), or null. */
	switchOff: string | null;
}) {
	const t = useT();
	const where = server.scope ? `${server.target} [${server.scope}]` : server.target;
	const total = server.tools.length;
	let status: ReactNode;
	// Off in the config, yet the process still has its tools: omp drops a server only when it starts again.
	if (!server.enabled && total > 0) status = <span className="text-warning">{t("loaded.mcpOffStillRunning")}</span>;
	else if (!server.enabled) status = <span className="text-faint">{t("loaded.mcpDisabled")}</span>;
	else if (total === 0) status = <span className="text-warning">{t("loaded.mcpNoTools")}</span>;
	else
		status = (
			<span className="text-success">{total === 1 ? t("loaded.mcpToolOne") : t("loaded.mcpTools", { n: total })}</span>
		);
	const name = server.other ? t("loaded.mcpOther") : server.name;
	const nameFits = mcpSwitchable(server.name);
	const off = switchOff ?? (server.inBoth ? t("loaded.mcpSwitchBoth") : nameFits ? null : t("loaded.mcpSwitchName"));
	return (
		<li data-testid="loaded-server" data-server={server.name} data-enabled={server.enabled}>
			<div className="flex items-center gap-2 pr-3">
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent"
					aria-expanded={total ? open : undefined}
					aria-label={total ? t(open ? "loaded.mcpCollapse" : "loaded.mcpExpand", { name }) : undefined}
					title={server.other ? t("loaded.mcpOtherTip") : undefined}
					disabled={!total}
					onClick={onToggle}
				>
					<ChevronRight
						size={12}
						className={cx("shrink-0 text-faint transition-transform", open && "rotate-90", !total && "opacity-0")}
					/>
					<span className="min-w-0 truncate text-sm font-medium">{name}</span>
					{server.other ? null : <Badge>{server.transport}</Badge>}
					<span className="ml-auto shrink-0 text-xs" data-testid="loaded-server-status">
						{status}
					</span>
				</button>
				{server.other ? null : (
					<Switch
						checked={server.enabled}
						onCheckedChange={(on) => switches.mcp(server, on)}
						label={t("loaded.mcpSwitch", { name: server.name })}
						busy={switches.busy(mcpKey(server.name))}
						disabled={off !== null}
						title={off ?? undefined}
						data-testid="loaded-server-switch"
					/>
				)}
			</div>
			{server.other ? null : (
				<div className="truncate px-3 pb-1 pl-8 font-mono text-xs text-faint" title={where}>
					{where}
				</div>
			)}
			{open && total ? (
				<ul className="pb-1 pl-5">
					{tools.map((tool) => (
						<ToolRow key={tool.name} tool={tool} />
					))}
				</ul>
			) : null}
		</li>
	);
}

function CommandRow({ command }: { command: LoadedCommand }) {
	const t = useT();
	return (
		<li className="px-3 py-1" data-testid="loaded-command" data-command={command.name} data-source={command.source}>
			<div className="flex items-baseline gap-2">
				<span className="font-mono text-xs font-medium">/{command.name}</span>
				{command.aliases.length ? (
					<span className="truncate text-xs text-faint">
						{t("loaded.aliases", { names: command.aliases.map((a) => `/${a}`).join(", ") })}
					</span>
				) : null}
				{command.subcommands ? (
					<span className="ml-auto shrink-0 text-xs text-faint">
						{t("loaded.subcommands", { n: command.subcommands })}
					</span>
				) : null}
			</div>
			{command.description ? <Description text={command.description} /> : null}
		</li>
	);
}

function SkillRow({ skill, switches }: { skill: LoadedSkill; switches: Switches }) {
	const t = useT();
	return (
		<li
			className="flex items-start gap-2 px-3 py-1"
			data-testid="loaded-skill"
			data-skill={skill.name}
			data-enabled={skill.enabled}
		>
			<div className={cx("min-w-0 flex-1", !skill.enabled && "opacity-60")}>
				<div className="flex items-baseline gap-2">
					<span className="min-w-0 truncate font-mono text-xs font-medium">{skill.name}</span>
					{skill.enabled ? null : (
						<span title={t("loaded.skillOffTip")}>
							<Badge tone="warning">{t("loaded.skillOff")}</Badge>
						</span>
					)}
				</div>
				{skill.description ? <Description text={skill.description} /> : null}
			</div>
			<Switch
				checked={skill.enabled}
				onCheckedChange={(on) => switches.skill(skill.name, on)}
				label={t("loaded.skillSwitch", { name: skill.name })}
				busy={switches.busy(skillKey(skill.name))}
				data-testid="loaded-skill-switch"
			/>
		</li>
	);
}

function PluginRow({ plugin, light, switches }: { plugin: LoadedPlugin; light: boolean; switches: Switches }) {
	const t = useT();
	return (
		<li
			className="flex items-start gap-2 px-3 py-1"
			data-testid="loaded-plugin"
			data-plugin={plugin.name}
			data-scope={plugin.scope ?? ""}
			data-enabled={plugin.enabled}
		>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
					<span className="min-w-0 truncate text-sm font-medium">{plugin.name}</span>
					{plugin.version ? <span className="text-xs text-faint">{plugin.version}</span> : null}
					<Badge>{plugin.kind}</Badge>
					{plugin.scope ? <Badge>{plugin.scope}</Badge> : null}
					{plugin.shadowedBy ? <Badge tone="warning">{t("loaded.pluginShadowed")}</Badge> : null}
					{plugin.enabled ? null : <Badge tone="warning">{t("loaded.pluginDisabled")}</Badge>}
					{light && plugin.enabled ? <Badge tone="warning">{t("loaded.pluginLight")}</Badge> : null}
				</div>
				{plugin.path ? (
					<div className="truncate font-mono text-xs text-faint" title={plugin.path}>
						{plugin.path}
					</div>
				) : null}
			</div>
			<Switch
				checked={plugin.enabled}
				onCheckedChange={(on) => switches.plugin(plugin, on)}
				label={t("loaded.pluginSwitch", { name: plugin.name })}
				busy={switches.busy(pluginKey(plugin))}
				disabled={light}
				title={light ? t("loaded.pluginSwitchLight") : undefined}
				data-testid="loaded-plugin-switch"
			/>
		</li>
	);
}

function RuleRow({ rule }: { rule: LoadedRule }) {
	const detail = [...rule.scope, ...rule.triggers].join(" · ");
	return (
		<li className="px-3 py-1" data-testid="loaded-rule" data-rule={rule.name}>
			<div className="flex items-baseline gap-2">
				<span className="min-w-0 truncate font-mono text-xs font-medium">{rule.name}</span>
				<Badge>{rule.provider}</Badge>
			</div>
			{rule.description ? <Description text={rule.description} /> : null}
			{detail ? (
				<div className="truncate font-mono text-xs text-faint" title={detail}>
					{detail}
				</div>
			) : null}
		</li>
	);
}

/**
 * MCP servers were switched in this conversation's config, which its omp reads once, when it starts. Offers the restart
 * that applies them when the conversation can be restarted without cutting something off; says that they wait for the
 * next start otherwise.
 */
function McpRestartNote({
	names,
	working,
	restarting,
	onRestart,
}: {
	names: string[];
	working: boolean;
	restarting: boolean;
	onRestart: (() => void) | undefined;
}) {
	const t = useT();
	const offer = !working && onRestart !== undefined;
	return (
		<div
			className="mx-3 mb-1.5 rounded-lg border border-border bg-accent-soft px-3 py-2 text-xs"
			data-testid="loaded-mcp-restart"
			data-working={working}
		>
			<p>{t(offer ? "loaded.mcpRestartIdle" : "loaded.mcpRestartLater", { names: names.join(", ") })}</p>
			{offer ? (
				<Button
					size="sm"
					variant="primary"
					className="mt-1.5"
					disabled={restarting}
					onClick={onRestart}
					data-testid="loaded-mcp-restart-now"
				>
					{restarting ? <Spinner size={12} /> : null}
					{t(restarting ? "loaded.mcpRestarting" : "loaded.mcpRestartNow")}
				</Button>
			) : null}
		</div>
	);
}

// ------------------------------------------------------------------ groups

/**
 * One group of the panel under a heading that folds it. A group omp could not fill shows why; one with `null` (the
 * conversation has no process to ask) is left out, and with a filter so is one with nothing that matches.
 */
function Group<T>({
	id,
	title,
	value,
	folding,
	match,
	note,
	empty,
	count,
	children,
}: {
	id: string;
	title: string;
	value: T[] | LoadedFailure | null;
	folding: Folding;
	match: (item: T) => boolean;
	note?: string;
	empty?: string;
	/** What the heading counts, where it is not every item shown. */
	count?: (items: T[]) => number;
	children: (items: T[]) => ReactNode;
}) {
	const t = useT();
	const { q, opened, toggle } = folding;
	if (value === null) return null;
	const failure = Array.isArray(value) ? null : value;
	const items = Array.isArray(value) ? value.filter(match) : [];
	if (q && !items.length) return null;
	const open = q ? true : (opened[id] ?? false);
	const content = failure ? (
		<p className="flex items-start gap-1.5 px-3 py-1 text-xs text-warning" data-testid="loaded-failed">
			<TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
			{failure.folderMissing ? failure.error : t("loaded.sectionFailed", { error: failure.error })}
		</p>
	) : (
		<>
			{!q && note ? <p className="px-3 pb-1.5 text-xs text-faint">{note}</p> : null}
			{!q && empty && items.length === 0 ? <p className="px-3 pb-1.5 text-xs text-faint">{empty}</p> : null}
			{children(items)}
		</>
	);
	return (
		<section className="border-b border-border" data-testid={`loaded-section-${id}`} data-open={open}>
			<button
				type="button"
				className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold hover:bg-hover"
				aria-expanded={open}
				onClick={() => toggle(id)}
			>
				<ChevronRight size={13} className={cx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
				{title}
				{failure ? null : (
					<span className="font-normal text-faint tabular-nums" data-testid={`loaded-count-${id}`}>
						{count ? count(items) : items.length}
					</span>
				)}
			</button>
			{open ? <div className="pb-2">{content}</div> : null}
		</section>
	);
}

/** The tools and MCP servers: both are read from one answer, which can be missing or failed as a whole. */
function splitTools(tools: LoadedData["tools"]): {
	builtin: LoadedTool[] | LoadedFailure | null;
	mcp: McpEntry[] | LoadedFailure | null;
} {
	if (!tools || isFailure(tools)) return { builtin: tools, mcp: tools };
	const other: McpEntry[] = tools.otherMcp.length
		? [{ name: "", transport: "", enabled: true, target: "", scope: null, tools: tools.otherMcp, other: true }]
		: [];
	return { builtin: tools.builtin, mcp: [...tools.servers, ...other] };
}

/**
 * What this conversation has loaded, which is what the terminal's `/status` (Extension Control Center) shows: its
 * tools, the MCP servers behind some of them, slash commands, skills, plugins and rules, read from omp.
 */
export function LoadedPanel({
	live,
	file,
	onRestart,
}: {
	live: LiveState | undefined;
	file: string | null;
	/** Start this conversation's omp anew from its saved file; resolves to whether it did (a failure is already said). */
	onRestart?: () => Promise<boolean>;
}) {
	const t = useT();
	const liveId = live && !live.info.exited ? live.info.liveId : null;
	const paused = liveId !== null && live?.info.pausedAt !== null;
	const { data, error, loading, refresh } = useLoaded({ liveId, file, paused });
	const switches = useLoadedSwitches({ liveId, file }, refresh);
	const bashRunning = useApp((s) => (liveId ? (s.bash[liveId]?.length ?? 0) > 0 : false));
	const [restarting, setRestarting] = useState(false);
	const restart = async () => {
		if (!onRestart || !liveId) return;
		setRestarting(true);
		try {
			await onRestart();
		} finally {
			setRestarting(false);
		}
	};
	const [filter, setFilter] = useState("");
	const [opened, setOpened] = useState<Record<string, boolean>>({ tools: true, mcp: true });
	// Servers whose tools are listed; a filter lists the tools that match without asking.
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const q = filter.trim().toLowerCase();
	const folding: Folding = {
		q,
		opened,
		toggle: (id) => setOpened((cur) => ({ ...cur, [id]: !(cur[id] ?? false) })),
	};

	let body: ReactNode;
	if (!data) {
		body = error ? (
			<Empty icon={<TriangleAlert size={22} />} title={t("loaded.loadFailed", { error })}>
				<Button size="sm" onClick={refresh}>
					{t("loaded.refresh")}
				</Button>
			</Empty>
		) : (
			<div className="flex justify-center py-10" data-testid="loaded-loading">
				<Spinner />
			</div>
		);
	} else {
		const { builtin, mcp } = splitTools(data.tools);
		const light = data.mode === "light";
		const running = data.tools !== null;
		// The servers the process does not follow yet, as the server says (it derives that from the config files and the
		// process's start, so a reload or another tab shows the same).
		const owed = Array.isArray(mcp) ? mcp.filter((s) => s.restartOwed).map((s) => s.name) : [];
		const switchOff = light ? t("loaded.mcpSwitchLight") : restarting ? t("loaded.mcpRestarting") : null;
		const groups = (
			<div className="[&>section:last-child]:border-b-0">
				{/* Shown only when no group is: with a filter, a group with nothing to show leaves the page. */}
				<p className="hidden px-3 py-6 text-center text-xs text-muted only:block" data-testid="loaded-no-match">
					{t("loaded.noMatch", { query: filter.trim() })}
				</p>
				<Group
					id="tools"
					title={t("loaded.sectionTools")}
					value={builtin}
					folding={folding}
					match={(x) => toolMatches(q, x)}
					note={t("loaded.toolsNote")}
				>
					{(items) => (
						<ul>
							{items.map((x) => (
								<ToolRow key={x.name} tool={x} />
							))}
						</ul>
					)}
				</Group>
				<Group
					id="mcp"
					title={t("loaded.sectionMcp")}
					value={mcp}
					folding={folding}
					match={(s) => serverMatches(q, s)}
					note={t("loaded.mcpNote")}
					count={(items) => items.filter((s) => !s.other).length}
				>
					{(items) => (
						<>
							{owed.length > 0 && !light ? (
								<McpRestartNote
									names={owed}
									working={live ? isWorking(live, bashRunning) : true}
									restarting={restarting}
									onRestart={onRestart ? restart : undefined}
								/>
							) : null}
							<ul>
								{items.map((s) => {
									// With a filter a server lists the tools that match, unless its own name does.
									const own = matchesQuery(q, s.name, s.target, s.transport);
									const tools = q && !own ? s.tools.filter((x) => toolMatches(q, x)) : s.tools;
									return (
										<ServerRow
											key={s.other ? "other" : s.name}
											server={s}
											tools={tools}
											open={q ? tools.length > 0 : (expanded[s.name] ?? false)}
											onToggle={() => setExpanded((cur) => ({ ...cur, [s.name]: !(cur[s.name] ?? false) }))}
											switches={switches}
											switchOff={switchOff}
										/>
									);
								})}
							</ul>
						</>
					)}
				</Group>
				<Group
					id="commands"
					title={t("loaded.sectionCommands")}
					value={data.commands}
					folding={folding}
					match={(c) => matchesQuery(q, c.name, c.description, ...c.aliases)}
				>
					{(items) =>
						commandsBySource(items).map(([source, list]) => (
							<div key={source} data-testid="loaded-command-group" data-source={source}>
								<div className="px-3 pt-1.5 pb-0.5 text-xs font-medium text-muted">
									{SOURCE_LABELS[source] ? t(SOURCE_LABELS[source]) : source}
								</div>
								<ul>
									{list.map((c) => (
										<CommandRow key={c.name} command={c} />
									))}
								</ul>
							</div>
						))
					}
				</Group>
				<Group
					id="skills"
					title={t("loaded.sectionSkills")}
					value={data.skills}
					folding={folding}
					match={(s) => matchesQuery(q, s.name, s.description)}
					note={t("loaded.skillsNote")}
					empty={t("loaded.skillsEmpty")}
				>
					{(items) => (
						<ul>
							{items.map((s) => (
								<SkillRow key={s.name} skill={s} switches={switches} />
							))}
						</ul>
					)}
				</Group>
				<Group
					id="plugins"
					title={t("loaded.sectionPlugins")}
					value={data.plugins}
					folding={folding}
					match={(p) => matchesQuery(q, p.name, p.path)}
					note={t("loaded.pluginsNote")}
					empty={t("loaded.pluginsEmpty")}
				>
					{(items) => (
						<ul>
							{items.map((p) => (
								<PluginRow key={`${p.kind}:${p.scope ?? ""}:${p.name}`} plugin={p} light={light} switches={switches} />
							))}
						</ul>
					)}
				</Group>
				<Group
					id="rules"
					title={t("loaded.sectionRules")}
					value={data.rules}
					folding={folding}
					match={(r) => matchesQuery(q, r.name, r.description, r.provider, ...r.scope, ...r.triggers)}
					note={t("loaded.rulesNote")}
					empty={t("loaded.rulesEmpty")}
				>
					{(items) => (
						<ul>
							{items.map((r) => (
								<RuleRow key={`${r.provider}:${r.name}`} rule={r} />
							))}
						</ul>
					)}
				</Group>
			</div>
		);
		body = (
			<>
				{error ? (
					<div
						role="alert"
						className="flex items-center gap-2 border-b border-border bg-bg-soft px-3 py-2 text-xs text-warning"
						data-testid="loaded-refresh-failed"
					>
						<TriangleAlert size={13} className="shrink-0" aria-hidden />
						<span className="min-w-0 flex-1 break-words">{t("loaded.refreshFailed", { error })}</span>
						<Button size="sm" onClick={refresh} disabled={loading}>
							{t("loaded.retry")}
						</Button>
					</div>
				) : null}
				{light ? (
					<p className="border-b border-border bg-accent-soft px-3 py-2 text-xs" data-testid="loaded-light">
						{t("loaded.lightNote")}
					</p>
				) : null}
				{running ? null : (
					<p
						className="border-b border-border bg-bg-soft px-3 py-2 text-xs text-muted"
						data-testid="loaded-not-running"
					>
						{t(paused ? "loaded.paused" : "loaded.notRunning")}
					</p>
				)}
				{groups}
			</>
		);
	}

	return (
		<div className="space-y-2" data-testid="loaded-panel">
			<div className="flex items-center gap-1.5">
				<input
					type="search"
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder={t("loaded.searchPlaceholder")}
					aria-label={t("loaded.searchAria")}
					data-testid="loaded-search"
					className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg-soft px-2.5 text-sm outline-none focus:border-faint"
				/>
				<IconButton
					label={t("loaded.refresh")}
					size="sm"
					disabled={loading}
					onClick={refresh}
					data-testid="loaded-refresh"
				>
					<RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
				</IconButton>
			</div>
			<div className="max-h-[55vh] overflow-y-auto rounded-xl border border-border" data-loading={loading}>
				{body}
			</div>
		</div>
	);
}

/** The dialog the header button, the ⋯ menu and `/status`, `/extensions`, `/skills` open. */
export function LoadedDialog({
	live,
	file,
	onRestart,
}: {
	live: LiveState | undefined;
	file: string | null;
	onRestart?: () => Promise<boolean>;
}) {
	const t = useT();
	const open = useLoadedDialog((s) => s.open);
	return (
		<Modal
			open={open}
			onOpenChange={(o) => useLoadedDialog.setState({ open: o })}
			title={t("loaded.title")}
			description={t("loaded.description")}
			wide
		>
			<LoadedPanel live={live} file={file} onRestart={onRestart} />
		</Modal>
	);
}
