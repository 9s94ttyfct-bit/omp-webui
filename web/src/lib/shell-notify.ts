import type { Shown } from "@shared/attention.ts";
import type { PageMode } from "@shared/browser-protocol.ts";

/**
 * The page's part in the macOS app's notifications. The app shows this UI in a WKWebView and shows the notifications itself
 * (`macos/notifications.swift`, from what the server streams to it: `server/shell-events.ts`), so that they do not depend on
 * a page: Run in Background closes the window. The page asks two things of the shell over a script message handler
 * (`window.webkit.messageHandlers.ompwNotify`), answered from `UNUserNotificationCenter`:
 *
 * - `{ type: "status" }`: what macOS allows this app now; it also tells the shell the page is up, which is when a click that
 *   opened the app is handed over.
 * - `{ type: "request" }`: ask macOS to allow notifications (a system prompt the first time), then say what it answered.
 * - `{ type: "show", tag, title, body, open: { panel: "ci" } }`: the end of a CI run (the CI tab's bell, `lib/ci-runs.ts`),
 *   the one notification a page may ask for, and only in that shape (`tag` is `ci:` and the run's number, the text at most
 *   `CI_NOTE_LIMITS`, a click opens the CI tab); the shell refuses anything else. It is shown when macOS allows it.
 *
 * Each is answered with `{ permission }`. The shell also tells the page about things on its own, as an `ompw-notification`
 * event on `window`: `{ type: "open", liveId, file }` when a conversation's notification was clicked (the window is already
 * in front), `{ type: "open-panel", panel: "ci" }` when a CI run's was, and `{ type: "permission", permission }` when the app
 * came to the front, because the person may have changed the setting in System Settings meanwhile.
 *
 * It also tells the shell what the page shows, once on start and whenever it changes: `{ type: "viewing", liveId, file }`, the
 * conversation on screen (null and null when another page is). The shell is the one that knows whether its window is the one in
 * use, so the two together are what decides that nobody is looking at a conversation (`isLookingAt`) and a notification is shown.
 * A window onto another Mac (`macos/remotewindow.swift`) has no notifications to ask for: it has `ompwView`, the same
 * `viewing` message and the same `ompw-notification` click event. Since 0.23.2 it also has `ompwRemoteNotify`: whether the app
 * shows that Mac's notifications (the Macs menu's tick for it), `{ type: "status" }` and `{ type: "set", on }`, each answered
 * with `{ on, permission }`; the app says a change made either way as an `ompw-remote-notify` event with the same detail.
 *
 * Everything here is inert in a browser: there is no handler, `inShell()` is false, and the page uses `Notification`.
 */

/** `default` is "not asked yet", as in the browser; `unsupported` is a shell that cannot show notifications (no app bundle). */
export type ShellPermission = "default" | "granted" | "denied" | "unsupported";

export type ShellEvent =
	| { type: "open"; liveId: string | null; file: string | null }
	| { type: "open-panel"; panel: "ci" }
	| { type: "permission"; permission: ShellPermission };

interface Handler {
	postMessage(message: unknown): Promise<unknown>;
}

declare global {
	interface Window {
		webkit?: {
			messageHandlers?: {
				ompwNotify?: Handler;
				ompwWindow?: Handler;
				ompwDrop?: Handler;
				ompwMacs?: Handler;
				ompwView?: Handler;
				/** The Mac app's own window: its native CEF view over the Browser tab (see `BrowserBridgeMessage`). */
				ompwBrowser?: Handler;
				/** The Mac app's login item (Settings › Start at login, `web/src/lib/login-start.ts`). */
				ompwLogin?: Handler;
				/** A window onto another Mac: whether the app shows that Mac's notifications (see `remoteNotify`). */
				ompwRemoteNotify?: Handler;
			};
		};
	}
}

/** The name the page listens to for what the shell says on its own. */
export const SHELL_EVENT = "ompw-notification";

/**
 * What the Browser tab tells the Mac app's own window, which lays its native CEF view over the tab instead of the page
 * drawing the screencast (`components/BrowserTab.tsx`):
 *
 * - `place`: show page `targetId` in `rect` (CSS pixels of this page's viewport: the tab's frame area), laid out at `size`
 *   (the page's CSS size in `mode`), scaled down to fit when it is larger; sent on layout, resize, panel drag, tab
 *   switch, scroll and a change of the page's size.
 * - `cover`: whether a menu, popover or dialog of the page lies over that rectangle now (the view hides under it).
 * - `hide`: the tab is not shown (another tab, the panel closed or folded, no page).
 * - `devtools`: open the developer tools of page `targetId`.
 */
export type BrowserBridgeMessage =
	| {
			type: "place";
			targetId: string;
			rect: { x: number; y: number; w: number; h: number };
			size: { w: number; h: number };
			mode: PageMode;
	  }
	| { type: "cover"; covered: boolean }
	| { type: "hide" }
	| { type: "devtools"; targetId: string };

const browserHandler = (): Handler | undefined =>
	typeof window === "undefined" ? undefined : window.webkit?.messageHandlers?.ompwBrowser;

/** The page is in the Mac app's own window, whose native view shows the Browser tab's page. */
export const hasBrowserBridge = (): boolean => typeof browserHandler()?.postMessage === "function";

/** Tell the app's window about the Browser tab; nothing is waited for. */
export function postBrowserBridge(message: BrowserBridgeMessage): void {
	try {
		void Promise.resolve(browserHandler()?.postMessage(message)).catch(() => {});
	} catch {
		// A window that refuses keeps its view where it was.
	}
}

