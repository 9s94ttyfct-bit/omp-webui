import { working as isWorking } from "@shared/attention.ts";
import { PREF } from "@shared/prefs.ts";
import { Monitor, Moon, Settings, Sun } from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import "../i18n/later.ts";
import { LANGS, type Lang, useLang, useT } from "../i18n/index.ts";
import { setNotifications, useNotify } from "../lib/attention.ts";
import { resetAllWidths } from "../lib/panel-widths.ts";
import { setPref } from "../lib/prefs.ts";
import { useSectionIndex } from "../lib/section-index.ts";
import { SETTINGS_PAGE_LABEL } from "../lib/settings-page-labels.ts";
import { lastSettingsPage, pageOfElement, rememberSettingsPage, type SettingsPageId } from "../lib/settings-pages.ts";
import { SETTINGS, type SettingEntry } from "../lib/settings-search.ts";
import { inShell } from "../lib/shell-notify.ts";
import { applyTheme } from "../lib/theme.ts";
import { autoTitleEnabled, closeLive, useApp } from "../store/app.ts";
import { Accounts, isAccountsHelper } from "./Accounts.tsx";
import { ApprovalSettings } from "./ApprovalSettings.tsx";
import { CompactAtSettings } from "./CompactAtSettings.tsx";
import { CompactWhereSettings } from "./CompactWhereSettings.tsx";
import { DropSettings } from "./DropSettings.tsx";
import { ModelConfigSettings } from "./ModelConfigSettings.tsx";
import { ModeSettings } from "./ModeSettings.tsx";
import { OmpSettings } from "./OmpSettings.tsx";
import { PalettePicker } from "./PalettePicker.tsx";
import { QuitSettings } from "./QuitSettings.tsx";
import { RemoteSettings } from "./RemoteSettings.tsx";
import { Select } from "./Select.tsx";
import { SettingsIndex } from "./SettingsIndex.tsx";
import { SettingsSearch } from "./SettingsSearch.tsx";
import { StarPromptSetting } from "./StarPromptSetting.tsx";
import { ToolTimerSetting } from "./ToolTimerSetting.tsx";
import { UpdateSettings } from "./UpdateSettings.tsx";
import { UsageWaitSetting } from "./UsageWaitSetting.tsx";
import { Button, CardHeader, cx, WithCode } from "./ui.tsx";

// The card holds its own strings and code (and the Chinese strings a chunk of their own): none of it is in the first chunk.
const MigrationSettings = lazy(() => import("./MigrationSettings.tsx").then((m) => ({ default: m.MigrationSettings })));
// Safety (guard dangerous commands): a chunk of its own, with its strings; not for a page that came through the tunnel.
const GuardSettings = lazy(() => import("./GuardSettings.tsx").then((m) => ({ default: m.GuardSettings })));
// The projects folder: a chunk of its own, with its strings.
const ProjectsSettings = lazy(() => import("./ProjectsSettings.tsx").then((m) => ({ default: m.ProjectsSettings })));
// Web Push notifications for a closed page (#629): a chunk of its own, with its strings and the code that subscribes.
const PushSettings = lazy(() => import("./PushSettings.tsx").then((m) => ({ default: m.PushSettings })));
// Every keyboard binding (#639): read once in a while, so it is not in the page's own chunk either.
const ShortcutsSettings = lazy(() => import("./ShortcutsSettings.tsx").then((m) => ({ default: m.ShortcutsSettings })));
// The model guidance templates (#641): a chunk of its own, with its strings. A page that is not this computer's sees the
// card read only (it may not change them), as it does the guard's.
const GuidanceSettings = lazy(() => import("./GuidanceSettings.tsx").then((m) => ({ default: m.GuidanceSettings })));
// Unattended mode (#646): a chunk of its own, with its strings. A page that is not this computer's sees the text read only.
const UnattendedSettings = lazy(() =>
	import("./UnattendedSettings.tsx").then((m) => ({ default: m.UnattendedSettings })),
);
// Sleep (#647): keeping the Mac awake while something works, and what a sleep interrupted; a chunk of its own.
const SleepSettings = lazy(() => import("./SleepSettings.tsx").then((m) => ({ default: m.SleepSettings })));
// The quota floor (#652): holding a working conversation at a provider's quota floor; a chunk of its own, with the code that reads the figures.
const QuotaFloorSettings = lazy(() =>
	import("./QuotaFloorSettings.tsx").then((m) => ({ default: m.QuotaFloorSettings })),
);
// Arranging the sidebar's and the rail's pages without a pointer (#654): a chunk of its own, with its strings.
const NavLayoutSettings = lazy(() => import("./NavLayoutSettings.tsx").then((m) => ({ default: m.NavLayoutSettings })));
// Quick prompts of the message box (#659), Soft stop among them (#658): a chunk of its own, with its strings.
const QuickPromptsSettings = lazy(() =>
	import("./QuickPromptsSettings.tsx").then((m) => ({ default: m.QuickPromptsSettings })),
);

