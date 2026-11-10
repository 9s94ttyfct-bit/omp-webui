import { useEffect } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { loadHost } from "../lib/host.ts";
import { setHostDisks, useHostDisks } from "../lib/host-disks.ts";
import { fmtMem } from "../lib/host-rows.ts";
import { useHost } from "../lib/host-store.ts";
import { CardHeader } from "./ui.tsx";

/**
 * Settings › App & system › Host load disks (#613): which of the disks the server tells (`GET /api/host`'s `info.disks`)
 * the host load pane draws a tile and a graph for. None chosen is every disk, the default; the choice follows the person,
 * as the other preferences do (`ompw.hostDisks`, `lib/host-disks.ts`). A disk chosen and later taken out stays chosen, and
 * is drawn again when it comes back.
 */
export function HostDisksSettings() {
	const t = useT();
	const disks = useHost((s) => s.info?.disks ?? null);
	const dataDisk = useHost((s) => s.info?.dataDisk ?? null);
	const chosen = useHostDisks();
	useEffect(() => {
		void loadHost();
	}, []);
	const toggle = (id: string, on: boolean) => {
		// From "every disk" (none chosen), unticking one chooses all the others.
		const from = chosen.length ? chosen : (disks ?? []).map((d) => d.id);
		const next = on ? [...from, id] : from.filter((x) => x !== id);
		setHostDisks(next.length === (disks ?? []).length && disks?.every((d) => next.includes(d.id)) ? [] : next);
	};
	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="host-disks-settings">
			<CardHeader title={t("pages.settingsHostDisks")} hint={t("pages.settingsHostDisksHint")} />
			{disks === null ? (
				<p className="text-xs text-muted">{t("pages.settingsHostDisksNone")}</p>
			) : (
				<ul className="space-y-1.5 text-sm">
					{disks.map((d) => (
						<li key={d.id}>
							<label className="flex cursor-pointer items-start gap-3">
								<input
									type="checkbox"
									className="mt-1 accent-[var(--accent)]"
									data-testid="host-disk-choice"
									data-disk={d.id}
									checked={chosen.length === 0 || chosen.includes(d.id)}
									onChange={(e) => toggle(d.id, e.target.checked)}
								/>
								<span>
									{d.name}
									<span className="block text-xs text-muted">
										{d.id} · {fmtMem(d.total)}
										{d.id === dataDisk ? ` · ${t("pages.settingsHostDisksData")}` : ""}
									</span>
								</span>
							</label>
						</li>
					))}
				</ul>
			)}
			<p className="mt-2 text-xs text-muted">{t("pages.settingsHostDisksAll")}</p>
		</section>
	);
}
