import type { OmpFrame } from "@shared/protocol.ts";

/** What omp's `notice` frames (`{ level, message, source? }`) become on screen. */

export interface NoticeToast {
	level: "info" | "warning" | "error";
	text: string;
}

/**
 * The toast for a notice, worded as the TUI's status line words it: `source: message`. Info notices ("Claude session
 * limit reset") are shown like the others. The one kind left out is omp's bookkeeping of the tools it mounted (source
 * `xdev`, `xd://: mounted mcp__…`): it lists every tool of every MCP server each time a conversation starts, and the
 * Context tab lists them anyway.
 */
export function noticeToast(frame: OmpFrame): NoticeToast | null {
	const message = typeof frame.message === "string" ? frame.message.trim() : "";
	if (!message) return null;
	const level = frame.level === "error" ? "error" : frame.level === "warning" ? "warning" : "info";
	const source = typeof frame.source === "string" ? frame.source.trim() : "";
	if (level === "info" && source === "xdev") return null;
	return { level, text: source ? `${source}: ${message}` : message };
}
