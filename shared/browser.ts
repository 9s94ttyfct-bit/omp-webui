/**
 * The built-in browser's install state, as the server tells every page (`{ t: "browser_state" }`) and answers
 * `GET /api/browser`. Docs: docs/agents/browser.md.
 */

/** Which engine this server drives: CEF inside the Mac app, or Chrome for Testing when the server runs alone. */
export type EngineKind = "cft" | "cef";

export type BrowserJobKind = "install" | "update" | "clear" | "uninstall";

/**
 * What the last automatic update check of Chrome for Testing came to (Settings › Browser, `ompw.browserAutoUpdate`; the Mac
 * app's CEF updates with the app): `upToDate`, nothing newer; `waiting`, `version` is downloaded and checked, and is switched
 * to once no conversation uses the browser; `updated`, switched to `version`; `failed`, `error` says why, and the next check
 * tries again.
 */
export interface BrowserAutoCheck {
	/** When it ended, in milliseconds since the epoch. */
	at: number;
	result: "upToDate" | "waiting" | "updated" | "failed";
	version: string | null;
	error: string | null;
}

export interface BrowserState {
	/** Grows with every change: a page keeps the newest it was told. */
	rev: number;
	engine: EngineKind;
	/** CfT: the installed version, null for none. CEF: the version the Mac app ships (always there). */
	installed: { version: string } | null;
	/** The newest version found by the last check (CfT only); null before one or when it failed. */
	latest: string | null;
	/** What runs now; `received`/`total` in bytes (total 0 while unknown, and for a clear or an uninstall). */
	job: { kind: BrowserJobKind; received: number; total: number } | null;
	/** Why the last job or check failed, in words; null when it did not. An automatic update's failure is `autoCheck`'s. */
	error: string | null;
	/** CEF only: the app has to restart for a clear to take effect. */
	restartNeeded: boolean;
	/** The last automatic update check since the server started; null before one. */
	autoCheck: BrowserAutoCheck | null;
	/** Whether the page told may install, update, clear and uninstall (this computer, or a verified Access sign-in). */
	canManage: boolean;
}

/** Why a page may not install, update or clear: it is neither on this computer nor signed in through Access. */
export const BROWSER_NOT_HERE = "browserNotHere";
