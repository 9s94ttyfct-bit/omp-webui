import { type BrowserInput, frameToPage, type PageInfo, type Size } from "@shared/browser-protocol.ts";
import { useEffect, useRef } from "react";
import { useT } from "../i18n/index.ts";
import { type Frame, onFrame, sendScreen } from "../store/browser-screen.ts";

/**
 * A page of the built-in browser as its screencast (everywhere but the Mac app's own window, where a native view covers the
 * tab): the frames drawn on a canvas that fills the room it is given, the page letterboxed in it at its own proportions,
 * and the person's pointer, wheel, keys and composed text sent to the page in its CSS pixels (`frameToPage`).
 *
 * It never takes the keyboard by itself: the composer keeps it until the person clicks or taps into the page. Then a
 * hidden text area holds it, so that a phone's keyboard and an IME have somewhere to type; what they compose is sent as
 * text, and keys that type nothing (Enter, Backspace, arrows, shortcuts) as keys.
 */

/** CDP's modifier bits. */
function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
	return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const BUTTONS = ["left", "middle", "right"] as const;

/** A finger that travels this far (CSS px) scrolls the page instead of tapping it. */
const TAP_SLOP = 8;

/**
 * A press of the same mouse button this soon (ms) and this near (CSS px) after the last one is its double-click (then a
 * triple-click): pointer events carry no click count (`detail` is 0), and the page makes a `dblclick` or selects a word
 * only when the press it is sent says 2.
 */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_SLOP = 4;

/** What a key types into the page, for the keys that type something without being text (`\r` for Enter, as CDP has it). */
const KEY_TEXT: Record<string, string> = { Enter: "\r" };

/** Where the page is drawn in the canvas (CSS px of the canvas), from the page's size and the canvas's. */
function fit(page: Size, room: Size): { x: number; y: number; w: number; h: number } {
	const scale = Math.min(room.w / page.w, room.h / page.h);
	const w = page.w * scale;
	const h = page.h * scale;
	return { x: (room.w - w) / 2, y: (room.h - h) / 2, w, h };
}

