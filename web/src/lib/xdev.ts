/**
 * omp (18.22 on) runs its discoverable tools (`lsp`, `ast_edit`, `debug`, every MCP server's tools…) as "mounted devices":
 * the model calls `write { path: "xd://<tool>", content: "<JSON arguments>" }`, and the result says what ran in
 * `details.xdev` (`{ tool, mode: "execute" | "help", args, inner }`). Such a `write` writes no file.
 */

/** A path that is one of omp's internal URLs (`xd://lsp`, `local://plan.md`, `agent://Main`), not a file of the folder. */
export const isInternalUrl = (path: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(path);

export interface DeviceCall {
	/** The tool that ran: `details.xdev.tool`, else the name in the path. */
	tool: string;
	/** Its arguments: `details.xdev.args`, else the JSON the call wrote (as it was, when it is not JSON). */
	args: unknown;
}

const rec = (v: unknown): Record<string, unknown> | null =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The device call a `write` to `xd://…` is; null for any other call. */
export function deviceCallOf(name: string, args: unknown, details: unknown): DeviceCall | null {
	const path = rec(args)?.path;
	if (name !== "write" || typeof path !== "string" || !path.startsWith("xd://")) return null;
	const xdev = rec(rec(details)?.xdev);
	const named = path.slice("xd://".length).split(/[/?#]/)[0];
	const tool = typeof xdev?.tool === "string" && xdev.tool ? xdev.tool : named || path;
	if (xdev && "args" in xdev) return { tool, args: xdev.args };
	const content = rec(args)?.content;
	if (typeof content !== "string") return { tool, args: content ?? {} };
	try {
		return { tool, args: JSON.parse(content) };
	} catch {
		return { tool, args: content };
	}
}
