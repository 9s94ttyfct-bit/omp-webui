import * as Menu from "@radix-ui/react-dropdown-menu";
import type { SessionSummary } from "@shared/protocol.ts";
import { Feather, GitBranch, MoreHorizontal, Pause, Pin, Square, SquareCheck } from "lucide-react";
import { type MouseEvent, memo, Suspense, useRef, useState } from "react";
import { t, useT } from "../i18n/index.ts";
import { fmtCost } from "../lib/format.ts";
import { lazyChunk } from "../lib/lazy-chunk.ts";
import { advisorUsageOf } from "../lib/totals.ts";
import { useApp } from "../store/app.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { Mark } from "./Mark.tsx";
import { Snippet } from "./Snippet.tsx";
import { cx } from "./ui.tsx";

// The row's actions: a chunk of their own, loaded when the menu opens.
const { Chunk: SessionMenu, retry: retrySessionMenu } = lazyChunk(() =>
	import("./SessionMenu.tsx").then((m) => ({ default: m.SessionMenu })),
);

/**
 * A conversation's live omp process, as the sidebar shows it. `needsInput`: a dialog (a tool approval, a
 * question) is waiting for the user, which beats `running` because omp is not making progress. `quotaHeld`: omp waits at
 * its provider's quota floor until the window resets (#652): not frozen like `paused`, and not working either.
 */
export type LiveDot = "running" | "open" | "paused" | "needsInput" | "quotaHeld";

export function sessionLabel(s: SessionSummary): string {
	return s.title || s.preview || t("shell.sessionUntitled");
}

/** A conversation's cost for its tooltip, with what its subagents and its advisors account for when it has any. */
function costLabel(s: SessionSummary): string {
	const cost = fmtCost(s.usage.cost);
	const advisor = advisorUsageOf(s.advisorUsage);
	if (s.subagentCount && advisor.requests) {
		return t("shell.sessionCostWithSubagentsAndAdvisor", {
			cost,
			sub: fmtCost(s.subagentUsage.cost),
			advisor: fmtCost(advisor.cost),
		});
	}
	if (s.subagentCount) return t("shell.sessionCostWithSubagents", { cost, sub: fmtCost(s.subagentUsage.cost) });
	if (advisor.requests) return t("shell.sessionCostWithAdvisor", { cost, advisor: fmtCost(advisor.cost) });
	return cost;
}

export type SessionAction = "rename" | "delete";

interface Props {
	session: SessionSummary;
	/** Where a search matched the row's name: those characters are marked (see `Mark`). */
	mark?: readonly number[];
	/** The line of the message the sidebar's search found the conversation by (#717), shown under its name. */
	snippet?: string;
	active: boolean;
	pinned: boolean;
	archived: boolean;
	/** The conversation's live omp process, if any. */
	liveState: LiveDot | undefined;
	/** The callbacks are handed the row's own file or session, so one function can serve every row (the row is memoized). */
	onOpen: (file: string) => void;
	onTogglePin: (file: string) => void;
	onToggleArchive: (file: string) => void;
	/** `trigger` is the row's menu button: the dialog an action opens returns focus there when it closes. */
	onAction: (session: SessionSummary, action: SessionAction, trigger: HTMLElement | null) => void;
	/** Selection mode: a click toggles the row (shift-click extends) instead of opening it. */
	selecting?: boolean;
	selected?: boolean;
	onSelect?: (file: string, e: MouseEvent) => void;
}

/** Each state's label and look: the dot is small, and what it says is its label. */
const DOT = {
	running: ["shell.sessionRunning", "h-1.5 w-1.5 animate-pulse bg-accent"],
	needsInput: ["shell.sessionNeedsInput", "h-2 w-2 bg-warning ring-[3px] ring-warning/25"],
	quotaHeld: ["shell.sessionQuotaHeld", "h-2 w-2 border-2 border-warning"],
	open: ["shell.sessionOpen", "h-1.5 w-1.5 bg-success"],
} as const;

