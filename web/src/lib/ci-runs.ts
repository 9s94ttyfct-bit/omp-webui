import { type CiAnswer, type CiBadge, type CiJob, type CiRun, type CiScope, CI_SCOPES, ciBadge } from "@shared/ci.ts";
import { PREF } from "@shared/prefs.ts";
import { useEffect, useState } from "react";
import "../i18n/later.ts";
import { t } from "../i18n/index.ts";
import { useNotify, windowInUse } from "./attention.ts";
import { browserPage } from "./auto-refresh.ts";
import { type CiView, CiWatcher } from "./ci-watch.ts";
import { showPanelTab } from "./panel-panes.ts";
import { inRemoteShell, inShell, shellShowCi } from "./shell-notify.ts";

/**
 * The CI tab's runs on this page (`lib/ci-watch.ts`): the one watcher every view of them shares, the tab's badge, and the
 * notification of a run of the folder's branch that finished (`ompw.ciNotify`, off by default).
 */

async function post<T>(path: string, body: unknown): Promise<CiAnswer<T>> {
	const res = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json", "x-omp-webui": "1" },
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) return { ok: false, problem: "failed", message: data.error ?? res.statusText, nextMs: 60_000 };
	return data as CiAnswer<T>;
}

/**
 * Whether a run's end can be told here: in a browser, and in the macOS app, which shows it for the page (`shellShowCi`, audit
 * A-015). Not in the app's window onto another Mac: that app's own window watches its runs.
 */
export const ciNotifyPossible = (): boolean => inShell() || (typeof Notification !== "undefined" && !inRemoteShell());

/** Whether the person wants a run's end told, and notifications are on here (in the app: what macOS allows it). */
export function ciNotifyWanted(): boolean {
	if (!ciNotifyPossible() || localStorage.getItem(PREF.ciNotify) !== "on") return false;
	const notify = useNotify.getState();
	if (!notify.enabled) return false;
	return inShell() ? notify.permission === "granted" : Notification.permission === "granted";
}

/** localStorage key (device-local, like the sidebar's layout): which runs the CI tab lists, every branch's or the folder's. */
export const CI_SCOPE_KEY = "ompw.ciScope";

/** The CI tab's last choice on this device; every branch's runs when there is none. */
export function readCiScope(): CiScope {
	try {
		const v = localStorage.getItem(CI_SCOPE_KEY);
		return CI_SCOPES.find((s) => s === v) ?? "all";
	} catch {
		return "all";
	}
}

export function saveCiScope(scope: CiScope): void {
	try {
		localStorage.setItem(CI_SCOPE_KEY, scope);
	} catch {
		// storage refused (a private window that is full): the choice lasts until the page is closed
	}
}

/** Tell that `runs` of the folder's branch ended, unless somebody is looking at this window (they see the tab's badge change). */
export function notifyFinished(_cwd: string, runs: CiRun[]): void {
	if (!ciNotifyWanted() || windowInUse()) return;
	for (const run of runs) {
		const title =
			run.state === "success"
				? t("panel.ciNotifyPassed", { workflow: run.workflow })
				: run.state === "failure"
					? t("panel.ciNotifyFailed", { workflow: run.workflow })
					: run.state === "cancelled"
						? t("panel.ciNotifyCancelled", { workflow: run.workflow })
						: t("panel.ciNotifyDone", { workflow: run.workflow });
		const body = `${run.branch} · ${run.title}`;
		// The macOS app shows it (its web view has no `Notification` that shows anything); a click opens the CI tab there too.
		if (inShell()) {
			void shellShowCi(run.id, title, body);
			continue;
		}
		try {
			// One per run: a newer word on the same run replaces the older.
			const note = new Notification(title, { body, tag: `ci:${run.id}` });
			note.onclick = () => {
				window.focus();
				note.close();
				showPanelTab("ci");
			};
		} catch {
			// The browser refuses to construct notifications here (some mobile browsers want a service worker).
		}
	}
}

export const ciWatcher = new CiWatcher({
	ask: (body) => post("/api/github/runs", body),
	env: browserPage,
	setTimer: (fn, ms) => setTimeout(fn, ms),
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	background: (scope) => scope === "branch" && ciNotifyWanted(),
	onFinished: notifyFinished,
});

/** A folder's list as the watcher knows it, kept up to date while the component shows it. */
export function useCiRuns(cwd: string | null, scope: CiScope): CiView | null {
	const [view, setView] = useState<CiView | null>(null);
	useEffect(() => {
		if (!cwd) {
			setView(null);
			return;
		}
		return ciWatcher.watch(cwd, scope, setView);
	}, [cwd, scope]);
	return view;
}

/** The CI tab's badge: of the latest commit's runs on the folder's branch (`ciBadge`). */
export function useCiBadge(cwd: string | null): CiBadge | null {
	const view = useCiRuns(cwd, "branch");
	return view?.answer?.ok ? ciBadge(view.answer.value) : null;
}

/** One run's jobs (`POST /api/github/run`). */
export const askJobs = (cwd: string, id: number, fresh = false): Promise<CiAnswer<CiJob[]>> =>
	post<CiJob[]>("/api/github/run", { cwd, id, fresh }).catch(
		(e: unknown): CiAnswer<CiJob[]> => ({ ok: false, problem: "failed", message: String(e), nextMs: 60_000 }),
	);
