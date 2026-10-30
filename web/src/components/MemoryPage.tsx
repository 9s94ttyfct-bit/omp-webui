import {
	type MemoryDetail as Detail,
	MEMORY_KINDS,
	MEMORY_PAGE,
	MEMORY_PAGE_MAX,
	type MemoryItem,
	type MemoryKind,
	type MemoryList,
	type MemoryOverview,
	type MemoryQuery,
} from "@shared/memory.ts";
import { Brain, Check, Copy, Lock, Plus, RefreshCw, Search } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { fmtRelative } from "../lib/format.ts";
import { useNarrowerThan } from "../lib/media.ts";
import { memoryApi, memoryErrorText } from "../lib/memory-api.ts";
import { useMemoryStrings } from "../lib/memory-strings.ts";
import {
	addableProjects,
	type Draft,
	INITIAL_FILTERS,
	KIND_LABEL,
	keyOf,
	type MemoryFilters,
	projectBanks,
	projectNames,
	queryOf,
} from "../lib/memory-view.ts";
import { useStable } from "../lib/stable.ts";
import { useApp } from "../store/app.ts";
import { MemoryDetail } from "./MemoryDetail.tsx";
import { AddMemory } from "./MemoryDialogs.tsx";
import { Switch } from "./Switch.tsx";
import { Badge, Button, cx, Empty, IconButton, Select, Spinner, WithCode } from "./ui.tsx";

/** What turns omp's long-term memory on. This page cannot change omp's own settings, so it is given as a command to run. */
const ENABLE_COMMAND = "omp config set memory.backend mnemopi";

/** The command that turns memory on, in a box with a Copy button, and the setting it writes in words. */
function EnableMemory() {
	const t = useT();
	const [copied, setCopied] = useState(false);
	const copy = () => {
		navigator.clipboard?.writeText(ENABLE_COMMAND).then(
			() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			},
			() => {},
		);
	};
	return (
		<div data-testid="memory-enable">
			<div className="mx-auto mt-3 flex items-center gap-2 rounded-lg border border-border bg-surface py-1.5 pr-1.5 pl-3 text-left">
				<code className="min-w-0 flex-1 break-all font-mono text-xs" data-testid="memory-enable-command">
					{ENABLE_COMMAND}
				</code>
				<IconButton label={`${t("common.copy")}: ${ENABLE_COMMAND}`} size="sm" onClick={copy}>
					{copied ? <Check size={13} /> : <Copy size={13} />}
				</IconButton>
			</div>
			<p className="mt-2">
				<WithCode text={t("memory.noneSetting")} />
			</p>
		</div>
	);
}

/** Below this the list and the memory do not fit side by side: one is shown, with a way back from the other. */
const NARROW_PX = 760;

/** The debounce of the search box: a request for every word, not for every key. */
const SEARCH_MS = 250;

type Selected = { bank: string; id: string };

/**
 * What the page held when it was left (to open the conversation a memory came from, say): the unsaved edits above all,
 * which a click on a link must not lose, and the search and the memory that was open, so that Back finds the page as it was.
 * Lives as long as the app's page does.
 */
const kept: { filters: MemoryFilters; search: string; selected: Selected | null; drafts: Record<string, Draft> } = {
	filters: INITIAL_FILTERS,
	search: "",
	selected: null,
	drafts: {},
};

const segment = (on: boolean) =>
	cx(
		"rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
		on ? "bg-hover text-fg" : "text-muted hover:text-fg",
	);

/** The words in the box, a moment after the last key. */
function useDebounced(value: string, ms: number): string {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setSettled(value), ms);
		return () => clearTimeout(timer);
	}, [value, ms]);
	return settled;
}

/** Numbers the requests of a list: only the answer to the latest one is used. */
function useLatest() {
	const count = useRef(0);
	return useMemo(
		() => ({
			next: () => {
				count.current += 1;
				return count.current;
			},
			isCurrent: (n: number) => n === count.current,
		}),
		[],
	);
}

