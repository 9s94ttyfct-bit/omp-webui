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
