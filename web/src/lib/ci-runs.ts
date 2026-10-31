import { type CiAnswer, type CiBadge, type CiJob, type CiRun, type CiScope, ciBadge } from "@shared/ci.ts";
import { PREF } from "@shared/prefs.ts";
import { useEffect, useState } from "react";
import "../i18n/later.ts";
import { t } from "../i18n/index.ts";
import { useNotify, windowInUse } from "./attention.ts";
import { browserPage } from "./auto-refresh.ts";
import { type CiView, CiWatcher } from "./ci-watch.ts";
import { showPanelTab } from "./panel-panes.ts";
import { inRemoteShell, inShell } from "./shell-notify.ts";

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

/** Whether a run's end can be told here: in a browser (the macOS app's window has no notifications a page can show). */
export const ciNotifyPossible = (): boolean => typeof Notification !== "undefined" && !inShell() && !inRemoteShell();

/** Whether the person wants a run's end told, and notifications are on here. */
export function ciNotifyWanted(): boolean {
	return (
		ciNotifyPossible() &&
		localStorage.getItem(PREF.ciNotify) === "on" &&
		useNotify.getState().enabled &&
		Notification.permission === "granted"
	);
}

function notifyFinished(_cwd: string, runs: CiRun[]): void {
	// Somebody looking at this window sees the tab's badge change.
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
		try {
			// One per run: a newer word on the same run replaces the older.
			const note = new Notification(title, { body: `${run.branch} · ${run.title}`, tag: `ci:${run.id}` });
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
