import { FocusScope } from "@radix-ui/react-focus-scope";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useT } from "../i18n/index.ts";
import { useToastPlace } from "../lib/panel-widths.ts";
import { matches } from "../lib/shortcuts.ts";
import { useToastClearance } from "../lib/toast-clearance.ts";
import { type Toast, useApp } from "../store/app.ts";
import { cx, IconButton, toastRegion } from "./ui.tsx";

const ICON = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert };
const TONE = { info: "text-accent", success: "text-success", warning: "text-warning", error: "text-danger" };
/** How many toasts are on the screen at once; the rest of the stack waits for room. */
const MAX_SHOWN = 2;
/** What a toast needs of the room it stands in to be read and dismissed: its padding (2 × 12px) and one line of text. */
const MIN_FIT = 44;

/**
 * One toast. Its countdown stops while the pointer is over it, focus is inside it or its text is open in full, so it can
 * be read. A long text (a stack trace, a provider's error page) is cut to a few lines with a "Show more" that opens it
 * in a box of its own height, which scrolls: a toast is never taller than that, however long its text.
 */
function ToastItem({ toast, crowded }: { toast: Toast; crowded: boolean }) {
	const dismissToast = useApp((s) => s.dismissToast);
	const pauseToast = useApp((s) => s.pauseToast);
	const resumeToast = useApp((s) => s.resumeToast);
	const t = useT();
	const [open, setOpen] = useState(false);
	const [clipped, setClipped] = useState(false);
	const text = useRef<HTMLDivElement>(null);
	const held = useRef({ pointer: false, focus: false, open: false, crowded: false });
	const hold = (by: "pointer" | "focus" | "open" | "crowded", on: boolean) => {
		held.current[by] = on;
		if (held.current.pointer || held.current.focus || held.current.open || held.current.crowded) pauseToast(toast.id);
		else resumeToast(toast.id);
	};
	// A toast put away (the stack is crowded out) is not read: its clock waits, and runs again once it is back.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `hold` is made again each render; `crowded` is the trigger
	useEffect(() => hold("crowded", crowded), [crowded]);
	// Whether the text is longer than the lines it is cut to; the text's own box is measured while it is cut.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new text is a new thing to measure
	useLayoutEffect(() => {
		const el = text.current;
		if (el && !open) setClipped(el.scrollHeight > el.clientHeight + 1);
	}, [toast.text, open]);
	const Icon = ICON[toast.level];
	// The only things in a toast that take focus are its buttons (and its text, once it scrolls). A press on a button must
	// not take focus from what has it (a dialog's field, the composer): the buttons stay reachable by Tab, and the click
	// still lands.
	const whileFocused = {
		onFocus: () => hold("focus", true),
		onBlur: () => hold("focus", false),
		onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
	};
	const toggle = () => {
		hold("open", !open);
		setOpen(!open);
	};
	return (
		<div
			role={toast.level === "error" ? "alert" : "status"}
			className="pointer-events-auto flex items-start gap-2 rounded-xl border border-border bg-surface p-3 text-sm shadow-xl fade-in"
			data-testid="toast"
			data-level={toast.level}
			onPointerEnter={() => hold("pointer", true)}
			onPointerLeave={() => hold("pointer", false)}
		>
			<Icon size={16} className={cx("mt-0.5 shrink-0", TONE[toast.level])} />
			<div className="min-w-0 flex-1 break-words">
				{open ? (
					<section
						// What scrolls is reached from the keyboard; focus in it holds the toast like focus on a button.
						// biome-ignore lint/a11y/noNoninteractiveTabindex: it scrolls
						tabIndex={0}
						aria-label={toast.text.slice(0, 80)}
						onFocus={() => hold("focus", true)}
						onBlur={() => hold("focus", false)}
						// A whole number of lines (`lh`: this box's own line height), so that the last line is not cut in half at the
						// bottom of the box, and at the window's 40% when that is less; `round()` where it is known.
						className="max-h-[14lh] supports-[height:round(down,1px,1px)]:max-h-[round(down,min(14lh,40dvh),1lh)] overflow-y-auto pr-1 whitespace-pre-line"
						data-testid="toast-text"
					>
						{toast.text}
					</section>
				) : (
					<div ref={text} className="line-clamp-3 whitespace-pre-line" data-testid="toast-text">
						{toast.text}
					</div>
				)}
				{toast.action ? (
					<button
						type="button"
						data-testid="toast-action"
						className="mt-1 block text-xs font-medium text-accent hover:underline"
						{...whileFocused}
						onClick={() => {
							toast.action?.run();
							dismissToast(toast.id);
						}}
					>
						{toast.action.label}
					</button>
				) : null}
				{clipped || open ? (
					<button
						type="button"
						data-testid="toast-more"
						aria-expanded={open}
						className="mt-1 block text-xs font-medium text-accent hover:underline"
						{...whileFocused}
						onClick={toggle}
					>
						{t(open ? "shell.toastLess" : "shell.toastMore")}
					</button>
				) : null}
			</div>
			<IconButton
				label={t("shell.toastDismiss")}
				size="sm"
				className="-mt-1 -mr-1.5"
				data-testid="toast-dismiss"
				{...whileFocused}
				onClick={() => dismissToast(toast.id)}
			>
				<X size={14} />
			</IconButton>
		</div>
	);
}

