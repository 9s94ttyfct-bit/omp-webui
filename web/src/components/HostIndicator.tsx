import * as Popover from "@radix-ui/react-popover";
import { Suspense, useId } from "react";
import { useT } from "../i18n/index.ts";
import { useHostWatch } from "../lib/host.ts";
import { lineDisks, useHostDisks } from "../lib/host-disks.ts";
import { fmtMem, fmtRate, fmtShare, fmtWatts, hostColor } from "../lib/host-rows.ts";
import { useHost } from "../lib/host-store.ts";
import { PRESSURE_DOT, PRESSURE_KEY, useHostStrings } from "../lib/host-strings.ts";
import { lazyChunk } from "../lib/lazy-chunk.ts";
import { useApp } from "../store/app.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { cx, Spinner, Tip } from "./ui.tsx";

/** The graphs are a chunk of their own (they bring the chart library): fetched when the pointer or the focus comes to the indicator, or when it is opened. */
export const { Chunk: HostPaneChunk, retry: retryHostPane, preload } = lazyChunk(() => import("./HostPane.tsx"));

/**
 * The host's load in the sidebar's footer, as one line (`CPU 12% · GPU 3% · MEM 61% · 6.2 W · ↓1.2 MB/s ↑40 KB/s · 120 GB
 * free` and a dot that is the colour of the memory pressure), or, in the rail, as three small bars. A click, a tap or the
 * keyboard opens the graphs. While it is on screen the server tells this page each look, at its background pace (the line
 * alone is no reason to look every 2 s); the pane that opens here asks for the live pace (`HostPane`). A page that is
 * hidden, or has no connection, asks for nothing (`useHostWatch`) and the line is dimmed while there is no connection. The
 * GPU is left out on a computer that has none to read, the power draw on one that tells none, and the network on one that
 * tells none (Windows). The disks are the ones chosen in Settings, or the system's disk (`lineDisks`); each is named when
 * there are several. The rail's bars are shares, so it has no bar for power, the network or the disks.
 */
