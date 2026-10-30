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

/**
 * The row's tint is a variable (`--row-bg`): the actions are laid over the end of the name, on a backdrop of the
 * sidebar's colour with that tint over it, which is the colour of the row under them whatever state the row is in.
 */
const TINT = {
	selected: "text-fg [--row-bg:var(--color-accent-soft)]",
	active: "text-fg [--row-bg:var(--color-hover)]",
	rest: "text-muted [--row-bg:transparent] hover:text-fg hover:[--row-bg:color-mix(in_oklab,var(--color-hover)_70%,transparent)]",
} as const;

/** The actions at rest: not seen until the row is hovered or has focus, and always seen on a touch screen. */
const HIDDEN = "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100";
/** And out of the pointer's way while they are not seen: a click there is a click on the name under them. */
const UNREACHABLE =
	"pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto touch:pointer-events-auto";

/**
 * One sidebar row: open on click, plus a menu with omp-backed session actions.
 *
 * The name has the whole width of the row: the menu button takes none of it. With a mouse the button is shown over the
 * end of the name (on a backdrop that fades in, so that the two do not run into each other) while the row is hovered,
 * has keyboard focus, or is the open conversation, and the name stays where it is. The marks before the name (pinned,
 * branch) are never covered, and neither are the live state's after it: the button stops where they start. On a touch
 * screen, where nothing is hovered, the button is always shown at the end of the row, after the name, as it always was.
 */
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
	// What the live process is doing, after the name.
	const trail =
		liveState === "paused" ? (
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
		) : null;
	// The open conversation's actions are always shown, and so are those of a row whose menu is open.
	const shown = active || menuOpen;
	return (
		<div
			className={cx(
				"group relative flex items-center rounded-lg bg-(--row-bg)",
				selecting && selected ? TINT.selected : active && !selecting ? TINT.active : TINT.rest,
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
					"flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pr-2.5 pl-2.5 text-left text-sm focus-visible:-outline-offset-2",
					!selecting && "touch:rounded-r-none touch:pr-1",
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
				<span data-testid="session-title" className="min-w-0 flex-1 truncate">
					<Mark text={sessionLabel(s)} positions={mark ?? []} />
				</span>
				{trail}
				{snippet === undefined ? null : (
					// The whole width under the name: a line of the message is what says why the row is listed.
					<span data-testid="session-item-snippet" className="w-full truncate text-xs text-faint">
						<Snippet text={snippet} />
					</span>
				)}
			</button>
			{selecting ? null : (
				// Over the end of the row, clear of the focus ring at its top and bottom; on a touch screen, after the name.
				<div className="pointer-events-none absolute inset-y-0.5 right-0 flex pr-2.5 touch:static touch:pr-1">
					<div
						data-testid="session-actions"
						className={cx(
							"flex items-center bg-bg-soft bg-[linear-gradient(var(--row-bg),var(--row-bg))] pl-6 [mask-image:linear-gradient(to_right,transparent,black_1.5rem)]",
							"touch:bg-transparent touch:bg-none touch:pl-0 touch:[mask-image:none]",
							shown ? "opacity-100" : HIDDEN,
						)}
					>
						<Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
							<Menu.Trigger asChild>
								<button
									ref={menuTrigger}
									type="button"
									aria-label={t("shell.sessionActionsFor", { label: sessionLabel(s) })}
									data-testid="session-menu"
									className={cx(
										"rounded-md p-1.5 text-faint hover:bg-surface hover:text-fg",
										shown ? "pointer-events-auto opacity-100" : [HIDDEN, UNREACHABLE],
									)}
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
					</div>
					{/* A stand-in for the live state's marks, as wide as they are: the backdrop stops where they start. */}
					{trail ? (
						<span aria-hidden className="invisible flex items-center gap-2 pl-2 touch:hidden">
							{trail}
						</span>
					) : null}
				</div>
			)}
		</div>
	);
});
