import * as Popover from "@radix-ui/react-popover";
import { Suspense, useId } from "react";
import { useT } from "../i18n/index.ts";
import { useHostWatch } from "../lib/host.ts";
import { fmtShare, fmtWatts, hostColor } from "../lib/host-rows.ts";
import { useHost } from "../lib/host-store.ts";
import { PRESSURE_DOT, PRESSURE_KEY, useHostStrings } from "../lib/host-strings.ts";
import { lazyChunk } from "../lib/lazy-chunk.ts";
import { useApp } from "../store/app.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { cx, Spinner, Tip } from "./ui.tsx";

/** The graphs are a chunk of their own (they bring the chart library): fetched when the pointer or the focus comes to the indicator, or when it is opened. */
export const { Chunk: HostPaneChunk, retry: retryHostPane, preload } = lazyChunk(() => import("./HostPane.tsx"));

/**
 * The host's load in the sidebar's footer, as one line (`CPU 12% · GPU 3% · MEM 61% · 6.2 W` and a dot that is the colour
 * of the memory pressure), or, in the rail, as three small bars. A click, a tap or the keyboard opens the graphs. While it
 * is on screen the server tells this page each look, at its background pace (the line alone is no reason to look every
 * 2 s); the pane that opens here asks for the live pace (`HostPane`). A page that is hidden, or has no connection, asks for
 * nothing (`useHostWatch`) and the line is dimmed while there is no connection. The GPU is left out on a computer that
 * has none to read, and the power draw on one that tells none (the rail's bars are shares, so it has no bar for power).
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
	const rail = variant === "rail";
	if (!ready) return <div aria-hidden className={rail ? "h-8 w-8" : "h-7"} />;

	const showGpu = gpuKnown || (latest?.gpu ?? null) !== null;
	const level = latest?.pressure ?? null;
	const figures = [
		t("host.chipCpu", { v: fmtShare(latest?.cpu) }),
		...(showGpu ? [t("host.chipGpu", { v: fmtShare(latest?.gpu) })] : []),
		t("host.chipMem", { v: fmtShare(latest?.mem) }),
	];
	// The whole computer's power draw ends the line where the computer tells it; read aloud with its name.
	const showPower = powerKnown || (latest?.power ?? null) !== null;
	const watts = fmtWatts(latest?.power);
	const shown = showPower ? [...figures, watts] : figures;
	const told = showPower ? [...figures, t("host.chipPower", { v: watts })] : figures;
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
					    (the power draw, at the end): each figure keeps its separator, and the space after it is where a line may break. */}
					<span className="min-w-0" data-testid="host-figures">
						{shown.map((figure, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: the figures are CPU, GPU, memory, power in a fixed order
							<span key={i}>
								{i > 0 ? " " : null}
								<span className="whitespace-nowrap">{i < shown.length - 1 ? `${figure} ·` : figure}</span>
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
