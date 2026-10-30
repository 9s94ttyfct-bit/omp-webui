import { useT } from "../i18n/index.ts";
import { type NavGroup as Group, type NavSurface, navItemsIn, useNavLayout } from "../lib/nav-layout.ts";
import { useApp } from "../store/app.ts";
import { startNavPress } from "./nav-press.ts";
import { cx, IconButton } from "./ui.tsx";

/**
 * The pages a bar offers (#654), drawn from the one `NAV_ITEMS` model and placed by the person's layout: the group's items
 * in their order, the current page marked (`aria-current`). The sidebar, the rail and the palette's *Go to* all read the
 * same list, so they cannot drift apart.
 *
 * This is a chunk of its own (`NavDock.tsx` fetches it as the page starts): the model, the icons and the drag's first
 * step are not what the first paint is made of. Every item says what it is (`data-nav-item`, `data-nav-surface`,
 * `data-nav-group`) and starts a drag when pressed (`nav-press.ts`); what a drag shows is drawn from attributes by
 * `index.css`, so nothing here renders for a pointer move. A group with nothing in it is an empty box that shows only while
 * something is dragged, as a place to drop on; the group `hidden` is the zone that takes an item off the bar.
 */

export interface NavGroupProps {
	/** Labelled rows (the sidebar), or icon buttons (the rail). */
	variant: "rows" | "icons";
	surface: NavSurface;
	group: Group;
	/** This page is not on this computer: the items that are a setting of this Mac are left out (the guard). */
	remote: boolean;
}

/** A group of the sidebar: one labelled row per item, as the pages' entries always were. */
function Rows({ surface, group, remote }: Omit<NavGroupProps, "variant">) {
	const t = useT();
	const view = useApp((s) => s.view);
	const setView = useApp((s) => s.setView);
	const items = navItemsIn(useNavLayout(), surface, group, { remote });
	return (
		<div
			className="space-y-0.5"
			data-nav-group-box={group}
			data-nav-surface={surface}
			data-hint={t("shell.navDropHere")}
			data-testid={`nav-group-${surface}-${group}`}
		>
			{items.map((item) => (
				<button
					key={item.id}
					type="button"
					aria-current={view.kind === item.id ? "page" : undefined}
					data-nav-item={item.id}
					data-nav-group={group}
					data-nav-surface={surface}
					data-testid={`nav-${item.id}`}
					// `touch-none`: a finger moving on a row is a drag (pointer events the page hears), not a scroll of the list.
					className={cx(
						"flex w-full touch-none select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm",
						view.kind === item.id ? "bg-hover text-fg" : "text-muted hover:bg-hover hover:text-fg",
					)}
					onPointerDown={startNavPress}
					onClick={() => setView({ kind: item.id } as never)}
				>
					<item.icon size={16} /> {t(item.labelKey)}
				</button>
			))}
		</div>
	);
}

/** A group of the rail: one icon button per item, its name a tooltip and its `aria-label`. */
function Icons({ surface, group, remote }: Omit<NavGroupProps, "variant">) {
	const t = useT();
	const view = useApp((s) => s.view);
	const setView = useApp((s) => s.setView);
	const items = navItemsIn(useNavLayout(), surface, group, { remote });
	return (
		<div
			className="flex flex-col items-center gap-1"
			data-nav-group-box={group}
			data-nav-surface={surface}
			data-hint="+"
			data-testid={`nav-group-${surface}-${group}`}
		>
			{items.map((item) => (
				<span
					key={item.id}
					className="relative touch-none rounded-lg"
					data-nav-item={item.id}
					data-nav-group={group}
					data-nav-surface={surface}
					onPointerDown={startNavPress}
				>
					<IconButton
						label={t(item.labelKey)}
						active={view.kind === item.id}
						aria-current={view.kind === item.id ? "page" : undefined}
						data-testid={`rail-${item.id}`}
						onClick={() => setView({ kind: item.id } as never)}
					>
						<item.icon size={16} />
					</IconButton>
				</span>
			))}
		</div>
	);
}

/** Where an item dragged out of a bar is dropped to take it off: shown only while something is dragged (`index.css`). */
function HideZone({ variant, surface }: Pick<NavGroupProps, "variant" | "surface">) {
	const t = useT();
	const label = t("shell.navDropHide");
	return (
		<div
			aria-hidden
			data-nav-group-box="hidden"
			data-nav-surface={surface}
			data-hint={variant === "icons" ? "×" : label}
			title={label}
			data-testid={`nav-hide-${surface}`}
		/>
	);
}

/** One group of a bar, or (`hidden`) the zone that takes an item off it. */
export function NavGroup(props: NavGroupProps) {
	if (props.group === "hidden") return <HideZone variant={props.variant} surface={props.surface} />;
	return props.variant === "rows" ? <Rows {...props} /> : <Icons {...props} />;
}
