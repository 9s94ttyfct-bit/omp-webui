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
