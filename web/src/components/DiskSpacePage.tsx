import {
	DEFAULT_DISK_SORT,
	type DiskRow,
	type DiskSort,
	type DiskSortKey,
	type DiskSpaceAnswer,
	isDiskSort,
} from "@shared/disk-space.ts";
import { PREF } from "@shared/prefs.ts";
import { ArrowDown, ArrowUp, HardDrive, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { en } from "../i18n/disk-space.ts";
import { type MessageKey, registerStrings, type Translate as TFunction, useT } from "../i18n/index.ts";
import { formatBytes } from "../lib/app-update.ts";
import { diskApi, rowTotal, sortRows } from "../lib/disk-space.ts";
import { fmtRelative, shortPath } from "../lib/format.ts";
import { setPref } from "../lib/prefs.ts";
import { useApp } from "../store/app.ts";
import { DiskCleanupDialog } from "./DiskCleanupDialog.tsx";
import { Button, cx, Empty, Spinner } from "./ui.tsx";

// This chunk carries its own English strings: the first page does not (see `registerStrings`).
registerStrings("diskSpace", en);

/**
 * The Disk space page (docs/superpowers/specs/2026-11-26-disk-space-page-design.md): every project folder with what its
 * folder and its conversations take, sortable, each with a "Clean up…" dialog. The server measures in the background;
 * the page asks again every two seconds while a scan runs.
 */

const POLL_MS = 2000;

const storedSort = (): DiskSort => {
	try {
		const v = JSON.parse(localStorage.getItem(PREF.diskSort) ?? "null");
		return isDiskSort(v) ? v : DEFAULT_DISK_SORT;
	} catch {
		return DEFAULT_DISK_SORT;
	}
};

const COLUMNS: { key: DiskSortKey; label: MessageKey; className?: string; numeric?: boolean }[] = [
	{ key: "name", label: "diskSpace.colName" },
	{ key: "folder", label: "diskSpace.colFolder", className: "@max-2xl:hidden" },
	{ key: "conversations", label: "diskSpace.colConversations", className: "@max-xl:hidden", numeric: true },
	{ key: "total", label: "diskSpace.colTotal", numeric: true },
	{ key: "lastUsed", label: "diskSpace.colLastUsed", className: "@max-xl:hidden", numeric: true },
];

export function DiskSpacePage() {
	const t = useT();
	const home = useApp((s) => s.meta?.home);
	const [answer, setAnswer] = useState<DiskSpaceAnswer | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [sort, setSort] = useState<DiskSort>(storedSort);
	const [cleaning, setCleaning] = useState<DiskRow | null>(null);
	const alive = useRef(true);

	const load = useCallback(async () => {
		try {
			const a = await diskApi.rows();
			if (!alive.current) return;
			setAnswer(a);
			setError(null);
		} catch (e) {
			if (alive.current) setError((e as Error).message);
		}
	}, []);
	useEffect(() => {
		alive.current = true;
		void load();
		return () => {
			alive.current = false;
		};
	}, [load]);
	// While a scan runs the page asks again, and stops once it is done.
	const running = answer?.scan.running ?? false;
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => void load(), POLL_MS);
		return () => clearInterval(timer);
	}, [running, load]);

	const rescan = async () => {
		await diskApi.scan().catch(() => null);
		await load();
	};
	const pickSort = (by: DiskSortKey) => {
		const next: DiskSort = sort.by === by ? { by, desc: !sort.desc } : { by, desc: by !== "name" && by !== "folder" };
		setSort(next);
		setPref(PREF.diskSort, JSON.stringify(next));
	};
	const rows = useMemo(() => sortRows(answer?.rows ?? [], sort), [answer, sort]);
	const total = rows.reduce((n, r) => n + rowTotal(r), 0);
	const scan = answer?.scan;

	return (
		<div className="h-full flex-1 overflow-y-auto" data-testid="disk-space-page">
			<div className="@container mx-auto max-w-6xl space-y-4 px-6 pt-4 pb-8 sm:pt-8">
				<div className="flex flex-wrap items-center gap-3">
					<HardDrive className="shrink-0 text-accent" />
					<h1 className="text-xl font-semibold">{t("diskSpace.title")}</h1>
					{answer?.disk ? (
						<span className="text-xs text-faint" data-testid="disk-free">
							{t("diskSpace.diskFree", { free: formatBytes(answer.disk.free), total: formatBytes(answer.disk.total) })}
						</span>
					) : null}
					<span className="flex-1" />
					<span className="text-xs text-muted" data-testid="disk-scan-state">
						{scan?.running
							? t("diskSpace.scanning", { done: scan.done, total: scan.total })
							: scan?.finishedAt
								? t("diskSpace.measuredAgo", { ago: fmtRelative(scan.finishedAt) })
								: t("diskSpace.neverMeasured")}
					</span>
					<Button
						size="sm"
						className="max-sm:h-8 max-sm:w-8 max-sm:px-0"
						data-testid="disk-refresh"
						onClick={() => void rescan()}
						disabled={running}
					>
						{running ? <Spinner size={13} /> : <RefreshCw size={13} />}
						<span className="max-sm:sr-only">{t("diskSpace.refresh")}</span>
					</Button>
				</div>
				<p className="text-sm text-muted">{t("diskSpace.intro")}</p>
				{error ? (
					<div className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
						{t("diskSpace.loadFailed", { error })}
					</div>
				) : null}
				{!answer && !error ? (
					<div className="flex justify-center py-20">
						<Spinner />
					</div>
				) : null}
				{answer && rows.length === 0 ? <Empty icon={<HardDrive />} title={t("diskSpace.empty")} /> : null}
				{rows.length ? (
					<section className="overflow-hidden rounded-2xl border border-border bg-surface">
						<table className="w-full text-sm" data-testid="disk-table">
							<thead className="whitespace-nowrap text-left text-xs text-faint">
								<tr>
									{COLUMNS.map((c) => (
										<th
											key={c.key}
											aria-sort={sort.by === c.key ? (sort.desc ? "descending" : "ascending") : "none"}
											className={cx("px-3 py-2 font-medium first:pl-4", c.numeric && "text-right", c.className)}
										>
											<button
												type="button"
												data-testid={`disk-sort-${c.key}`}
												title={t("diskSpace.sortBy", { column: t(c.label) })}
												onClick={() => pickSort(c.key)}
												className={cx("inline-flex items-center gap-1 hover:text-fg", sort.by === c.key && "text-fg")}
											>
												{t(c.label)}
												{sort.by === c.key ? sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} /> : null}
											</button>
										</th>
									))}
									<th className="px-4 py-2">
										<span className="sr-only">{t("diskSpace.cleanUp")}</span>
									</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-border">
								{rows.map((r) => (
									<Row key={r.folder} row={r} home={home} t={t} onClean={() => setCleaning(r)} />
								))}
							</tbody>
							<tfoot>
								<tr className="border-t border-border text-xs text-muted">
									<td colSpan={COLUMNS.length + 1} className="px-4 py-2" data-testid="disk-footer">
										{t("diskSpace.footer", { n: rows.length, total: formatBytes(total) })}
									</td>
								</tr>
							</tfoot>
						</table>
					</section>
				) : null}
			</div>
			{cleaning ? (
				<DiskCleanupDialog
					row={cleaning}
					onClose={(changed) => {
						setCleaning(null);
						// What was cleaned up is measured again.
						if (changed) void rescan();
					}}
				/>
			) : null}
		</div>
	);
}