const handler = (): Handler | undefined =>
	typeof window === "undefined" ? undefined : window.webkit?.messageHandlers?.ompwNotify;

/** The page runs inside the macOS app, which shows notifications itself. */
export const inShell = (): boolean => typeof handler()?.postMessage === "function";

/** The page is in a window onto another Mac of the macOS app: that app shows the notifications, and wants to know what is on screen. */
export const inRemoteShell = (): boolean =>
	typeof window !== "undefined" && typeof window.webkit?.messageHandlers?.ompwView?.postMessage === "function";

/** Tell the shell which conversation is on screen (`null`: none, another page is). No answer is waited for or needed. */
export function reportShown(shown: Shown | null): void {
	const message = { type: "viewing", liveId: shown?.liveId ?? null, file: shown?.file ?? null };
	try {
		void Promise.resolve((handler() ?? window.webkit?.messageHandlers?.ompwView)?.postMessage(message)).catch(() => {});
	} catch {
		// A shell that refuses knows nothing of what is on screen, and shows a notification for whatever needs the person.
	}
}

/** Whether the app shows notifications of the conversations of the Mac this window is onto, and what macOS allows the app. */
export interface RemoteNotifyState {
	on: boolean;
	permission: ShellPermission;
}

/** The event the app sends every window of the Mac when that choice changed (here or in its Macs menu). */
export const REMOTE_NOTIFY_EVENT = "ompw-remote-notify";

const remoteNotifyHandler = (): Handler | undefined =>
	typeof window === "undefined" ? undefined : window.webkit?.messageHandlers?.ompwRemoteNotify;

/** The window onto another Mac can read and change that choice (an app of 0.23.2 or later). */
export const hasRemoteNotify = (): boolean => typeof remoteNotifyHandler()?.postMessage === "function";

/** The app's answer as the page uses it; null for anything else. */
export function remoteNotifyState(v: unknown): RemoteNotifyState | null {
	if (typeof v !== "object" || v === null) return null;
	const { on, permission } = v as { on?: unknown; permission?: unknown };
	if (typeof on !== "boolean" || typeof permission !== "string" || !PERMISSIONS.includes(permission)) return null;
	return { on, permission: permission as ShellPermission };
}

/** Ask the app (`status`) or change the choice (`set`); null when there is no such bridge or it refused. */
export async function remoteNotify(
	request: { type: "status" } | { type: "set"; on: boolean },
): Promise<RemoteNotifyState | null> {
	try {
		return remoteNotifyState(await remoteNotifyHandler()?.postMessage(request));
	} catch {
		return null;
	}
}

const PERMISSIONS: readonly string[] = ["default", "granted", "denied", "unsupported"];

/** Post a message and read the permission out of the answer. A shell that fails to answer cannot show notifications. */
async function ask(message: Record<string, unknown>): Promise<ShellPermission> {
	try {
		const reply = (await handler()?.postMessage(message)) as { permission?: unknown } | null | undefined;
		const permission = reply?.permission;
		return typeof permission === "string" && PERMISSIONS.includes(permission)
			? (permission as ShellPermission)
			: "unsupported";
	} catch {
		return "unsupported";
	}
}

/** What macOS allows this app now; also tells the shell the page is up, which is when a click that opened the app is handed over. */
export const shellStatus = (): Promise<ShellPermission> => ask({ type: "status" });

/** Ask macOS to allow notifications. It prompts only while the person has not decided; the answer is what it says afterwards. */
export const shellRequest = (): Promise<ShellPermission> => ask({ type: "request" });

/** The most a CI run's notification may carry, in characters: what `macos/notifications.swift` takes (`ciNoteTitleLimit`). */
export const CI_NOTE_LIMITS = { title: 200, body: 400 } as const;

/** `text` cut to `max` characters (code points, never more than Swift's characters), with an ellipsis when it was longer. */
function cut(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** Ask the shell to show that a CI run (`runId`) ended: one per run, a newer word replacing the older; a click opens the CI tab. */
export const shellShowCi = (runId: number, title: string, body: string): Promise<ShellPermission> =>
	ask({
		type: "show",
		tag: `ci:${runId}`,
		title: cut(title, CI_NOTE_LIMITS.title),
		body: cut(body, CI_NOTE_LIMITS.body),
		open: { panel: "ci" },
	});

/** Hear what the shell says on its own; returns the way to stop. Anything that is not one of its events is ignored. */
export function onShellEvent(fn: (event: ShellEvent) => void): () => void {
	const listener = (e: Event) => {
		const d = (e as CustomEvent<Record<string, unknown> | null>).detail;
		if (d?.type === "open") {
			const { liveId, file } = d;
			fn({
				type: "open",
				liveId: typeof liveId === "string" && liveId !== "" ? liveId : null,
				file: typeof file === "string" && file !== "" ? file : null,
			});
		} else if (d?.type === "open-panel" && d.panel === "ci") {
			fn({ type: "open-panel", panel: "ci" });
		} else if (d?.type === "permission" && typeof d.permission === "string" && PERMISSIONS.includes(d.permission)) {
			fn({ type: "permission", permission: d.permission as ShellPermission });
		}
	};
	window.addEventListener(SHELL_EVENT, listener);
	return () => window.removeEventListener(SHELL_EVENT, listener);
}