function Notice({
	children,
	tone = "info",
	id,
}: {
	children: ReactNode;
	tone?: "info" | "warning" | "danger";
	id: string;
}) {
	return (
		<div
			role={tone === "danger" ? "alert" : "status"}
			data-testid={id}
			className={cx(
				"rounded-lg border px-3 py-2 text-sm",
				tone === "danger" && "border-danger/30 bg-danger/10 text-danger",
				tone === "warning" && "border-warning/40 bg-warning/10",
				tone === "info" && "border-border bg-bg-soft text-muted",
			)}
		>
			{children}
		</div>
	);
}

/**
 * The Memory page: omp's long-term memory (Mnemopi), listed, searched, read in full, rewritten, added to,
 * retired and deleted. It is the page of this computer: what omp remembers is private, so a page that came through the
 * tunnel is told so and asks for nothing (the routes refuse it too). The server does the changes (`server/memory/`), with
 * a copy of the store made first; this page asks for each one, and deleting asks the person first.
 */
export function MemoryPage() {
	const t = useT();
	const ready = useMemoryStrings();
	const meta = useApp((s) => s.meta);
	const home = meta?.home;
	const remote = meta?.remote === true;
	const live = meta !== null && !remote;

	const [frame, setFrame] = useState<HTMLElement | null>(null);
	const narrow = useNarrowerThan(frame, NARROW_PX);

	const [overview, setOverview] = useState<MemoryOverview | null>(null);
	const [overviewError, setOverviewError] = useState<string | null>(null);
	const [filters, setFilters] = useState<MemoryFilters>(kept.filters);
	const [search, setSearch] = useState(kept.search);
	const q = useDebounced(search, SEARCH_MS);
	const [list, setList] = useState<MemoryList | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [listBusy, setListBusy] = useState(false);
	const [selected, setSelected] = useState<Selected | null>(kept.selected);
	/** The text of memories being edited, by `bank/id`: opening another memory does not lose what was typed. */
	const [drafts, setDrafts] = useState<Record<string, Draft>>(kept.drafts);
	useEffect(() => {
		Object.assign(kept, { filters, search, selected, drafts });
	}, [filters, search, selected, drafts]);
	const [addOpen, setAddOpen] = useState(false);
	/** Counts up on Refresh: the open memory is read again too. */
	const [tick, setTick] = useState(0);
	/** The latest answer wins: a slow one for an older search must not replace the list of a newer one. */
	const latest = useLatest();

	const loadOverview = useStable(async () => {
		try {
			setOverview(await memoryApi.overview());
			setOverviewError(null);
		} catch (e) {
			setOverviewError(memoryErrorText(e));
		}
	});

	const loadList = useStable(async (query: Partial<MemoryQuery>, append: boolean) => {
		const mine = latest.next();
		setListBusy(true);
		try {
			const got = await memoryApi.items(query);
			if (!latest.isCurrent(mine)) return;
			setList((was) => (append && was ? { ...got, items: [...was.items, ...got.items] } : got));
			setListError(null);
		} catch (e) {
			if (latest.isCurrent(mine)) setListError(memoryErrorText(e));
		} finally {
			if (latest.isCurrent(mine)) setListBusy(false);
		}
	});

	/** Read the list again after a change: as far down as it was loaded, so that the person does not lose their place. */
	const reload = useStable(() => {
		void loadOverview();
		const size = Math.min(MEMORY_PAGE_MAX, Math.max(MEMORY_PAGE, list?.items.length ?? 0));
		void loadList(queryOf(filters, q, size, 0), false);
	});

	useEffect(() => {
		if (live) void loadOverview();
	}, [live, loadOverview]);

	/** There is a store to list: omp has written one, and the page knows where it is. */
	const listable =
		overview !== null && overview.unsupported === null && (overview.present || overview.banks.length > 0);
	useEffect(() => {
		if (listable) void loadList(queryOf(filters, q, MEMORY_PAGE, 0), false);
	}, [listable, filters, q, loadList]);

	const onGone = useStable(() => {
		setSelected(null);
		reload();
	});
	const setDraft = (key: string, draft: Draft | null) =>
		setDrafts((all) => {
			if (draft) return { ...all, [key]: draft };
			const { [key]: _gone, ...rest } = all;
			return rest;
		});

	if (!ready) return null;

	const shell = (body: ReactNode) => (
		<div ref={setFrame} className="flex h-full min-h-0 flex-1 flex-col overflow-hidden" data-testid="memory-page">
			{body}
		</div>
	);
	const title = (
		<h1 className="flex items-center gap-3 text-xl font-semibold">
			<Brain className="shrink-0 text-accent" /> {t("memory.title")}
		</h1>
	);

	if (remote) {
		return shell(
			<div className="mx-auto w-full max-w-xl space-y-6 px-6 py-8">
				{title}
				<div data-testid="memory-remote">
					<Empty icon={<Lock size={28} className="text-accent" />} title={t("memory.remoteTitle")}>
						{t("memory.remoteHint")}
					</Empty>
				</div>
			</div>,
		);
	}
	if (!live) {
		return shell(
			<div className="flex justify-center py-20">
				<Spinner />
			</div>,
		);
	}

	const banks = overview?.banks ?? [];
	const projects = overview ? projectBanks(overview) : [];
	const names = projectNames(projects, home);
	const canAdd = overview !== null && (overview.canAddGlobal || addableProjects(overview).length > 0);
	// Why Add cannot be pressed (while the overview loads it is merely not ready). With no store yet, the reason matches
	// what the page says below it: memory is on and the store is not made yet, or memory is to be turned on first.
	const addWhy =
		overview === null || canAdd
			? null
			: overview.unsupported !== null
				? t("memory.addNeedsPath")
				: !listable
					? overview.backend === "mnemopi"
						? t("memory.addNoStoreYet")
						: t("memory.addNoStore")
					: t("memory.addNowhere");
	const hasGlobal = banks.some((b) => b.scope === "global");

	const refresh = () => {
		setTick((n) => n + 1);
		reload();
	};

	const back = () => {
		const key = selected ? keyOf(selected) : null;
		setSelected(null);
		// The list comes back with the row that was open: focus lands where the person was.
		if (key)
			requestAnimationFrame(() =>
				document.querySelector<HTMLElement>(`[data-memory-key="${CSS.escape(key)}"]`)?.focus(),
			);
	};
	const toggleKind = (kind: MemoryKind) =>
		setFilters((f) => {
			const on = f.kinds.includes(kind);
			// The list of nothing is not a choice: the last kind stays on.
			if (on && f.kinds.length === 1) return f;
			return { ...f, kinds: MEMORY_KINDS.filter((k) => (k === kind ? !on : f.kinds.includes(k))) };
		});

	const header = (
		<header className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-4">
			{title}
			<span className="hidden max-w-md text-xs text-faint lg:inline">{t("memory.intro")}</span>
			<span className="flex-1" />
			{/* Disabled for real when there is nowhere to add to, and the reason is on the page, under the buttons: a tooltip
			    cannot be read on a phone, and a button that is only dimmed looks as if it could still be pressed. */}
			<Button
				size="sm"
				variant="primary"
				disabled={overview === null || addWhy !== null}
				aria-describedby={addWhy !== null ? "memory-add-why" : undefined}
				onClick={() => setAddOpen(true)}
				data-testid="memory-add"
			>
				<Plus size={13} /> {t("memory.add")}
			</Button>
			<Button
				size="sm"
				className="max-sm:h-8 max-sm:w-8 max-sm:px-0"
				onClick={refresh}
				disabled={listBusy}
				data-testid="memory-refresh"
			>
				{listBusy ? <Spinner size={13} /> : <RefreshCw size={13} />}
				<span className="max-sm:sr-only">{t("memory.refresh")}</span>
			</Button>
			{addWhy !== null ? (
				<p id="memory-add-why" data-testid="memory-add-why" className="basis-full text-xs text-muted">
					{addWhy}
				</p>
			) : null}
		</header>
	);

	if (overviewError !== null && overview === null) {
		return shell(
			<>
				{header}
				<div className="px-6 py-4">
					<Notice tone="danger" id="memory-error">
						{t("memory.loadFailed", { error: overviewError })}
					</Notice>
				</div>
			</>,
		);
	}
	if (overview === null) {
		return shell(
			<>
				{header}
				<div className="flex justify-center py-20">
					<Spinner />
				</div>
			</>,
		);
	}

	// What the notices say is of the store that is shown: with none yet, there is no store for omp to be "not using", and
	// the page says once (in its empty state) that there is none and how memory is turned on.
	const notices = (
		<>
			{!overview.settingsKnown ? (
				<Notice tone="warning" id="memory-settings-unknown">
					<WithCode text={t(listable ? "memory.settingsUnknown" : "memory.settingsUnknownNoStore")} />
				</Notice>
			) : null}
			{overview.unsupported === "relativePath" ? (
				<Notice tone="warning" id="memory-unsupported">
					<WithCode text={t("memory.unsupportedPath")} />
				</Notice>
			) : null}
			{listable && overview.backend !== null && overview.backend !== "mnemopi" ? (
				<Notice tone="warning" id="memory-not-used">
					{t("memory.notUsed", { backend: overview.backend })}
				</Notice>
			) : null}
			{overviewError !== null ? (
				<Notice tone="danger" id="memory-error">
					{t("memory.loadFailed", { error: overviewError })}
				</Notice>
			) : null}
		</>
	);

	if (!listable) {
		return shell(
			<>
				{header}
				<div className="space-y-3 px-6 empty:hidden [&:not(:empty)]:py-3">{notices}</div>
				{overview.unsupported === null ? (
					<div data-testid="memory-none" className="px-6">
						<Empty icon={<Brain size={28} className="text-accent" />} title={t("memory.noneTitle")}>
							{overview.backend === "mnemopi" ? (
								<span data-testid="memory-none-hint">{t("memory.noneOnHint")}</span>
							) : (
								<>
									<span data-testid="memory-none-hint">
										{overview.backend === null || overview.backend === "off"
											? t("memory.noneHint")
											: t("memory.noneOtherHint", { backend: overview.backend })}
									</span>
									<EnableMemory />
								</>
							)}
						</Empty>
					</div>
				) : null}
			</>,
		);
	}

	const key = selected ? keyOf(selected) : null;
	const showList = !narrow || selected === null;
	const showDetail = !narrow || selected !== null;
	const items = list?.items ?? [];
	const total = list?.total ?? 0;
	const info = selected ? banks.find((b) => b.bank === selected.bank) : undefined;

	const row = (m: MemoryItem) => {
		const rowKey = keyOf(m);
		const on = rowKey === key;
		return (
			<li key={rowKey}>
				<button
					type="button"
					aria-current={on ? "true" : undefined}
					data-testid="memory-row"
					data-memory-key={rowKey}
					data-id={m.id}
					data-kind={m.kind}
					className={cx(
						"block w-full border-b border-border px-4 py-3 text-left transition-colors",
						on ? "bg-hover" : "hover:bg-hover/50",
					)}
					onClick={() => setSelected({ bank: m.bank, id: m.id })}
				>
					<span className={cx("line-clamp-3 break-words text-sm", m.retired && "text-muted")}>
						{m.content}
						{m.truncated ? "…" : ""}
					</span>
					<span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
						<Badge>{t(KIND_LABEL[m.kind].one)}</Badge>
						<Badge>{m.scope === "project" ? (names.get(m.bank) ?? m.bank) : t("memory.globalBadge")}</Badge>
						{m.retired ? <Badge tone="warning">{t("memory.retiredBadge")}</Badge> : null}
						{drafts[rowKey] ? <Badge tone="accent">{t("memory.unsaved")}</Badge> : null}
						{m.createdAt ? <span>{fmtRelative(m.createdAt)}</span> : null}
						{m.importance !== null ? <span>{t("memory.importance", { value: m.importance })}</span> : null}
					</span>
				</button>
			</li>
		);
	};

	const filterBar = (
		<div className="space-y-2.5 border-b border-border p-4">
			<label className="relative block">
				<span className="sr-only">{t("memory.searchLabel")}</span>
				<Search
					size={14}
					aria-hidden
					className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
				/>
				<input
					type="search"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder={t("memory.searchPlaceholder")}
					className="h-9 w-full rounded-xl border border-border bg-bg-soft pr-3 pl-9 text-sm outline-none focus:border-faint"
					data-testid="memory-search"
				/>
			</label>
			<div className="flex flex-wrap items-center gap-2">
				<fieldset className="inline-flex min-w-0 rounded-lg border border-border p-0.5">
					<legend className="sr-only">{t("memory.scopeLabel")}</legend>
					<button
						type="button"
						aria-pressed={filters.scope === "all"}
						className={segment(filters.scope === "all")}
						onClick={() => setFilters((f) => ({ ...f, scope: "all", bank: "" }))}
						data-testid="memory-scope-all"
					>
						{t("memory.scopeAll")}
					</button>
					<button
						type="button"
						aria-pressed={filters.scope === "global"}
						disabled={!hasGlobal}
						title={t("memory.scopeGlobalHint")}
						className={segment(filters.scope === "global")}
						onClick={() => setFilters((f) => ({ ...f, scope: "global", bank: "" }))}
						data-testid="memory-scope-global"
					>
						{t("memory.scopeGlobal")}
					</button>
					<button
						type="button"
						aria-pressed={filters.scope === "project"}
						disabled={projects.length === 0}
						title={t("memory.scopeProjectHint")}
						className={segment(filters.scope === "project")}
						onClick={() => setFilters((f) => ({ ...f, scope: "project" }))}
						data-testid="memory-scope-project"
					>
						{t("memory.scopeProject")}
					</button>
				</fieldset>
				{filters.scope === "project" && projects.length > 0 ? (
					<Select
						tone="compact"
						className="min-w-0 flex-1"
						aria-label={t("memory.projectLabel")}
						value={filters.bank}
						onChange={(e) => setFilters((f) => ({ ...f, bank: e.target.value }))}
						data-testid="memory-project"
					>
						<option value="">{t("memory.allProjects")}</option>
						{projects.map((p) => (
							<option key={p.bank} value={p.bank}>
								{names.get(p.bank)}
							</option>
						))}
					</Select>
				) : null}
			</div>
			<fieldset className="flex min-w-0 flex-wrap gap-1.5">
				<legend className="sr-only">{t("memory.kindsLabel")}</legend>
				{MEMORY_KINDS.map((kind) => {
					const on = filters.kinds.includes(kind);
					return (
						<button
							key={kind}
							type="button"
							aria-pressed={on}
							title={t(KIND_LABEL[kind].hint)}
							className={cx(
								"rounded-full border px-2.5 py-1 text-xs transition-colors",
								on ? "border-accent bg-accent-soft text-fg" : "border-border text-muted hover:text-fg",
							)}
							onClick={() => toggleKind(kind)}
							data-testid={`memory-kind-${kind}`}
						>
							{t(KIND_LABEL[kind].many)}
							{list ? <span className="ml-1 tabular-nums text-faint">{list.counts[kind]}</span> : null}
						</button>
					);
				})}
			</fieldset>
			<div className="flex items-center gap-2 text-xs text-muted">
				<Switch
					label={t("memory.showRetired")}
					checked={filters.includeRetired}
					onCheckedChange={(on) => setFilters((f) => ({ ...f, includeRetired: on }))}
					data-testid="memory-show-retired"
				/>
				<span aria-hidden>{t("memory.showRetired")}</span>
			</div>
		</div>
	);

	const listPane = (
		<section
			aria-label={t("memory.listLabel")}
			className={cx("flex min-h-0 flex-col", narrow ? "flex-1" : "w-[min(26rem,45%)] shrink-0 border-r border-border")}
		>
			{filterBar}
			<div className="min-h-0 flex-1 overflow-y-auto" data-testid="memory-list">
				{listError !== null ? (
					<div className="p-4">
						<Notice tone="danger" id="memory-list-error">
							{t("memory.loadFailed", { error: listError })}
						</Notice>
					</div>
				) : null}
				{list && list.unreadable.length > 0 ? (
					<div className="p-4 pb-0">
						<Notice tone="warning" id="memory-unreadable">
							{t("memory.unreadable", { banks: list.unreadable.map((b) => names.get(b) ?? b).join(", ") })}
						</Notice>
					</div>
				) : null}
				{list === null && listError === null ? (
					<div className="flex justify-center py-12">
						<Spinner />
					</div>
				) : null}
				{list ? (
					items.length > 0 ? (
						<>
							<div className="px-4 py-2 text-xs text-faint" data-testid="memory-count-shown">
								{t("memory.countOf", { shown: items.length, total })}
							</div>
							<ul>{items.map(row)}</ul>
							{items.length < total ? (
								<div className="flex justify-center p-4">
									<Button
										size="sm"
										disabled={listBusy}
										onClick={() => void loadList(queryOf(filters, q, MEMORY_PAGE, items.length), true)}
										data-testid="memory-more"
									>
										{listBusy ? <Spinner size={13} /> : null}
										{listBusy ? t("memory.loading") : t("memory.loadMore")}
									</Button>
								</div>
							) : null}
						</>
					) : (
						<div data-testid="memory-empty">
							<Empty icon={<Brain size={28} className="text-accent" />} title={t("memory.emptyTitle")}>
								{t("memory.emptyHint")}
							</Empty>
						</div>
					)
				) : null}
				{overview.hiddenBanks > 0 ? (
					<p className="px-4 py-3 text-xs text-faint">{t("memory.hidden", { n: overview.hiddenBanks })}</p>
				) : null}
			</div>
		</section>
	);

	const detailPane = (
		<div className="@container min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="memory-detail-pane">
			{selected ? (
				<MemoryDetail
					key={`${keyOf(selected)}#${tick}`}
					bank={selected.bank}
					id={selected.id}
					info={info}
					draft={drafts[keyOf(selected)]}
					onDraft={(d) => setDraft(keyOf(selected), d)}
					onChanged={reload}
					onDeleted={() => {
						setSelected(null);
						reload();
					}}
					onGone={onGone}
					onOpen={(bank, id) => setSelected({ bank, id })}
					onBack={back}
					narrow={narrow}
				/>
			) : (
				<Empty icon={<Brain size={28} className="text-accent" />} title={t("memory.pickOne")} />
			)}
		</div>
	);

	return shell(
		<>
			{header}
			<div className="space-y-3 px-6 empty:hidden [&:not(:empty)]:py-3">{notices}</div>
			<div className="flex min-h-0 flex-1">
				{showList ? listPane : null}
				{showDetail ? detailPane : null}
			</div>
			<AddMemory
				open={addOpen}
				onOpenChange={setAddOpen}
				overview={overview}
				onAdded={(item: Detail) => {
					setAddOpen(false);
					// What was added is shown: a filter that would hide it is widened to take it in.
					setFilters((f) => ({
						...f,
						kinds: f.kinds.includes("note") ? f.kinds : MEMORY_KINDS.filter((k) => k === "note" || f.kinds.includes(k)),
					}));
					setSelected({ bank: item.bank, id: item.id });
					reload();
				}}
			/>
		</>,
	);
}