function Row({ row, home, t, onClean }: { row: DiskRow; home: string | undefined; t: TFunction; onClean: () => void }) {
	const state =
		row.folderState === "measured"
			? null
			: row.folderState === "pending"
				? t("diskSpace.folderMeasuring")
				: row.folderState === "unknown"
					? t("diskSpace.folderUnknown")
					: row.folderState === "gone"
						? t("diskSpace.folderGone")
						: t("diskSpace.folderNotMeasured");
	const folderText = row.folderBytes === null ? "—" : formatBytes(row.folderBytes);
	return (
		<tr className="group hover:bg-hover/50" data-testid="disk-row" data-folder={row.folder}>
			<td className="max-w-64 px-3 py-2 pl-4">
				<div className="truncate font-medium" data-testid="disk-row-name">
					{row.name}
				</div>
				<div className="truncate text-xs text-faint">
					{row.kind === "other" && row.real !== null
						? t("diskSpace.kindOther")
						: row.kind === "protected"
							? t("diskSpace.kindProtected")
							: null}
				</div>
			</td>
			<td className="max-w-80 truncate px-3 py-2 text-xs text-muted @max-2xl:hidden" title={row.folder}>
				{shortPath(row.folder, home)}
			</td>
			<td className="px-3 py-2 text-right tabular-nums @max-xl:hidden">
				<div>{row.conversations}</div>
				<div className="text-xs text-faint">{formatBytes(row.conversationBytes)}</div>
			</td>
			<td
				className="px-3 py-2 text-right tabular-nums"
				title={t("diskSpace.totalParts", { folder: folderText, conversations: formatBytes(row.conversationBytes) })}
			>
				<div className="font-medium" data-testid="disk-row-total">
					{formatBytes(rowTotal(row))}
				</div>
				{state ? <div className="text-xs text-faint">{state}</div> : null}
			</td>
			<td className="px-3 py-2 text-right text-xs text-muted @max-xl:hidden">
				{row.lastUsed === null ? "—" : fmtRelative(row.lastUsed)}
			</td>
			<td className="px-4 py-2 text-right">
				<Button size="sm" variant="ghost" data-testid="disk-clean" onClick={onClean}>
					{t("diskSpace.cleanUp")}
				</Button>
			</td>
		</tr>
	);
}