/**
 * At the bottom, above the conversation's bottom block (the composer, and what a request puts above it: its choices are
 * taps, which a toast over them would take) and under the top of the transcript, so the header's buttons and a banner's
 * stay clear (`toast-clearance.ts`). Right of the conversation, left of the side panel (a toast over the panel would
 * cover its first row, whose Stop button the toast a Stop raises must not hide); where the panel is a sheet on a window
 * too narrow to leave room beside it, the stack goes over the sheet at the bottom of the window instead, above the
 * sheet's message box when it has one. On a phone the stack is as wide as the screen allows. Two toasts are shown at
 * most, the newest: the older ones wait (a note says how many) with their clocks stopped, and come back as the others go.
 * Whatever is in them, what does not fit scrolls. Where not even the first toast fits above the block (a phone on its
 * side), the stack is put away (`data-crowded`: invisible, so that it takes no taps) and its toasts' clocks wait until it
 * is back. The padding is room for the toasts' shadows, which a scrolling box would cut off; the box sits that much
 * further out, so the toasts are where they were.
 *
 * A dialog traps focus, so Tab never reaches the stack while one is open. The `toasts` shortcut starts a visit
 * instead: focus goes to the newest toast's first button (its action, else Dismiss), Tab goes round the buttons of
 * the stack, and Esc ends the visit and gives focus back to where it was, the dialog staying open (`ignoreToastRegion`
 * keeps that Esc from closing it). Using or dismissing the last toast ends it too; focus or a press going elsewhere
 * ends it and leaves focus where it went. The visit is a `FocusScope` of its own on top of the dialog's, which is
 * what makes the dialog's trap stand aside while it lasts. The scope holds nothing (the stack is not inside it): it
 * only takes its place in Radix's stack of scopes, and focus is given back here, not by Radix, which does it a task
 * late, after the next visit may have begun.
 */
