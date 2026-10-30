import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { parseTokenAmount } from "../lib/token-amount.ts";
import { cx } from "./ui.tsx";

/**
 * The token budget field of the goal form and of the interview's proposal. It reads the amounts the page prints
 * (`200k`, `1.5M`) and plain digits, says what it understood before the goal starts, and says so when it cannot read
 * the text: a budget the user did not type must never reach omp. `parseTokenAmount(value)` is what the caller sends.
 */
export function BudgetField({
	id,
	testId,
	className,
	placeholder,
	value,
	onChange,
}: {
	id: string;
	testId: string;
	className: string;
	placeholder: string;
	value: string;
	onChange: (value: string) => void;
}) {
	const t = useT();
	const amount = parseTokenAmount(value);
	const hint = `${id}-hint`;
	return (
		<>
			<input
				id={id}
				data-testid={testId}
				autoComplete="off"
				spellCheck={false}
				className={className}
				placeholder={placeholder}
				value={value}
				aria-invalid={amount === null}
				aria-describedby={amount === undefined ? undefined : hint}
				onChange={(e) => onChange(e.target.value)}
			/>
			{amount === undefined ? null : (
				<p
					id={hint}
					data-testid={`${testId}-hint`}
					role="status"
					className={cx("mt-1 text-xs", amount === null ? "text-danger" : "text-muted tabular-nums")}
				>
					{amount === null
						? t("panel.goalBudgetInvalid")
						: t("panel.goalBudgetParsed", { tokens: amount.toLocaleString() })}
				</p>
			)}
		</>
	);
}