/** One sidebar row: open on click, plus a menu with omp-backed session actions. */
export const SessionItem = memo(function SessionItem({
	session: s,
	mark,
	snippet,
	active,
	pinned,
	archived,
	liveState,
	onOpen,
	onTogglePin,
	onToggleArchive,
	onAction,
	selecting,
	selected,
	onSelect,
}: Props) {
	const t = useT();
	// No store subscription here: a thousand rows each subscribed make every streamed token ask a thousand listeners
	// whether anything changed. The two store actions the menu uses are read when it uses them.
	const menuTrigger = useRef<HTMLButtonElement>(null);
	// Open or not is the row's to know: a menu that could not be loaded is closed from here.
	const [menuOpen, setMenuOpen] = useState(false);
	// Whether the conversation's process was started in Light mode (it keeps its mode, whatever new chats start in).
	const light = useApp(
		(st) =>
			liveState !== undefined &&
			Object.values(st.lives).some((l) => !l.info.exited && l.info.sessionFile === s.file && l.info.mode === "light"),
	);
	const stateLabel = (state: keyof typeof DOT) =>
		light ? t("mode.liveState", { state: t(DOT[state][0]) }) : t(DOT[state][0]);
	return (
		<div
			className={cx(
				"group relative flex items-center rounded-lg",
				selecting && selected
					? "bg-accent-soft text-fg"
					: active && !selecting
						? "bg-hover text-fg"
						: "text-muted hover:bg-hover/70 hover:text-fg",
			)}
		>
			<button
				type="button"
				data-testid="session-item"
				data-file={s.file}
				aria-current={active && !selecting ? "page" : undefined}
				aria-pressed={selecting ? Boolean(selected) : undefined}
				title={t("shell.sessionTooltip", {
					label: sessionLabel(s),
					cwd: s.cwd,
					count: s.messageCount,
					cost: costLabel(s),
				})}
				onClick={(e) => (selecting ? onSelect?.(s.file, e) : onOpen(s.file))}
				className={cx(
					"flex min-w-0 flex-1 items-center gap-2 rounded-l-lg py-1.5 pr-1 pl-2.5 text-left text-sm focus-visible:-outline-offset-2",
					snippet !== undefined && "flex-wrap gap-y-0.5",
				)}
			>
				{selecting ? (
					selected ? (
						<SquareCheck size={15} className="shrink-0 text-accent" />
					) : (
						<Square size={15} className="shrink-0 text-faint" />
					)
				) : null}
				{pinned ? <Pin size={12} className="shrink-0 text-faint" aria-label={t("shell.sessionPinnedMark")} /> : null}
				{s.parentSession ? (
					<GitBranch size={13} className="shrink-0 text-faint" aria-label={t("shell.sessionBranchMark")} />
				) : null}
				<span className="min-w-0 flex-1 truncate">
					<Mark text={sessionLabel(s)} positions={mark ?? []} />
				</span>
				{liveState === "paused" ? (
					<Pause
						size={11}
						className="shrink-0 text-accent"
						fill="currentColor"
						role="img"
						aria-label={t("shell.sessionPaused")}
					/>
				) : liveState !== undefined ? (
					<>
						{light ? <Feather size={11} className="shrink-0 text-faint" aria-hidden /> : null}
						<span
							className={cx("shrink-0 rounded-full", DOT[liveState][1])}
							role="img"
							aria-label={stateLabel(liveState)}
							title={stateLabel(liveState)}
						/>
					</>
				) : null}
				{snippet === undefined ? null : (
					// The whole width under the name: a line of the message is what says why the row is listed.
					<span data-testid="session-item-snippet" className="w-full truncate text-xs text-faint">
						<Snippet text={snippet} />
					</span>
				)}
			</button>
			{selecting ? null : (
				<Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
					<Menu.Trigger asChild>
						<button
							ref={menuTrigger}
							type="button"
							aria-label={t("shell.sessionActionsFor", { label: sessionLabel(s) })}
							data-testid="session-menu"
							className="mr-1 rounded-md p-1.5 text-faint opacity-0 hover:bg-surface hover:text-fg group-hover:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
						>
							<MoreHorizontal size={15} />
						</button>
					</Menu.Trigger>
					{/*
						A chunk that is gone is a toast, not the Reload screen: the rest of the sidebar stays, the menu is closed, and
						the next time it is opened the chunk is asked for again (the boundary is cleared by the menu closing).
						The boundary is outside the portal, not inside it: Radix hands the portal's child a ref to read its animation
						off the element (`Presence`), which a class component answers with its instance, and `getComputedStyle` on
						that throws, so that the menu would crash the whole app the moment it opens.
					*/}
					<ErrorBoundary
						resetKey={menuOpen}
						fallback={() => null}
						onError={() => {
							retrySessionMenu();
							setMenuOpen(false);
							useApp.getState().toast("error", t("shell.errorSessionMenuLoad"));
						}}
					>
						<Menu.Portal>
							<Suspense fallback={null}>
								<SessionMenu
									session={s}
									pinned={pinned}
									archived={archived}
									trigger={menuTrigger}
									onAction={onAction}
									onTogglePin={onTogglePin}
									onToggleArchive={onToggleArchive}
								/>
							</Suspense>
						</Menu.Portal>
					</ErrorBoundary>
				</Menu.Root>
			)}
		</div>
	);
});
