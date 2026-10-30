import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { type ContextUsage, contextLevel } from "../lib/context-usage.ts";
import { cx } from "./ui.tsx";

/** The colour of a context figure by how full it is, as the status line's meter has it. */
const LEVEL_TEXT = { ok: undefined, warn: "text-warning", high: "text-danger" } as const;

/**
 * How full a subagent's context window is, `ctx 41%`, with the tokens and the window in its tooltip (the status line's
 * wording for the conversation's own). Nothing while it is not known: no 0% for a subagent that has not said.
 */
export function ContextPercent({ ctx, className }: { ctx: ContextUsage | undefined; className?: string }) {
	const t = useT();
	if (!ctx) return null;
	const level = contextLevel(ctx.percent);
	const percent = Math.round(ctx.percent);
	return (
		<span
			className={cx("whitespace-nowrap tabular-nums", LEVEL_TEXT[level], className)}
			title={t("chat.contextTip", {
				tokens: ctx.tokens.toLocaleString(),
				window: ctx.contextWindow.toLocaleString(),
			})}
			data-testid="subagent-context"
			data-percent={percent}
			data-level={level}
		>
			{t("panel.agentContextPercent", { percent })}
		</span>
	);
}
