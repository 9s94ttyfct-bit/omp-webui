import type { LoadedMcpServer, LoadedPlugin } from "@shared/loaded.ts";
import { useCallback, useState } from "react";
import "../i18n/later.ts";
import { t } from "../i18n/index.ts";
import { useApp } from "../store/app.ts";
import type { LiveState } from "../store/live.ts";
import { controls } from "./api.ts";
import { isRunning } from "./subagents.ts";

/**
 * The switches of the Loaded dialog (skills, plugins, MCP servers). A switch is a request to the server, which has omp
 * carry it out (`/api/controls/*`); the dialog asks omp what is loaded again afterwards and shows that, so a switch that
 * did not take goes back by itself. A switch is busy until its request is answered and that answer is on screen (a click
 * in between would act on the state shown before it), and says why when it failed.
 */
export interface Switches {
	busy: (key: string) => boolean;
	skill: (name: string, enabled: boolean) => void;
	plugin: (plugin: LoadedPlugin, enabled: boolean) => void;
	mcp: (server: LoadedMcpServer, enabled: boolean) => void;
}

export const skillKey = (name: string) => `skill:${name}`;
/** A plugin installed in both scopes is two rows, each with its own switch: the scope is part of the key. */
export const pluginKey = (plugin: LoadedPlugin) => `plugin:${plugin.kind}:${plugin.scope ?? ""}:${plugin.name}`;
export const mcpKey = (name: string) => `mcp:${name}`;

/**
 * omp is doing, or waiting for an answer to, something that restarting it would cut off. The server decides in the end
 * (it refuses a restart then); this is what the dialog can tell, so that it offers the restart only when it can be done.
 */
export function isWorking(live: LiveState, bashRunning: boolean): boolean {
	return (
		live.streaming ||
		live.needsInput ||
		bashRunning ||
		live.info.pausedAt !== null ||
		Boolean(live.info.retry) ||
		Boolean(live.compacting) ||
		live.retry?.phase === "waiting" ||
		Object.values(live.subagents).some((a) => isRunning(a.status))
	);
}

export function useLoadedSwitches(
	target: { liveId: string | null; file: string | null },
	refresh: () => Promise<void>,
): Switches {
	const toast = useApp((s) => s.toast);
	const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
	const { liveId, file } = target;
	const run = useCallback(
		async (key: string, work: () => Promise<void>) => {
			setBusy((cur) => new Set(cur).add(key));
			try {
				await work();
			} finally {
				await refresh();
				setBusy((cur) => {
					const next = new Set(cur);
					next.delete(key);
					return next;
				});
			}
		},
		[refresh],
	);
	return {
		busy: (key) => busy.has(key),
		skill: (name, enabled) =>
			void run(skillKey(name), async () => {
				try {
					const done = await controls.setSkill({ live: liveId, file }, name, enabled);
					if (done.overridden) toast("warning", t("loaded.skillOverridden", { name, by: done.overridden }));
				} catch (e) {
					toast("error", t("loaded.skillFailed", { name, error: (e as Error).message }));
				}
			}),
		plugin: (plugin, enabled) =>
			void run(pluginKey(plugin), async () => {
				try {
					const done = await controls.setPlugin({ live: liveId, file }, plugin.name, enabled, plugin.scope);
					if (liveId && !done.reloaded) toast("info", t("loaded.pluginNotReloaded", { name: plugin.name }));
				} catch (e) {
					toast("error", t("loaded.pluginFailed", { name: plugin.name, error: (e as Error).message }));
				}
			}),
		mcp: (server, enabled) => {
			if (!liveId) return;
			void run(mcpKey(server.name), async () => {
				try {
					await controls.setMcpServer(liveId, server.name, enabled);
				} catch (e) {
					toast("error", t("loaded.mcpFailed", { name: server.name, error: (e as Error).message }));
				}
			});
		},
	};
}
