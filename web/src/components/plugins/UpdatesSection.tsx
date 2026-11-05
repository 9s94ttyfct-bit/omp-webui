import {
	isPluginsFailure,
	type PluginsData,
	type PluginUpdate,
	type SkillsData,
	skillOn,
	type UpdatesState,
} from "@shared/plugins.ts";
import { PREF } from "@shared/prefs.ts";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { fmtRelative, fmtTime, shortPath } from "../../lib/format.ts";
import type { JobRequest } from "../../lib/plugins-api.ts";
import { pluginsApi } from "../../lib/plugins-api.ts";
import { onPrefsChanged, setPref } from "../../lib/prefs.ts";
import { Switch } from "../Switch.tsx";
import { Badge, Button, cx, Spinner, WithCode } from "../ui.tsx";
import { Confirm, SCOPE_KEY, Section } from "./parts.tsx";

/**
 * The Plugins page's Overview tab: what is installed at a glance (each count opens its tab), and the Updates section, where
 * the newer versions of plugins and registry skills are listed (`GET /api/plugins/updates`), checked for (`POST
 * /api/plugins/updates/check`, which also refreshes the marketplaces' catalogs), chosen and installed in one job
 * (`update` with their keys), and the automatic update (`ompw.extensionsAutoUpdate`) is switched.
 */

const CHECK_POLL_MS = 700;

type Tab = "installed" | "skills" | "marketplaces";

/** The last check, read on open and again until a check that runs is done; `refresh` reads it once more. */
export function useUpdates(): {
	state: UpdatesState | null;
	error: string | null;
	refresh: () => void;
	check: () => void;
} {
	const [state, setState] = useState<UpdatesState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const refresh = useCallback(() => {
		pluginsApi
			.updates()
			.then((s) => {
				setState(s);
				setError(null);
			})
			.catch((e: Error) => setError(e.message));
	}, []);
	useEffect(refresh, [refresh]);
	const checking = state?.checking ?? false;
	useEffect(() => {
		if (!checking) return;
		const timer = setInterval(refresh, CHECK_POLL_MS);
		return () => clearInterval(timer);
	}, [checking, refresh]);
	const check = useCallback(() => {
		setError(null);
		pluginsApi
			.checkUpdates()
			.then(setState)
			.catch((e: Error) => setError(e.message));
	}, []);
	return { state, error, refresh, check };
}

export function OverviewStats({
	data,
	cwd,
	updates,
	changes,
	onOpen,
}: {
	data: PluginsData | null;
	cwd: string | null;
	updates: UpdatesState | null;
	/** Counts the changes that ended: the skills are read again after one. */
	changes: number;
	onOpen: (tab: Tab | "updates") => void;
}) {
	const t = useT();
	const [skills, setSkills] = useState<SkillsData | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: read again after each change
	useEffect(() => {
		let gone = false;
		pluginsApi
			.skills(cwd)
			.then((s) => !gone && setSkills(s))
			.catch(() => !gone && setSkills(null));
		return () => {
			gone = true;
		};
	}, [cwd, changes]);
	const plugins = data && !isPluginsFailure(data.installed) ? data.installed : null;
	const markets = data && !isPluginsFailure(data.marketplaces) ? data.marketplaces : null;
	const catalog = data && !isPluginsFailure(data.catalog) ? data.catalog : null;
	const skillsOn = skills?.installed.filter(skillOn).length ?? 0;
	const pluginsOn = plugins?.filter((p) => p.enabled).length ?? 0;
	const tiles: { id: Tab | "updates"; label: MessageKey; value: string; detail: string; accent?: boolean }[] = [
		{
			id: "installed",
			label: "plugins.statPlugins",
			value: plugins ? String(plugins.length) : "–",
			detail: plugins ? t("plugins.statOnOff", { on: pluginsOn, off: plugins.length - pluginsOn }) : "",
		},
		{
			id: "skills",
			label: "plugins.statSkills",
			value: skills ? String(skills.installed.length) : "–",
			detail: skills ? t("plugins.statOnOff", { on: skillsOn, off: skills.installed.length - skillsOn }) : "",
		},
		{
			id: "marketplaces",
			label: "plugins.statMarketplaces",
			value: markets ? String(markets.length) : "–",
			detail: catalog ? t("plugins.statMarketplacesDetail", { count: catalog.length }) : "",
		},
		{
			id: "updates",
			label: "plugins.statUpdates",
			value: updates?.checkedAt ? String(updates.updates.length) : "–",
			detail: !updates?.checkedAt
				? t("plugins.statUpdatesNever")
				: updates.updates.length === 0
					? t("plugins.statUpdatesNone")
					: t("plugins.statUpdatesSome", { count: updates.updates.length }),
			accent: (updates?.updates.length ?? 0) > 0,
		},
	];
	return (
		<ul className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="plugins-stats">
			{tiles.map((x) => (
				<li key={x.id}>
					<button
						type="button"
						onClick={() => onOpen(x.id)}
						data-testid={`plugins-stat-${x.id}`}
						className={cx(
							"flex h-full w-full flex-col items-start gap-0.5 rounded-xl border p-3 text-left transition-colors hover:bg-bg-soft focus-visible:outline-2 focus-visible:outline-accent",
							x.accent ? "border-accent/50" : "border-border",
						)}
					>
						<span className="text-xs text-muted">{t(x.label)}</span>
						<span className={cx("text-2xl font-semibold tabular-nums", x.accent && "text-accent")}>{x.value}</span>
						<span className="text-xs text-faint">{x.detail}</span>
					</button>
				</li>
			))}
		</ul>
	);
}

