import type { UsageReport } from "@shared/protocol.ts";
import { floorOf } from "@shared/quota-floor.ts";
import { ChevronRight, Hourglass } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { api } from "../lib/api.ts";
import { bestAccount } from "../lib/quota.ts";
import { quotaFloorApi } from "../lib/quota-floor-api.ts";
import { percentLeft } from "../lib/quota-hold.ts";
import { Button, CardHeader, Spinner } from "./ui.tsx";

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A whole percent as typed: digits only, so that `5.5`, `-3`, `1e1` and the empty field are refused before the server is asked. */
const DIGITS = /^\d{1,3}$/;

/** The reasons the card explains itself by, under "How it works". */
const HOW = [
	"pages.settingsQuotaFloorHow1",
	"pages.settingsQuotaFloorHow2",
	"pages.settingsQuotaFloorHow3",
	"pages.settingsQuotaFloorHow4",
	"pages.settingsQuotaFloorHow5",
] as const;

/**
 * One provider: its share of the window that is left now, and the floor (percent left) at which a conversation that works on
 * it is held. The field is the floor being typed; the stored one is what `floor` says.
 */
function FloorRow({
	provider,
	floor,
	reports,
	onFloors,
}: {
	provider: string;
	floor: number | undefined;
	/** The usage figures as omp reports them; null while they are being read, or when they could not be. */
	reports: UsageReport[] | null;
	onFloors: (floors: Record<string, number>) => void;
}) {
	const t = useT();
	const field = useId();
	const [draft, setDraft] = useState(floor === undefined ? "" : String(floor));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Another page changed the floor, or this one saved it: the field shows what is stored.
	useEffect(() => setDraft(floor === undefined ? "" : String(floor)), [floor]);
	const quota = reports ? bestAccount(reports, provider)?.tightest : undefined;
	const left = quota ? percentLeft(quota.fraction) : null;
	const write = (next: number | null) => {
		setBusy(true);
		setError(null);
		quotaFloorApi.set(provider, next).then(
			(s) => {
				setBusy(false);
				onFloors(s.floors);
			},
			(e: unknown) => {
				setBusy(false);
				setError(t("pages.settingsQuotaFloorFailed", { error: messageOf(e) }));
			},
		);
	};
	const save = (e: FormEvent) => {
		e.preventDefault();
		const typed = draft.trim();
		const next = DIGITS.test(typed) ? floorOf(Number(typed)) : null;
		if (next === null) return setError(t("pages.settingsQuotaFloorInvalid"));
		write(next);
	};
	return (
		<li
			className="py-3 first:pt-0 last:pb-0"
			data-testid="quota-floor-row"
			data-provider={provider}
			data-floor={floor ?? ""}
		>
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
				<span className="text-sm font-medium" data-testid="quota-floor-provider">
					{provider}
				</span>
				<span className="text-xs text-muted tabular-nums" data-testid="quota-floor-left" data-left={left ?? ""}>
					{reports === null
						? t("pages.settingsQuotaFloorLoading")
						: quota && left !== null
							? quota.limit.label
								? t("pages.settingsQuotaFloorLeftWindow", { pct: left, window: quota.limit.label })
								: t("pages.settingsQuotaFloorLeft", { pct: left })
							: t("pages.settingsQuotaFloorNoFigure")}
				</span>
				<span className="flex-1" />
				<span className="text-xs text-muted" data-testid="quota-floor-state">
					{floor === undefined ? t("pages.settingsQuotaFloorNone") : t("pages.settingsQuotaFloorSet", { floor })}
				</span>
			</div>
			<form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={save}>
				<label htmlFor={field} className="text-xs text-muted">
					{t("pages.settingsQuotaFloorLabel")}
				</label>
				<input
					id={field}
					type="text"
					inputMode="numeric"
					autoComplete="off"
					value={draft}
					maxLength={3}
					// An example of what goes here: empty, the box read as a gap in the line.
					placeholder="10"
					aria-invalid={error !== null}
					data-testid="quota-floor-input"
					className="h-8 w-16 rounded-lg border border-faint bg-bg px-2 text-center text-sm tabular-nums outline-none placeholder:text-faint focus:border-accent"
					onChange={(e) => {
						setDraft(e.target.value);
						setError(null);
					}}
				/>
				<span className="text-xs text-muted">{t("pages.settingsQuotaFloorUnit")}</span>
				<Button
					type="submit"
					size="sm"
					variant="primary"
					data-testid="quota-floor-save"
					disabled={busy || draft.trim() === (floor === undefined ? "" : String(floor))}
				>
					{busy ? <Spinner size={12} /> : null}
					{t("pages.settingsQuotaFloorSave")}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					data-testid="quota-floor-off"
					disabled={busy || floor === undefined}
					onClick={() => write(null)}
				>
					{t("pages.settingsQuotaFloorOff")}
				</Button>
			</form>
			<div role="status" className="min-h-4 text-xs">
				{error ? (
					<span className="text-danger" role="alert" data-testid="quota-floor-error">
						{error}
					</span>
				) : null}
			</div>
		</li>
	);
}

