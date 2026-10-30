import type { Shown } from "@shared/attention.ts";

/**
 * The page's part in the macOS app's notifications. The app shows this UI in a WKWebView and shows the notifications itself
 * (`macos/notifications.swift`, from what the server streams to it: `server/shell-events.ts`), so that they do not depend on
 * a page: Run in Background closes the window. The page asks two things of the shell over a script message handler
 * (`window.webkit.messageHandlers.ompwNotify`), answered from `UNUserNotificationCenter`:
 *
 * - `{ type: "status" }`: what macOS allows this app now; it also tells the shell the page is up, which is when a click that
 *   opened the app is handed over.
 * - `{ type: "request" }`: ask macOS to allow notifications (a system prompt the first time), then say what it answered.
 *
 * Each is answered with `{ permission }`. The shell also tells the page about two things on its own, as an `ompw-notification`
 * event on `window`: `{ type: "open", liveId, file }` when a notification was clicked (the window is already in front),
 * and `{ type: "permission", permission }` when the app came to the front, because the person may have changed the setting
 * in System Settings meanwhile.
 *
 * It also tells the shell what the page shows, once on start and whenever it changes: `{ type: "viewing", liveId, file }`, the
 * conversation on screen (null and null when another page is). The shell is the one that knows whether its window is the one in
 * use, so the two together are what decides that nobody is looking at a conversation (`isLookingAt`) and a notification is shown.
 * A window onto another Mac (`macos/remotewindow.swift`) has no notifications to ask for: it has `ompwView`, the same
 * `viewing` message and the same `ompw-notification` click event, and nothing else.
 *
 * Everything here is inert in a browser: there is no handler, `inShell()` is false, and the page uses `Notification`.
 */

/** `default` is "not asked yet", as in the browser; `unsupported` is a shell that cannot show notifications (no app bundle). */
export type ShellPermission = "default" | "granted" | "denied" | "unsupported";

export type ShellEvent =
	| { type: "open"; liveId: string | null; file: string | null }
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
			};
		};
	}
}

/** The name the page listens to for what the shell says on its own. */
export const SHELL_EVENT = "ompw-notification";

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

/** Hear what the shell says on its own; returns the way to stop. Anything that is not one of the two events is ignored. */
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
		} else if (d?.type === "permission" && typeof d.permission === "string" && PERMISSIONS.includes(d.permission)) {
			fn({ type: "permission", permission: d.permission as ShellPermission });
		}
	};
	window.addEventListener(SHELL_EVENT, listener);
	return () => window.removeEventListener(SHELL_EVENT, listener);
}
