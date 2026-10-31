import { CalendarRange } from "lucide-react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { DATE_RANGES, type DateRange } from "../lib/session-search.ts";
import { Select } from "./Select.tsx";
import { cx } from "./ui.tsx";

const LABELS: Record<DateRange, MessageKey> = {
	today: "shell.sidebarRangeToday",
	week: "shell.sidebarRangeWeek",
	month: "shell.sidebarRangeMonth",
	all: "shell.sidebarRangeAll",
};

/**
 * The sidebar's date filter: a 32px calendar next to the project filter, with a dot (and the accent) while a range is
 * chosen. The app's select is laid over the button with no paint of its own (the system's picker on a phone), and its
 * tooltip names the range it is filtering by.
 */
export function RangeFilter({ value, onChange }: { value: DateRange; onChange: (range: DateRange) => void }) {
	const t = useT();
	const filtered = value !== "all";
	return (
		<label
			title={`${t("shell.sidebarRangeLabel")}: ${t(LABELS[value])}`}
			className={cx(
				"relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border hover:bg-hover has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
				filtered ? "border-accent/50 bg-accent-soft text-fg" : "border-border bg-surface text-muted hover:text-fg",
			)}
		>
			<CalendarRange size={14} aria-hidden />
			{filtered ? (
				<span aria-hidden className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-accent ring-2 ring-bg-soft" />
			) : null}
			<Select
				tone="overlay"
				aria-label={t("shell.sidebarRangeLabel")}
				data-testid="session-range"
				value={value}
				onValueChange={(v) => onChange(v as DateRange)}
			>
				{DATE_RANGES.map((range) => (
					<option key={range} value={range}>
						{t(LABELS[range])}
					</option>
				))}
			</Select>
		</label>
	);
}
