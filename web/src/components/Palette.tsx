import * as Dialog from "@radix-ui/react-dialog";
import type { SearchHit } from "@shared/protocol.ts";
import type { QuickPrompt } from "@shared/quick-prompts.ts";
import { Command } from "cmdk";
import { Archive, ListChecks, MessageSquare, MessageSquarePlus, Search, Send, Target, Zap } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { api } from "../lib/api.ts";
import { errorText } from "../lib/error-text.ts";
import { fmtRelative } from "../lib/format.ts";
import { NAV_ITEMS } from "../lib/nav-layout.ts";
import { quickPromptSender } from "../lib/quick-prompt-bridge.ts";
import { promptName, quickPrompts } from "../lib/quick-prompts.ts";
import { requestGoal, useApp, type View } from "../store/app.ts";
import { conversationKey, conversationOfView, useShownGoal } from "../store/shown-goal.ts";
import { Snippet } from "./Snippet.tsx";
import { Badge, Button, ignoreToastRegion, useReturnFocus } from "./ui.tsx";

/** Who wrote a matched message, as the server names it. */
const ROLE_LABELS: Record<string, MessageKey> = {
	user: "shell.paletteRoleUser",
	assistant: "shell.paletteRoleAssistant",
	custom: "shell.paletteRoleCustom",
};

/** Why an archived conversation is missing from the sidebar; never wraps or shrinks, so rows keep their layout on a phone. */
function ArchivedTag({ label }: { label: string }) {
	return (
		<span data-testid="palette-archived" className="shrink-0 whitespace-nowrap">
			<Badge className="px-1 py-0 text-xs">{label}</Badge>
		</span>
	);
}

/** While the server is still indexing, a search is asked again this often. */
const INDEXING_RETRY_MS = 3000;
/** The rest of one conversation is asked for again this many times (`INDEXING_RETRY_MS` apart) while it is not all in the index. */
const FILE_INDEXING_RETRIES = 10;

