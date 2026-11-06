/**
 * The Browser tab's socket (`/ws/browser`): the page asks to watch a conversation's pages and drives them; the server
 * sends the page list, console entries, and the shown page's screencast frames. Docs: docs/agents/browser.md.
 *
 * Frames are binary: `[u32 big-endian header length][header JSON (FrameHeader)][JPEG]`. Everything else is JSON text.
 */

export type PageMode = "desktop" | "panel" | "phone";

/** A size in CSS pixels. */
export interface Size {
	w: number;
	h: number;
}

export interface MouseInput {
	kind: "mouse";
	type: "mousePressed" | "mouseReleased" | "mouseMoved";
	/** CSS pixels of the page. */
	x: number;
	y: number;
	button: "none" | "left" | "middle" | "right";
	clickCount: number;
	/** CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
	modifiers: number;
}

export interface WheelInput {
	kind: "wheel";
	x: number;
	y: number;
	deltaX: number;
	deltaY: number;
	modifiers: number;
}

export interface KeyInput {
	kind: "key";
	type: "keyDown" | "keyUp";
	key: string;
	code: string;
	/** What the key types, for a key that types something (Enter types "\r"). */
	text?: string;
	keyCode: number;
	modifiers: number;
}

/** Composed text (an IME's commit, a phone keyboard's input), inserted as it is. */
export interface TextInput {
	kind: "text";
	text: string;
}

export type BrowserInput = MouseInput | WheelInput | KeyInput | TextInput;

export type ScreenClientMessage =
	/** Watch `owner`'s page list, and the frames and console of `targetId` (none: the list only). `panel`: the frame's
	 *  room in device pixels. `frames: false`: the console only (the Mac app's own view draws the page). */
	| { t: "watch"; owner: string; targetId: string | null; panel: Size; frames?: boolean }
	| { t: "unwatch" }
	/** A new page for the conversation (the person's "New page"). */
	| { t: "open"; owner: string; url: string }
	| { t: "close"; targetId: string }
	| { t: "navigate"; targetId: string; action: "url" | "back" | "forward" | "reload"; url?: string }
	/** The page's layout size: the desktop size (`desktop`, from Settings; 1280×800 without it), the panel's, a phone's. */
	| { t: "size"; targetId: string; mode: PageMode; panel?: Size; desktop?: Size }
	/** The page is drawn by the Mac app's own view of it (not a screencast) in `room` (CSS pixels of the tab, the view's
	 *  points), scaled down to fit when it is laid out larger; null: it is not any more. */
	| { t: "fit"; targetId: string; room: Size | null }
	| { t: "input"; targetId: string; event: BrowserInput }
	/** Cancel one of the conversation's downloads that is still running. */
	| { t: "download_cancel"; id: string }
	/** Show one of the conversation's finished downloads in Finder (a page on this Mac only). */
	| { t: "download_reveal"; id: string };

/** Where a download of the built-in browser is (the Mac app's CEF saves them to the Downloads folder). */
export type DownloadState = "progress" | "done" | "cancelled" | "failed";

/** A download as the Browser tab is told it: its name, never where it is on the Mac. */
export interface BrowserDownload {
	id: string;
	name: string;
	state: DownloadState;
	received: number;
	/** Its size in bytes; null while it is not known. */
	total: number | null;
	/** When the server first heard of it (ms since the epoch). */
	startedAt: number;
	/** Why it failed, as the engine says it. */
	error?: string;
}

export interface PageInfo {
	targetId: string;
	url: string;
	title: string;
	mode: PageMode;
	/** Layout size in CSS pixels. */
	w: number;
	h: number;
	canBack: boolean;
	canForward: boolean;
}

export interface ConsoleEntry {
	level: "log" | "info" | "warn" | "error";
	text: string;
	source: "console" | "network";
	url?: string;
	time: number;
}

export type ScreenServerMessage =
	| { t: "pages"; owner: string; pages: PageInfo[] }
	| { t: "console"; targetId: string; entry: ConsoleEntry }
	/** The browser cannot be used now (not installed, failed to start, restarted): why, in words. */
	| { t: "unavailable"; reason: string }
	/** It can be used again: the tab's last watch, which could not be carried out, has been now. */
	| { t: "available" }
	/** The conversation's downloads, newest first: sent on watch and whenever one changes. */
	| { t: "downloads"; owner: string; downloads: BrowserDownload[] };

/** What precedes a frame's JPEG. `w`/`h`: the page's layout size in CSS pixels the frame shows. */
export interface FrameHeader {
	targetId: string;
	w: number;
	h: number;
	/** Device pixels per CSS pixel of the page. */
	scale: number;
	seq: number;
}

export const DESKTOP_SIZE: Size = { w: 1280, h: 800 };
export const PHONE_SIZE: Size = { w: 390, h: 844 };

/** The desktop sizes Settings › Browser takes (`ompw.browserSize`), in CSS pixels, each side. */
export const BROWSER_SIZE_BOUNDS = { min: 320, max: 3840 } as const;

/** `ompw.browserSize` (`<width>x<height>`) as a size; null for anything else, a side out of bounds among it. */
export function parseBrowserSize(value: string | null | undefined): Size | null {
	const m = /^(\d{3,4})x(\d{3,4})$/.exec(value ?? "");
	if (!m) return null;
	const w = Number(m[1]);
	const h = Number(m[2]);
	const ok = (n: number) => n >= BROWSER_SIZE_BOUNDS.min && n <= BROWSER_SIZE_BOUNDS.max;
	return ok(w) && ok(h) ? { w, h } : null;
}

export const formatBrowserSize = (size: Size): string => `${size.w}x${size.h}`;

/** The layout a page gets in a mode. */
export function pageSizeFor(
	mode: PageMode,
	panel: Size,
	desktop: Size = DESKTOP_SIZE,
): { w: number; h: number; scale: number; mobile: boolean } {
	if (mode === "phone") return { ...PHONE_SIZE, scale: 3, mobile: true };
	if (mode === "panel")
		return { w: Math.max(1, Math.round(panel.w)), h: Math.max(1, Math.round(panel.h)), scale: 1, mobile: false };
	return { ...desktop, scale: 1, mobile: false };
}

/** A point of the shown frame (`frame`: its size as shown) as CSS pixels of the page (`page`), kept on the page. */
export function frameToPage(x: number, y: number, frame: Size, page: Size): { x: number; y: number } {
	const px = (x * page.w) / frame.w;
	const py = (y * page.h) / frame.h;
	return { x: Math.min(Math.max(px, 0), page.w - 1), y: Math.min(Math.max(py, 0), page.h - 1) };
}

/** A binary frame: header and JPEG. */
export function encodeFrame(header: FrameHeader, jpeg: Uint8Array): Uint8Array {
	const head = new TextEncoder().encode(JSON.stringify(header));
	const out = new Uint8Array(4 + head.length + jpeg.length);
	new DataView(out.buffer).setUint32(0, head.length);
	out.set(head, 4);
	out.set(jpeg, 4 + head.length);
	return out;
}

export function decodeFrame(data: Uint8Array): { header: FrameHeader; jpeg: Uint8Array } {
	const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
	const header = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + length))) as FrameHeader;
	return { header, jpeg: data.subarray(4 + length) };
}
