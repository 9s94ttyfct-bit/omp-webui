import type { IsolationInfo } from "@shared/isolated-env.ts";
import { useEffect, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { api, ownerPage } from "../lib/api.ts";
import { errorText } from "../lib/error-text.ts";
import { socket } from "../lib/ws.ts";
import { useApp } from "../store/app.ts";
import type { LiveState } from "../store/live.ts";
import IsolationToggle from "./IsolationToggle.tsx";

/**
 * The isolated environment of the folder a running conversation works in, in the chat's header beside the guard's switch
 * (`ChatHeader`), or a row of its menu when the header has no room (`HeaderMenu`, `inMenu`): New chat's switch
 * (`shared/isolated-env.ts`), for a conversation that runs already. It is the folder's: a flip changes it for every
 * conversation there (`set_isolation`). A process keeps the variables it started with, so the change applies when the
 * conversation restarts: the title's "Restart to apply" (`IsolatedBadge`) says so and restarts it when the person chooses.
 * Nothing is shown where this computer offers no isolation.
 */
export default function HeaderIsolation({ live, inMenu = false }: { live: LiveState; inMenu?: boolean }) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const notOwner = useApp((s) => !ownerPage(s.meta));
	const { liveId, cwd, isolated, isolationStale } = live.info;
	const [state, setState] = useState<IsolationInfo | null>(null);
	const [asked, setAsked] = useState(0);
	const [busy, setBusy] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: each is a trigger: a flip here (`asked`), or the folder switched from another page (the process's own marks change then).
	useEffect(() => {
		let current = true;
		api.isolation(cwd).then(
			(answer) => current && setState(answer),
			() => {},
		);
		return () => {
			current = false;
		};
	}, [cwd, asked, isolated, isolationStale]);
	if (!state?.supported) return null;
	const on = state.root !== null;

	const flip = async (next: boolean) => {
		if (busy) return;
		setBusy(true);
		try {
			await socket.request({ t: "set_isolation", liveId, on: next });
		} catch (e) {
			toast("error", t("panel.controlsIsolationFailed", { error: errorText(e) }));
		} finally {
			setAsked((n) => n + 1);
			setBusy(false);
		}
	};
	const toggle = (
		<IsolationToggle
			on={on}
			folder={state.root ?? cwd}
			refused={state.refused}
			notOwner={notOwner}
			onToggle={(next) => void flip(next)}
		/>
	);
	if (!inMenu) return <span data-testid="header-isolation">{toggle}</span>;
	// In the menu: the switch with its name and its state, a row as the menu's others.
	return (
		<div className="flex w-full items-center gap-2.5 px-1 py-1 text-sm" data-testid="header-isolation-row">
			{toggle}
			<span>{t("panel.controlsIsolationTitle")}</span>
			<span className="ml-auto pr-1.5 text-xs text-muted">{t(on ? "panel.controlsOn" : "panel.controlsOff")}</span>
		</div>
	);
}
