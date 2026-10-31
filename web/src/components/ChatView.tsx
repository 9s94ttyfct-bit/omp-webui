import * as Popover from "@radix-ui/react-popover";
import { hasTextFiles } from "@shared/attachment.ts";
import { goalHeld } from "@shared/goal.ts";
import { runsLocal } from "@shared/offline.ts";
import type { OpenTarget, PathAbove, SessionEntry, SessionFileData } from "@shared/protocol.ts";
import {
	ArrowDown,
	Download,
	FolderOpen,
	Layers,
	MoreHorizontal,
	PanelRight,
	Pencil,
	SlidersHorizontal,
	Target,
} from "lucide-react";
import {
	lazy,
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import "../i18n/later.ts";
import { t as translate, useT } from "../i18n/index.ts";
import { blobBase64, controls, downloadExport, sessionActions } from "../lib/api.ts";
import { unarchiveOnSend } from "../lib/archive.ts";
import { conversationBusy } from "../lib/busy.ts";
import { useChatBottom } from "../lib/chat-bottom.ts";
import { loadCommandNotes } from "../lib/command-notes.ts";
import { withHeldFollowUps } from "../lib/compact-queue.ts";
import { errorText } from "../lib/error-text.ts";
import { destinationFor, FamilyBuilder, familySignature, unwrittenOwnFile } from "../lib/family.ts";
import { glideToEnd, useFollowEnd } from "../lib/follow-end.ts";
import { fmtCost, fmtCostExact, fmtTokens, shortPath } from "../lib/format.ts";
import {
	createGoal,
	goalWait,
	guidedGoalActive,
	pendingProposal,
	startGuidedGoal,
	useGoalRequest,
} from "../lib/goal.ts";
import { loadGuardDecisions } from "../lib/guard-decisions.ts";
import { Carried, figuresOf, joinPrompts, NO_ABOVE, needsStats } from "../lib/history.ts";
import { attachedBytes, MAX_TOTAL_IMAGE_BYTES } from "../lib/images.ts";
import { openLoaded } from "../lib/loaded.ts";
import { MdOpenContext } from "../lib/md-open.ts";
import { useNarrowerThan } from "../lib/media.ts";
import { messageOf, type PromptImage, promptImages, roleOf, textOf } from "../lib/messages.ts";
import { useStartConfig } from "../lib/model-config.ts";
import { selectedThinking } from "../lib/models.ts";
import { providersUsed } from "../lib/quota.ts";
import { placeAnchor, type Reading, readAnchor, registerReader } from "../lib/reading.ts";
import { promptsOf } from "../lib/recall.ts";
import { interruptedTail, retryableTail } from "../lib/retry.ts";
import { useSavedApproval } from "../lib/saved-approval.ts";
import { savedGoal } from "../lib/saved-goal.ts";
import { savedSettings } from "../lib/session-settings.ts";
import { matches, typingInField } from "../lib/shortcuts.ts";
import { isCommand } from "../lib/slash.ts";
import type { StartLive } from "../lib/start-live.ts";
import { stopTurn, type Withdrawn } from "../lib/stop.ts";
import { isWorking } from "../lib/subagents.ts";
import type { HeaderUsage } from "../lib/totals.ts";
import { PathTracker } from "../lib/tree.ts";
import { recallable, userParts } from "../lib/user-message.ts";
import { ReplyError, socket } from "../lib/ws.ts";
import { openAgentForToolCall, useConversationTotals } from "../store/agents.ts";
import {
	abortBash,
	continueConversation,
	denyPendingApprovals,
	dismissOverlays,
	liveFor,
	NO_BASH,
	openLive,
	refreshEntries,
	refreshState,
	runBash,
	setPaused,
	useApp,
} from "../store/app.ts";
import { closeBig, useBig } from "../store/big.ts";
import { conversationOf, useGuard } from "../store/guard.ts";
import { useHistory } from "../store/history.ts";
import { isApproval, type LiveState, type OverlayMessage } from "../store/live.ts";
import { useMdEditor } from "../store/md-editor.ts";
import { clearGoal, conversationKey, showGoal } from "../store/shown-goal.ts";
import { ApprovalPicker } from "./ApprovalPicker.tsx";
import { ArchivedMark } from "./ArchivedMark.tsx";
import { ChatStatus, StatusMenuRows } from "./ChatStatus.tsx";
import { Composer, type ComposerDraft, type ComposerHandle, type ImageAttachment, type SendMode } from "./Composer.tsx";
import { ComposerMore } from "./ComposerMore.tsx";
import { ErrorBoundary, ErrorScreen } from "./ErrorBoundary.tsx";
import { GoalBar, GoalDialog } from "./Goal.tsx";
import { GuidedGoalBar } from "./GuidedGoal.tsx";
import { JobsBlock } from "./JobsBlock.tsx";
import { LoadError } from "./LoadError.tsx";
import { LoadedDialog } from "./LoadedPanel.tsx";
import type { MessageActions } from "./Message.tsx";
import { ModeBadge } from "./ModeBadge.tsx";
import { ModelPicker, ThinkingPicker } from "./ModelPicker.tsx";
import { PausedBanner, usePausedFocus } from "./PausedBanner.tsx";
import { PendingCommands } from "./PendingCommands.tsx";
import { PlanBadge } from "./PlanBadge.tsx";
import { PresetPicker } from "./PresetPicker.tsx";
import { Quota } from "./Quota.tsx";
import { ResumeFolderDialog } from "./ResumeFolderDialog.tsx";
import { ResumeModelDialog } from "./ResumeModelDialog.tsx";
import { RetryStatus } from "./RetryStatus.tsx";
import { RightPanel } from "./RightPanel.tsx";
import { SessionControls, type SessionControlsHandle } from "./SessionControls.tsx";
import { StopConfirm, StoppingNote, useStopConfirm } from "./StopConfirm.tsx";
import { TodoStrip } from "./TodoStrip.tsx";
import { Transcript, type TranscriptHandle } from "./Transcript.tsx";
import { UIRequests } from "./UIRequests.tsx";
import { UsageSplit } from "./UsageSplit.tsx";
import { Button, cx, IconButton, Modal, Spinner, Tip } from "./ui.tsx";

// No reviewer model could be reached ("Guard dangerous commands"): the strip that says so, with its strings, is a chunk of its own.
const GuardNotice = lazy(() => import("./GuardNotice.tsx"));
// Its omp runs without the gate, so the guard does not look at its risky calls: the strip that says so, and opens it again, is another.
const GuardUngated = lazy(() => import("./GuardUngated.tsx"));
// The guard's switch beside This session (v0.12.2): Off for this conversation alone and back; a chunk of its own, with the guard's strings.
const GuardToggle = lazy(() => import("./GuardToggle.tsx"));
// A conversation started from Settings › Ask agent for help: its badge, the time its access has left with Revoke now, and
// the security changes waiting for an Allow. A chunk of its own, with its strings; other conversations never load it.
const SettingsHelpBar = lazy(() => import("./SettingsHelp.tsx").then((m) => ({ default: m.SettingsHelpBar })));
// A file, or a file's change, opened large over the conversation's column (#635): the Files tab's own chunk, loaded when
// something is opened large and not before.
const BigView = lazy(() => import("./BigView.tsx"));
// A Markdown file open over the whole window, its source beside its rendering: the editor, its renderer and CodeMirror are a
// chunk of their own, loaded when a file is first opened in it (Mermaid and KaTeX later still, when a file needs them).
const MdEditor = lazy(() => import("./md/MdEditor.tsx"));
// The switch for unattended mode (#646) and the chip with the number of questions waiting: a chunk of its own, with its strings.
const UnattendedToggle = lazy(() => import("./UnattendedToggle.tsx"));
// Quick prompts (#659) and the built-in Soft stop (#658): a chunk of its own with its strings, edited in Settings.
const QuickPromptMenu = lazy(() => import("./QuickPromptMenu.tsx"));

interface Props {
	file: string | null;
	liveId: string | null;
	/** Branch leaf to show instead of the file's latest entry. */
	initialLeaf?: string;
	/** Entry to reveal (switching to its branch if needed), scroll to and highlight. */
	focus?: string;
	/** When `focus` was asked for: picking the same search hit again is a new request for the same entry. */
	focusAt?: number;
	/** Where the reader was in this conversation when they left it (Back): the messages shown, and the place in them. */
	reading?: Reading;
}

/** What the header shows of a conversation: everything it used, and each side's share when it has subagents. */
type Usage = HeaderUsage;

/** Below this width of the chat column the header swaps its readouts and buttons for one menu. */
const COMPACT_HEADER_PX = 704;

/** How long the place Back put the reader at is held while what is above it settles (pictures decode, code is coloured). */
const SETTLE_MS = 1000;

/** No streaming messages. A constant, not a new `[]` per render: the scroll effect lists it, and a new one runs it. */
const NO_OVERLAY: OverlayMessage[] = [];
/** No family loaded yet, no entries yet: one array each, so that what is derived from them is not derived again for a new `[]`. */
const NO_FAMILY: SessionFileData[] = [];
const NO_ENTRIES: SessionEntry[] = [];
const NO_PROVIDERS: string[] = [];

/** What shows while the large view's chunk is on its way: the column stays covered, and nothing of the conversation shows under it. */
function BigFallback() {
	return (
		<div className="absolute inset-0 z-10 flex items-center justify-center bg-bg" data-testid="big-fallback">
			<Spinner />
		</div>
	);
}

/**
 * Input, output, cache and cost of a conversation: the cost chip's tooltip, and what the phone menu lists. The tooltip is
 * where the exact cost belongs (`exactCost`); the menu writes it as every other cost is, the exact one in its title.
 */
function UsageBreakdown({ usage, className, exactCost }: { usage: Usage; className?: string; exactCost?: boolean }) {
	const t = useT();
	return (
		<div className={cx("font-mono", className)}>
			<div>{t("chat.usageInput", { n: usage.input.toLocaleString() })}</div>
			<div>{t("chat.usageOutput", { n: usage.output.toLocaleString() })}</div>
			<div>{t("chat.usageCacheRead", { n: usage.cacheRead.toLocaleString() })}</div>
			<div>{t("chat.usageCacheWrite", { n: usage.cacheWrite.toLocaleString() })}</div>
			<div title={exactCost ? undefined : fmtCostExact(usage.cost)}>
				{t("chat.usageCost", { cost: exactCost ? fmtCostExact(usage.cost) : fmtCost(usage.cost) })}
			</div>
			{usage.partial ? <div className="font-sans">{t("chat.usagePartial")}</div> : null}
			{usage.split ? <UsageSplit split={usage.split} /> : null}
		</div>
	);
}

/** Tokens and cost so far. With `tip`, hovering it shows the breakdown. */
function SessionCost({ usage, tip }: { usage: Usage; tip: boolean }) {
	const t = useT();
	const chip = (
		<span
			className="shrink-0 cursor-default whitespace-nowrap rounded-md bg-bg-soft px-2 py-1 text-xs tabular-nums text-muted"
			data-testid="session-cost"
			data-cost={usage.cost}
			data-partial={usage.partial ? "" : undefined}
		>
			{t("chat.sessionCost", {
				tokens: `${usage.partial ? "≥" : ""}${fmtTokens(usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.pending)}`,
				cost: `${usage.partial ? "≥" : ""}${fmtCost(usage.cost)}`,
			})}
		</span>
	);
	return tip ? <Tip label={<UsageBreakdown usage={usage} exactCost />}>{chip}</Tip> : chip;
}

/**
 * What a narrow header keeps behind one button: the readouts and buttons that sit beside the title when the chat
 * column has room for them (cost, session settings, rename, export, goal). The context share is not among them: the
 * status line under the composer shows it (#454).
 */
function HeaderMenu({
	usage,
	controls,
	onRename,
	onExport,
	onGoal,
	hasGoal,
	onLoaded,
	status,
}: {
	usage: Usage;
	/** What the gear opens: the process's settings, which it starts omp for when none runs (see `StartLive`). */
	controls: { live: LiveState | undefined; start: StartLive } | undefined;
	onRename: (() => void) | undefined;
	onExport: (() => void) | undefined;
	onGoal: () => void;
	/** A goal exists: the row shows it instead of offering to set one. */
	hasGoal: boolean;
	onLoaded: () => void;
	/** The status line's items a narrow column folds into the menu. */
	status: ReactNode;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const after = useRef<(() => void) | null>(null);
	const menu = useRef<HTMLDivElement>(null);
	// The session panel opens from the menu's button once the menu has closed, not beside it (it would sit behind the panel).
	const button = useRef<HTMLSpanElement>(null);
	const panel = useRef<SessionControlsHandle>(null);
	const row = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-sm hover:bg-hover";
	/**
	 * Close the menu, then open a dialog: once Radix has given focus back to the menu button, so the dialog
	 * remembers it as its opener and returns focus there.
	 */
	const afterClose = (action: () => void) => {
		after.current = action;
		setOpen(false);
	};
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<span ref={button} className="inline-flex shrink-0">
				<Popover.Trigger asChild>
					<IconButton label={t("chat.moreActions")} active={open} data-testid="chat-more">
						<MoreHorizontal size={16} />
					</IconButton>
				</Popover.Trigger>
			</span>
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={6}
					collisionPadding={8}
					ref={menu}
					aria-label={t("chat.moreActions")}
					className="z-50 w-72 max-w-[calc(100vw-1rem)] rounded-2xl border border-border bg-surface p-2 shadow-2xl outline-none"
					data-testid="chat-more-panel"
					// Focus the menu itself: its first button would open its tooltip over the figures. Tab reaches the buttons.
					onOpenAutoFocus={(e) => {
						e.preventDefault();
						menu.current?.focus();
					}}
					onCloseAutoFocus={() => {
						const action = after.current;
						after.current = null;
						if (action) setTimeout(action, 0);
					}}
				>
					<div className="space-y-2 px-2 pt-1 pb-2">
						<div className="flex items-center justify-between">
							<div className="text-sm font-semibold">{t("panel.controlsTitle")}</div>
							{controls ? (
								<IconButton
									label={t("panel.controlsTrigger")}
									data-testid="session-controls"
									onClick={() => afterClose(() => panel.current?.open())}
								>
									<SlidersHorizontal size={16} />
								</IconButton>
							) : null}
						</div>
						<SessionCost usage={usage} tip={false} />
						<UsageBreakdown usage={usage} className="grid grid-cols-2 gap-x-3 text-xs text-muted" />
						{status}
					</div>
					<div className="border-t border-border pt-1">
						{onRename ? (
							<button type="button" className={row} onClick={() => afterClose(onRename)}>
								<Pencil size={15} /> {t("common.rename")}
							</button>
						) : null}
						{onExport ? (
							<button
								type="button"
								className={row}
								data-testid="export-html"
								onClick={() => {
									setOpen(false);
									onExport();
								}}
							>
								<Download size={15} /> {t("chat.exportHtml")}
							</button>
						) : null}
						<button type="button" className={row} data-testid="open-goal" onClick={() => afterClose(onGoal)}>
							<Target size={15} /> {t(hasGoal ? "chat.showGoal" : "chat.setGoal")}
						</button>
						<button type="button" className={row} data-testid="open-loaded" onClick={() => afterClose(onLoaded)}>
							<Layers size={15} /> {t("loaded.title")}
						</button>
					</div>
				</Popover.Content>
			</Popover.Portal>
			{controls ? <SessionControls ref={panel} anchor={button} live={controls.live} start={controls.start} /> : null}
		</Popover.Root>
	);
}

/**
 * The images of a prompt entry as `prompt` takes them, for sending the prompt again (Edit, Regenerate).
 * Loaded before anything is branched, so a failure leaves the conversation as it was.
 */
async function attachmentsOf(entry: SessionEntry): Promise<PromptImage[]> {
	const m = messageOf(entry);
	if (!m) return [];
	let images: PromptImage[];
	try {
		images = await promptImages(m, blobBase64);
	} catch (e) {
		throw new Error(translate("chat.errImageLoad", { error: (e as Error).message }));
	}
	// The server drops a WebSocket message that is too large; say so instead of losing the connection.
	if (attachedBytes(images) > MAX_TOTAL_IMAGE_BYTES)
		throw new Error(translate("chat.errImagesTooLarge", { mb: MAX_TOTAL_IMAGE_BYTES / (1024 * 1024) }));
	return images;
}

/** Asked at the moment of an action, from the store: the render it was clicked in can be a state behind. */
function assertIdle(id: string): void {
	const s = useApp.getState();
	if (conversationBusy(s.lives[id], s.bash[id] ?? NO_BASH)) throw new Error(translate("chat.errBusyBranch"));
}

/**
 * Text (and pictures, and attached text files) put back in the composer: what a branch that was made, a prompt that was
 * refused and a queue withdrawn by Stop would lose. The files' blocks leave the text and come back as attachments.
 */
function toDraft(text: string, images: PromptImage[]): ComposerDraft {
	const { typed, files } = userParts(text);
	return {
		text: typed,
		images: images.map((img) => ({ ...img, name: "image", id: crypto.randomUUID() })),
		files: files.map(({ name, bytes, text }) => ({ type: "text", name, bytes, text, id: crypto.randomUUID() })),
		nonce: Date.now(),
	};
}

export function ChatView({ file, liveId: liveIdProp, initialLeaf, focus, focusAt, reading }: Props) {
	const t = useT();
	const setView = useApp((s) => s.setView);
	const toast = useApp((s) => s.toast);
	const meta = useApp((s) => s.meta);
	const sessions = useApp((s) => s.sessions);
	const panelOpen = useApp((s) => s.panelOpen);
	const set = useApp((s) => s.set);
	const archived = useApp((s) => s.archived);
	// The process of the conversation on screen: the one named, else the one running its file. Only its own changes
	// redraw this view: a frame of another conversation's process is none of its business.
	const live: LiveState | undefined = useApp(
		(s) =>
			(liveIdProp ? s.lives[liveIdProp] : undefined) ??
			(file ? Object.values(s.lives).find((l) => !l.info.exited && l.info.sessionFile === file) : undefined),
	);
	const liveId = live && !live.info.exited ? live.info.liveId : null;
	const currentFile = live?.info.sessionFile ?? file;
	// What commands printed here: the process's list while this page has one for it, else what this browser kept of the file.
	const noLive = live === undefined;
	const savedNotes = useMemo(() => (noLive ? loadCommandNotes(currentFile) : []), [noLive, currentFile]);
	const commandNotes = live?.commandOutput ?? savedNotes;
	const [attempt, setAttempt] = useState(0);
	// The branch leaf being viewed, scoped to the file it belongs to (resets when the file changes).
	const [pinned, setPinned] = useState<{ file: string | null; leaf: string } | null>(
		initialLeaf ? { file, leaf: initialLeaf } : null,
	);
	const viewLeaf = pinned && pinned.file === currentFile ? pinned.leaf : null;
	const setViewLeaf = useCallback(
		(leaf: string | null) => setPinned(leaf ? { file: currentFile, leaf } : null),
		[currentFile],
	);
	const [busy, setBusy] = useState(false);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [goalOpen, setGoalOpen] = useState(false);
	const [goalMode, setGoalMode] = useState<"guided" | "direct">("guided");
	/** The goal whose details the bar shows (a goal omp holds is shown, not offered again: see `openGoal`). */
	const [expandedGoal, setExpandedGoal] = useState<string | null>(null);
	const heldGoalId = useRef<string | null>(null);
	const openGoal = useCallback((mode: "guided" | "direct" = "guided") => {
		if (heldGoalId.current) {
			setExpandedGoal(heldGoalId.current);
			return;
		}
		setGoalMode(mode);
		setGoalOpen(true);
	}, []);
	useGoalRequest(openGoal);
	const [draft, setDraft] = useState<ComposerDraft | null>(null);
	const summary = sessions.find((s) => s.file === currentFile);
	const isArchived = currentFile !== null && archived.includes(currentFile);
	// The header has the room of this column, not of the window: the sidebar and the side panel take some of it.
	const [column, setColumn] = useState<HTMLDivElement | null>(null);
	const compact = useNarrowerThan(column, COMPACT_HEADER_PX);
	// A file, or a file's change, open large over this column (`BigView`): the panel opens it, and it is kept for this
	// conversation alone — the key the panel's tree is kept under (see `store/big.ts`).
	const chatKey = currentFile ?? liveId ?? "";
	const big = useBig((s) => (s.chatKey === chatKey ? s.target : null));
	// The Markdown editor, kept for this conversation as the large view is (see `store/md-editor.ts`), and what a path in its
	// messages (or a Markdown file of its folder) opens it with.
	const mdPath = useMdEditor((s) => (s.target?.chatKey === chatKey ? s.target.path : null));
	const folderScope = useMemo(() => ({ live: liveId, file: currentFile }), [liveId, currentFile]);
	const mdOpen = useMemo(() => ({ scope: folderScope, chatKey, base: "" }), [folderScope, chatKey]);

	// Load the lineage family when the file changes, or a conversation of the family does (a branch is written or removed,
	// another omp process appends to one): not for a write anywhere else, nor to the live file, whose entries arrive here.
	// And not for a file omp has named but not written yet (a new chat before its first assistant message): the server
	// answers 404, so the page waits until the session list holds the file, which changes `familyKey`.
	const fromLive = Boolean(live?.info.sessionFile) && live?.info.sessionFile === currentFile;
	const sessionsLoaded = useApp((s) => s.sessionsLoaded);
	const unwritten = useMemo(
		() => currentFile !== null && unwrittenOwnFile(sessions, sessionsLoaded, currentFile, fromLive),
		[sessions, sessionsLoaded, currentFile, fromLive],
	);
	const familyKey = useMemo(
		() => (currentFile ? familySignature(sessions, currentFile, fromLive ? currentFile : null) : ""),
		[sessions, currentFile, fromLive],
	);
	// The history: the end of the conversation's path, and the pages above or below it as the reader goes there (see
	// `store/history.ts`). A conversation opens on its end; the entry a search hit or Back names opens its window instead.
	// The family is asked for again when a conversation of it changed or joined it (`familyKey`), and when Retry says so.
	const hist = useHistory({
		file: currentFile,
		leaf: viewLeaf,
		at: focus ?? null,
		resume: reading?.anchor?.segment ?? null,
		unwritten,
		missingOk: fromLive,
		refetchKey: sessionsLoaded ? familyKey : null,
		attempt,
		process: live?.entries,
	});
	const family = hist.members;
	const loadError = hist.error;
	// A window opened around an entry on another branch than the file's last: that branch is the one on screen.
	const adopted = hist.adopted;
	useEffect(() => {
		if (adopted) setViewLeaf(adopted);
	}, [adopted, setViewLeaf]);
	// The URL named the file through a symlink: continue under omp's canonical path.
	useEffect(() => {
		if (hist.canonical && currentFile && hist.canonical !== currentFile && !liveId)
			setView({ kind: "chat", file: hist.canonical, liveId: null }, { replace: true });
	}, [hist.canonical, currentFile, liveId, setView]);

	// What "Guard dangerous commands" decided about this conversation's calls (and its branches'), so that the cards of calls
	// decided before this page opened it show their verdict; the decisions that come while it is open arrive on the socket.
	// They are asked for by transcript file, which is all a decision names: no transcript is read for it.
	const remotePage = useApp((s) => s.meta?.remote === true);
	useEffect(() => {
		loadGuardDecisions(currentFile, remotePage);
		for (const member of family ?? []) loadGuardDecisions(member.file, remotePage);
	}, [family, currentFile, remotePage]);
	// No reviewer could be reached in this conversation: the strip that says so is drawn here, and in none that it is not about.
	const guardHomes = useMemo(
		() => [
			...new Set([currentFile, ...(family ?? []).map((m) => m.file)].flatMap((f) => (f ? [conversationOf(f)] : []))),
		],
		[family, currentFile],
	);
	const guardUnavailable = useGuard((s) => guardHomes.some((h) => h in s.unavailable));

	// The family goes on from where it was as the live file grows (see `FamilyBuilder`), and so do the paths drawn from it.
	const familyBuilder = useMemo(() => new FamilyBuilder(), []);
	const fam = useMemo(
		() =>
			familyBuilder.update(
				family ?? NO_FAMILY,
				live?.info.sessionFile ?? null,
				live?.entries ?? NO_ENTRIES,
				hist.extras,
			),
		[familyBuilder, family, live?.info.sessionFile, live?.entries, hist.extras],
	);
	const headLeaf = live?.leafId ?? (currentFile ? (fam.headOf.get(currentFile) ?? null) : null);
	// What is shown ends at the leaf asked for, or the file's last entry; a stretch that stops short of it (the window around
	// a search hit) ends where it does; a leaf that is not held yet (another branch is on its way) leaves the old one.
	const wanted = viewLeaf ?? headLeaf;
	const leaf = hist.later ? hist.shown : wanted && fam.idx.byId.has(wanted) ? wanted : (hist.shown ?? wanted);
	const pathTracker = useMemo(() => new PathTracker(), []);
	const path = useMemo(() => pathTracker.path(fam.idx, leaf), [pathTracker, fam, leaf]);
	// What the entries above the stretch leave, for what is read from the whole path (the goal, the model, the providers).
	const above: PathAbove = hist.held?.above ?? NO_ABOVE;
	const carried = useMemo(() => new Carried(), []);
	const wholePath = useMemo(() => carried.derive(above.carry, path), [carried, above.carry, path]);
	// What the controls show of the conversation (the goal, the model, the thinking level) is what the path ends with: a stretch
	// that stops short of its leaf says so by what the server says the path leaves (`end`), not by its own last entries.
	const endCarry = hist.later ? (hist.held?.end?.carry ?? null) : null;
	// The running omp's goal; before omp runs here (a goal set in the terminal), the one the transcript leaves.
	const fromFile = useMemo(() => savedGoal(endCarry ?? wholePath), [endCarry, wholePath]);
	const goalHere = (liveId ? live?.goal : null) ?? fromFile;
	const goalOpenNow = goalHeld(goalHere);
	// Where a goal exists the Goal control shows it (the bar, opened in place) instead of offering to create one.
	heldGoalId.current = goalOpenNow && goalHere ? goalHere.id : null;
	const goalExpanded = Boolean(goalHere && goalOpenNow && goalHere.id === expandedGoal);
	const toggleGoal = () => {
		if (goalHere && goalOpenNow) setExpandedGoal(goalExpanded ? null : goalHere.id);
		else openGoal();
	};
	const toolResults = fam.toolResults;
	// What the chip's figures are added to: the process's entries when this page has any, else the stretch's (the history asks
	// for the figures of the whole file until they join these, `useHistory`).
	const fileEntries = hist.figureEntries;
	// What the server adds the whole file up to, when the page holds only a part of it: the cost, the time worked, the models.
	// A stretch that stops short of the end is inside them, and so is added nothing (see `figuresOf`).
	const held = hist.held;
	const figures = useMemo(() => (held ? figuresOf(held, fileEntries) : null), [held, fileEntries]);
	// Everything the conversation used: its own requests, its subagents' and its advisors' (`totals.main` / `.subagents` / `.advisor`).
	const totals = useConversationTotals(currentFile, live, fileEntries, figures);
	// Until the figures of the whole file have arrived (or when they could not be had) the chip adds up what the page holds, and says so.
	const partial = Boolean(held && needsStats(held) && !figures);
	const usage: Usage = useMemo(() => (partial ? { ...totals.usage, partial } : totals.usage), [totals.usage, partial]);
	const streaming = Boolean(live?.streaming);
	// What waits for the end of the turn behind a queued compact is the server's (see `LiveInfo.compactQueued`), and is shown with omp's own queue.
	const queue = useMemo(
		() => withHeldFollowUps(live?.queue, live?.info.compactQueued),
		[live?.queue, live?.info.compactQueued],
	);
	// A queued compact ended (see `LiveInfo.compactEnded`): the compaction is in the transcript now, and this page says how it went.
	// What it finds when it mounts, or when it moves to another conversation, ended before it looked and is not said again.
	const compactEnded = live?.info.compactEnded;
	const endedSeen = useRef<{ liveId: string | null; at: number | undefined } | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `compactEnded` is read through its `at`.
	useEffect(() => {
		const at = compactEnded?.at;
		const seen = endedSeen.current;
		endedSeen.current = { liveId, at };
		if (!liveId || !compactEnded || seen?.liveId !== liveId || seen.at === at) return;
		void refreshEntries(liveId);
		void refreshState(liveId);
		void import("../lib/queued-compact.ts").then((m) => m.noteQueuedCompactEnd(compactEnded, toast));
	}, [liveId, compactEnded?.at, toast]);
	// A tool approval waits: a message typed now denies it, and the composer says so before the user sends one.
	const approvalPending = Boolean(live?.uiRequests.some(isApproval));
	/** Any request omp waits on: it is on the screen above the composer, which is what the bottom block makes room for. */
	const asking = Boolean(live?.uiRequests.length);
	const overlay = live?.overlay ?? NO_OVERLAY;

	// The one answer to "does this conversation hold a goal": the header's control, the ⋯ menu's row and the command
	// palette's entry read it, so they cannot offer a goal omp would refuse (see `store/shown-goal.ts`). It is
	// published for the conversation on screen, and taken back when the page leaves it.
	const goalKey = conversationKey(currentFile, live);
	useEffect(() => {
		showGoal(goalHere, goalKey);
		return () => clearGoal(goalKey);
	}, [goalHere, goalKey]);

	// ------------------------------------------------------------------ actions

	const [modelPrompt, setModelPrompt] = useState<{ reason: string; resolve: (model: string | null) => void } | null>(
		null,
	);
	const [folderPrompt, setFolderPrompt] = useState<{
		reason: string;
		start: string;
		resolve: (folder: string | null) => void;
	} | null>(null);
	const deadCwd = live?.info.cwd;
	/** Start omp from the conversation's saved file, and show the conversation on the process that resumed it. */
	const resumeLive = useCallback(async (): Promise<string> => {
		if (!currentFile) throw new Error(translate("chat.errNoSession"));
		// The exited process's cwd lets the server start over if its session file was never written.
		let target: OpenTarget & { kind: "resume" } = { kind: "resume", sessionFile: currentFile, cwd: deadCwd };
		let id: string | undefined;
		while (id === undefined) {
			try {
				id = await openLive(target);
			} catch (e) {
				const message = (e as Error).message;
				// The folder the conversation ran in is gone: omp's tools would run wherever it is started, so ask where.
				if (
					e instanceof ReplyError &&
					(e.code === "sessionFolderGone" || e.code === "sessionFolderUnknown") &&
					target.folder === undefined
				) {
					const choice = Promise.withResolvers<string | null>();
					setFolderPrompt({ reason: errorText(e), start: String(e.params?.nearest ?? ""), resolve: choice.resolve });
					const folder = await choice.promise;
					setFolderPrompt(null);
					if (!folder) throw new Error(translate("chat.errResumeCancelled"));
					target = { ...target, folder };
				} else if (/Could not restore model/i.test(message) && target.model === undefined) {
					// omp refuses to resume when the saved model can't be restored; let the user pick another.
					const choice = Promise.withResolvers<string | null>();
					setModelPrompt({ reason: message.replace(/^.*?error:\s*/i, ""), resolve: choice.resolve });
					const model = await choice.promise;
					setModelPrompt(null);
					if (!model) throw new Error(translate("chat.errResumeCancelled"));
					target = { ...target, model };
				} else throw e;
			}
		}
		const file = useApp.getState().lives[id]?.info.sessionFile ?? currentFile;
		// Resuming can take seconds; if the user moved on meanwhile, don't pull them back.
		const now = useApp.getState().view;
		const stillHere =
			now.kind === "chat" &&
			((now.file !== null && now.file === currentFile) || (liveIdProp !== null && now.liveId === liveIdProp));
		if (stillHere) setView({ kind: "chat", file, liveId: id });
		return id;
	}, [liveIdProp, currentFile, deadCwd, setView]);
	const ensureLive = useCallback(async (): Promise<string> => liveId ?? (await resumeLive()), [liveId, resumeLive]);

	/**
	 * Open the conversation again, now that its omp has ended: the same file is resumed in a new process, which is
	 * what sending a message would do anyway, but said outright (#472). A failure is a toast, not a dead button.
	 */
	const reopen = useCallback(async (): Promise<void> => {
		try {
			await resumeLive();
		} catch (e) {
			// The failure is told here, where it can be read; it is not raised again, so that the page has no
			// unhandled rejection besides the toast (#516).
			toast("error", translate("chat.endedReopenFailed", { error: (e as Error).message }));
		}
	}, [resumeLive, toast]);

	/** Run an action with the busy state; errors become a toast. Resolves to whether it succeeded. */
	const run = useCallback(
		async (label: string, fn: () => Promise<void>): Promise<boolean> => {
			setBusy(true);
			try {
				await fn();
				return true;
			} catch (e) {
				toast("error", translate("chat.runError", { label, error: (e as Error).message }));
				return false;
			} finally {
				setBusy(false);
			}
		},
		[toast],
	);

	/**
	 * Start this conversation's omp anew from its saved file, for what omp reads only at startup (its MCP servers).
	 * Only while it is idle: the server refuses otherwise, and nothing is cut off. Resolves to whether it restarted.
	 */
	const restartOmp = useCallback(async (): Promise<boolean> => {
		if (!liveId) return false;
		return run(translate("chat.errRestart"), async () => {
			await controls.endIfIdle(liveId);
			await resumeLive();
		});
	}, [liveId, run, resumeLive]);

	/**
	 * Start omp for a click on a control (the pickers, the session settings, the Ask tab) where none runs: one start at a
	 * time, so a double click, or two controls clicked in a row, share it. Resolves to the process's id, or null when it
	 * did not start (the toast says why) or the user declined to choose another model for it.
	 */
	const starting = useRef<Promise<string | null> | null>(null);
	const startLive = useCallback((): Promise<string | null> => {
		starting.current ??= (async () => {
			let id: string | null = null;
			await run(translate("chat.errResume"), async () => {
				id = await ensureLive();
			});
			return id;
		})().finally(() => {
			starting.current = null;
		});
		return starting.current;
	}, [run, ensureLive]);
	// What a conversation without a running omp shows in its controls: what its transcript and the server leave.
	const headTracker = useMemo(() => new PathTracker(), []);
	const headCarried = useMemo(() => new Carried(), []);
	const headEndCarry = viewLeaf && viewLeaf !== headLeaf ? (hist.held?.headEnd?.carry ?? null) : null;
	const headPath = useMemo(() => {
		const carry = headEndCarry ?? endCarry;
		if (carry) return carry;
		if (headLeaf === leaf || !headLeaf || !fam.idx.byId.has(headLeaf)) return wholePath;
		return headCarried.derive(above.carry, headTracker.path(fam.idx, headLeaf));
	}, [headTracker, headCarried, fam, headLeaf, leaf, wholePath, above.carry, endCarry, headEndCarry]);
	const saved = useMemo(() => savedSettings(headPath), [headPath]);
	const shownModel = live?.state?.model ?? saved.model;
	const thinking = selectedThinking(live, saved.thinking, useStartConfig(live));
	const savedApproval = useSavedApproval(currentFile, !liveId);
	/** The controls that need omp can be used: omp runs, or can be started from the conversation's file. */
	const canAct = Boolean(liveId || currentFile);

	/** Make the process's leaf match what the user is looking at before continuing. */
	const alignLeaf = useCallback(
		async (id: string) => {
			if (!viewLeaf || viewLeaf === headLeaf) return;
			const lastMsg = [...path].reverse().find((e) => e.type === "message");
			if (lastMsg) await socket.rpc(id, { type: "fork", entryId: lastMsg.id });
			setViewLeaf(null);
		},
		[viewLeaf, headLeaf, path, setViewLeaf],
	);

	const bash = useApp((s) => (liveId ? (s.bash[liveId] ?? NO_BASH) : NO_BASH));
	const bashRunning = bash.length > 0;
	// A subagent that works keeps the conversation busy after the turn that started it is over (a wait for a provider's usage
	// limit lasts for hours): Stop ends it too, so it is offered for it.
	const subagentsWorking = useMemo(
		() => Object.values(live?.subagents ?? {}).some((s) => isWorking(s.status)),
		[live?.subagents],
	);
	const paused = Boolean(live?.info.pausedAt);
	// Pausing takes the Pause button away and puts the banner up, so focus goes to Resume; resuming goes back to the composer.
	const resumeButton = useRef<HTMLButtonElement>(null);
	const composer = useRef<ComposerHandle>(null);
	usePausedFocus(liveId, paused, resumeButton, composer);
	const chatBottom = useChatBottom();
	const scroller = useRef<HTMLDivElement>(null);
	const transcript = useRef<TranscriptHandle>(null);
	/** Whether the reader follows the end (`following` is `atBottom` a render sooner: a resize does not wait for one). */
	const { following, atEnd: atBottom, setAtEnd: setAtBottom, pin, scrolled, settle } = useFollowEnd();
	/** Show the end of the conversation and stay with it as it grows: what sending a message does, wherever the reader was. */
	const pinToBottom = useCallback(() => {
		setAtBottom(true);
		// A window around a search hit does not reach the end: the latest messages take its place.
		transcript.current?.showLatest();
		const el = scroller.current;
		if (el) pin(el);
	}, [setAtBottom, pin]);
	const send = useCallback(
		async (text: string, images: ImageAttachment[], mode: SendMode): Promise<boolean> => {
			// The message and the reply that follow it belong on screen, however far up the reader was.
			pinToBottom();
			// The composer gets its draft back when this resolves false.
			return run(translate("chat.errSend"), async () => {
				const id = await ensureLive();
				unarchiveOnSend(useApp.getState().lives[id]?.info.sessionFile);
				// Sending to a paused conversation continues it first.
				if (useApp.getState().lives[id]?.info.pausedAt) await setPaused(id, false);
				// A !command always runs as a command, whatever the mode: omp would send it to the model as text otherwise.
				// With pictures or attached text files it is a message (omp's bash takes neither).
				const withFiles = hasTextFiles(text);
				if (text.startsWith("!") && !images.length && !withFiles) {
					await alignLeaf(id);
					// Runs in the background: the composer stays usable and Stop cancels it.
					runBash(id, text.slice(1).trim());
					return;
				}
				const imgs = images.map(({ type, data, mimeType }) => ({ type, data, mimeType }));
				// omp holds a message behind an open tool approval and the turn stalls, so the approval is denied once the
				// message is on its way, as the terminal does. The denial comes after the send: a send that failed was no
				// message, and denying then would be a denial the user never asked for.
				// A slash command is not that message: omp runs it at once and the approval stays.
				const denies = mode !== "normal" && !isCommand(text, imgs.length > 0 || withFiles, live?.commands ?? []);
				if (mode === "steer") await socket.rpc(id, { type: "steer", message: text, images: imgs });
				else if (mode === "followUp")
					await socket.rpc(id, { type: "prompt", message: text, images: imgs, streamingBehavior: "followUp" });
				else {
					await alignLeaf(id);
					const r = await socket.rpc<{ agentInvoked?: boolean } | undefined>(id, {
						type: "prompt",
						message: text,
						images: imgs,
					});
					if (r && r.agentInvoked === false && text.startsWith("/")) void refreshEntries(id);
				}
				if (denies) denyPendingApprovals(id);
			});
		},
		[ensureLive, alignLeaf, run, pinToBottom, live?.commands],
	);

	// Stop was pressed and the conversation has not stopped yet (see `stopAll`): for which conversation, and for the page.
	const stoppingFor = useRef<string | null>(null);
	const [stopping, setStopping] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: another conversation is another Stop.
	useEffect(() => {
		stoppingFor.current = null;
		setStopping(false);
	}, [liveId]);

	/** Stop like the TUI's Esc: withdraw queued input into the composer, then abort (no turn starts from the old queue). */
	const stop = useCallback(
		async (id: string) => {
			// What the page shows as queued: if omp has to be ended, what it held of it goes with it, and is put back from here.
			const queued = useApp.getState().lives[id]?.queue;
			try {
				const r = await stopTurn((command) => socket.stop(id, command));
				// A press that joined a Stop another page ran is told how it went, not what came back of the queue: that page puts it in
				// its message box, and two boxes would hold the same text.
				// What the server held behind a queued compact comes back with the rest (`r.followUp`): after a Stop that had to end omp too.
				const items: Withdrawn[] = r?.joined
					? []
					: r?.ended
						? [
								...[...(queued?.steering.slice(queued.liveSteered ?? 0) ?? []), ...(queued?.followUp ?? [])].map(
									(text) => ({ text }),
								),
								...(r.followUp ?? []),
							]
						: [...(r?.steering ?? []), ...(r?.followUp ?? [])];
				if (!items.length) return;
				setDraft(
					toDraft(
						items.map((w) => w.text).join("\n\n"),
						items.flatMap((w) => w.images ?? []),
					),
				);
				if (r?.truncated) toast("warning", translate("chat.toastQueueTruncated"));
			} catch (e) {
				toast("error", translate("chat.errStop", { error: (e as Error).message }));
			}
		},
		[toast],
	);

	/**
	 * Edit a queued message. omp has no edit command: the message is withdrawn (with its images) and the new text queued
	 * again as the same kind, so it goes to the end of that queue. Already delivered, it is left alone. If queueing the
	 * new text fails, the text comes back in the composer rather than being lost.
	 */
	const editQueued = useCallback(
		async (text: string, queue: "steering" | "followUp", next: string) => {
			if (!liveId) return;
			let taken: { removed?: boolean; images?: PromptImage[]; imagesDropped?: boolean } | undefined;
			try {
				taken = await socket.act(liveId, { type: "remove_queued_message", message: text, queue });
			} catch (e) {
				toast("error", (e as Error).message);
				return;
			}
			if (!taken?.removed) {
				toast("info", translate("chat.queueEditGone"));
				return;
			}
			const images = taken.images ?? [];
			try {
				await socket.act(liveId, {
					type: "prompt",
					message: next,
					...(images.length ? { images } : {}),
					streamingBehavior: queue === "steering" ? "steer" : "followUp",
				});
			} catch (e) {
				toast("error", translate("chat.errQueueEdit", { error: (e as Error).message }));
				setDraft(toDraft(next, images));
				return;
			}
			if (taken.imagesDropped) toast("warning", translate("chat.queueEditImagesDropped"));
		},
		[liveId, toast],
	);

	/**
	 * Stop whatever is running. A paused conversation has to run again to take the abort, so the resume goes out first
	 * and the abort right behind it, without waiting for the reply: little of what was frozen runs in between. The server
	 * carries the stop through (`Live.stop`): it answers when the conversation has stopped, or when omp did not stop in
	 * time and its process was ended. Until then another press is the same press: nothing more is sent.
	 */
	const stopAll = useCallback(() => {
		if (!liveId || stoppingFor.current === liveId) return;
		stoppingFor.current = liveId;
		setStopping(true);
		if (paused)
			void setPaused(liveId, false).catch((e) => toast("error", translate("chat.errPause", { error: e.message })));
		void (bashRunning ? abortBash(liveId) : stop(liveId)).finally(() => {
			if (stoppingFor.current !== liveId) return;
			stoppingFor.current = null;
			setStopping(false);
		});
	}, [liveId, paused, bashRunning, stop, toast]);

	// Esc asks before it stops the reply (`useStopConfirm`): the first one shows the question, a second within a few
	// seconds stops. It works wherever focus is, as the Stop button's tip says (the composer, and the banner of a paused
	// conversation, call `escapeStop` themselves). It is not for a text field, nor while a dialog, menu, list or the
	// sidebar's selection is open: that is what the key closes first. The Stop button stops at once.
	const running = Boolean(liveId) && (streaming || bashRunning);
	const confirmStop = useStopConfirm(running, liveId, stopAll);
	const pressStop = confirmStop.press;
	const escapeStop = useCallback(() => {
		// An overlay opened this very moment takes this Escape, before it has registered as the top layer (#605).
		if (dismissOverlays()) return;
		const inPrompt = Boolean(document.activeElement?.closest("[data-stop-confirm]"));
		pressStop();
		// The question's own buttons go with it: focus goes back to the message box rather than to nowhere.
		if (inPrompt) composer.current?.focus();
	}, [pressStop]);
	useEffect(() => {
		if (!running) return;
		const onKey = (e: KeyboardEvent) => {
			if (!matches("stop", e) || e.defaultPrevented || e.repeat) return;
			if (typingInField(e.target)) return;
			if (
				document.querySelector(
					'[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-testid="selection-bar"]',
				)
			)
				return;
			e.preventDefault();
			escapeStop();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [running, escapeStop]);

	const navigateTo = useCallback(
		(dest: { file: string; leaf: string }) => {
			if (dest.file === currentFile) {
				setViewLeaf(dest.leaf === headLeaf ? null : dest.leaf);
			} else {
				const existing = liveFor(dest.file);
				const head = fam.headOf.get(dest.file);
				setView({
					kind: "chat",
					file: dest.file,
					liveId: existing?.info.liveId ?? null,
					leaf: head === dest.leaf ? undefined : dest.leaf,
				});
			}
		},
		[currentFile, headLeaf, fam, setView, setViewLeaf],
	);

	// Retry belongs to the failure that ends the latest branch, while nothing else is going on.
	// A stretch that stops short of the path's end does not hold the failure that ends it: the end of the stretch is none.
	const midPath = hist.later || Boolean(viewLeaf && viewLeaf !== headLeaf);
	const retryEntryId = midPath ? null : retryableTail(path);
	const retryWaiting = live?.retry?.phase === "waiting";
	const retry = useMemo(
		() =>
			retryEntryId && !streaming && !bashRunning && !retryWaiting
				? { entryId: retryEntryId, run: () => void send("/retry", [], "normal") }
				: undefined,
		[retryEntryId, streaming, bashRunning, retryWaiting, send],
	);
	// A conversation that ends in tool calls nobody answered (omp was killed while they ran) has nothing for `/retry` to
	// redo; a message goes on from there, so what is offered is Continue.
	const resumeEntryId = midPath
		? null
		: interruptedTail(path, fam.toolResults, live && !live.info.exited ? live.tools : undefined);
	// While the page does not know whether a process runs the conversation (it is loaded, and connecting, or asking the
	// server), a call nobody answered may be one that is being run: it is not shown as stopped until the page knows, or
	// has waited long enough (`FIND_MS`) (#598).
	const finding = useApp((s) => Boolean(currentFile && s.finding[currentFile]));
	const maybeRunning = !live && finding && resumeEntryId !== null;
	const resume = useMemo(
		() =>
			resumeEntryId && !streaming && !maybeRunning && !bashRunning && !retryWaiting
				? { entryId: resumeEntryId, run: () => void send("continue", [], "normal") }
				: undefined,
		[resumeEntryId, streaming, maybeRunning, bashRunning, retryWaiting, send],
	);
	/** What was sent in this conversation, for Up and Down in the composer (a message's attached files are not recalled). */
	const history = useMemo(() => recallable(joinPrompts(above.prompts, promptsOf(path))), [above.prompts, path]);

	// While omp replies or runs a command, a prompt cannot be sent again: Edit, Regenerate and Branch are not offered.
	const working = conversationBusy(live, bash);

	// What the actions use of the render they run in is read when one is clicked: the actions stay one object, so no row
	// on screen is drawn again because an entry was added (the path, the family and the callbacks are new then).
	const used = { fam, currentFile, ensureLive, path, run, toast, navigateTo, setViewLeaf };
	const latest = useRef(used);
	latest.current = used;
	const actions: MessageActions = useMemo(
		() => ({
			edit: working
				? undefined
				: (entry, text) => {
						const { fam, currentFile, ensureLive, run, setViewLeaf } = latest.current;
						void run(translate("chat.errEdit"), async () => {
							let images: PromptImage[] = [];
							try {
								const owner = destinationFor(fam, entry.id, currentFile)?.file ?? currentFile;
								if (owner !== currentFile) throw new Error(translate("chat.errOpenBranch"));
								images = await attachmentsOf(entry);
								const id = await ensureLive();
								await continueConversation(id);
								assertIdle(id);
								await socket.rpc(id, { type: "branch", entryId: entry.id });
								setViewLeaf(null);
								await socket.rpc(id, { type: "prompt", message: text, images });
							} catch (e) {
								// The edit exists nowhere else: it goes back to the composer instead of vanishing with the error.
								setDraft(toDraft(text, images));
								throw e;
							}
						});
					},
			regenerate: working
				? undefined
				: (entry) => {
						const { ensureLive, path, run, setViewLeaf } = latest.current;
						void run(translate("chat.errRegenerate"), async () => {
							const i = path.findIndex((e) => e.id === entry.id);
							const user = [...path.slice(0, i)].reverse().find((e) => roleOf(e) === "user");
							if (!user) throw new Error(translate("chat.errNoPrompt"));
							const m = messageOf(user);
							const text = m ? textOf(m) : "";
							const images = await attachmentsOf(user);
							let branched = false;
							try {
								const id = await ensureLive();
								// Sending the prompt again continues a paused conversation, as sending does.
								await continueConversation(id);
								assertIdle(id);
								await socket.rpc(id, { type: "branch", entryId: user.id });
								branched = true;
								setViewLeaf(null);
								await socket.rpc(id, { type: "prompt", message: text, images });
							} catch (e) {
								// Once branched, the conversation on screen is a new file without this prompt: the prompt goes back to the composer.
								if (branched) setDraft(toDraft(text, images));
								throw e;
							}
						});
					},
			fork: working
				? undefined
				: (entry) => {
						const { ensureLive, run, setViewLeaf, toast } = latest.current;
						void run(translate("chat.errBranch"), async () => {
							const id = await ensureLive();
							assertIdle(id);
							await socket.act(id, { type: "fork", entryId: entry.id });
							setViewLeaf(null);
							toast("success", translate("chat.toastBranched"));
						});
					},
			switchSibling: (_from, to) => {
				const { fam, currentFile, navigateTo } = latest.current;
				const dest = destinationFor(fam, to.id, currentFile);
				if (dest) navigateTo(dest);
			},
			openSubagent: (toolCallId) => openAgentForToolCall(toolCallId, [...latest.current.fam.idx.byId.values()]),
			retry,
			resume,
			paused,
		}),
		[working, retry, resume, paused],
	);

	// ------------------------------------------------------------------ scrolling

	const scrolledFor = useRef<string | null | undefined>(undefined);
	/** Where Back puts the reader, until the transcript has been drawn once. */
	const resuming = useRef(reading?.anchor ?? null);
	/** A place put back stays put while what is above it settles (a picture decodes), until the reader moves it. */
	const settling = useRef<{ segment: string; top: number; until: number } | null>(null);
	// Stick to the bottom while new content streams in, and jump to the end when a conversation opens: the place the
	// reader left it at, when they come back.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `atBottom` is a trigger: coming within reach of the end snaps to it.
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el || (!path.length && !overlay.length)) return;
		const fresh = scrolledFor.current !== currentFile;
		scrolledFor.current = currentFile;
		const back = fresh ? resuming.current : null;
		if (fresh) resuming.current = null;
		if (back && placeAnchor(el, back)) {
			setAtBottom(false);
			settling.current = { ...back, until: performance.now() + SETTLE_MS };
			return;
		}
		// `following` is `atBottom` a render sooner: an effect that runs twice (StrictMode) must not undo what the first did.
		// A conversation that opens is followed from its end: not left to the scroll event of the pin to say so, which the
		// content growing meanwhile makes no promise of (the view keeps its state when it shows another file, as a fork does).
		if (fresh) setAtBottom(true);
		if (following.current || fresh) pin(el);
	}, [path, overlay, atBottom, currentFile, setAtBottom, pin]);
	// The layout around the transcript changes with what is going on (the line under the message box is two lines of
	// disclaimer on a phone, one of "Working…" while a message is on its way), and the browser cuts the view's position
	// back each time the view gets taller: noted after every render, while the layout is that, so that the scroll event a
	// frame later is not taken for the reader going up when the layout is the old one again (see `settledPlace`).
	useLayoutEffect(() => {
		if (scroller.current) settle(scroller.current);
	});
	// Where the reader is, for when they leave: Back reopens the conversation there (see `lib/reading.ts`).
	useEffect(
		() =>
			registerReader(() => {
				const el = scroller.current;
				const shown = transcript.current;
				if (!el || !shown || !el.firstElementChild?.childElementCount) return null;
				const atEnd = following.current && shown.endShown();
				return { window: shown.window(), anchor: atEnd ? null : readAnchor(el) };
			}),
		[following],
	);

	// Reveal a focused entry (from search): show its branch, then scroll to it and flash it.
	const [focusId, setFocusId] = useState(focus ?? null);
	const focusHistory = hist.focus;
	// The same hit picked again names the same entry: `focusAt` is what tells a new request from the old one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `focusAt` is the trigger.
	useEffect(() => {
		if (focus) setFocusId(focus);
	}, [focus, focusAt]);
	/** The entry that is flashing and when it stops: asked for again, it flashes for a fresh 2.5 s. */
	const flash = useRef<{ el: HTMLElement; timer: number } | null>(null);
	/** The entry whose window is on its way: the page asks for it once. */
	const focusing = useRef<string | null>(null);
	useEffect(() => {
		if (!focusId || !family) return;
		if (!fam.idx.byId.has(focusId)) {
			// A hit among the history the page does not hold: the window around it takes the place of what is held.
			if (focusing.current === focusId) return;
			focusing.current = focusId;
			void focusHistory(focusId).then((where) => {
				focusing.current = null;
				// No window, or one that does not hold the entry either: there is nothing more to ask for.
				if (!where?.holds) setFocusId(null);
				else setViewLeaf(where.leaf === where.head ? null : where.leaf);
			});
			return;
		}
		if (!path.some((e) => e.id === focusId)) {
			const dest = destinationFor(fam, focusId, currentFile);
			if (dest?.file === currentFile) setViewLeaf(dest.leaf === headLeaf ? null : dest.leaf);
			else if (dest) setView({ kind: "chat", file: dest.file, liveId: null, leaf: dest.leaf, focus: focusId });
			return;
		}
		const raf = requestAnimationFrame(() => {
			const el = scroller.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(focusId)}"]`);
			if (!el) return;
			el.scrollIntoView({ block: "center" });
			// The scroll event that says so comes after the re-render below, which would stick to the bottom again.
			setAtBottom(false);
			if (flash.current) {
				clearTimeout(flash.current.timer);
				delete flash.current.el.dataset.focused;
			}
			el.dataset.focused = "true";
			flash.current = {
				el,
				timer: window.setTimeout(() => {
					delete el.dataset.focused;
					flash.current = null;
				}, 2500),
			};
			setFocusId(null);
		});
		return () => cancelAnimationFrame(raf);
	}, [focusId, family, fam, path, currentFile, headLeaf, focusHistory, setViewLeaf, setView, setAtBottom]);

	// ------------------------------------------------------------------ render

	const title =
		live?.state?.sessionName ||
		summary?.title ||
		summary?.preview ||
		(currentFile ? t("chat.untitledSession") : t("chat.newConversation"));
	const cwd = live?.info.cwd ?? summary?.cwd;

	const ready = !currentFile || family !== null;
	// The scroller's size and its content's change without a render (a picture decodes, a long draft makes the composer
	// taller and the transcript shorter): while the reader is at the end, the end stays in view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `ready` is the trigger — the scroller exists once it is true.
	useEffect(() => {
		const el = scroller.current;
		const content = el?.firstElementChild;
		if (!el || !content) return;
		const keepEnd = new ResizeObserver(() => {
			if (following.current) pin(el);
			else if (settling.current && performance.now() < settling.current.until) placeAnchor(el, settling.current);
		});
		keepEnd.observe(el);
		keepEnd.observe(content);
		// The reader moving the view ends the settling: what they scroll to is theirs.
		const moved = () => {
			settling.current = null;
		};
		const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
		for (const type of inputs) el.addEventListener(type, moved, { passive: true });
		return () => {
			keepEnd.disconnect();
			for (const type of inputs) el.removeEventListener(type, moved);
		};
	}, [ready, pin]);
	const retryLoad = () => setAttempt((n) => n + 1);
	const exportHtml = () => {
		if (currentFile) void downloadExport(currentFile).catch((e) => toast("error", e.message));
	};
	// Long titles and paths end in an ellipsis; hovering shows them in full.
	const titleBlock = (
		<div className="min-w-0 flex-1">
			<div className="flex items-center gap-2">
				<h1 className="truncate text-sm font-semibold" data-testid="chat-title" title={title}>
					{title}
				</h1>
				<ModeBadge info={live?.info} />
				{live?.planMode && !live.exited ? <PlanBadge /> : null}
				{!compact && ready && currentFile ? (
					<IconButton label={t("common.rename")} size="xs" onClick={() => setRenaming(title)}>
						<Pencil size={12} />
					</IconButton>
				) : null}
			</div>
			{cwd || isArchived ? (
				<div className="flex min-w-0 items-center gap-1.5 text-xs text-faint">
					{isArchived && currentFile ? <ArchivedMark file={currentFile} /> : null}
					{cwd ? (
						<>
							<FolderOpen size={11} className="shrink-0" />
							<span className="truncate" title={cwd} data-testid="chat-cwd">
								{shortPath(cwd, meta?.home)}
							</span>
						</>
					) : null}
				</div>
			) : null}
		</div>
	);
	const panelToggle = (
		<IconButton
			label={t("chat.toggleSidePanel")}
			active={panelOpen}
			onClick={() => set({ panelOpen: !panelOpen })}
			data-testid="toggle-panel"
		>
			<PanelRight size={16} />
		</IconButton>
	);
	// A conversation spends the quota of every provider it has used, not only its current model's; a saved one has no
	// running omp, so its transcript says which. One on a local server spends only that server's.
	const currentProvider = live?.state?.model?.provider;
	const local = runsLocal(live?.info);
	// A page that holds only the end of the conversation reads the providers of the rest from the session list.
	const olderProviders = useMemo(
		() => (hist.earlier ? [...new Set((summary?.models ?? []).map((m) => m.split("/")[0]))] : NO_PROVIDERS),
		[hist.earlier, summary?.models],
	);
	// What its subagents and advisors spent, from their own transcripts (the guard's reviewer is in the conversation's).
	const ownFile = fam.files.find((f) => f.file === currentFile);
	const helperProviders = useMemo(() => {
		const seen = new Set<string>();
		for (const t of [...(ownFile?.subagents ?? []), ...(ownFile?.advisors ?? [])])
			for (const p of t.providers ?? []) seen.add(p);
		return [...seen];
	}, [ownFile?.subagents, ownFile?.advisors]);
	const quotaProviders = useMemo(
		() => providersUsed(wholePath, currentProvider, local, olderProviders, helperProviders),
		[wholePath, currentProvider, local, olderProviders, helperProviders],
	);
	// The header shows the provider's remaining quota, not the context share: the composer already shows the context
	// (#454). The conversation's own model gets a meter and the window's reset; the other providers it has used get
	// their figure alone, so a mixed conversation still fits.
	const quota = quotaProviders.length ? (
		<div className="flex shrink-0 items-center gap-2 whitespace-nowrap" data-testid="quota-pills">
			{quotaProviders.map((p) => {
				const own = p === currentProvider;
				return (
					<Quota
						key={p}
						provider={p}
						active={own && (streaming || bashRunning)}
						variant={own && !compact ? "bar" : "pill"}
						model={own ? live?.state?.model?.id : null}
						showName={quotaProviders.length > 1 && !compact}
						terse={quotaProviders.length > 1 && compact}
						file={currentFile}
					/>
				);
			})}
		</div>
	) : null;
	// The guard's switch, beside This session (in a narrow header, beside the menu that holds it). Only a conversation whose
	// process has a guard (`LiveInfo.guard`) has one; its place is held while its chunk loads.
	const guardToggle =
		liveId && live?.info.guard ? (
			<Suspense fallback={<span aria-hidden className="h-8 w-8 shrink-0" />}>
				<GuardToggle liveId={liveId} />
			</Suspense>
		) : null;

	// Until the transcript is here there is a spinner, or the reason it failed with a Retry. The cost, Export, Goal
	// and the composer would only act on a conversation that is not on screen yet, so they wait too.
	if (!ready) {
		return (
			<div className="relative flex h-full min-w-0 flex-1">
				<div ref={setColumn} className="flex h-full min-w-0 flex-1 flex-col">
					<header className="flex h-13 shrink-0 items-center gap-2 border-b border-border px-4">{titleBlock}</header>
					<div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
						{loadError ? (
							<LoadError title={t("chat.loadErrorTitle")} error={loadError} onRetry={retryLoad} />
						) : (
							<div className="flex justify-center py-10" data-testid="chat-loading">
								<Spinner />
							</div>
						)}
					</div>
				</div>
			</div>
		);
	}

	return (
		<MdOpenContext.Provider value={mdOpen}>
			<div className="relative flex h-full min-w-0 flex-1">
				{/* The large view covers this column, not the panel: the file it shows is opened from the panel, which stays usable. */}
				<div className="relative flex min-w-0 flex-1">
					<div ref={setColumn} className={cx("flex h-full min-w-0 flex-1 flex-col", big && "invisible")}>
						<header className="flex h-13 shrink-0 items-center gap-2 border-b border-border px-4">
							{titleBlock}
							{compact ? (
								<>
									{quota}
									{panelToggle}
									{guardToggle}
									<HeaderMenu
										usage={usage}
										controls={canAct ? { live, start: startLive } : undefined}
										onRename={currentFile ? () => setRenaming(title) : undefined}
										onExport={currentFile ? exportHtml : undefined}
										onGoal={() => openGoal()}
										hasGoal={goalOpenNow}
										onLoaded={openLoaded}
										status={<StatusMenuRows live={live} entries={fileEntries} stats={figures} />}
									/>
								</>
							) : (
								<>
									<SessionCost usage={usage} tip />
									{quota}
									{currentFile ? (
										<IconButton label={t("chat.exportHtml")} data-testid="export-html" onClick={exportHtml}>
											<Download size={16} />
										</IconButton>
									) : null}
									{guardToggle}
									{canAct ? <SessionControls live={live} start={startLive} /> : null}
									<IconButton
										label={t(goalOpenNow ? "chat.showGoal" : "chat.setGoal")}
										active={goalExpanded}
										aria-expanded={goalOpenNow ? goalExpanded : undefined}
										onClick={toggleGoal}
										data-testid="open-goal"
									>
										<Target size={16} />
									</IconButton>
									<IconButton label={t("loaded.title")} onClick={openLoaded} data-testid="open-loaded">
										<Layers size={16} />
									</IconButton>
									{panelToggle}
								</>
							)}
						</header>
						{guardUnavailable ? (
							<Suspense fallback={null}>
								<GuardNotice homes={guardHomes} />
							</Suspense>
						) : null}
						{cwd && meta?.settingsHelpFolder === cwd ? (
							<Suspense fallback={null}>
								<SettingsHelpBar liveId={live?.info.liveId ?? null} />
							</Suspense>
						) : null}
						{liveId && live?.info.ungated ? (
							<Suspense fallback={null}>
								<GuardUngated liveId={liveId} kind={live.info.ungated} onReopen={currentFile ? reopen : null} />
							</Suspense>
						) : null}

						{/* On a phone the button below is a strip under the transcript, not a button over it: the text it floated on was unreadable. */}
						<div className="relative min-h-0 flex-1 max-sm:flex max-sm:flex-col">
							<div
								ref={scroller}
								className="h-full overflow-y-auto max-sm:h-auto max-sm:min-h-0 max-sm:flex-1"
								data-testid="transcript"
								// Whether the reader follows the end: a finished turn folds under a reader who does (see `AgentTurnBlock`).
								data-following={atBottom}
								onScroll={(e) => {
									// The end is where the reader follows it from: not the bottom of a window that stops short of it.
									scrolled(e.currentTarget, transcript.current?.endShown() !== false);
								}}
							>
								<Transcript
									ref={transcript}
									scroller={scroller}
									path={path}
									idx={fam.idx}
									toolResults={toolResults}
									live={live}
									streaming={streaming || maybeRunning}
									actions={actions}
									focusId={focusId}
									hasFile={Boolean(currentFile)}
									commandNotes={commandNotes}
									onReopen={currentFile ? reopen : null}
									restore={reading?.window}
									history={hist}
									before={
										<>
											{loadError ? (
												<LoadError title={t("chat.loadErrorTitle")} error={loadError} onRetry={retryLoad} />
											) : null}
											{viewLeaf && viewLeaf !== headLeaf ? (
												<div className="rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-xs text-fg">
													{t("chat.viewingEarlier")}{" "}
													<button type="button" className="underline" onClick={() => setViewLeaf(null)}>
														{t("chat.backToLatest")}
													</button>
												</div>
											) : null}
										</>
									}
								/>
							</div>
							{!atBottom ? (
								<button
									type="button"
									aria-label={t("chat.scrollToBottom")}
									className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-surface p-2 text-muted shadow-lg hover:text-fg max-sm:static max-sm:flex max-sm:h-9 max-sm:w-full max-sm:shrink-0 max-sm:translate-x-0 max-sm:items-center max-sm:justify-center max-sm:gap-1.5 max-sm:rounded-none max-sm:border-x-0 max-sm:border-b-0 max-sm:p-0 max-sm:text-xs max-sm:shadow-none"
									// A glide to the end (smooth) aims at where the end is when it starts: while the conversation grows it ends
									// short, still not following. A conversation that is growing is gone to at once.
									onClick={() =>
										running || transcript.current?.endShown() === false
											? pinToBottom()
											: scroller.current && glideToEnd(scroller.current)
									}
								>
									<ArrowDown size={16} />
									<span className="sm:hidden">{t("chat.scrollToBottom")}</span>
								</button>
							) : null}
						</div>

						{/*
						 * The bottom block never takes more than the window gives it, nor more than the keyboard leaves of it (`--vvh`,
						 * see `useChatBottom`). The transcript gives way first; past that the jobs list and a tool approval do, each
						 * scrolling inside itself, so that the approval's choices and the composer stay on the screen. In a short window
						 * (`data-short`) a waiting request keeps only itself and the message box (index.css), and with no keyboard
						 * the request comes first: the block scrolls to the message box.
						 */}
						<div
							ref={chatBottom}
							className="flex max-h-[var(--vvh,none)] min-h-0 flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 [&[data-keyboard]]:pb-2 [&[data-short]:not([data-keyboard])]:overflow-y-auto [&[data-short]:not([data-keyboard])]:overscroll-contain"
							data-chat-bottom
							data-asking={asking || undefined}
						>
							<div className="mx-auto flex min-h-0 w-full max-w-3xl flex-col">
								{goalHere && goalOpenNow ? (
									<GoalBar
										liveId={liveId}
										goal={goalHere}
										working={streaming}
										waiting={goalWait(live)}
										expanded={goalExpanded}
										onExpandedChange={(open) => setExpandedGoal(open ? goalHere.id : null)}
										ensureLive={ensureLive}
									/>
								) : null}
								{live ? <TodoStrip live={live} /> : null}
								{live && liveId && guidedGoalActive(live) && !pendingProposal(live) ? (
									<GuidedGoalBar live={live} />
								) : null}
								{live ? <UIRequests live={live} /> : null}
								{live ? <JobsBlock live={live} /> : null}
								<GoalDialog
									open={goalOpen}
									onOpenChange={setGoalOpen}
									initialMode={goalMode}
									onGuided={async (rough) => {
										const ok = await run(translate("chat.errGoal"), async () => {
											const id = await ensureLive();
											const target = useApp.getState().lives[id];
											if (goalOpenNow || goalHeld(target?.goal)) throw new Error(translate("panel.goalActive"));
											// One interview at a time: a second would only confuse the model and leave the bar showing the first.
											if (guidedGoalActive(target)) throw new Error(translate("panel.guidedActive"));
											// Starting the interview is sending a message: it wakes an archived or paused conversation too.
											unarchiveOnSend(target?.info.sessionFile);
											if (target?.info.pausedAt) await setPaused(id, false);
											await alignLeaf(id);
											await startGuidedGoal(id, rough, { queue: Boolean(target?.streaming) });
										});
										if (ok) setGoalOpen(false);
										return ok;
									}}
									onCreate={async (objective, budget) => {
										const ok = await run(translate("chat.errGoal"), async () => {
											const id = await ensureLive();
											// omp refuses a second goal (`A goal is already active`) with a message about a goal the page may not show.
											if (goalOpenNow || goalHeld(useApp.getState().lives[id]?.goal))
												throw new Error(translate("panel.goalActive"));
											await createGoal(id, objective, budget);
										});
										if (ok) setGoalOpen(false);
										return ok;
									}}
								/>
								{live && Object.keys(live.statuses).length ? (
									<div className="mb-1.5 flex flex-wrap gap-3 text-xs text-faint">
										{Object.entries(live.statuses).map(([k, v]) => (
											<span key={k}>{v}</span>
										))}
									</div>
								) : null}
								{live ? <RetryStatus live={live} /> : null}
								{/* `data-keep`: Stop and Resume stay while a request waits in a short window (index.css). */}
								{liveId ? (
									<div data-keep>
										<PendingCommands liveId={liveId} onStop={stopAll} />
									</div>
								) : null}
								{liveId && live?.info.pausedAt ? (
									<div data-keep>
										<PausedBanner
											since={live.info.pausedAt}
											commands={bash.map((r) => r.command)}
											resumeRef={resumeButton}
											onStop={stopAll}
											onStopKey={escapeStop}
											onResume={() =>
												void setPaused(liveId, false).catch((e) =>
													toast("error", translate("chat.errPause", { error: e.message })),
												)
											}
										/>
									</div>
								) : null}
								{stopping ? (
									<div data-keep>
										<StoppingNote />
									</div>
								) : null}
								{/* The question the first Esc asks; `data-keep`: it stays while a request waits in a short window (index.css). */}
								<div data-keep>
									<StopConfirm
										armed={confirmStop.armed}
										onStop={() => {
											confirmStop.cancel();
											stopAll();
										}}
										onCancel={confirmStop.cancel}
										returnFocus={composer}
									/>
								</div>
								{/* `data-keep`: in a short window the block keeps the message box (index.css), unless a field of the request has the keyboard. */}
								<div data-keep data-composer>
									<Composer
										ref={composer}
										history={history}
										draftKey={currentFile ?? liveIdProp}
										commands={live?.commands ?? []}
										onLoaded={openLoaded}
										cwd={cwd}
										predictLive={liveId}
										uploadScope={liveId || currentFile ? { live: liveId, file: currentFile } : null}
										streaming={streaming || bashRunning}
										paused={Boolean(live?.info.pausedAt)}
										approvalPending={approvalPending}
										retryWait={live?.retry?.phase === "waiting" && !live.retry.resumed}
										onPause={
											liveId
												? () =>
														void setPaused(liveId, true).catch((e) =>
															toast("error", translate("chat.errPause", { error: e.message })),
														)
												: undefined
										}
										disabled={busy}
										queue={queue}
										onSend={send}
										draft={draft}
										onAbort={stopAll}
										stoppable={subagentsWorking}
										stopping={stopping}
										onStopKey={escapeStop}
										onRemoveQueued={(text, queue) =>
											liveId &&
											void socket
												.act(liveId, { type: "remove_queued_message", message: text, queue })
												.catch((e) => toast("error", e.message))
										}
										onPromoteQueued={(text) =>
											liveId &&
											void socket
												.act(liveId, { type: "promote_queued_message", message: text })
												// A message sent now is a message like any other: omp holds it behind an open tool approval, so
												// the approval is denied once the message is on its way.
												.then(() => denyPendingApprovals(liveId))
												.catch((e) => toast("error", e.message))
										}
										onEditQueued={liveId ? editQueued : undefined}
										// One line beside Attach and Send (V17): where the controls with their names do not fit on it (a side panel open), the
										// less used are behind "⋯" and the rest keep only their icons.
										footerOneRow
										footer={({ typing }) =>
											liveId || currentFile ? (
												<>
													<PresetPicker
														liveId={liveId}
														folder={cwd}
														file={currentFile}
														saved={saved}
														start={startLive}
													/>
													<ModelPicker liveId={liveId} current={shownModel} start={startLive} />
													{/* Where they do not fit on the row with their names these are behind "⋯" (C1): the model, permission mode, unattended mode and Attach stay in the row. */}
													<ComposerMore>
														<ThinkingPicker
															liveId={liveId}
															level={thinking.selected}
															resolved={thinking.resolved}
															current={shownModel}
															start={startLive}
														/>
														{/* A message sent while omp asks for an approval denies it: no one-tap send then, the approval is answered first (and a phone's row of controls keeps its room for the choices). */}
														{approvalPending ? null : (
															<Suspense fallback={null}>
																<QuickPromptMenu
																	liveId={liveId}
																	streaming={streaming}
																	onSend={send}
																	ensureLive={ensureLive}
																	hidden={typing}
																/>
															</Suspense>
														)}
													</ComposerMore>
													<ApprovalPicker liveId={liveId} saved={savedApproval} start={startLive} />
													<Suspense fallback={null}>
														<UnattendedToggle liveId={liveId} file={currentFile} start={startLive} />
													</Suspense>
												</>
											) : null
										}
									/>
								</div>
								<ChatStatus
									live={live}
									entries={fileEntries}
									stats={figures}
									cwd={cwd}
									cost={{ main: totals.main.cost, subagents: totals.subagents.cost, advisor: totals.advisor.cost }}
									agentsRunning={totals.subagents.running}
									savedThinking={saved.thinking}
									compact={compact}
								/>
								<p className="mt-1.5 text-center text-xs text-faint">
									{busy ? t("chat.working") : t("chat.disclaimer")}
								</p>
							</div>
						</div>
						<LoadedDialog live={live} file={currentFile} onRestart={restartOmp} />
						<ResumeModelDialog prompt={modelPrompt} />
						<ResumeFolderDialog prompt={folderPrompt} />
						<Modal open={renaming !== null} onOpenChange={(o) => !o && setRenaming(null)} title={t("chat.renameTitle")}>
							<form
								onSubmit={(e) => {
									e.preventDefault();
									const name = renaming?.trim();
									setRenaming(null);
									if (name && currentFile) {
										// A running omp renames its own conversation; without one the server does it through a short-lived one.
										const renamed = liveId
											? socket.act(liveId, { type: "set_session_name", name })
											: sessionActions.rename(currentFile, name);
										void renamed
											// set_session_name emits no frames: refresh the header's state ourselves.
											.then(() =>
												Promise.all([liveId ? refreshState(liveId, true) : null, useApp.getState().loadSessions()]),
											)
											.catch((err) => toast("error", err.message));
									}
								}}
							>
								<input
									aria-label={t("chat.renameLabel")}
									className="w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm outline-none focus:border-faint"
									value={renaming ?? ""}
									onChange={(e) => setRenaming(e.target.value)}
									// biome-ignore lint/a11y/noAutofocus: dialog primary field
									autoFocus
								/>
								<div className="mt-3 flex justify-end gap-2">
									<Button variant="ghost" onClick={() => setRenaming(null)}>
										{t("common.cancel")}
									</Button>
									<Button variant="primary" type="submit">
										{t("common.save")}
									</Button>
								</div>
							</form>
						</Modal>
					</div>
					{big ? (
						// The conversation's own column under it is hidden, not unmounted: its place, its draft and the panel stay.
						<ErrorBoundary
							resetKey={`${currentFile ?? ""}\u0000${big.kind}\u0000${big.path}`}
							fallback={(error) => (
								<div className="absolute inset-0 z-10 bg-bg">
									<ErrorScreen error={error} />
								</div>
							)}
						>
							<Suspense fallback={<BigFallback />}>
								<BigView scope={{ live: liveId, file: currentFile }} target={big} onClose={closeBig} />
							</Suspense>
						</ErrorBoundary>
					) : null}
				</div>
				{panelOpen ? (
					<RightPanel
						live={live}
						file={currentFile}
						family={fam}
						entries={path}
						onClose={() => set({ panelOpen: false })}
						onNavigate={(f) => setView({ kind: "chat", file: f, liveId: liveFor(f)?.info.liveId ?? null })}
						start={startLive}
						figures={figures}
						totals={totals}
					/>
				) : null}
				{mdPath !== null ? (
					// Over the whole window (a portal): a chunk that is gone shows the Reload screen in its place.
					<ErrorBoundary
						resetKey={`${chatKey}\u0000${mdPath}`}
						fallback={(error) => (
							<div className="fixed inset-0 z-40 bg-bg">
								<ErrorScreen error={error} />
							</div>
						)}
					>
						<Suspense
							fallback={
								<div className="fixed inset-0 z-40 flex items-center justify-center bg-bg" data-testid="md-fallback">
									<Spinner />
								</div>
							}
						>
							<MdEditor scope={folderScope} chatKey={chatKey} path={mdPath} />
						</Suspense>
					</ErrorBoundary>
				) : null}
			</div>
		</MdOpenContext.Provider>
	);
}