export function BrowserScreen({ page }: { page: PageInfo }) {
	const t = useT();
	const canvas = useRef<HTMLCanvasElement>(null);
	const typing = useRef<HTMLTextAreaElement>(null);
	/** The last frame drawn: its page size is what a point is mapped against. */
	const shown = useRef<{ bitmap: ImageBitmap; header: Frame["header"] } | null>(null);
	const targetId = page.targetId;

	// Frames: decoded off the main thread, drawn in order (a frame older than the one drawn is dropped).
	useEffect(() => {
		const el = canvas.current;
		if (!el) return;
		let latest = 0;
		let disposed = false;
		const draw = () => {
			const frame = shown.current;
			const ctx = el.getContext("2d");
			if (!ctx) return;
			const dpr = window.devicePixelRatio || 1;
			const room = { w: el.clientWidth, h: el.clientHeight };
			const want = { w: Math.max(1, Math.round(room.w * dpr)), h: Math.max(1, Math.round(room.h * dpr)) };
			if (el.width !== want.w || el.height !== want.h) {
				el.width = want.w;
				el.height = want.h;
			}
			ctx.clearRect(0, 0, el.width, el.height);
			if (!frame) return;
			const at = fit(frame.header, room);
			ctx.imageSmoothingQuality = "high";
			ctx.drawImage(frame.bitmap, at.x * dpr, at.y * dpr, at.w * dpr, at.h * dpr);
		};
		const stop = onFrame(({ header, jpeg }) => {
			if (header.targetId !== targetId || header.seq <= latest) return;
			latest = header.seq;
			const seq = header.seq;
			createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" })).then(
				(bitmap) => {
					if (disposed || seq < latest) return bitmap.close();
					shown.current?.bitmap.close();
					shown.current = { bitmap, header };
					el.dataset.seq = String(seq);
					el.dataset.page = `${header.w}x${header.h}`;
					draw();
				},
				() => {},
			);
		});
		const resized = new ResizeObserver(draw);
		resized.observe(el);
		return () => {
			disposed = true;
			stop();
			resized.disconnect();
			shown.current?.bitmap.close();
			shown.current = null;
		};
	}, [targetId]);

	// The person's input. The listeners are the element's own (a wheel's default is prevented, which React's are not let do).
	useEffect(() => {
		const el = canvas.current;
		const text = typing.current;
		if (!el || !text) return;
		const toPage = (event: BrowserInput) => sendScreen({ t: "input", targetId, event });
		/** The point as CSS px of the page; null outside the page's picture. */
		const pointOf = (e: { clientX: number; clientY: number }, clamp = false) => {
			const frame = shown.current?.header;
			const size = frame ? { w: frame.w, h: frame.h } : { w: page.w, h: page.h };
			const box = el.getBoundingClientRect();
			const at = fit(size, { w: box.width, h: box.height });
			const x = e.clientX - box.left - at.x;
			const y = e.clientY - box.top - at.y;
			if (!clamp && (x < 0 || y < 0 || x > at.w || y > at.h)) return null;
			return frameToPage(x, y, { w: at.w, h: at.h }, size);
		};
		const mouse = (
			type: "mousePressed" | "mouseReleased" | "mouseMoved",
			p: { x: number; y: number },
			button: "none" | "left" | "middle" | "right",
			clickCount: number,
			modifiers: number,
		) => toPage({ kind: "mouse", type, x: p.x, y: p.y, button, clickCount, modifiers });

		/** A finger on the page: a tap when it lifts where it went down, a scroll when it travels. */
		let touch: { id: number; x: number; y: number; lastX: number; lastY: number; moved: boolean } | null = null;
		/** A mouse button held on the page, and the click count its press was sent with. */
		let held: { id: number; button: "left" | "middle" | "right"; count: number } | null = null;
		/** The last press of a mouse button, which the next one may continue as a double or triple click. */
		let lastPress: { button: string; time: number; x: number; y: number; count: number } | null = null;
		let moveQueued: PointerEvent | null = null;
		let frameRequest = 0;

		const down = (e: PointerEvent) => {
			const p = pointOf(e);
			if (!p) return;
			// Only now does the page take the keyboard: the person clicked into it.
			text.focus({ preventScroll: true });
			e.preventDefault();
			if (e.pointerType === "touch") {
				touch = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false };
				el.setPointerCapture(e.pointerId);
				return;
			}
			const button = BUTTONS[e.button] ?? "left";
			const last = lastPress;
			const count =
				last &&
				last.button === button &&
				e.timeStamp - last.time < MULTI_CLICK_MS &&
				Math.hypot(e.clientX - last.x, e.clientY - last.y) <= MULTI_CLICK_SLOP
					? last.count + 1
					: 1;
			lastPress = { button, time: e.timeStamp, x: e.clientX, y: e.clientY, count };
			held = { id: e.pointerId, button, count };
			el.setPointerCapture(e.pointerId);
			mouse("mousePressed", p, button, count, modifiersOf(e));
		};
		const move = (e: PointerEvent) => {
			if (touch && e.pointerId === touch.id) {
				if (!touch.moved && Math.hypot(e.clientX - touch.x, e.clientY - touch.y) < TAP_SLOP) return;
				touch.moved = true;
				const p = pointOf(e, true);
				if (!p) return;
				toPage({
					kind: "wheel",
					x: p.x,
					y: p.y,
					deltaX: touch.lastX - e.clientX,
					deltaY: touch.lastY - e.clientY,
					modifiers: 0,
				});
				touch.lastX = e.clientX;
				touch.lastY = e.clientY;
				return;
			}
			if (e.pointerType === "touch") return;
			// One move a frame: the page needs where the pointer is, not every step of the way.
			moveQueued = e;
			if (frameRequest) return;
			frameRequest = requestAnimationFrame(() => {
				frameRequest = 0;
				const last = moveQueued;
				moveQueued = null;
				if (!last) return;
				const p = pointOf(last, held !== null);
				if (p) mouse("mouseMoved", p, held?.button ?? "none", 0, modifiersOf(last));
			});
		};
		const up = (e: PointerEvent) => {
			if (touch && e.pointerId === touch.id) {
				const tapped = !touch.moved;
				touch = null;
				const p = pointOf(e, true);
				if (tapped && p) {
					mouse("mousePressed", p, "left", 1, 0);
					mouse("mouseReleased", p, "left", 1, 0);
				}
				return;
			}
			if (!held || e.pointerId !== held.id) return;
			const p = pointOf(e, true);
			if (p) mouse("mouseReleased", p, held.button, held.count, modifiersOf(e));
			held = null;
		};
		const cancel = (e: PointerEvent) => {
			if (touch?.id === e.pointerId) touch = null;
			if (held?.id === e.pointerId) held = null;
		};
		const wheel = (e: WheelEvent) => {
			const p = pointOf(e);
			if (!p) return;
			e.preventDefault();
			const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
			toPage({
				kind: "wheel",
				x: p.x,
				y: p.y,
				deltaX: e.deltaX * unit,
				deltaY: e.deltaY * unit,
				modifiers: modifiersOf(e),
			});
		};
		const contextMenu = (e: Event) => e.preventDefault();

		// Keys. A key that types one character with no shortcut modifier is sent with its text; one that is being composed
		// (an IME, a phone's keyboard: `Process` / 229) is left to the text area, whose composed text is sent as text.
		let composing = false;
		const key = (type: "keyDown" | "keyUp", e: KeyboardEvent) => {
			const typesText = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
			const typed = typesText ? e.key : KEY_TEXT[e.key];
			toPage({
				kind: "key",
				type,
				key: e.key,
				code: e.code,
				...(typed !== undefined && type === "keyDown" ? { text: typed } : {}),
				keyCode: e.keyCode,
				modifiers: modifiersOf(e),
			});
		};
		/** Left to the text area: a key being composed, or the paste shortcut (the paste is sent as text). */
		const leftAlone = (e: KeyboardEvent) =>
			composing ||
			e.isComposing ||
			e.keyCode === 229 ||
			e.key === "Unidentified" ||
			e.key === "Process" ||
			((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v");
		const keyDown = (e: KeyboardEvent) => {
			if (leftAlone(e)) return;
			e.preventDefault();
			key("keyDown", e);
		};
		const keyUp = (e: KeyboardEvent) => {
			if (leftAlone(e)) return;
			e.preventDefault();
			key("keyUp", e);
		};
		const paste = (e: ClipboardEvent) => {
			e.preventDefault();
			const pasted = e.clipboardData?.getData("text/plain");
			if (pasted) toPage({ kind: "text", text: pasted });
		};
		const beforeInput = (e: InputEvent) => {
			if (composing || e.isComposing) return;
			if (e.inputType === "insertText" && e.data) {
				e.preventDefault();
				toPage({ kind: "text", text: e.data });
			} else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
				e.preventDefault();
				const enter = { key: "Enter", code: "Enter", keyCode: 13, modifiers: 0 };
				toPage({ kind: "key", type: "keyDown", text: "\r", ...enter });
				toPage({ kind: "key", type: "keyUp", ...enter });
			} else if (e.inputType === "deleteContentBackward") {
				e.preventDefault();
				const backspace = { key: "Backspace", code: "Backspace", keyCode: 8, modifiers: 0 };
				toPage({ kind: "key", type: "keyDown", ...backspace });
				toPage({ kind: "key", type: "keyUp", ...backspace });
			}
		};
		const compositionStart = () => {
			composing = true;
		};
		const compositionEnd = (e: CompositionEvent) => {
			composing = false;
			if (e.data) toPage({ kind: "text", text: e.data });
			text.value = "";
		};

		el.addEventListener("pointerdown", down);
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
		el.addEventListener("pointercancel", cancel);
		el.addEventListener("wheel", wheel, { passive: false });
		el.addEventListener("contextmenu", contextMenu);
		text.addEventListener("keydown", keyDown);
		text.addEventListener("keyup", keyUp);
		text.addEventListener("beforeinput", beforeInput);
		text.addEventListener("compositionstart", compositionStart);
		text.addEventListener("compositionend", compositionEnd);
		text.addEventListener("paste", paste);
		return () => {
			cancelAnimationFrame(frameRequest);
			el.removeEventListener("pointerdown", down);
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", up);
			el.removeEventListener("pointercancel", cancel);
			el.removeEventListener("wheel", wheel);
			el.removeEventListener("contextmenu", contextMenu);
			text.removeEventListener("keydown", keyDown);
			text.removeEventListener("keyup", keyUp);
			text.removeEventListener("beforeinput", beforeInput);
			text.removeEventListener("compositionstart", compositionStart);
			text.removeEventListener("compositionend", compositionEnd);
			text.removeEventListener("paste", paste);
		};
	}, [targetId, page.w, page.h]);

	const label = t("browser.screenLabel", {
		title: !page.url || page.url === "about:blank" ? t("browser.untitled") : page.title || page.url,
	});
	return (
		<div className="relative min-h-0 flex-1 bg-bg">
			<canvas
				ref={canvas}
				className="absolute inset-0 h-full w-full touch-none select-none"
				data-testid="browser-screen"
				data-target={targetId}
				role="img"
				aria-label={label}
			/>
			{/* Where the keyboard goes once the person clicked into the page: off screen, never focused by itself. */}
			<textarea
				ref={typing}
				className="pointer-events-none absolute top-0 left-0 h-px w-px resize-none overflow-hidden opacity-0"
				aria-label={label}
				data-testid="browser-keys"
				autoCapitalize="off"
				autoComplete="off"
				autoCorrect="off"
				spellCheck={false}
				tabIndex={-1}
			/>
		</div>
	);
}