export default function HostIndicator({ variant }: { variant: "line" | "rail" }) {
	const ready = useHostStrings();
	useHostWatch();
	const t = useT();
	const titleId = useId();
	const connected = useApp((s) => s.connected);
	const latest = useHost((s) => s.fine.at(-1) ?? null);
	const gpuKnown = useHost((s) => s.info?.gpu != null);
	const powerKnown = useHost((s) => s.info?.power === true);
	const netKnown = useHost((s) => s.info?.net === true);
	const listed = useHost((s) => s.info?.disks);
	const dataDisk = useHost((s) => s.info?.dataDisk ?? null);
	const chosen = useHostDisks();
	const rail = variant === "rail";
	if (!ready) return <div aria-hidden className={rail ? "h-8 w-8" : "h-7"} />;

	const showGpu = gpuKnown || (latest?.gpu ?? null) !== null;
	const level = latest?.pressure ?? null;
	const figures = [
		t("host.chipCpu", { v: fmtShare(latest?.cpu) }),
		...(showGpu ? [t("host.chipGpu", { v: fmtShare(latest?.gpu) })] : []),
		t("host.chipMem", { v: fmtShare(latest?.mem) }),
	];
	// The whole computer's power draw comes after the shares where the computer tells it; read aloud with its name.
	const showPower = powerKnown || (latest?.power ?? null) !== null;
	const watts = fmtWatts(latest?.power);
	const showNet = netKnown || (latest?.rx ?? null) !== null;
	const down = fmtRate(latest?.rx);
	const up = fmtRate(latest?.tx);
	const disks = lineDisks(listed ?? [], chosen, dataDisk);
	const named = disks.length > 1;
	const free = (id: string) => {
		const v = latest?.disks?.[id];
		return v === null || v === undefined ? "—" : fmtMem(v);
	};
	const diskFigure = (name: string, v: string) =>
		named ? t("host.chipDisk", { name, v }) : t("host.diskValue", { free: v });
	const shown = [
		...figures,
		...(showPower ? [watts] : []),
		...(showNet ? [t("host.chipNet", { down, up })] : []),
		...disks.map((d) => diskFigure(d.name, free(d.id))),
	];
	// Each figure keeps the room of its two-digit form ("GPU 88%", "88.8 W", "↓888 KB/s"): a share going from 9% to 10%
	// no longer moves a figure to the next line and the list under it by a line's height.
	const roomy = [
		t("host.chipCpu", { v: "88%" }),
		...(showGpu ? [t("host.chipGpu", { v: "88%" })] : []),
		t("host.chipMem", { v: "88%" }),
		...(showPower ? [fmtWatts(88.8)] : []),
		...(showNet ? [t("host.chipNet", { down: "888 KB/s", up: "888 KB/s" })] : []),
		...disks.map((d) => diskFigure(d.name, "888 GB")),
	];
	const told = [
		...figures,
		...(showPower ? [t("host.chipPower", { v: watts })] : []),
		...(showNet ? [t("host.chipNetAria", { down, up })] : []),
		...disks.map((d) => t("host.chipDisk", { name: d.name, v: free(d.id) })),
	];
	const said = level === null ? null : t(PRESSURE_KEY[level]);
	const spoken = said
		? t("host.chipAria", { figures: told.join(", "), pressure: said })
		: t("host.chipAriaNoPressure", { figures: told.join(", ") });
	const aria = connected ? spoken : `${spoken} ${t("host.chipOffline")}`;
	const dot = PRESSURE_DOT[level ?? "none"];
	const bars = [latest?.cpu ?? null, ...(showGpu ? [latest?.gpu ?? null] : []), latest?.mem ?? null];

	const trigger = (
		<Popover.Trigger asChild>
			{rail ? (
				<button
					type="button"
					aria-label={aria}
					data-testid="host-chip"
					data-variant="rail"
					data-level={level ?? ""}
					data-connected={connected}
					onPointerEnter={preload}
					onFocus={preload}
					className={cx(
						"relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg",
						!connected && "opacity-50",
					)}
				>
					<span aria-hidden className="flex h-5 items-end gap-[3px]">
						{bars.map((v, i) => (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: the bars are CPU, GPU, memory in a fixed order
								key={i}
								className="relative h-full w-1 overflow-hidden rounded-sm bg-hover"
							>
								<span
									className="absolute inset-x-0 bottom-0"
									style={{ height: `${Math.max(v ?? 0, 4)}%`, background: hostColor(i) }}
								/>
							</span>
						))}
					</span>
					<span
						aria-hidden
						data-testid="host-dot"
						className={cx("absolute top-1 right-1 h-1.5 w-1.5 rounded-full", dot)}
					/>
				</button>
			) : (
				<button
					type="button"
					aria-label={aria}
					title={connected ? t("host.chipTitle") : t("host.chipOffline")}
					data-testid="host-chip"
					data-variant="line"
					data-level={level ?? ""}
					data-connected={connected}
					onPointerEnter={preload}
					onFocus={preload}
					className={cx(
						"flex min-h-7 w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-xs tabular-nums hover:bg-hover hover:text-fg",
						// Figures the server no longer updates are told apart in the faint ink, not faded: at half opacity they were 2.2:1.
						connected ? "text-muted" : "text-faint",
					)}
				>
					{/* A narrow sidebar breaks the line between two figures, never inside one, rather than cutting off the last
					    (a disk, at the end): each figure keeps its separator, and the space after it is where a line may break. */}
					<span className="min-w-0" data-testid="host-figures">
						{shown.map((figure, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: the figures are CPU, GPU, memory, power, network, disks in a fixed order
							<span key={i}>
								{i > 0 ? " " : null}
								{/* The room is the two-digit form drawn invisibly in a pseudo-element, under the figure: not text of the page. */}
								<span
									className="inline-grid whitespace-nowrap after:invisible after:col-start-1 after:row-start-1 after:content-[attr(data-room)]"
									data-room={i < shown.length - 1 ? `${roomy[i]} ·` : roomy[i]}
								>
									<span className="col-start-1 row-start-1">{i < shown.length - 1 ? `${figure} ·` : figure}</span>
								</span>
							</span>
						))}
					</span>
					<span aria-hidden data-testid="host-dot" className={cx("ml-auto h-2 w-2 shrink-0 rounded-full", dot)} />
				</button>
			)}
		</Popover.Trigger>
	);
	return (
		<Popover.Root>
			{rail ? <Tip label={aria}>{trigger}</Tip> : trigger}
			<Popover.Portal>
				<Popover.Content
					side={rail ? "right" : "top"}
					align={rail ? "end" : "start"}
					// In the rail the button is inset from the strip's edge: the popover starts beyond the strip, not over it.
					sideOffset={rail ? 14 : 6}
					collisionPadding={8}
					aria-labelledby={titleId}
					data-testid="host-popover"
					// On a phone the sidebar is the window's height: at its full height the popover covered New chat at its top.
					className="z-50 max-h-[min(44rem,var(--radix-popover-content-available-height))] w-[26rem] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-surface p-3 text-sm shadow-2xl max-md:max-h-[min(60vh,var(--radix-popover-content-available-height))]"
				>
					<ErrorBoundary fallback={() => null} onError={retryHostPane}>
						<Suspense
							fallback={
								<div className="flex justify-center py-10">
									<Spinner />
								</div>
							}
						>
							<HostPaneChunk titleId={titleId} />
						</Suspense>
					</ErrorBoundary>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
