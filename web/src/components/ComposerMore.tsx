import { Ellipsis } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { cx, IconButton } from "./ui.tsx";

/** What a control in the panel can ask of it (`useComposerMore`). */
interface MoreHandle {
	/** An action that sends or starts something was chosen in the panel: it has done its job, and the panel goes away. */
	done(): void;
	/**
	 * Gives focus to "⋯", for a menu of the panel that closes with the panel (a menu returns focus to its button, which is
	 * hidden then). False where "⋯" is not shown: the controls are in the row, and the menu's own button is the place.
	 */
	focusToggle(): boolean;
}

const MoreContext = createContext<MoreHandle | null>(null);

/** The panel the control is in, or null where it is not in one. */
export function useComposerMore(): MoreHandle | null {
	return useContext(MoreContext);
}

/**
 * The message box's less used controls (thinking, guard, guidance, goal, quick prompts…) where the box is too narrow for
 * all of them. On a phone they were eight icons in a row beside two words, with two amber shields that could not be told
 * apart: there the box keeps the model, the permission mode, Attach and unattended mode, and the rest are behind "⋯", in
 * a panel where each says what it is.
 *
 * The controls are rendered once, in the same place, whatever the width: wide, the panel is `display: contents` and they
 * sit in the row; narrow, it is a panel that "⋯" shows and hides. Moving them between two places would remount them
 * and lose what a picker holds while it is open.
 */
export function ComposerMore({ children }: { children: ReactNode }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const panelId = useId();
	const root = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		if (!open) return;
		const away = (e: PointerEvent) => {
			const target = e.target as Element | null;
			// A picker's own menu is in a portal: choosing in it is not leaving the panel.
			if (!target || root.current?.contains(target) || target.closest("[data-radix-popper-content-wrapper]")) return;
			setOpen(false);
		};
		// The first Escape closes a picker's menu that is open in the panel (Radix takes that Escape, `preventDefault`); the
		// next closes the panel, and is taken here: it is not also the page's Esc that asks to stop a running reply.
		const onEscape = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			e.preventDefault();
			setOpen(false);
			root.current?.querySelector<HTMLButtonElement>('[data-testid="composer-more"]')?.focus();
		};
		document.addEventListener("pointerdown", away);
		document.addEventListener("keydown", onEscape);
		return () => {
			document.removeEventListener("pointerdown", away);
			document.removeEventListener("keydown", onEscape);
		};
	}, [open]);
	const handle = useMemo<MoreHandle>(
		() => ({
			done: () => setOpen(false),
			focusToggle: () => {
				const toggle = root.current?.querySelector<HTMLButtonElement>('[data-testid="composer-more"]');
				if (!toggle || toggle.getClientRects().length === 0) return false;
				toggle.focus();
				return true;
			},
		}),
		[],
	);
	return (
		<span
			ref={root}
			className="contents composer-narrow:relative composer-narrow:order-last composer-narrow:inline-flex"
		>
			{/* Only where the box is narrow: a wrapper, as the button's own `inline-flex` would win over a `hidden` on it. */}
			<span className="hidden composer-narrow:contents">
				<IconButton
					label={t("chat.composerMore")}
					aria-expanded={open}
					aria-controls={panelId}
					data-testid="composer-more"
					active={open}
					onClick={() => setOpen((o) => !o)}
				>
					<Ellipsis size={16} />
				</IconButton>
			</span>
			<span
				id={panelId}
				data-composer-more=""
				data-testid="composer-more-panel"
				className={cx(
					"contents",
					open
						? "composer-narrow:absolute composer-narrow:right-0 composer-narrow:bottom-full composer-narrow:z-30 composer-narrow:mb-2 composer-narrow:flex composer-narrow:w-max composer-narrow:max-w-[calc(100vw-2rem)] composer-narrow:flex-col composer-narrow:items-start composer-narrow:gap-1 composer-narrow:rounded-xl composer-narrow:border composer-narrow:border-border composer-narrow:bg-surface composer-narrow:p-1.5 composer-narrow:shadow-2xl"
						: "composer-narrow:hidden",
				)}
			>
				<MoreContext value={handle}>{children}</MoreContext>
			</span>
		</span>
	);
}