export function SettingsPage() {
	const t = useT();
	const { lang, setLang } = useLang();
	const { theme, set, meta, setView, predictionUnavailable, keepThinkingOpen } = useApp(
		useShallow((s) => ({
			theme: s.theme,
			set: s.set,
			meta: s.meta,
			setView: s.setView,
			predictionUnavailable: s.predictionUnavailable,
			keepThinkingOpen: s.keepThinkingOpen,
		})),
	);
	// The processes are read as what they are and whether they work, not as `lives`: that changes for every streamed token
	// of any conversation, and this page would render again for each. Both are equal while only a reply is being written.
	const infos = useApp(
		useShallow((s) =>
			Object.fromEntries(
				Object.values(s.lives)
					.filter((l) => !l.info.exited)
					.map((l) => [l.info.liveId, l.info]),
			),
		),
	);
	const working = useApp(
		useShallow((s) =>
			Object.fromEntries(
				Object.values(s.lives)
					.filter((l) => !l.info.exited)
					.map((l) => [l.info.liveId, isWorking(l)]),
			),
		),
	);
	// What the list names a process by is its conversation's title, not the list of conversations: that changes whenever any
	// conversation's file is written (by another one, too), and this page would render again for each of them.
	const titles = useApp(
		useShallow((s) =>
			Object.fromEntries(
				Object.values(s.lives).flatMap((l) => {
					const file = l.info.sessionFile;
					return !l.info.exited && file ? [[file, s.sessions.find((x) => x.file === file)?.title]] : [];
				}),
			),
		),
	);
	const open = useMemo(
		() => Object.values(infos).map((info) => ({ info, streaming: working[info.liveId] })),
		[infos, working],
	);
	const [autoTitle, setAutoTitle] = useState(autoTitleEnabled);
	const notify = useNotify();
	// The macOS app shows notifications through the shell, and macOS (System Settings) is where they are allowed.
	const app = inShell();
	const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
	const [column, setColumn] = useState<HTMLDivElement | null>(null);
	// Settings' pages (v0.11.18 §10): the one in the address, else the one last shown (and the address says so).
	const viewPage = useApp((s) => (s.view.kind === "settings" ? (s.view.page ?? null) : undefined));
	const page: SettingsPageId = viewPage ?? lastSettingsPage();
	useEffect(() => {
		if (viewPage === null) setView({ kind: "settings", page: lastSettingsPage() }, { replace: true });
		else if (viewPage) rememberSettingsPage(viewPage);
	}, [viewPage, setView]);
	const choosePage = useCallback(
		(p: SettingsPageId) => {
			if (p !== page) setView({ kind: "settings", page: p });
		},
		[page, setView],
	);
	// Another page starts at its top, not where the last one was left.
	useEffect(() => {
		if (page) scroller?.scrollTo({ top: 0 });
	}, [page, scroller]);
	// The index lists the cards of the page shown: its part of the column.
	const [shown, setShown] = useState<HTMLDivElement | null>(null);
	const index = useSectionIndex(shown, scroller);
	// A setting chosen in the search: its element is brought into view and marked for a moment, so that the reader sees
	// which of the card's controls the result was about (a card holds several, and the search names one).
	const [marked, setMarked] = useState<string | null>(null);
	const markTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(markTimer.current), []);
	const jump = useCallback((entry: SettingEntry, el: HTMLElement) => {
		el.scrollIntoView({ block: "center" });
		setMarked(entry.id);
		clearTimeout(markTimer.current);
		markTimer.current = setTimeout(() => setMarked(null), 2400);
		// The control the search named takes the focus when it can hold it: the next Tab is then from there, not from the top.
		const focusable = el.matches("input, select, button, textarea, a[href]")
			? el
			: el.querySelector<HTMLElement>("input, select, button, textarea, a[href]");
		focusable?.focus({ preventScroll: true });
	}, []);
	// A setting on another page: that page is shown first, and the jump is made once it is (a hidden element has no place).
	const [pending, setPending] = useState<SettingEntry | null>(null);
	const goToSetting = useCallback(
		(entry: SettingEntry) => {
			const el = scroller?.querySelector<HTMLElement>(entry.target);
			if (!el) return;
			const where = pageOfElement(el);
			if (where && where !== page) {
				setPending(entry);
				choosePage(where);
				return;
			}
			jump(entry, el);
		},
		[scroller, page, choosePage, jump],
	);
	useEffect(() => {
		if (!pending) return;
		const el = scroller?.querySelector<HTMLElement>(pending.target);
		if (!el || pageOfElement(el) !== page) return;
		setPending(null);
		jump(pending, el);
	}, [pending, page, scroller, jump]);
	// Which element a marked entry is: `entry.target` may match a wrapper (a fieldset, a card), so the mark is put on the
	// element the selector names and `data-marked` is read from it and from what is inside it.
	const markedEntry = marked ? SETTINGS.find((e) => e.id === marked) : undefined;
	useEffect(() => {
		if (!column || !markedEntry) return;
		const el = column.querySelector<HTMLElement>(markedEntry.target);
		if (!el) return;
		el.dataset.marked = "true";
		return () => {
			delete el.dataset.marked;
		};
	}, [column, markedEntry]);
	/** One page's cards: shown when it is the page, hidden (but there, for the search and for links to a card) otherwise. */
	const part = (id: SettingsPageId, children: ReactNode) => (
		<div
			data-settings-page={id}
			ref={id === page ? setShown : undefined}
			className={
				// A narrow page has two rows over its top (the pages, the cards): a chosen card starts under both.
				id === page ? "flex flex-col gap-6 [&>section]:scroll-mt-24 @min-[65rem]:[&>section]:scroll-mt-8" : "hidden"
			}
		>
			<h2 className="-mb-3 px-1 text-xs font-semibold tracking-wide text-muted uppercase">
				{t(SETTINGS_PAGE_LABEL[id])}
			</h2>
			{children}
		</div>
	);
	return (
		// `relative`: the page's visually hidden radios and checkboxes (`sr-only` is `position:absolute`) are placed against
		// this box; without it they sit against the app shell, beyond the window, and focusing one scrolls the shell.
		// `@container`: the index below lays itself out by this box's width, not the window's.
		<div ref={setScroller} className="@container relative h-full flex-1 overflow-y-auto" data-testid="settings-page">
			<div ref={setColumn} className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-8">
				<h1 className="flex items-center gap-2 text-xl font-semibold">
					<Settings className="text-accent" /> {t("pages.settingsTitle")}
				</h1>
				<SettingsIndex
					page={page}
					onPage={choosePage}
					entries={index.entries}
					current={index.current}
					onGo={index.go}
					scroller={scroller}
				/>
				<SettingsSearch onGo={goToSetting} />
				{part(
					"look",
					<>
						<section className="rounded-2xl border border-border bg-surface p-4">
							<CardHeader title={t("pages.settingsAppearance")} />
							<fieldset className="flex gap-2">
								<legend className="sr-only">{t("pages.settingsTheme")}</legend>
								{(
									[
										["light", Sun, t("pages.settingsThemeLight")],
										["dark", Moon, t("pages.settingsThemeDark")],
										["system", Monitor, t("pages.settingsThemeSystem")],
									] as const
								).map(([v, Icon, label]) => (
									<label
										key={v}
										className={cx(
											"flex flex-1 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-xl border px-2 py-3 text-sm sm:px-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
											theme === v ? "border-accent bg-accent-soft" : "border-border hover:bg-hover",
										)}
									>
										<input
											type="radio"
											name="theme"
											value={v}
											className="sr-only"
											checked={theme === v}
											onChange={() => {
												applyTheme(v);
												set({ theme: v });
											}}
										/>
										<Icon size={16} /> {label}
									</label>
								))}
							</fieldset>
							<PalettePicker />
							<div className="mt-3 flex flex-wrap items-center gap-3">
								<Button data-testid="reset-layout" className="shrink-0 whitespace-nowrap" onClick={resetAllWidths}>
									{t("pages.settingsResetLayout")}
								</Button>
								<span className="text-xs text-muted">{t("pages.settingsResetLayoutHint")}</span>
							</div>
						</section>
						{/* Which pages the sidebar and the rail offer, and where (#654): a chunk of its own, for the keyboard's way to what a drag does. */}
						<Suspense fallback={null}>
							<NavLayoutSettings />
						</Suspense>
						<section className="rounded-2xl border border-border bg-surface p-4">
							<CardHeader title={t("common.language")} />
							<Select
								data-testid="language"
								aria-label={t("common.language")}
								value={lang}
								onValueChange={(v) => void setLang(v as Lang)}
							>
								{LANGS.map((l) => (
									<option key={l.value} value={l.value}>
										{l.label}
									</option>
								))}
							</Select>
						</section>
						{/* Every keyboard binding (#639): its own chunk, and the card `?` opens Settings at. */}
						<Suspense fallback={null}>
							<ShortcutsSettings />
						</Suspense>
					</>,
				)}
				{part(
					"chats",
					<>
						<section className="rounded-2xl border border-border bg-surface p-4">
							<CardHeader title={t("pages.settingsConversations")} />
							<label className="flex cursor-pointer items-start gap-3 text-sm">
								<input
									type="checkbox"
									className="mt-1 accent-[var(--accent)]"
									data-testid="auto-title"
									checked={autoTitle}
									onChange={(e) => {
										setPref(PREF.autoTitle, e.target.checked ? "on" : "off");
										setAutoTitle(e.target.checked);
									}}
								/>
								<span>
									{t("pages.settingsAutoTitle")}
									<span className="block text-xs text-muted">{t("pages.settingsAutoTitleHint")}</span>
								</span>
							</label>
							<label className="mt-3 flex cursor-pointer items-start gap-3 text-sm">
								<input
									type="checkbox"
									className="mt-1 accent-[var(--accent)]"
									data-testid="keep-thinking"
									checked={keepThinkingOpen}
									onChange={(e) => {
										setPref(PREF.keepThinking, e.target.checked ? "on" : "off");
										set({ keepThinkingOpen: e.target.checked });
									}}
								/>
								<span>
									{t("pages.settingsKeepThinking")}
									<span className="block text-xs text-muted">{t("pages.settingsKeepThinkingHint")}</span>
								</span>
							</label>
							<ToolTimerSetting />
							<label className="mt-3 flex cursor-pointer items-start gap-3 text-sm">
								<input
									type="checkbox"
									className="mt-1 accent-[var(--accent)]"
									data-testid="notifications"
									checked={notify.enabled && notify.permission === "granted"}
									disabled={notify.permission === "unsupported" || notify.permission === "denied"}
									onChange={(e) => void setNotifications(e.target.checked)}
								/>
								<span>
									{t("pages.settingsNotify")}
									<span className="block text-xs text-muted" data-testid="notifications-hint">
										{notify.permission === "unsupported"
											? t(app ? "pages.settingsNotifyUnsupportedApp" : "pages.settingsNotifyUnsupported")
											: notify.permission === "denied"
												? t(app ? "pages.settingsNotifyBlockedApp" : "pages.settingsNotifyBlocked")
												: t(app ? "pages.settingsNotifyHintApp" : "pages.settingsNotifyHint")}
									</span>
								</span>
							</label>
							<UsageWaitSetting />
							{predictionUnavailable ? (
								<p className="mt-3 text-xs text-warning" data-testid="prediction-unavailable">
									<WithCode text={t("pages.settingsPredictionUnavailable")} />
								</p>
							) : null}
						</section>
						<Suspense fallback={null}>
							<QuickPromptsSettings />
						</Suspense>
						{/* Where omp compacts by itself: omp's own two settings, as `omp config` shows them in the terminal. */}
						<CompactAtSettings />
						{/* Where a compact queued while the agent works runs: when the turn ends, or between two steps (#651). */}
						<CompactWhereSettings />
						<DropSettings />
						{/* A page through the tunnel sees it and cannot change it: the setting is the person's at this computer. */}
						<Suspense fallback={null}>
							<ProjectsSettings />
						</Suspense>
						{/* Notifications when no page is open (Web Push): for a browser or a Home Screen app, not for the macOS app. */}
						<Suspense fallback={null}>
							<PushSettings />
						</Suspense>
					</>,
				)}
				{part(
					"models",
					<>
						<ModeSettings />
						<Accounts />
						<ModelConfigSettings />
						{/* What the main agent is told of how to use models for subagents (#641): templates picked in New chat. */}
						<Suspense fallback={null}>
							<GuidanceSettings />
						</Suspense>
						{/* The share of a provider's usage window that may be left before a working conversation is held (#652). */}
						<Suspense fallback={null}>
							<QuotaFloorSettings />
						</Suspense>
					</>,
				)}
				{part(
					"safety",
					<>
						<ApprovalSettings />
						{meta && !meta.remote ? (
							<Suspense fallback={null}>
								<GuardSettings />
							</Suspense>
						) : null}
						{/* What the agent is told while a conversation is unattended, and whether new ones start so (#646). */}
						<Suspense fallback={null}>
							<UnattendedSettings />
						</Suspense>
					</>,
				)}
				{part(
					"app",
					<>
						<OmpSettings />
						<UpdateSettings />
						<QuitSettings />
						<Suspense fallback={null}>
							<SleepSettings />
						</Suspense>
						<RemoteSettings />
						<Suspense fallback={null}>
							<MigrationSettings />
						</Suspense>
						<StarPromptSetting />
						<section className="rounded-2xl border border-border bg-surface p-4" data-setting="config">
							<CardHeader title={t("pages.settingsConfig")} hint={t("pages.settingsConfigHint")} />
							<div className="flex flex-wrap gap-2">
								<Button onClick={() => setView({ kind: "cli", command: "config" })}>omp config</Button>
								<Button onClick={() => setView({ kind: "cli", command: "models" })}>omp models</Button>
								<Button onClick={() => setView({ kind: "cli", command: "plugin" })}>omp plugin</Button>
								<Button onClick={() => setView({ kind: "cli", command: "login" })}>omp login</Button>
								<Button onClick={() => setView({ kind: "cli", command: "update" })}>omp update</Button>
							</div>
						</section>
						<section className="rounded-2xl border border-border bg-surface p-4" data-setting="running">
							<CardHeader title={t("pages.settingsRunning")} />
							{open.length ? (
								<ul className="divide-y divide-border text-sm">
									{open.map((l) => {
										const helper = isAccountsHelper(l.info, meta?.home);
										const name = helper
											? t("pages.settingsAccountsHelper")
											: ((l.info.sessionFile ? titles[l.info.sessionFile] : undefined) ??
												l.info.sessionFile?.split("/").pop() ??
												t("pages.settingsNewSession"));
										return (
											<li
												key={l.info.liveId}
												className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5"
												data-testid="running-session"
												data-helper={helper ? "accounts" : undefined}
											>
												<span
													className={cx(
														"h-2 w-2 shrink-0 rounded-full",
														l.info.pausedAt || l.info.quotaHold?.state === "held"
															? "bg-warning"
															: l.streaming
																? "animate-pulse bg-accent"
																: "bg-success",
													)}
												/>
												{/* The name keeps the row; on a phone the status and pid drop to a line of their own under it. */}
												<span className="min-w-0 flex-1 basis-40 truncate">{name}</span>
												<span className="order-last flex basis-full gap-2 pl-4 text-xs sm:order-none sm:basis-auto sm:pl-0">
													<span className="text-muted" data-testid="running-status">
														{helper
															? t("pages.settingsAccountsHelperStatus")
															: l.info.pausedAt
																? t("pages.settingsPaused")
																: l.info.quotaHold?.state === "held"
																	? t("pages.settingsQuotaHeld")
																	: l.streaming
																		? t("pages.settingsWorking")
																		: l.info.subscribers > 0
																			? t("pages.settingsWatched")
																			: t("pages.settingsIdle")}
													</span>
													<span className="text-faint">pid {l.info.pid}</span>
												</span>
												{/* A button that looks like one: as plain text, Close read as part of the row's status. */}
												<Button size="sm" onClick={() => closeLive(l.info.liveId)}>
													<span className="sr-only">{t("pages.settingsCloseProcess", { name })}</span>
													<span aria-hidden>{t("common.close")}</span>
												</Button>
											</li>
										);
									})}
								</ul>
							) : (
								<p className="text-sm text-muted">{t("pages.settingsNoProcesses")}</p>
							)}
							{open.some((l) => l.info.pausedAt) ? (
								<p className="mt-2 text-xs text-muted" data-testid="running-paused-note">
									{t("pages.settingsPausedNote")}
								</p>
							) : null}
						</section>
						{meta ? (
							<section className="space-y-1 rounded-2xl border border-border bg-surface p-4 text-xs text-muted">
								<div>{t("pages.settingsOmpVersion", { v: meta.ompVersion })}</div>
								<div>{t("pages.settingsWebVersion", { v: meta.serverVersion })}</div>
								<div className="break-all">{t("pages.settingsAgentDir", { v: meta.agentDir })}</div>
								<div className="break-all">{t("pages.settingsSessionsDir", { v: meta.sessionsDir })}</div>
							</section>
						) : null}
					</>,
				)}
			</div>
		</div>
	);
}