export function Toasts() {
	const t = useT();
	const toasts = useApp((s) => s.toasts);
	const pauseToast = useApp((s) => s.pauseToast);
	// The newest toasts are shown, MAX_SHOWN at most; the older ones wait their turn (see `queued`).
	const shown = toasts.slice(-MAX_SHOWN);
	const queued = toasts.slice(0, -MAX_SHOWN);
	const queuedIds = queued.map((q) => q.id).join();
	// A toast that waits is not read: its clock waits too, and runs again once it is shown (its `ToastItem` starts it).
	// biome-ignore lint/correctness/useExhaustiveDependencies: `queuedIds` says which toasts these are
	useEffect(() => {
		for (const q of queued) pauseToast(q.id);
	}, [queuedIds, pauseToast]);
	const place = useToastPlace();
	const region = useRef<HTMLDivElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const clearance = useToastClearance();
	// Over a sheet the conversation's composer is covered, and there is nothing to stand above.
	const clear = place.overSheet ? null : clearance;
	// Whether the stack is put away: it stands above the conversation's bottom block (`clear`), and not even the first
	// toast fits in what is left (a phone on its side, a request that fills the screen). Measured, since the room is what
	// the page's other blocks leave it. Only while the clearance holds: a stack with its own place is cut off by its own
	// bounds, and is never hidden.
	const [crowded, setCrowded] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a count that comes or goes moves the first toast
	useLayoutEffect(() => {
		const box = region.current;
		const items = list.current;
		if (!box || !items) return;
		const measure = () => {
			const first = items.firstElementChild;
			// The first toast starts under the box's top padding (`p-3`, 12px) and the note of what waits. Its padding and a line
			// of its text (MIN_FIT) are what a person needs to read it and reach its Dismiss: a taller toast scrolls in what is
			// left, and only when not even that fits is the stack put away.
			const over =
				first instanceof HTMLElement && first.offsetTop + Math.min(first.offsetHeight, MIN_FIT) > box.clientHeight;
			setCrowded(clear !== null && over);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(box);
		observer.observe(items);
		return () => observer.disconnect();
	}, [clear, queued.length]);
	const [visiting, setVisiting] = useState(false);
	/** The visit in progress, once its scope has taken over from the dialog's; `origin` is what had focus before. */
	const visit = useRef<{ origin: Element | null } | null>(null);

	const focusNewest = useCallback(() => {
		list.current?.lastElementChild?.querySelector<HTMLElement>("button")?.focus();
	}, []);
	const endVisit = useCallback((giveBack: boolean) => {
		const ended = visit.current;
		if (!ended) return;
		visit.current = null;
		setVisiting(false);
		if (!giveBack) return;
		const now = document.activeElement;
		// Something else has taken focus meanwhile (a toast's action opened a page and focused its field): it keeps it.
		if (now && now !== document.body && !region.current?.contains(now)) return;
		const { origin } = ended;
		if (origin instanceof HTMLElement && origin.isConnected && origin !== document.body) origin.focus();
		// A page with nothing focused had no focus to give back: the stack is not left holding it.
		else if (now instanceof HTMLElement) now.blur();
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!matches("toasts", e) || e.isComposing || useApp.getState().toasts.length === 0) return;
			e.preventDefault();
			if (visit.current) focusNewest();
			else setVisiting(true);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [focusNewest]);

	// Focus or a press anywhere but the stack hands the visit back to whoever took it.
	useEffect(() => {
		if (!visiting) return;
		const away = (e: Event) => {
			if (!region.current?.contains(e.target as Node)) endVisit(false);
		};
		document.addEventListener("pointerdown", away, true);
		document.addEventListener("focusin", away);
		return () => {
			document.removeEventListener("pointerdown", away, true);
			document.removeEventListener("focusin", away);
		};
	}, [visiting, endVisit]);

	// The toast that had focus is gone (used, dismissed, pushed out): the next one has it, or the visit is over.
	useEffect(() => {
		if (!visit.current) return;
		if (toasts.length === 0) endVisit(true);
		else if (document.activeElement === document.body) focusNewest();
	}, [toasts, endVisit, focusNewest]);

	const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		if (!visit.current || e.nativeEvent.isComposing) return;
		if (e.key === "Escape") {
			// Not the page's: a side sheet or the sidebar's selection would close with it.
			e.preventDefault();
			e.stopPropagation();
			endVisit(true);
		} else if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) {
			const buttons = list.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
			const first = buttons?.[0];
			const last = buttons?.[buttons.length - 1];
			if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
				e.preventDefault();
				(e.shiftKey ? last : first)?.focus();
			}
		}
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the keys are its buttons' own; the stack only sees them bubble.
		<div
			ref={region}
			className={cx(
				"pointer-events-none fixed z-[60] flex w-[min(21.5rem,calc(100vw-0.5rem))] flex-col gap-2 overflow-y-auto overscroll-contain p-3 max-sm:w-[calc(100vw-0.5rem)]",
				// Without a conversation to stand above (another page, or a sheet over it) the stack is at the window's bottom.
				// Under the header and a banner (9rem is more than both take).
				!clear && "bottom-[max(0.25rem,env(safe-area-inset-bottom))] max-h-[calc(100dvh-9rem)]",
				// Over a sheet it stands above the sheet's own bar (the steer box, the Ask box: `data-panel-bar`, 49px) when the sheet
				// has one, so that a failed send does not cover the field and the button it needs to try again. Only there: an
				// element this rule matches makes the browser watch `body:has(…)` for every change of the page from then on, and
				// a long conversation that streams changes it all the time (whole-page style work on each).
				place.overSheet && "[body:has([data-panel-bar])_&]:bottom-12",
			)}
			style={{
				right: `calc(${place.inset}px + 0.25rem)`,
				// Above the conversation's bottom block and under its transcript's top. The padding is room for the toasts'
				// shadows, so the box reaches the block's top and 8px above the transcript's (a toast starts 4px under it).
				...(clear
					? {
							bottom: `${clear.bottom}px`,
							maxHeight: `calc(100dvh - ${clear.bottom}px - ${Math.max(0, clear.top - 8)}px)`,
						}
					: {}),
			}}
			data-crowded={crowded || undefined}
			{...toastRegion}
			aria-live="polite"
			onKeyDown={onKeyDown}
		>
			{queued.length > 0 ? (
				<div
					className={cx(
						"self-end rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs text-muted shadow-md",
						crowded && "invisible",
					)}
					data-testid="toasts-queued"
				>
					{t("shell.toastsQueued", { n: queued.length })}
				</div>
			) : null}
			{/* Put away: not even the first toast fits above what it must keep clear, and a sliver of one that takes taps is worse than none. They wait (the clocks too), and the words below say so. */}
			<div ref={list} className={cx("flex flex-col gap-2", crowded && "invisible")}>
				{shown.map((toast) => (
					<ToastItem key={toast.id} toast={toast} crowded={crowded} />
				))}
			</div>
			{crowded ? (
				<p className="sr-only" data-testid="toasts-waiting">
					{t("shell.toastsWaiting", { n: toasts.length })}
				</p>
			) : null}
			{visiting ? (
				<>
					<FocusScope
						className="hidden"
						onMountAutoFocus={(e) => {
							e.preventDefault();
							visit.current = { origin: document.activeElement };
							focusNewest();
						}}
						onUnmountAutoFocus={(e) => e.preventDefault()}
					/>
					<div
						className="self-end rounded-md border border-border bg-surface px-2 py-1 text-xs text-muted shadow-md"
						data-testid="toasts-hint"
					>
						{t("shell.toastsHint")}
					</div>
				</>
			) : null}
		</div>
	);
}
