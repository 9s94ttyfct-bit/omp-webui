import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { fmtCost, fmtCostExact, fmtTokens } from "../lib/format.ts";
import type { HeaderUsage } from "../lib/totals.ts";

/**
 * Under the usage figures: what the conversation's own requests cost, and what its subagents' and its advisors' did
 * (each only when the conversation has any).
 */
export function UsageSplit({ split }: { split: NonNullable<HeaderUsage["split"]> }) {
	const t = useT();
	const { main, subagents, advisor } = split;
	return (
		<div
			className="col-span-2 mt-1 space-y-0.5 border-t border-border pt-1"
			data-testid="usage-split"
			data-main-cost={main.cost}
			data-subagent-cost={subagents.cost}
			data-subagent-count={subagents.count}
			data-subagent-running={subagents.running}
			data-advisor-cost={advisor.cost}
			data-advisor-requests={advisor.requests}
		>
			<div data-split="main" title={fmtCostExact(main.cost)}>
				{t("chat.usageSplitMain", { tokens: fmtTokens(main.tokens), cost: fmtCost(main.cost) })}
			</div>
			{subagents.count > 0 ? (
				<div data-split="subagents" title={fmtCostExact(subagents.cost)}>
					{t(subagents.running ? "chat.usageSplitSubagentsRunning" : "chat.usageSplitSubagents", {
						n: subagents.count,
						running: subagents.running,
						tokens: fmtTokens(subagents.tokens),
						cost: fmtCost(subagents.cost),
					})}
				</div>
			) : null}
			{advisor.requests > 0 ? (
				<div data-split="advisor" title={fmtCostExact(advisor.cost)}>
					{t("chat.usageSplitAdvisor", { tokens: fmtTokens(advisor.tokens), cost: fmtCost(advisor.cost) })}
				</div>
			) : null}
		</div>
	);
}
