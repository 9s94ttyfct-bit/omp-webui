import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import clsx from "clsx";
import { ChevronDown, Loader2, X } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useRef } from "react";
import { useT } from "../i18n/index.ts";

export const cx = clsx;

type Variant = "primary" | "ghost" | "outline" | "danger";

const VARIANTS: Record<Variant, string> = {
	primary: "bg-accent text-accent-fg hover:brightness-110 disabled:opacity-50",
	ghost: "text-muted hover:bg-hover hover:text-fg disabled:opacity-40",
	outline: "border border-border text-fg hover:bg-hover disabled:opacity-50",
	danger: "bg-danger text-accent-fg hover:brightness-110 disabled:opacity-50",
};

export function Button({
	variant = "outline",
	size = "md",
	className,
	children,
	...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
	return (
		<button
			type="button"
			className={cx(
				// A button has a fixed height: a label that wraps spills out of it, so it stays on one line and the row makes room.
				"inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors disabled:cursor-not-allowed",
				size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
				VARIANTS[variant],
				className,
			)}
			{...rest}
		>
			{children}
		</button>
	);
}

const ICON_SIZES: Record<"xs" | "sm" | "md", string> = { xs: "h-6 w-6", sm: "h-7 w-7", md: "h-8 w-8" };

/**
 * Square icon button with a tooltip. Size it with `size` (24, 28 or 32 px), not with `h-*`/`w-*` in `className`:
 * the stylesheet decides between two competing utilities, so the larger one always won.
 *
 * On a touch screen its tooltip is not drawn: there is no hover to ask for it, and focus put back on the button (a
 * drawer closing) left it open over the page for good.
 */
export function IconButton({
	label,
	children,
	className,
	active,
	size = "md",
	...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: keyof typeof ICON_SIZES }) {
	return (
		<Tip label={label} contentClassName="pointer-coarse:hidden">
			<button
				type="button"
				aria-label={label}
				className={cx(
					"inline-flex shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40",
					ICON_SIZES[size],
					active && "bg-hover text-fg",
					className,
				)}
				{...rest}
			>
				{children}
			</button>
		</Tip>
	);
}

/**
 * `wide` is for a tip that is a block of figures, not a hint. `keepSide` keeps it on `side`, from the start of what it
 * points at, where it would otherwise flip to the other side when it does not fit (and cover what the reader is looking
 * at there): it takes the room that side has and scrolls the rest.
 */
export function Tip({
	label,
	children,
	side = "bottom",
	contentClassName,
	wide,
	keepSide,
}: {
	label: ReactNode;
	children: ReactNode;
	side?: "top" | "bottom" | "left" | "right";
	contentClassName?: string;
	wide?: boolean;
	keepSide?: boolean;
}) {
	return (
		<Tooltip.Root delayDuration={350}>
			<Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content
					side={side}
					sideOffset={6}
					align={keepSide ? "start" : "center"}
					avoidCollisions={!keepSide}
					className={cx(
						"z-50 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg shadow-lg",
						wide ? "max-w-[min(32rem,calc(100vw-2rem))]" : "max-w-xs",
						keepSide && "max-h-[var(--radix-tooltip-content-available-height)] overflow-y-auto overscroll-contain",
						contentClassName,
					)}
				>
					{label}
				</Tooltip.Content>
			</Tooltip.Portal>
		</Tooltip.Root>
	);
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
	const t = useT();
	return <Loader2 size={size} className={cx("animate-spin", className)} aria-label={t("shell.uiLoading")} />;
}

export function Badge({
	children,
	tone = "default",
	className,
}: {
	children: ReactNode;
	tone?: "default" | "accent" | "success" | "warning" | "danger";
	className?: string;
}) {
	const tones = {
		default: "bg-hover text-muted",
		// A solid fill with the palette's own label colour (`accent-fg`, held to 4.5:1 on `accent` in every palette): as a tint
		// of the accent under accent text it dropped to 3.5–4.4:1 inside the selected option card, which is that tint too.
		accent: "bg-accent text-accent-fg",
		success: "bg-success/15 text-success",
		warning: "bg-warning/15 text-warning",
		danger: "bg-danger/15 text-danger",
	};
	return (
		<span
			className={cx(
				"inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium",
				tones[tone],
				className,
			)}
		>
			{children}
		</span>
	);
}

/**
 * The modifier symbols of a shortcut (⌘, ⇧, ↵) are drawn in the UI face, not the code face: in a monospace font they
 * sit at about half the height of the letters beside them, so a key cap read as a small sign next to a letter.
 */
const MODIFIER = /[⌘⇧↵]/;

/** A key cap: the letters in the code face, the modifier symbols in the UI face. */
export function Kbd({ children }: { children: ReactNode }) {
	return (
		<kbd className="rounded border border-border bg-bg-soft px-1.5 py-0.5 font-mono text-xs text-muted">
			{typeof children === "string"
				? children
						.split(/([⌘⇧↵])/)
						.filter((part) => part !== "")
						.map((part, i) =>
							MODIFIER.test(part) ? (
								// biome-ignore lint/suspicious/noArrayIndexKey: the parts of one string, in order.
								<span key={i} className="font-sans">
									{part}
								</span>
							) : (
								// biome-ignore lint/suspicious/noArrayIndexKey: the parts of one string, in order.
								<span key={i}>{part}</span>
							),
						)
				: children}
		</kbd>
	);
}

/**
 * The head of a Settings card, the same in every card: the title (with the card's icon), one line of what the card is for
 * and, at the right of the title, an action. The line is a caption, not body text, so that it reads below the title.
 */
export function CardHeader({
	title,
	icon,
	hint,
	action,
}: {
	title: ReactNode;
	icon?: ReactNode;
	hint?: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="mb-3">
			{/* Wraps: on a phone an action as wide as two buttons would otherwise squeeze the title into one word per line. */}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<h2 className="flex min-w-0 flex-1 basis-40 items-center gap-2 text-title font-semibold">
					{icon}
					{title}
				</h2>
				{action}
			</div>
			{hint ? <p className="mt-1 max-w-prose text-xs text-muted">{hint}</p> : null}
		</div>
	);
}

/**
 * How each kind of select looks. The chevron is the app's own (a lucide `ChevronDown`) over a native `<select>` that draws
 * none: the browser's own chevron is bolder than the thin ones of the buttons beside it and moves with the OS.
 */
const SELECT_TONES = {
	/** A form field: the box of the text fields and of the model picker beside it. */
	field: {
		wrap: "block",
		select: "h-9 w-full rounded-xl border border-border bg-bg-soft pr-9 pl-3 text-sm outline-none focus:border-faint",
		chevron: "right-3 text-muted",
		size: 14,
	},
	/** A small filter above a list, with the text of the field over it. */
	compact: {
		wrap: "block",
		select:
			"w-full rounded-lg border border-border bg-surface py-1.5 pr-8 pl-2.5 text-xs text-muted outline-none focus-visible:border-faint",
		chevron: "right-2.5 text-muted",
		size: 12,
	},
	/**
	 * A control among the chips of the composer: no box, as wide as what it shows, the chevron right after it. The select is
	 * laid over the words that size it (`fit`) instead of sharing their cell: WebKit counts a select's longest option toward
	 * the width of a grid cell whatever its `w-0`, which left a gap of a few words after "Off".
	 */
	chip: {
		wrap: "inline-grid",
		select: "absolute inset-0 size-full cursor-pointer bg-transparent pr-4 outline-none",
		chevron: "right-0",
		size: 12,
	},
} as const;

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> & {
	/** Layout of the control as a whole (width, shrink, margin); how it looks comes from `tone`. */
	className?: string;
} & (
		| { tone?: "field" | "compact"; fit?: never }
		// A chip is as wide as the words it shows, which a `<select>` cannot be (it is as wide as its longest option): `fit`
		// is what it shows now, set invisibly in the same cell to give the control its width.
		| { tone: "chip"; fit: ReactNode }
	);

/** A `<select>` with the app's chevron. Everything of a `<select>` (value, `onChange`, `data-testid`, `aria-label`…) goes to it. */
export function Select({ tone = "field", fit, className, children, ...rest }: SelectProps) {
	const look = SELECT_TONES[tone];
	return (
		<span className={cx("relative", look.wrap, "has-[:disabled]:opacity-50", className)}>
			{fit === undefined ? null : (
				<span aria-hidden data-select-sizer className="invisible col-start-1 row-start-1 whitespace-nowrap pr-4">
					{fit}
				</span>
			)}
			<select {...rest} className={cx("appearance-none", look.select)}>
				{children}
			</select>
			<ChevronDown
				size={look.size}
				aria-hidden
				className={cx("pointer-events-none absolute top-1/2 -translate-y-1/2", look.chevron)}
			/>
		</span>
	);
}

/**
 * The last element that held focus outside any dialog. Radix does not ask a dialog where focus came from when focus is
 * already inside it as it opens (a first field with `autoFocus`), so for such a dialog this is what it was opened from.
 *
 * It is held weakly: the element is whatever the user last touched, and a view that has been closed is of no use to
 * anyone. Holding it strongly kept the whole tree of every view the user had opened alive for as long as the page was
 * open: the element is a node of that view, and a node keeps its parents and its siblings alive.
 */
let focusedOutside: WeakRef<HTMLElement> | null = null;
if (typeof document !== "undefined") {
	document.addEventListener(
		"focusin",
		(e) => {
			const el = e.target;
			if (el instanceof HTMLElement && !el.closest('[role="dialog"], [role="alertdialog"]'))
				focusedOutside = new WeakRef(el);
		},
		true,
	);
}

/**
 * Radix gives focus back on close only to a `Dialog.Trigger`, and these dialogs are opened from state, so
 * there is none. Remember what held focus when the dialog opened (or `returnTo`, for an opener that is gone
 * by then, like a menu item) and focus it again on close. Spread the result on `Dialog.Content`.
 */
export function useReturnFocus(returnTo?: HTMLElement | null) {
	/** `undefined`: `onOpenAutoFocus` did not run for this opening (see `focusedOutside`); `null`: it ran and found no opener. */
	const opener = useRef<HTMLElement | null | undefined>(undefined);
	return {
		onOpenAutoFocus: () => {
			const active = document.activeElement;
			opener.current = returnTo ?? (active instanceof HTMLElement && active !== document.body ? active : null);
		},
		onCloseAutoFocus: (e: Event) => {
			e.preventDefault();
			const el = opener.current === undefined ? (returnTo ?? focusedOutside?.deref() ?? null) : opener.current;
			opener.current = undefined;
			if (el?.isConnected) el.focus();
		},
	};
}

/** Presses that landed on the toast region, noted while they happen (see `toastRegion`). */
const toastPresses = new WeakSet<Event>();

/**
 * Toasts render outside every dialog, so Radix counts a press (or focus) on one as "outside" and closes the
 * dialog under it. `toastRegion` goes on the toast stack, `ignoreToastRegion` on `Dialog.Content`.
 * Radix defers the outside press to the click, by which time a dismissed or used toast has left the DOM and
 * the event's target is detached, so the press is recorded when it starts rather than looked up afterwards.
 * Escape is the same: pressed in the stack, which a keyboard user enters with a shortcut while a dialog is open
 * (see `Toasts`), it ends that visit and must not close the dialog.
 */
export const toastRegion = {
	"data-toast-region": true,
	onPointerDownCapture: (e: { nativeEvent: Event }) => toastPresses.add(e.nativeEvent),
};

export const ignoreToastRegion = {
	onInteractOutside: (e: Event) => {
		const press = (e as CustomEvent<{ originalEvent?: Event }>).detail?.originalEvent;
		if ((press && toastPresses.has(press)) || (e.target instanceof Element && e.target.closest("[data-toast-region]")))
			e.preventDefault();
	},
	// Escape while a toast has focus is the stack's (it gives focus back to the dialog), not the dialog's.
	onEscapeKeyDown: (e: KeyboardEvent) => {
		if (e.target instanceof Element && e.target.closest("[data-toast-region]")) e.preventDefault();
	},
};

export function Modal({
	open,
	onOpenChange,
	title,
	description,
	children,
	wide,
	returnFocusTo,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	title: ReactNode;
	description?: ReactNode;
	children: ReactNode;
	wide?: boolean;
	/** Where focus goes on close when the opener won't hold it by then (a menu item that opened this dialog). */
	returnFocusTo?: HTMLElement | null;
}) {
	const t = useT();
	const focus = useReturnFocus(returnFocusTo);
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] fade-in" />
				<Dialog.Content
					className={cx(
						"fixed left-1/2 top-[12vh] z-50 max-h-[76vh] w-[calc(100vw-2rem)] -translate-x-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-2xl fade-in",
						wide ? "max-w-3xl" : "max-w-lg",
					)}
					{...focus}
					{...ignoreToastRegion}
				>
					<div className="mb-3 pr-8">
						<Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
						{description ? (
							<Dialog.Description className="mt-1 text-sm text-muted">{description}</Dialog.Description>
						) : (
							<Dialog.Description className="sr-only">{String(title)}</Dialog.Description>
						)}
					</div>
					{children}
					{/* Last in the DOM, so the dialog opens on its first field (not here) and Tab reaches Close after the actions. */}
					<Dialog.Close asChild>
						<button
							type="button"
							aria-label={t("common.close")}
							className="absolute top-5 right-5 rounded-md p-1 text-muted hover:bg-hover hover:text-fg"
						>
							<X size={16} />
						</button>
					</Dialog.Close>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted">
			{icon}
			<div className="text-sm font-medium text-fg">{title}</div>
			{children ? <div className="max-w-sm text-xs">{children}</div> : null}
		</div>
	);
}

/** A translated string in which the segments between backticks are code (`omp login`). */
export function WithCode({ text }: { text: string }) {
	return (
		<>
			{text.split("`").map((part, i) =>
				i % 2 ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: segments of one immutable string
					<code key={i}>{part}</code>
				) : (
					part
				),
			)}
		</>
	);
}
