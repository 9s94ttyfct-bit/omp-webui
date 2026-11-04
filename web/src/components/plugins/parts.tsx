import type { PluginScope } from "@shared/plugins.ts";
import type { WebCatalog } from "@shared/plugins-catalogs.ts";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { Select } from "../Select.tsx";
import { Button, CardHeader, Modal } from "../ui.tsx";

/**
 * What the Plugins page's sections have in common: a section's card, a confirmation, the scope picker. In a module of its
 * own so that the sections loaded with their tab (Skills, MCP) use them without importing the page.
 */

export const SCOPE_KEY: Record<PluginScope, MessageKey> = {
	user: "plugins.scopeUser",
	project: "plugins.scopeProject",
};

/** One choice of a list's filter: what it keeps, what it says, how many items it keeps. */
export interface FilterOption {
	value: string;
	label: string;
	count: number;
}

/** The distinct values `of` gives the items, each with how many have it, most first, then by name. */
export function countBy<T>(items: readonly T[], of: (item: T) => string | null): FilterOption[] {
	const counts = new Map<string, number>();
	for (const item of items) {
		const v = of(item);
		if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
	}
	return [...counts]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([value, count]) => ({ value, label: value, count }));
}

/** One filter of a list: the value chosen (`""`: any) and the value each item has for it. */
export interface Facet<T> {
	value: string;
	of: (item: T) => string | null;
}

/** A facet's choices, and whether the whole list has two values or more for it (else it filters nothing). */
export interface FacetChoices {
	options: FilterOption[];
	useful: boolean;
}

/**
 * A list filtered by several facets and `keep` (a text search): the items every facet keeps, and each facet's choices
 * counted over the items the *other* facets keep, so a count says what choosing it would show. The chosen value stays
 * a choice even when nothing has it any more (with 0), so that the control still shows it.
 */
export function facets<T, K extends string>(
	items: readonly T[],
	by: Record<K, Facet<T>>,
	keep: (item: T) => boolean,
): { kept: T[]; choices: Record<K, FacetChoices> } {
	const keys = Object.keys(by) as K[];
	const passes = (item: T, except: K | null) =>
		keep(item) && keys.every((k) => k === except || !by[k].value || by[k].of(item) === by[k].value);
	const choices = {} as Record<K, FacetChoices>;
	for (const k of keys) {
		const counted = countBy(
			items.filter((item) => passes(item, k)),
			by[k].of,
		);
		const chosen = by[k].value;
		choices[k] = {
			options:
				chosen && !counted.some((o) => o.value === chosen)
					? [...counted, { value: chosen, label: chosen, count: 0 }]
					: counted,
			useful: new Set(items.map(by[k].of).filter(Boolean)).size > 1,
		};
	}
	return { kept: items.filter((item) => passes(item, null)), choices };
}

/**
 * A filter of a list: "all" (`""`) and the values the list has, each with its count. Not shown when it would filter
 * nothing (unless a value is chosen, so that it can be undone). The "all" choice's option value is `*` (a Radix item
 * cannot have an empty one).
 */
export function FilterSelect({
	label,
	all,
	value,
	choices,
	labelOf,
	onChange,
	testId,
}: {
	label: string;
	/** What the "everything" choice says. */
	all: string;
	value: string;
	choices: FacetChoices;
	/** What a value says, where it is not its own label. */
	labelOf?: (value: string) => string;
	onChange: (value: string) => void;
	testId: string;
}) {
	if (!choices.useful && value === "") return null;
	const options = choices.options;
	return (
		<Select
			tone="compact"
			aria-label={label}
			title={label}
			data-testid={testId}
			value={value === "" ? "*" : value}
			onValueChange={(v) => onChange(v === "*" ? "" : v)}
			className="w-40 shrink-0"
		>
			<option value="*">{all}</option>
			{options.map((o) => (
				<option key={o.value} value={o.value}>
					{`${labelOf ? labelOf(o.value) : o.label} (${o.count})`}
				</option>
			))}
		</Select>
	);
}

export function Section({
	id,
	title,
	icon,
	hint,
	action,
	children,
}: {
	id: string;
	title: string;
	icon: ReactNode;
	hint?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section
			className="rounded-2xl border border-border bg-surface p-4"
			aria-labelledby={`plugins-${id}-title`}
			data-testid={`plugins-${id}`}
		>
			<CardHeader title={<span id={`plugins-${id}-title`}>{title}</span>} icon={icon} hint={hint} action={action} />
			{children}
		</section>
	);
}

export function Confirm({
	open,
	onOpenChange,
	title,
	body,
	action,
	danger,
	onConfirm,
	testId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	body: ReactNode;
	action: string;
	danger?: boolean;
	onConfirm: () => void;
	testId: string;
}) {
	const t = useT();
	return (
		<Modal open={open} onOpenChange={onOpenChange} title={title}>
			<div className="text-sm text-muted">{body}</div>
			<div className="mt-4 flex flex-wrap justify-end gap-2">
				<Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
				<Button
					variant={danger ? "danger" : "primary"}
					data-testid={testId}
					onClick={() => {
						onOpenChange(false);
						onConfirm();
					}}
				>
					{action}
				</Button>
			</div>
		</Modal>
	);
}

export function ScopePicker({
	value,
	onChange,
	projectAllowed,
	label,
	testId,
}: {
	value: PluginScope;
	onChange: (scope: PluginScope) => void;
	projectAllowed: boolean;
	label: string;
	testId: string;
}) {
	const t = useT();
	return (
		<Select
			tone="compact"
			aria-label={label}
			data-testid={testId}
			value={value}
			onValueChange={(v) => onChange(v === "project" ? "project" : "user")}
			className="w-28 shrink-0"
		>
			<option value="user">{t("plugins.scopeUser")}</option>
			{projectAllowed ? <option value="project">{t("plugins.scopeProject")}</option> : null}
		</Select>
	);
}

/** A field's look on the Plugins page: a search, a spec, a value. */
export const FIELD =
	"min-w-0 rounded-lg border border-border bg-bg-soft px-2.5 py-1.5 text-sm outline-none focus:border-faint";

/** Links to catalogs on the web, opened in a new tab. */
export function WebLinks({
	label,
	catalogs,
	testId,
}: {
	label: string;
	catalogs: readonly WebCatalog[];
	testId: string;
}) {
	return (
		<p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" data-testid={testId}>
			<span>{label}</span>
			{catalogs.map((c) => (
				<a
					key={c.url}
					href={c.url}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1 text-accent hover:underline"
				>
					{c.name} <ExternalLink size={11} aria-hidden />
				</a>
			))}
		</p>
	);
}
