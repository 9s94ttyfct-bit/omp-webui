import type { Terminal as XTerm } from "@xterm/xterm";
import { Accessibility } from "lucide-react";
import { type RefObject, useCallback, useRef, useState, useSyncExternalStore } from "react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import {
	isLeaveKey,
	type KeyId,
	keyData,
	leaveTerminal,
	screenReaderMode,
	setScreenReaderMode,
	withCtrl,
} from "../lib/terminal-keys.ts";
import { cx } from "./ui.tsx";

const COARSE = "(pointer: coarse)";

/** Whether the screen is a touch screen: the on-screen keyboards of phones and tablets have no Esc, Tab, Ctrl or arrows. */
function useTouchScreen(): boolean {
	return useSyncExternalStore(
		(notify) => {
			const query = window.matchMedia(COARSE);
			query.addEventListener("change", notify);
			return () => query.removeEventListener("change", notify);
		},
		() => window.matchMedia(COARSE).matches,
		() => false,
	);
}

const KEYS: { id: KeyId; label: string; name?: MessageKey }[] = [
	{ id: "esc", label: "Esc" },
	{ id: "tab", label: "Tab" },
	{ id: "up", label: "↑", name: "pages.termKeyUp" },
	{ id: "down", label: "↓", name: "pages.termKeyDown" },
	{ id: "left", label: "←", name: "pages.termKeyLeft" },
	{ id: "right", label: "→", name: "pages.termKeyRight" },
	{ id: "ctrlc", label: "Ctrl-C" },
];

const KEY_CLASS =
	"inline-flex h-9 min-w-9 items-center justify-center rounded-md border border-border px-2 font-mono text-xs text-fg hover:bg-hover";

/**
 * The keys a touch screen's keyboard lacks, as a row under the terminal (#369): Esc, Tab, Ctrl (one-shot: it turns the next
 * letter typed into its control code), the arrows and Ctrl-C. A press keeps the keyboard where it was, in the screen, so the
 * on-screen keyboard stays up. Shown on touch screens only.
 */
export function TerminalKeys({
	term,
	send,
	ctrl,
	onCtrl,
}: {
	term: XTerm | null;
	/** Sends what a key types to the process. */
	send: (data: string) => void;
	/** Whether the next letter typed is a control character. */
	ctrl: boolean;
	onCtrl: (on: boolean) => void;
}) {
	const t = useT();
	const touch = useTouchScreen();
	if (!touch) return null;
	// A press must not take the focus from the screen: the on-screen keyboard would close on every key.
	const keep = (e: { preventDefault: () => void }) => e.preventDefault();
	return (
		<div
			role="toolbar"
			aria-label={t("pages.termKeysLabel")}
			className="flex flex-wrap items-center gap-1 border-t border-border px-1.5 py-1"
			data-testid="terminal-keys"
		>
			{KEYS.slice(0, 2).map((k) => (
				<button
					key={k.id}
					type="button"
					className={KEY_CLASS}
					data-testid={`terminal-key-${k.id}`}
					onPointerDown={keep}
					onClick={() => send(keyData(k.id, false))}
				>
					{k.label}
				</button>
			))}
			<button
				type="button"
				aria-pressed={ctrl}
				className={cx(KEY_CLASS, ctrl && "border-accent bg-hover")}
				data-testid="terminal-key-ctrl"
				onPointerDown={keep}
				onClick={() => onCtrl(!ctrl)}
			>
				Ctrl
			</button>
			{KEYS.slice(2).map((k) => (
				<button
					key={k.id}
					type="button"
					className={KEY_CLASS}
					aria-label={k.name ? t(k.name) : undefined}
					data-testid={`terminal-key-${k.id}`}
					onPointerDown={keep}
					onClick={() => send(keyData(k.id, term?.modes.applicationCursorKeysMode ?? false))}
				>
					{k.label}
				</button>
			))}
		</div>
	);
}

/**
 * What every terminal screen shares for the keyboard and for assistive technology: the one-shot Ctrl of the touch keys, how the
 * keyboard leaves the screen (Ctrl+F6, named in its label and shown while it has the keyboard: #277), and screen reader mode
 * (#289). `toolbar` goes on the element whose first button takes the keyboard when it leaves; `wire` attaches it all to a screen.
 */
export function useTerminalAccess(termRef: RefObject<XTerm | null>) {
	const toolbar = useRef<HTMLDivElement>(null);
	const ctrlRef = useRef(false);
	const [ctrl, setCtrlState] = useState(false);
	const [reader, setReaderState] = useState(screenReaderMode);
	const [inside, setInside] = useState(false);
	const setCtrl = useCallback((on: boolean) => {
		ctrlRef.current = on;
		setCtrlState(on);
	}, []);
	const setReader = useCallback(
		(on: boolean) => {
			setScreenReaderMode(on);
			setReaderState(on);
			if (termRef.current) termRef.current.options.screenReaderMode = on;
		},
		[termRef],
	);
	/** What the screen sends for `data`: a Ctrl armed by the touch keys turns the next letter into its control code. */
	const typed = useCallback(
		(data: string) => {
			if (!ctrlRef.current) return data;
			setCtrl(false);
			return withCtrl(data);
		},
		[setCtrl],
	);
	/** Ctrl+F6 on the screen, and whether it has the keyboard; `other` handles the keys that are the terminal's own. */
	const wire = useCallback((term: XTerm, el: HTMLElement, other?: (e: KeyboardEvent) => boolean) => {
		term.attachCustomKeyEventHandler((e) => {
			if (e.type === "keydown" && isLeaveKey(e)) {
				e.preventDefault();
				e.stopPropagation();
				leaveTerminal(toolbar.current);
				return false;
			}
			return other ? other(e) : true;
		});
		const enter = () => setInside(true);
		const leave = () => setInside(false);
		el.addEventListener("focusin", enter);
		el.addEventListener("focusout", leave);
		return () => {
			el.removeEventListener("focusin", enter);
			el.removeEventListener("focusout", leave);
			setInside(false);
		};
	}, []);
	return { toolbar, ctrl, setCtrl, typed, reader, setReader, inside, wire };
}

/**
 * The hint that says how the keyboard leaves the screen. It comes and goes with the focus, so it is placed where its coming
 * moves nothing a click is aiming at: a button that slid away between pressing and releasing would lose the click.
 */
export function TerminalLeaveHint({ inside }: { inside: boolean }) {
	const t = useT();
	return inside ? (
		<span className="shrink-0 text-faint" data-testid="terminal-leave-hint">
			{t("pages.termLeaveHint")}
		</span>
	) : null;
}

/** The toolbar's switch for screen reader mode. */
export function TerminalReaderSwitch({ reader, onReader }: { reader: boolean; onReader: (on: boolean) => void }) {
	const t = useT();
	return (
		<button
			type="button"
			aria-pressed={reader}
			title={t("pages.termScreenReaderTip")}
			data-testid="terminal-reader"
			className={cx(
				"inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-muted hover:bg-hover hover:text-fg",
				reader && "bg-hover text-fg",
			)}
			onClick={() => onReader(!reader)}
		>
			<Accessibility size={12} aria-hidden /> {t("pages.termScreenReader")}
		</button>
	);
}
