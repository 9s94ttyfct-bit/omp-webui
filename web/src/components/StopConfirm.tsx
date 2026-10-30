import { STOP_GRACE_MS } from "@shared/stop.ts";
import { Loader2, Square } from "lucide-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { dismissesStop, STOP_CONFIRM_MS, stopPress } from "../lib/stop-confirm.ts";
import { Button } from "./ui.tsx";

/**
 * The state of the "Stop this reply?" question that the first Esc asks (the rule is in `lib/stop-confirm.ts`).
 * `press` is what an Esc that would stop calls: it asks, and a second one within the time stops. The question goes
 * away when the time is up, when the reply is over, on any other key (Tab and the modifiers aside: they walk to its
 * buttons) and on a press anywhere but on it. `scope` names what is being stopped; another one starts over.
 */
export function useStopConfirm(running: boolean, scope: string | null, stop: () => void) {
	const [armed, setArmed] = useState(false);
	// The moment it was asked, and the one stop it may still lead to: read in handlers that can run twice before a render.
	const armedAt = useRef<number | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const latest = useRef(stop);
	latest.current = stop;

	const cancel = useCallback(() => {
		clearTimeout(timer.current);
		armedAt.current = null;
		setArmed(false);
	}, []);

	const press = useCallback(() => {
		if (stopPress(armedAt.current, Date.now()) === "stop") {
			cancel();
			latest.current();
			return;
		}
		clearTimeout(timer.current);
		armedAt.current = Date.now();
		setArmed(true);
		timer.current = setTimeout(cancel, STOP_CONFIRM_MS);
	}, [cancel]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the reply or conversation changing is what ends the question.
	useEffect(() => cancel, [running, scope, cancel]);

	useEffect(() => {
		if (!armed) return;
		const onKey = (e: KeyboardEvent) => {
			// A key on the question's own buttons is theirs (Enter and Space press them).
			if (e.target instanceof Element && e.target.closest("[data-stop-confirm]")) return;
			if (dismissesStop(e.key)) cancel();
		};
		const onPress = (e: PointerEvent) => {
			if (!(e.target instanceof Element && e.target.closest("[data-stop-confirm]"))) cancel();
		};
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("pointerdown", onPress, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("pointerdown", onPress, true);
		};
	}, [armed, cancel]);

	return { armed, press, cancel };
}

/**
 * The question itself, above the message box: a live region (so a screen reader reads it when it appears, and it is not
 * a dialog: the second Esc must reach the page) with Stop and Cancel in the tab order, right before the composer. It
 * does not take focus; pressing either of its buttons gives focus back to the message box.
 */
export function StopConfirm({
	armed,
	onStop,
	onCancel,
	returnFocus,
}: {
	armed: boolean;
	onStop: () => void;
	onCancel: () => void;
	returnFocus: RefObject<{ focus(): void } | null>;
}) {
	const t = useT();
	// Whether the keyboard was on one of the prompt's buttons when it went: the card is removed with the focus in it,
	// which drops focus on the page and the draft's caret with it (the timer, the reply ending, a click elsewhere).
	const holdsFocus = useRef(false);
	const answer = (act: () => void) => () => {
		act();
		if (holdsFocus.current) returnFocus.current?.focus();
	};
	useEffect(() => {
		if (armed) {
			const inCard = (target: EventTarget | null) =>
				target instanceof Element && target.closest("[data-stop-confirm]") !== null;
			const focusing = (e: FocusEvent) => {
				holdsFocus.current = inCard(e.target);
			};
			const away = (e: PointerEvent) => {
				if (!inCard(e.target)) holdsFocus.current = false;
			};
			window.addEventListener("focusin", focusing, true);
			window.addEventListener("pointerdown", away, true);
			return () => {
				window.removeEventListener("focusin", focusing, true);
				window.removeEventListener("pointerdown", away, true);
			};
		}
		const active = document.activeElement;
		if (holdsFocus.current && (!active || active === document.body)) returnFocus.current?.focus();
		holdsFocus.current = false;
	}, [armed, returnFocus]);
	return (
		<div role="status" aria-atomic="true" data-testid="stop-confirm-region">
			{armed ? (
				<div
					data-stop-confirm
					data-testid="stop-confirm"
					className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm shadow-sm"
				>
					<Square size={13} className="shrink-0 text-muted" fill="currentColor" aria-hidden="true" />
					<span className="min-w-0 flex-1">{t("chat.stopConfirmText")}</span>
					<span className="flex shrink-0 items-center gap-2">
						<Button size="sm" variant="primary" data-testid="stop-confirm-stop" onClick={answer(onStop)}>
							{t("chat.composerStop")}
						</Button>
						<Button size="sm" data-testid="stop-confirm-cancel" onClick={answer(onCancel)}>
							{t("chat.stopConfirmCancel")}
						</Button>
					</span>
				</div>
			) : null}
		</div>
	);
}

/** How long a Stop may take before the page says what it is waiting for: a Stop that works is over before it. */
const SLOW_MS = 1500;

/**
 * What a Stop that has not finished says, above the message box: "Stopping…", and once it has taken a moment, that omp has
 * not stopped yet and what happens if it does not (its process is ended after `STOP_GRACE_MS`; the conversation is kept).
 * Mounted while the Stop is under way, so the moment is counted from its press.
 */
export function StoppingNote() {
	const t = useT();
	const [slow, setSlow] = useState(false);
	useEffect(() => {
		const timer = setTimeout(() => setSlow(true), SLOW_MS);
		return () => clearTimeout(timer);
	}, []);
	return (
		<div
			role="status"
			data-testid="stopping"
			className="mb-2 flex items-start gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm shadow-sm"
		>
			<Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-muted" aria-hidden="true" />
			<span className="min-w-0 flex-1">
				{slow ? t("chat.stoppingSlow", { s: STOP_GRACE_MS / 1000 }) : t("chat.stopping")}
			</span>
		</div>
	);
}
