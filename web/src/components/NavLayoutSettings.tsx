import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef } from "react";
import { registerStrings, useT } from "../i18n/index.ts";
import { en } from "../i18n/nav-layout.ts";
import {
	NAV_GROUPS,
	NAV_SURFACES,
	type NavGroup,
	type NavItemId,
	type NavSurface,
	navItemsIn,
	useNavLayout,
} from "../lib/nav-layout.ts";
import { moveNavItem, nudgeNavItem, resetNavLayout } from "../lib/nav-layout-edit.ts";
import { useApp } from "../store/app.ts";
import { Select } from "./Select.tsx";
import { Button, CardHeader, IconButton } from "./ui.tsx";

// This card is a chunk of its own (Settings): the arrangement's controls and their strings are not in the first page. The
// bars themselves (and the names of the pages) are, and they are what a drag arranges without this card.
registerStrings("navLayout", en);

const GROUP_KEYS = {
	top: "navLayout.groupTop",
	bottom: "navLayout.groupBottom",
	hidden: "navLayout.groupHidden",
} as const;

/**
 * Settings › Sidebar and rail (#654): the pages each bar offers, and where, for people who would rather not drag (a
 * keyboard, a screen reader): every item has a group (top, bottom or hidden) and Move up / Move down inside it. What a drag
 * in the bars does is the same move. Kept on this device (localStorage); "Reset to default" puts everything back.
 */
export function NavLayoutSettings() {
	const t = useT();
	const layout = useNavLayout();
	const remote = useApp((s) => s.meta?.remote === true);
	// A move to another group re-creates the item's controls; the one that was used takes the focus back.
	const refocus = useRef<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `layout` is the trigger: a move has just been drawn.
	useEffect(() => {
		const wanted = refocus.current;
		if (!wanted) return;
		refocus.current = null;
		document.querySelector<HTMLElement>(`[data-testid="${wanted}"]`)?.focus();
	}, [layout]);
	const surfaceName = (surface: NavSurface) => t(surface === "sidebar" ? "navLayout.sidebar" : "navLayout.rail");
	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="nav-layout-settings">
			<CardHeader title={t("navLayout.title")} hint={t("navLayout.hint")} />
			<div className="space-y-4">
				{NAV_SURFACES.map((surface) => (
					<fieldset key={surface} className="min-w-0" data-testid={`nav-edit-${surface}`}>
						<legend className="mb-1 text-sm font-medium">{surfaceName(surface)}</legend>
						<div className="space-y-2">
							{NAV_GROUPS.map((group) => (
								<Group
									key={group}
									surface={surface}
									group={group}
									remote={remote}
									onMoved={(testid) => {
										refocus.current = testid;
									}}
								/>
							))}
						</div>
					</fieldset>
				))}
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-3">
				<Button data-testid="nav-layout-reset" className="shrink-0 whitespace-nowrap" onClick={resetNavLayout}>
					{t("navLayout.reset")}
				</Button>
				<span className="text-xs text-muted">{t("navLayout.resetHint")}</span>
			</div>
			{remote ? <p className="mt-2 text-xs text-muted">{t("navLayout.guardNote")}</p> : null}
		</section>
	);
}

function Group({
	surface,
	group,
	remote,
	onMoved,
}: {
	surface: NavSurface;
	group: NavGroup;
	remote: boolean;
	/** The test id of the control to give the focus back to once the move has been drawn. */
	onMoved: (testid: string) => void;
}) {
	const t = useT();
	const layout = useNavLayout();
	const items = navItemsIn(layout, surface, group, { remote });
	const name = t(GROUP_KEYS[group]);
	return (
		<div
			className="min-w-0 rounded-xl border border-border bg-bg-soft p-2"
			data-testid={`nav-edit-group-${surface}-${group}`}
		>
			<div className="mb-1 px-1 text-xs font-medium text-muted">{name}</div>
			{items.length ? (
				<ul className="space-y-1">
					{items.map((item, index) => {
						const label = t(item.labelKey);
						const surfaceLabel = t(surface === "sidebar" ? "navLayout.sidebar" : "navLayout.rail");
						return (
							// A narrow card puts the controls on a line of their own rather than cut the name to a few letters.
							<li
								key={item.id}
								className="flex flex-wrap items-center gap-1"
								data-testid={`nav-edit-${surface}-${item.id}`}
								data-group={group}
							>
								<span className="flex min-w-0 flex-1 basis-36 items-center gap-1">
									<item.icon size={14} aria-hidden className="shrink-0 text-muted" />
									<span className="min-w-0 truncate text-sm">{label}</span>
								</span>
								<span className="ml-auto flex items-center gap-1">
									<IconButton
										size="sm"
										label={t("navLayout.moveUp", { item: label, surface: surfaceLabel })}
										disabled={index === 0}
										data-testid={`nav-edit-up-${surface}-${item.id}`}
										onClick={() => nudgeNavItem(surface, item.id, -1)}
									>
										<ChevronUp size={14} />
									</IconButton>
									<IconButton
										size="sm"
										label={t("navLayout.moveDown", { item: label, surface: surfaceLabel })}
										disabled={index === items.length - 1}
										data-testid={`nav-edit-down-${surface}-${item.id}`}
										onClick={() => nudgeNavItem(surface, item.id, 1)}
									>
										<ChevronDown size={14} />
									</IconButton>
									<GroupSelect
										surface={surface}
										id={item.id}
										group={group}
										label={t("navLayout.groupLabel", { item: label, surface: surfaceLabel })}
										onMoved={onMoved}
									/>
								</span>
							</li>
						);
					})}
				</ul>
			) : (
				<p className="px-1 py-1 text-xs text-faint">{t("navLayout.groupEmpty")}</p>
			)}
		</div>
	);
}

function GroupSelect({
	surface,
	id,
	group,
	label,
	onMoved,
}: {
	surface: NavSurface;
	id: NavItemId;
	group: NavGroup;
	label: string;
	onMoved: (testid: string) => void;
}) {
	const t = useT();
	return (
		<Select
			tone="compact"
			className="w-24 shrink-0"
			aria-label={label}
			data-testid={`nav-edit-group-select-${surface}-${id}`}
			value={group}
			onValueChange={(v) => {
				const next = v as NavGroup;
				if (next === group) return;
				// The control that moved is re-created in the other group: it is found again by its id.
				onMoved(`nav-edit-group-select-${surface}-${id}`);
				moveNavItem(surface, id, { group: next });
			}}
		>
			{NAV_GROUPS.map((g) => (
				<option key={g} value={g}>
					{t(GROUP_KEYS[g])}
				</option>
			))}
		</Select>
	);
}