export function Palette() {
	const t = useT();
	const { paletteOpen, set, sessions, setView, view, toast, remotePage } = useApp(
		useShallow((s) => ({
			paletteOpen: s.paletteOpen,
			set: s.set,
			sessions: s.sessions,
			setView: s.setView,
			view: s.view,
			toast: s.toast,
			remotePage: s.meta?.remote === true,
		})),
	);
	// Every page the bars can offer, wherever the person has put them (or hidden them): the palette is the way back to one.
	const navItems = NAV_ITEMS.filter((n) => !(remotePage && n.remoteHidden));
	const focus = useReturnFocus();
	const [q, setQ] = useState("");
	const [hits, setHits] = useState<SearchHit[]>([]);
	const [searching, setSearching] = useState(false);
	// How far the server's search index is, while it is still being built; null once it covers everything.
	const [indexing, setIndexing] = useState<{ indexed: number; total: number } | null>(null);
	// How far the index is with the one conversation whose other results were asked for, while it is not all of it: the
	// answer says what is in it so far, and the server is asked again (#509).
	const [fileIndexing, setFileIndexing] = useState<{ indexed: number; total: number; gaveUp: boolean } | null>(null);
	// Conversations whose full hit list replaced their capped one for the current query.
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	// Controlled so the highlight can move to the first newly revealed hit when a "more" row disappears.
	const [active, setActive] = useState("");
	const reveal = useRef<string | null>(null);
	const generation = useRef(0);
	// Why the search for the current query failed (nothing was answered for it yet); Retry asks again.
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	// What the current query has in flight (the search and any "more"): typing on abandons it, and the server drops it.
	const inflight = useRef<AbortController | null>(null);
	// The timer of a "more" that is asked again while the server is still indexing that one conversation.
	const expandTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const archived = useApp((s) => s.archived);
	// Where the conversation holds a goal the entry shows it (the Goal control opens it) instead of offering a new one.
	// The chat view publishes that answer for the conversation on screen (see `store/shown-goal.ts`), so this entry
	// cannot disagree with the header: a transcript's goal (set and paused in the terminal) counts as held too.
	const shown = useShownGoal();
	const goalHeldHere =
		view.kind === "chat" &&
		shown.goal !== null &&
		shown.of === conversationKey(view.file, conversationOfView(view).live);
	const archivedFiles = useMemo(() => new Set(archived), [archived]);
	useEffect(() => {
		if (!paletteOpen) {
			setQ("");
			setActive("");
		}
	}, [paletteOpen]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is Retry: it asks for the same query again.
	useEffect(() => {
		const query = q.trim();
		// Any answer started under an earlier query (a search or an expansion) is stale from here on.
		const mine = ++generation.current;
		const controller = new AbortController();
		inflight.current = controller;
		setExpanded(new Set());
		setIndexing(null);
		setFileIndexing(null);
		setError(null);
		if (!query) {
			setHits([]);
			setSearching(false);
			return;
		}
		setSearching(true);
		let timer: ReturnType<typeof setTimeout> | undefined;
		// This query has had an answer: a later failure leaves it on screen.
		let answered = false;
		const run = () => {
			api
				.search(query, undefined, controller.signal)
				.then((found) => {
					if (mine !== generation.current) return;
					answered = true;
					setError(null);
					setHits(found.hits);
					setIndexing(found.indexing);
					// A library the server is still indexing gets searched again, so hits from files indexed meanwhile show up.
					if (found.indexing) {
						timer = setTimeout(() => {
							setExpanded(new Set());
							run();
						}, INDEXING_RETRY_MS);
					}
				})
				.catch((e) => {
					if (mine !== generation.current) return;
					if (answered) {
						// A refresh while the server is still indexing: what is shown stays, and it is asked again.
						timer = setTimeout(() => {
							setExpanded(new Set());
							run();
						}, INDEXING_RETRY_MS);
						return;
					}
					// Not the empty answer: the hits of the query before are gone, and the person is told why.
					setHits([]);
					setError(errorText(e));
				})
				.finally(() => mine === generation.current && setSearching(false));
		};
		timer = setTimeout(run, 160);
		return () => {
			clearTimeout(timer);
			clearTimeout(expandTimer.current);
			controller.abort();
		};
	}, [q, attempt]);
	// Runs after cmdk has re-picked a highlight for the vanished "more" row, so this one wins.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `hits` is the trigger, not a value read here
	useEffect(() => {
		if (reveal.current === null) return;
		setActive(reveal.current);
		reveal.current = null;
	}, [hits]);
	const expand = (file: string) => {
		const query = q.trim();
		const mine = generation.current;
		const shown = new Set(hits.filter((h) => h.file === file).map((h) => h.entryId));
		const ask = (left: number): void => {
			api
				.search(query, file, inflight.current?.signal)
				.then((full) => {
					if (mine !== generation.current) return;
					const first = full.hits.find((h) => !shown.has(h.entryId));
					if (first) reveal.current = `h:${file}:${first.entryId}`;
					setExpanded((prev) => new Set(prev).add(file));
					setHits((prev) => {
						const at = prev.findIndex((h) => h.file === file);
						if (at < 0) return prev;
						const rest = prev.filter((h) => h.file !== file);
						rest.splice(at, 0, ...full.hits);
						return rest;
					});
					// The server answered from what it had of that conversation: the rest is asked again, so the row does
					// not stay a "N more" that is already there (#509).
					if (full.file) {
						// Not for ever: a conversation that stays out of the index (it was damaged, or the worker is wedged) is left as it is.
						setFileIndexing({ ...full.file, gaveUp: left === 0 });
						if (left > 0) expandTimer.current = setTimeout(() => ask(left - 1), INDEXING_RETRY_MS);
					} else setFileIndexing(null);
				})
				.catch((e) => {
					if (mine === generation.current) toast("error", t("shell.paletteMoreFailed", { error: errorText(e) }));
				});
		};
		ask(FILE_INDEXING_RETRIES);
	};
	const close = () => set({ paletteOpen: false });
	const go = (v: View) => {
		close();
		setView(v);
	};
	const lower = q.trim().toLowerCase();
	const titleMatches = sessions
		.filter((s) => s.messageCount > 0 && (!lower || (s.title ?? s.preview).toLowerCase().includes(lower)))
		.slice(0, lower ? 8 : 6);
	const item = "flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm data-[selected=true]:bg-hover";
	// Quick prompts (#659) go to the conversation on screen, through its message box's menu: none without one. A query
	// keeps those it names, like every other group: unfiltered, they stood above "no results", the first one picked for Enter.
	// It is matched against the row as drawn ("Send “Soft stop”"), so typing what is on screen finds it.
	const sendQuick = quickPromptSender();
	const quickLabel = (p: QuickPrompt) => t("quickPrompts.paletteItem", { name: promptName(p, t) });
	const quick = sendQuick ? quickPrompts().filter((p) => !lower || quickLabel(p).toLowerCase().includes(lower)) : [];
	// Setting a goal belongs to a conversation, or to New chat, which turns goal mode on.
	const goalLabel = t(goalHeldHere ? "chat.showGoal" : "chat.setGoal");
	const goalAction =
		(view.kind === "chat" || view.kind === "new") &&
		(!lower || [goalLabel, "goal"].some((s) => s.toLowerCase().includes(lower)));
	const feedbackAction =
		!lower || [t("feedback.navFeedback"), "feedback", "bug", "feature"].some((s) => s.toLowerCase().includes(lower));
	// Nothing to list for the query (yet): the list, a listbox, is left out rather than drawn with no option in it.
	const empty =
		Boolean(lower) && !goalAction && !feedbackAction && !quick.length && !titleMatches.length && !hits.length;
	return (
		<Dialog.Root open={paletteOpen} onOpenChange={(o) => set({ paletteOpen: o })}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" />
				<Dialog.Content
					className="fixed left-1/2 top-[14vh] z-50 w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
					aria-describedby={undefined}
					{...focus}
					{...ignoreToastRegion}
				>
					<Dialog.Title className="sr-only">{t("shell.paletteTitle")}</Dialog.Title>
					<Command shouldFilter={false} label={t("shell.paletteLabel")} value={active} onValueChange={setActive}>
						<div className="flex items-center gap-2 border-b border-border px-4 focus-within:border-accent focus-within:shadow-[inset_0_-1px_0_var(--accent)]">
							<Search size={16} className="text-faint" />
							<Command.Input
								value={q}
								onValueChange={setQ}
								placeholder={t("shell.palettePlaceholder")}
								className="h-12 flex-1 bg-transparent text-[15px] outline-none"
								data-testid="palette-input"
							/>
						</div>
						{/* A failed search is not "No results": the error says so below. */}
						{error === null ? (
							<Command.Empty className="p-6 text-center text-sm text-muted">
								{searching ? t("shell.paletteSearching") : t("shell.paletteNoResults")}
							</Command.Empty>
						) : null}
						{/* A rule and some air between groups: with nothing typed the go-to places, actions and quick prompts ran into one list. */}
						<Command.List
							className="max-h-[60vh] overflow-y-auto p-2 [&_[cmdk-group]+[cmdk-group]]:mt-1.5 [&_[cmdk-group]+[cmdk-group]]:border-t [&_[cmdk-group]+[cmdk-group]]:border-border [&_[cmdk-group]+[cmdk-group]]:pt-1.5"
							label={t("shell.paletteResults")}
							hidden={empty}
						>
							{!lower ? (
								<Command.Group
									heading={t("shell.paletteGoTo")}
									className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-faint"
								>
									<Command.Item className={item} onSelect={() => go({ kind: "new" })}>
										<MessageSquarePlus size={15} /> {t("shell.sidebarNewChat")}
									</Command.Item>
									{navItems.map((n) => (
										<Command.Item
											key={n.id}
											className={item}
											data-testid={`palette-go-${n.id}`}
											onSelect={() => go({ kind: n.id } as View)}
										>
											<n.icon size={15} /> {t(n.labelKey)}
										</Command.Item>
									))}
									{/* Not on the bars (#693: a conversation's are a tab of its panel), but every conversation's page is a place to go. */}
									<Command.Item
										className={item}
										data-testid="palette-go-questions"
										onSelect={() => go({ kind: "questions" })}
									>
										<ListChecks size={15} /> {t("shell.paletteQuestions")}
									</Command.Item>
									{/* The archive is a view of the sidebar (#707), not a page: open the sidebar there. None before a first conversation, which the sidebar has no list for. */}
									{sessions.some((s) => s.messageCount > 0) ? (
										<Command.Item
											className={item}
											data-testid="palette-go-archived"
											onSelect={() => {
												close();
												set({ sidebarOpen: true, sidebarArchived: true });
											}}
										>
											<Archive size={15} /> {t("shell.paletteGoArchived")}
										</Command.Item>
									) : null}
								</Command.Group>
							) : null}
							{goalAction || feedbackAction ? (
								<Command.Group
									heading={t("shell.paletteActions")}
									className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-faint"
								>
									{goalAction ? (
										<Command.Item
											className={item}
											data-testid="palette-goal"
											onSelect={() => {
												close();
												// After the palette has closed and handed focus back, so the goal dialog remembers where it came from.
												setTimeout(() => requestGoal(), 0);
											}}
										>
											<Target size={15} /> {goalLabel}
										</Command.Item>
									) : null}
									{feedbackAction ? (
										<Command.Item
											className={item}
											data-testid="palette-feedback"
											onSelect={() => {
												close();
												// Like the goal dialog: opened once the palette has handed focus back.
												setTimeout(() => set({ feedbackOpen: true }), 0);
											}}
										>
											<Send size={15} /> {t("feedback.navFeedback")}
										</Command.Item>
									) : null}
								</Command.Group>
							) : null}
							{quick.length ? (
								<Command.Group
									heading={t("quickPrompts.paletteGroup")}
									className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-faint"
								>
									{quick.map((p) => (
										<Command.Item
											key={p.id}
											value={`q:${p.id} ${promptName(p, t)}`}
											className={item}
											data-testid="palette-quick-prompt"
											onSelect={() => {
												close();
												sendQuick?.(p);
											}}
										>
											<Zap size={15} /> {quickLabel(p)}
										</Command.Item>
									))}
								</Command.Group>
							) : null}
							{titleMatches.length ? (
								<Command.Group
									heading={t("shell.paletteConversations")}
									className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-faint"
								>
									{titleMatches.map((s) => (
										<Command.Item
											key={s.file}
											value={`t:${s.file}`}
											className={item}
											onSelect={() => go({ kind: "chat", file: s.file, liveId: null })}
										>
											<MessageSquare size={15} className="shrink-0 text-faint" />
											<span className="min-w-0 flex-1 truncate">{s.title || s.preview}</span>
											{archivedFiles.has(s.file) ? <ArchivedTag label={t("shell.paletteArchived")} /> : null}
											<span className="shrink-0 text-xs text-faint">
												<span className="max-sm:hidden">{s.project} · </span>
												{fmtRelative(s.modifiedAt)}
											</span>
										</Command.Item>
									))}
								</Command.Group>
							) : null}
							{hits.length ? (
								<Command.Group
									heading={t("shell.paletteMessages")}
									className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-faint"
								>
									{hits.map((h) => (
										<Fragment key={`${h.file}:${h.entryId}`}>
											<Command.Item
												value={`h:${h.file}:${h.entryId}`}
												className={`${item} items-start`}
												data-testid="search-hit"
												onSelect={() => {
													close();
													setView({ kind: "chat", file: h.file, liveId: null, focus: h.entryId, focusAt: Date.now() });
												}}
											>
												<Search size={14} className="mt-0.5 shrink-0 text-faint" />
												<div className="min-w-0 flex-1">
													<div className="flex items-center gap-1.5">
														<span className="min-w-0 truncate text-xs font-medium">
															{h.title ?? t("shell.paletteUntitled")}
														</span>
														{archivedFiles.has(h.file) ? <ArchivedTag label={t("shell.paletteArchived")} /> : null}
													</div>
													{/* Three lines where the column is narrow: two cut the match off before its sentence said anything. */}
													<div className="line-clamp-3 text-xs text-muted sm:line-clamp-2">
														<span className="mr-1 text-faint">
															{Object.hasOwn(ROLE_LABELS, h.role) ? t(ROLE_LABELS[h.role]) : `${h.role}:`}
														</span>
														<Snippet text={h.snippet} />
													</div>
												</div>
											</Command.Item>
											{h.more && !expanded.has(h.file) ? (
												<Command.Item
													value={`m:${h.file}`}
													className={`${item} py-1.5 pl-9 text-xs text-muted`}
													data-testid="search-more"
													onSelect={() => expand(h.file)}
												>
													{t(h.more === 1 ? "shell.paletteMoreOne" : "shell.paletteMore", { n: h.more })}
												</Command.Item>
											) : null}
										</Fragment>
									))}
								</Command.Group>
							) : null}
						</Command.List>
						{error !== null && lower ? (
							<div
								role="alert"
								data-testid="palette-error"
								className="flex items-center gap-3 border-t border-border px-4 py-2 text-xs text-danger"
							>
								<span className="min-w-0 flex-1">{t("shell.paletteSearchFailed", { error })}</span>
								<Button size="sm" variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
									{t("common.retry")}
								</Button>
							</div>
						) : null}
						{indexing && lower ? (
							<div
								role="status"
								data-testid="palette-indexing"
								className="border-t border-border px-4 py-2 text-xs text-faint"
							>
								{t("shell.paletteIndexing", { done: indexing.indexed, total: indexing.total })}
							</div>
						) : null}
						{fileIndexing && lower ? (
							<div
								role="status"
								data-testid="palette-file-indexing"
								className="border-t border-border px-4 py-2 text-xs text-faint"
							>
								{t(fileIndexing.gaveUp ? "shell.paletteFileIndexingStopped" : "shell.paletteFileIndexing", {
									done: fileIndexing.indexed,
									total: fileIndexing.total,
								})}
							</div>
						) : null}
					</Command>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