/**
 * Settings › Quota floor (#652): for each provider, the share of a usage window that may be left before a working
 * conversation is held (the request in flight finishes, and the conversation waits for the reset instead of spending the
 * rest). Off for every provider until a floor is set. The floors are the person's, kept by the server (`quota-floor.json`), and
 * any page reads and changes them, as it does the setting of waiting out a usage limit, the other one about the same quota.
 * A change reaches the conversations that work now at their next look at the quota.
 *
 * The providers are the ones `omp usage` reports a quota for, and any that has a floor already (a provider that was signed out
 * since keeps its floor, and the person can still take it away). A chunk of its own, with its strings.
 */
export function QuotaFloorSettings() {
	const t = useT();
	const [floors, setFloors] = useState<Record<string, number> | null>(null);
	const [reports, setReports] = useState<UsageReport[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [usageError, setUsageError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		quotaFloorApi.get().then(
			(s) => live && setFloors(s.floors),
			(e: unknown) => live && setError(messageOf(e)),
		);
		// The figures take as long as `omp usage` does (it asks every provider); the floors are shown before them.
		api.usage("").then(
			(r) => live && setReports(r),
			(e: unknown) => {
				if (!live) return;
				setReports([]);
				setUsageError(messageOf(e));
			},
		);
		return () => {
			live = false;
		};
	}, []);
	const providers = useMemo(
		() => [...new Set([...(reports ?? []).map((r) => r.provider), ...Object.keys(floors ?? {})])].sort(),
		[reports, floors],
	);
	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="quota-floor-settings">
			<CardHeader
				title={t("pages.settingsQuotaFloor")}
				icon={<Hourglass size={16} className="text-accent" />}
				hint={t("pages.settingsQuotaFloorIntro")}
			/>
			{floors === null ? (
				error ? null : (
					<div className="flex justify-center py-6">
						<Spinner />
					</div>
				)
			) : providers.length ? (
				<ul className="divide-y divide-border" data-testid="quota-floor-list">
					{providers.map((provider) => (
						<FloorRow
							key={provider}
							provider={provider}
							floor={floors[provider]}
							reports={reports}
							onFloors={setFloors}
						/>
					))}
				</ul>
			) : reports === null ? (
				<div className="flex justify-center py-6">
					<Spinner />
				</div>
			) : (
				<p className="text-xs text-muted" data-testid="quota-floor-empty">
					{t("pages.settingsQuotaFloorEmpty")}
				</p>
			)}
			{usageError ? (
				<p className="mt-2 text-xs text-warning" data-testid="quota-floor-usage-error">
					{t("pages.settingsQuotaFloorUsageFailed", { error: usageError })}
				</p>
			) : null}
			{error ? (
				<p className="mt-2 text-xs text-danger" role="alert" data-testid="quota-floor-load-error">
					{t("pages.settingsQuotaFloorFailed", { error })}
				</p>
			) : null}
			<details className="group mt-3" data-testid="quota-floor-how">
				<summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
					<ChevronRight size={14} className="shrink-0 text-faint transition-transform group-open:rotate-90" />
					{t("pages.settingsQuotaFloorMore")}
				</summary>
				<ul className="mt-1 max-w-prose list-disc space-y-1 pl-5 text-xs text-muted" data-testid="quota-floor-details">
					{HOW.map((key) => (
						<li key={key}>{t(key)}</li>
					))}
				</ul>
			</details>
		</section>
	);
}
