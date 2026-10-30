import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { PanelLeftOpen } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ErrorBoundary, ErrorScreen } from "./components/ErrorBoundary.tsx";
import { NewChat } from "./components/NewChat.tsx";
import { OmpUpdateNotice } from "./components/OmpUpdateNotice.tsx";
import { Rail } from "./components/Rail.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { Unlock } from "./components/Unlock.tsx";
import { cx, IconButton, ignoreToastRegion, Spinner } from "./components/ui.tsx";
import { useT } from "./i18n/index.ts";
import { agentFullOpen, isPopOut } from "./lib/agent-full.ts";
import { startAttention } from "./lib/attention.ts";
import { type ChatKey, nextChatKey } from "./lib/chat-key.ts";
import { lazyChunk } from "./lib/lazy-chunk.ts";
import { PANEL_SHEET_QUERY, useMediaQuery } from "./lib/media.ts";
import { showShortcutsSettings } from "./lib/shortcut-view.ts";
import { matches, typingInField } from "./lib/shortcuts.ts";
import { attachLive, requestGoal, useApp } from "./store/app.ts";
import { ompScreen, useOmp } from "./store/omp.ts";

// Route-level code splitting: markdown/highlighting (chat), charts (usage), the
// terminal (commands) and cmdk (search) load only when first needed.
const ChatView = lazy(() => import("./components/ChatView.tsx").then((m) => ({ default: m.ChatView })));
const UsagePage = lazy(() => import("./components/UsagePage.tsx").then((m) => ({ default: m.UsagePage })));
// omp's long-term memory: its strings, its requests and its editor wait for the page to be opened.
const MemoryPage = lazy(() => import("./components/MemoryPage.tsx").then((m) => ({ default: m.MemoryPage })));
// The guard's own page (decisions, policy, benchmark): its strings, its requests and its tabs wait for the page to be opened.
const GuardPage = lazy(() => import("./components/GuardPage.tsx"));
// The questions agents filed while a conversation was unattended (#646): the page, its strings and its requests wait for it to be opened.
const QuestionsPage = lazy(() => import("./components/QuestionsPage.tsx"));
// The agent graph (#719): its layout, its strings and the live view it opens wait for the page to be opened.
const AgentGraphPage = lazy(() => import("./components/AgentGraphPage.tsx"));
const CliPage = lazy(() => import("./components/CliPage.tsx").then((m) => ({ default: m.CliPage })));
const SettingsPage = lazy(() => import("./components/SettingsPage.tsx").then((m) => ({ default: m.SettingsPage })));
const Palette = lazy(() => import("./components/Palette.tsx").then((m) => ({ default: m.Palette })));
// A subagent's live view full screen (over the conversation, or as the whole page of a window popped out for it).
const SubagentFull = lazy(() => import("./components/SubagentFull.tsx").then((m) => ({ default: m.SubagentFull })));
// Without omp, or right after installing it, these stand in for the whole app.
const FirstRun = lazy(() => import("./components/FirstRun.tsx").then((m) => ({ default: m.FirstRun })));
const Onboarding = lazy(() => import("./components/Onboarding.tsx").then((m) => ({ default: m.Onboarding })));
// The feedback dialog: opened from the sidebar or a shortcut, never on the first paint.
const { Chunk: Feedback, retry: retryFeedback } = lazyChunk(() =>
	import("./components/Feedback.tsx").then((m) => ({ default: m.Feedback })),
);

function PageFallback() {
	return (
		<div className="flex flex-1 items-center justify-center">
			<Spinner />
		</div>
	);
}

/** Where the sidebar is a drawer over the page instead of a column beside it (see the `max-[900px]` classes of its frame). */
const DRAWER_QUERY = "(max-width: 900px)";

/**
 * This window was opened for one subagent (see `popOutAgent`): it shows that and nothing else of the app. Read once: the
 * window is one or the other for as long as it lives.
 */
const POP_OUT = isPopOut(location.search);

/**
 * The sidebar as a drawer: a modal dialog, so that Esc closes it, focus stays inside while it is open and comes back
 * to the button that opens it, and what is behind it is not reachable by screen readers or Tab.
 */
function SidebarDrawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
	const t = useT();
	return (
		<Dialog.Root open onOpenChange={(open) => !open && onClose()}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-30 bg-black/40" />
				<Dialog.Content
					aria-describedby={undefined}
					aria-modal="true"
					className="fixed inset-y-0 left-0 z-40 outline-none"
					data-testid="sidebar-drawer"
					// The button that opened it is not on the page while it is open (it comes back with the page): focus its new self.
					onCloseAutoFocus={(e) => {
						e.preventDefault();
						document.querySelector<HTMLElement>('[data-testid="show-sidebar"]')?.focus();
					}}
					{...ignoreToastRegion}
				>
					<Dialog.Title className="sr-only">{t("shell.sidebarAria")}</Dialog.Title>
					{children}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

export function App() {
	const t = useT();
	const drawer = useMediaQuery(DRAWER_QUERY);
	// Not `useApp()` whole: it would render the app, and with it the sidebar, for every token a conversation streams.
	const { view, sidebarOpen, set, setView, connected, locked, toast } = useApp(
		useShallow((s) => ({
			view: s.view,
			sidebarOpen: s.sidebarOpen,
			set: s.set,
			setView: s.setView,
			connected: s.connected,
			locked: s.locked,
			toast: s.toast,
		})),
	);
	const chatKeyRef = useRef<ChatKey | null>(null);
	// Derived during render from the previous key; idempotent, so StrictMode double renders agree.
	chatKeyRef.current = view.kind === "chat" ? nextChatKey(chatKeyRef.current, view) : null;
	const chatKey = chatKeyRef.current?.key ?? "";
	/** Which page is showing: another conversation or another kind of page, not a change within one conversation. */
	const pageKey = view.kind === "chat" ? chatKey : view.kind;
	const paletteOpen = useApp((s) => s.paletteOpen);
	const screen = useOmp(ompScreen);
	const [paletteWanted, setPaletteWanted] = useState(false);
	useEffect(() => {
		if (paletteOpen) setPaletteWanted(true);
	}, [paletteOpen]);
	// The feedback dialog loads when it is first asked for, not with the page.
	const feedbackOpen = useApp((s) => s.feedbackOpen);
	const [feedbackWanted, setFeedbackWanted] = useState(false);
	useEffect(() => {
		if (feedbackOpen) setFeedbackWanted(true);
	}, [feedbackOpen]);

	// The tab's title counts the conversations waiting for an answer and marks a reply that finished while it was hidden.
	useEffect(() => (POP_OUT ? undefined : startAttention()), []);

	useEffect(() => {
		// A window popped out for a subagent has no search, no sidebar and no conversation to start: no global keys.
		if (POP_OUT) return;
		const onKey = (e: KeyboardEvent) => {
			const shown = useApp.getState().view;
			if (matches("search", e)) {
				e.preventDefault();
				set({ paletteOpen: !useApp.getState().paletteOpen });
			} else if (matches("newChat", e)) {
				e.preventDefault();
				setView({ kind: "new" });
			} else if (matches("sidebar", e) && !(shown.kind === "chat" && shown.agent !== undefined)) {
				// Not behind a full screen, where the sidebar is hidden: it would change what comes back.
				e.preventDefault();
				set({ sidebarOpen: !useApp.getState().sidebarOpen });
			} else if (matches("goal", e) && !agentFullOpen()) {
				// Where there is a conversation (or New chat) to set it in.
				const kind = useApp.getState().view.kind;
				if (kind === "chat" || kind === "new") {
					e.preventDefault();
					requestGoal();
				}
			} else if (matches("help", e) && !typingInField(e.target) && !agentFullOpen()) {
				// The list is a page of Settings now (#639): the key goes there. Not behind a subagent's full screen, where the
				// shell is hidden and the page would open under it unseen: Esc leaves the full screen, as it did for the dialog.
				e.preventDefault();
				showShortcutsSettings();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [set, setView]);

	// Deep link to a live process (#/live/<id>) after a reload: re-attach when possible.
	useEffect(() => {
		if (view.kind === "chat" && view.liveId && !useApp.getState().lives[view.liveId]) {
			void attachLive(view.liveId).then((ok) => {
				if (!ok) setView({ kind: "new" });
			});
		}
	}, [view, setView]);

	// On narrow screens the sidebar is an overlay drawer: start collapsed, and close it
	// whenever the page changes (a conversation, New chat, Settings… was chosen).
	// biome-ignore lint/correctness/useExhaustiveDependencies: `view` is the trigger.
	useEffect(() => {
		if (matchMedia(DRAWER_QUERY).matches) set({ sidebarOpen: false });
	}, [set, view]);

	// Where the side panel is a sheet over the conversation (below `lg`), arrive at another page with it closed:
	// it would cover the next conversation the moment that opens.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `pageKey` is the trigger.
	useEffect(() => {
		if (matchMedia(PANEL_SHEET_QUERY).matches) set({ panelOpen: false });
	}, [set, pageKey]);

	if (locked) return <Unlock />;
	if (screen === "loading") {
		return (
			<div className="flex h-full">
				<PageFallback />
			</div>
		);
	}
	if (screen) {
		return (
			<Tooltip.Provider>
				<ErrorBoundary resetKey={screen}>
					<Suspense fallback={<PageFallback />}>{screen === "first-run" ? <FirstRun /> : <Onboarding />}</Suspense>
				</ErrorBoundary>
				<Toasts />
			</Tooltip.Provider>
		);
	}
	// A window popped out for a subagent shows that and nothing else, whatever its address says (a conversation that moved
	// on, a process that is gone, another page): the missing-subagent state, never the whole app.
	if (POP_OUT) {
		return (
			<Tooltip.Provider>
				<ErrorBoundary resetKey={pageKey}>
					<Suspense fallback={<PageFallback />}>
						<SubagentFull popOut />
					</Suspense>
				</ErrorBoundary>
				<Toasts />
			</Tooltip.Provider>
		);
	}
	/** Where the sidebar is a drawer and is shut, its toggle floats over the page; beside the page the rail has it. */
	const floatingToggle = !sidebarOpen && drawer;
	return (
		<Tooltip.Provider>
			<div className="app-shell flex h-full overflow-hidden">
				{sidebarOpen ? (
					drawer ? (
						<SidebarDrawer onClose={() => set({ sidebarOpen: false })}>
							<Sidebar />
						</SidebarDrawer>
					) : (
						<Sidebar />
					)
				) : drawer ? null : (
					<Rail />
				)}
				<main className="relative flex min-w-0 flex-1 flex-col">
					{!connected ? (
						<div className="bg-warning/15 px-4 py-1 text-center text-xs text-warning" role="status">
							{t("shell.appReconnecting")}
						</div>
					) : null}
					<OmpUpdateNotice />
					{/* Where the sidebar is a drawer its toggle floats over the page's top left corner: a chat's header leaves room beside it, any other page starts below it. Beside the page, the rail has the toggle. */}
					<div
						className={cx(
							"relative flex min-h-0 flex-1",
							floatingToggle && (view.kind === "chat" ? "[&_header]:pl-12" : "pt-12"),
						)}
					>
						{floatingToggle ? (
							<div className="absolute top-2.5 left-2 z-20">
								<IconButton
									label={t("shell.appShowSidebar")}
									onClick={() => set({ sidebarOpen: true })}
									data-testid="show-sidebar"
								>
									<PanelLeftOpen size={16} />
								</IconButton>
							</div>
						) : null}
						{/* A page that fails to render (or whose chunk is gone) shows the Reload screen here; the sidebar keeps working. */}
						<ErrorBoundary resetKey={pageKey}>
							<Suspense fallback={<PageFallback />}>
								{view.kind === "chat" ? (
									<ChatView
										key={chatKey}
										file={view.file}
										liveId={view.liveId}
										initialLeaf={view.leaf}
										focus={view.focus}
										focusAt={view.focusAt}
										reading={view.reading}
									/>
								) : null}
								{view.kind === "new" ? <NewChat /> : null}
								{view.kind === "usage" ? <UsagePage /> : null}
								{view.kind === "memory" ? <MemoryPage /> : null}
								{view.kind === "guard" ? <GuardPage /> : null}
								{view.kind === "agents" ? <AgentGraphPage /> : null}
								{view.kind === "questions" ? <QuestionsPage /> : null}
								{view.kind === "cli" ? (
									<CliPage
										key={`${view.command ?? ""}\u0000${view.run?.join("\u0001") ?? ""}`}
										command={view.command}
										run={view.run}
									/>
								) : null}
								{view.kind === "settings" ? <SettingsPage /> : null}
							</Suspense>
						</ErrorBoundary>
					</div>
				</main>
			</div>
			{view.kind === "chat" && view.agent ? (
				// The page above stays as it is, hidden while this is up. A chunk that is gone shows the Reload screen over it.
				<ErrorBoundary
					resetKey={chatKey}
					fallback={(error) => (
						<div className="fixed inset-0 z-40 bg-bg">
							<ErrorScreen error={error} />
						</div>
					)}
				>
					<Suspense fallback={null}>
						<SubagentFull popOut={false} />
					</Suspense>
				</ErrorBoundary>
			) : null}
			{paletteWanted ? (
				// Search is an overlay: if its chunk is gone, say so in a toast instead of replacing the whole app.
				<ErrorBoundary fallback={() => null} onError={() => toast("error", t("shell.errorSearchLoad"))}>
					<Suspense fallback={null}>
						<Palette />
					</Suspense>
				</ErrorBoundary>
			) : null}
			<Toasts />
			{feedbackWanted ? (
				// A chunk that is gone is a toast, not the Reload screen: the rest of the app stays, the dialog is given up,
				// and the next request for it asks for the chunk again.
				<ErrorBoundary
					fallback={() => null}
					onError={() => {
						retryFeedback();
						setFeedbackWanted(false);
						set({ feedbackOpen: false });
						toast("error", t("shell.errorFeedbackLoad"));
					}}
				>
					<Suspense fallback={null}>
						<Feedback />
					</Suspense>
				</ErrorBoundary>
			) : null}
		</Tooltip.Provider>
	);
}
