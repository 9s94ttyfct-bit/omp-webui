import { type OmpFeature, ompLacks } from "./omp-install.ts";

/**
 * omp's tool approval modes (`tools.approvalMode`, docs: approval-mode.md), in omp's own order. `always-ask-cached`
 * ("Ask and remember") asks like `always-ask` and also before reading a file it was not granted, and can remember a
 * file or folder. The web UI lets the user pick one per conversation and a default for new ones.
 */
export const APPROVAL_MODES = ["always-ask", "always-ask-cached", "write", "yolo"] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export function isApprovalMode(v: unknown): v is ApprovalMode {
	return typeof v === "string" && (APPROVAL_MODES as readonly string[]).includes(v);
}

/** The omp feature a mode needs beyond the oldest omp the web UI was written for. */
const MODE_FEATURE: Partial<Record<ApprovalMode, OmpFeature>> = { "always-ask-cached": "approvalModeCached" };

/**
 * The first omp version that knows `mode`, when the omp at `ompVersion` is older than that; null when it knows it (or
 * cannot say its version). Such a mode is neither offered nor sent to that omp: it would run in a mode other than the
 * one the page shows.
 */
export function approvalModeNeeds(mode: ApprovalMode, ompVersion: string | null | undefined): string | null {
	const feature = MODE_FEATURE[mode];
	return feature ? ompLacks(feature, ompVersion) : null;
}
