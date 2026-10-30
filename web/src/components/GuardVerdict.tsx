import type { GuardDecision } from "@shared/guard.ts";
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { useT } from "../i18n/index.ts";
import { CARD_TEXT, CHIP_TONE, money, secondsOf, shortModel, verdictKind } from "../lib/guard-format.ts";
import { useGuardStrings } from "../lib/guard-strings.ts";
import { cx } from "./ui.tsx";

/**
 * What "Guard dangerous commands" decided about a tool call, on the call's card: who said it, what they said, and for a
 * reviewer's verdict the model, what it cost and how long it took. A refusal because no reviewer could be reached says
 * so, because nobody judged the call: it is not a denial on the merits. What is shown is the decision's own text, as text.
 */
export default function GuardVerdict({ decision: d }: { decision: GuardDecision }) {
	const t = useT();
	const ready = useGuardStrings();
	if (!ready) return null;
	const kind = verdictKind(d);
	const parts = [t(CARD_TEXT[kind], { reason: d.reason })];
	if (d.by === "reviewer") {
		if (d.model) parts.push(shortModel(d.model));
		if (d.usage && d.usage.requests > 0) parts.push(money(d.usage.cost));
		if (d.ms > 0) parts.push(t("guard.seconds", { s: secondsOf(d.ms) }));
	}
	const Icon = d.verdict === "allow" ? ShieldCheck : d.verdict === "deny" ? ShieldX : ShieldAlert;
	// The last figure stays with the word before it: on a phone the line wraps, and "· 1.8 s" never starts a line alone.
	const head = parts.slice(0, -1).join(" · ");
	const cut = head.lastIndexOf(" ") + 1;
	return (
		<div
			className={cx("flex min-w-0 items-start gap-1.5 text-xs", CHIP_TONE[kind].split(" ")[1])}
			data-testid="guard-verdict"
			data-verdict={d.verdict}
			data-by={d.by}
			title={d.reason || undefined}
		>
			<Icon size={13} className="mt-0.5 shrink-0" aria-hidden />
			<span className="line-clamp-3 min-w-0 break-words">
				{parts.length === 1 ? (
					parts[0]
				) : (
					<>
						{head.slice(0, cut)}
						<span className="whitespace-nowrap">
							{head.slice(cut)} · {parts[parts.length - 1]}
						</span>
					</>
				)}
			</span>
		</div>
	);
}
