/**
 * The built-in browser's install state, as the server tells every page (`{ t: "browser_state" }`) and answers
 * `GET /api/browser`. Docs: docs/agents/browser.md.
 */

/** Which engine this server drives: CEF inside the Mac app, or Chrome for Testing when the server runs alone. */
export type EngineKind = "cft" | "cef";

export type BrowserJobKind = "install" | "update" | "clear" | "uninstall";

export interface BrowserState {
	/** Grows with every change: a page keeps the newest it was told. */
	rev: number;
	engine: EngineKind;
	installed: { version: string } | null;
	/** The newest version found by the last check; null before one or when it failed. */
	latest: string | null;
	/** What runs now; `received`/`total` in bytes (total 0 while unknown, and for a clear or an uninstall). */
	job: { kind: BrowserJobKind; received: number; total: number } | null;
	/** Why the last job or check failed, in words; null when it did not. */
	error: string | null;
	/** CEF only: the app has to restart for the installed version, a clear or an uninstall to take effect. */
	restartNeeded: boolean;
	/** Whether the page told may install, update, clear and uninstall (this computer, or a verified Access sign-in). */
	canManage: boolean;
}

/** Why a page may not install, update or clear: it is neither on this computer nor signed in through Access. */
export const BROWSER_NOT_HERE = "browserNotHere";