const SOURCE_KEY: Record<PluginUpdate["source"], MessageKey> = {
	marketplace: "plugins.updatesSourceMarketplace",
	npm: "plugins.sourceNpm",
	registry: "plugins.updatesSourceRegistry",
};

export function UpdatesSection({
	updates,
	error,
	busy,
	home,
	onCheck,
	onRefresh,
	onJob,
}: {
	updates: UpdatesState | null;
	error: string | null;
	busy: boolean;
	home: string | null;
	onCheck: () => void;
	/** Reads the state again (after the switch was turned, once the server has the new value). */
	onRefresh: () => void;
	onJob: (job: JobRequest) => void;
}) {
	const t = useT();
	const ids = useId();
	const [auto, setAuto] = useState(() => localStorage.getItem(PREF.extensionsAutoUpdate) === "on");
	useEffect(
		() =>
			onPrefsChanged((keys) => {
				if (keys.includes(PREF.extensionsAutoUpdate)) setAuto(localStorage.getItem(PREF.extensionsAutoUpdate) === "on");
			}),
		[],
	);
	const list = updates?.updates ?? [];
	const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
	// What is no longer listed (installed, or gone in a new check) is no longer chosen.
	useEffect(() => {
		setChosen((c) => {
			const keys = new Set(list.map((u) => u.key));
			const kept = [...c].filter((k) => keys.has(k));
			return kept.length === c.size ? c : new Set(kept);
		});
	}, [list]);
	const [asking, setAsking] = useState<PluginUpdate[] | null>(null);
	const groups = useMemo(
		() =>
			(["plugin", "skill"] as const)
				.map((kind) => ({ kind, items: list.filter((u) => u.kind === kind) }))
				.filter((g) => g.items.length > 0),
		[list],
	);
	const toggle = (keys: string[], on: boolean) =>
		setChosen((c) => {
			const next = new Set(c);
			for (const k of keys) {
				if (on) next.add(k);
				else next.delete(k);
			}
			return next;
		});
	const checking = updates?.checking ?? false;
	const where = (u: { scope: PluginUpdate["scope"]; folder: string | null }) =>
		u.folder ? shortPath(u.folder, home ?? undefined) : t(SCOPE_KEY[u.scope]);
	const busyCount = updates?.auto.waitingFor ? Object.values(updates.auto.waitingFor).reduce((a, b) => a + b, 0) : 0;
	const last = updates?.auto.last ?? null;
	return (
		<Section
			id="updates"
			title={t("plugins.updatesTitle")}
			icon={<ArrowUpCircle size={16} className="text-accent" />}
			hint={<WithCode text={t("plugins.updatesHint")} />}
			action={
				<Button size="sm" disabled={checking || busy} onClick={onCheck} data-testid="updates-check">
					{checking ? <Spinner size={13} /> : <RefreshCw size={13} />}{" "}
					{checking ? t("plugins.updatesChecking") : t("plugins.updatesCheck")}
				</Button>
			}
		>
			<div className="mb-3 flex items-start gap-3 rounded-xl bg-bg-soft p-3" data-testid="updates-auto">
				<div className="min-w-0 flex-1">
					<div className="text-sm font-medium" id={`${ids}-auto`}>
						{t("plugins.updatesAuto")}
					</div>
					<p className="text-xs text-muted">{t("plugins.updatesAutoHint")}</p>
					{auto && updates?.auto.nextCheckAt ? (
						<p className="mt-1 text-xs text-faint">
							{t("plugins.updatesAutoNext", { when: fmtTime(updates.auto.nextCheckAt) })}
						</p>
					) : null}
					{auto && busyCount > 0 ? (
						<p className="mt-1 text-xs text-warning" data-testid="updates-auto-waiting">
							{t("plugins.updatesAutoWaiting", { count: busyCount })}
						</p>
					) : null}
					{last ? (
						<p
							className={cx("mt-1 text-xs", last.error ? "text-danger" : "text-faint")}
							data-testid="updates-auto-last"
						>
							{last.error
								? t("plugins.updatesAutoLastFailed", { when: fmtRelative(last.at), error: last.error })
								: t("plugins.updatesAutoLast", { when: fmtRelative(last.at), count: last.count })}
						</p>
					) : null}
				</div>
				<Switch
					checked={auto}
					label={t("plugins.updatesAuto")}
					onCheckedChange={(on) => {
						setAuto(on);
						setPref(PREF.extensionsAutoUpdate, on ? "on" : "off");
						// The preference reaches the server after a short wait; then it says when it looks next.
						setTimeout(onRefresh, 1500);
					}}
					data-testid="updates-auto-switch"
				/>
			</div>

			{error ? (
				<p role="alert" className="mb-2 text-sm text-danger">
					{error}
				</p>
			) : null}
			<p className="mb-2 text-xs text-muted" data-testid="updates-checked">
				{updates?.checkedAt
					? t("plugins.updatesCheckedAt", { when: fmtRelative(updates.checkedAt) })
					: t("plugins.updatesNeverChecked")}
			</p>
			{updates?.checkedAt && list.length === 0 ? (
				<p className="text-sm text-success" data-testid="updates-none">
					{t("plugins.updatesNone")}
				</p>
			) : null}

			{groups.map((g) => {
				const label = t(g.kind === "plugin" ? "plugins.updatesGroupPlugins" : "plugins.updatesGroupSkills");
				const keys = g.items.map((u) => u.key);
				const all = keys.every((k) => chosen.has(k));
				const some = !all && keys.some((k) => chosen.has(k));
				return (
					<fieldset key={g.kind} className="mb-3" data-testid={`updates-group-${g.kind}`}>
						<legend className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
							<input
								type="checkbox"
								className="accent-[var(--accent)]"
								checked={all}
								ref={(el) => {
									if (el) el.indeterminate = some;
								}}
								aria-label={t("plugins.updatesSelectGroup", { group: label })}
								onChange={(e) => toggle(keys, e.target.checked)}
								data-testid="updates-select-group"
							/>
							{label}
						</legend>
						<ul className="divide-y divide-border rounded-xl border border-border">
							{g.items.map((u) => (
								<li key={u.key} data-testid="update-row" data-update={u.id} data-scope={u.scope}>
									<label className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
										<input
											type="checkbox"
											className="accent-[var(--accent)]"
											checked={chosen.has(u.key)}
											aria-label={t("plugins.updatesSelectOne", { name: u.id })}
											onChange={(e) => toggle([u.key], e.target.checked)}
											data-testid="update-select"
										/>
										<span className="min-w-0 flex-1 basis-40 break-all font-mono text-sm">{u.id}</span>
										<span className="flex flex-wrap items-center gap-1.5">
											<Badge>{where(u)}</Badge>
											<Badge>{t(SOURCE_KEY[u.source])}</Badge>
											<span className="font-mono text-xs tabular-nums" data-testid="update-versions">
												{u.from ?? "?"} → <span className="text-accent">{u.to}</span>
											</span>
										</span>
									</label>
								</li>
							))}
						</ul>
					</fieldset>
				);
			})}

			{list.length > 0 ? (
				<div className="flex flex-wrap justify-end gap-2">
					<Button
						size="sm"
						disabled={busy || chosen.size === 0}
						onClick={() => setAsking(list.filter((u) => chosen.has(u.key)))}
						data-testid="updates-selected"
					>
						{t("plugins.updatesSelected", { count: chosen.size })}
					</Button>
					<Button size="sm" variant="primary" disabled={busy} onClick={() => setAsking(list)} data-testid="updates-all">
						<ArrowUpCircle size={13} /> {t("plugins.updatesAll", { count: list.length })}
					</Button>
				</div>
			) : null}

			{(updates?.unchecked.length ?? 0) > 0 || (updates?.errors.length ?? 0) > 0 ? (
				<details className="mt-3 text-xs" data-testid="updates-unchecked">
					<summary className="cursor-pointer text-muted">
						{t("plugins.updatesNotChecked")} ({(updates?.unchecked.length ?? 0) + (updates?.errors.length ?? 0)})
					</summary>
					<ul className="mt-1 space-y-1">
						{updates?.unchecked.map((u) => (
							<li key={`${u.kind}\u0000${u.folder ?? ""}\u0000${u.id}`} className="text-muted">
								<span className="font-mono">{u.id}</span> ({where(u)}):{" "}
								{u.reason === "git" ? t("plugins.updatesNotCheckedGit") : u.detail}
							</li>
						))}
						{updates?.errors.map((e) => (
							<li key={e} className="text-warning">
								{t("plugins.updatesErrors")}: {e}
							</li>
						))}
					</ul>
				</details>
			) : null}

			<Confirm
				open={asking !== null}
				onOpenChange={(o) => !o && setAsking(null)}
				title={t("plugins.updatesConfirmTitle")}
				body={
					<>
						<p>{t("plugins.updatesConfirmBody")}</p>
						<ul className="mt-2 space-y-0.5 font-mono text-xs">
							{asking?.map((u) => (
								<li key={u.key}>
									{u.id} ({where(u)}): {u.from ?? "?"} → {u.to}
								</li>
							))}
						</ul>
					</>
				}
				action={t("plugins.updatesInstall")}
				testId="updates-confirm"
				onConfirm={() => {
					if (!asking) return;
					// The updates the dialog listed, by key: "all" would be the server's latest check, which can list others.
					onJob({ action: "update", keys: asking.map((u) => u.key) });
					setChosen(new Set());
				}}
			/>
		</Section>
	);
}
