import * as Menu from "@radix-ui/react-dropdown-menu";
import * as Tabs from "@radix-ui/react-tabs";
import { otherPane, type PaneId, type PaneLayout, type PanelTab } from "@shared/panes.ts";
import {
	ArrowDown,
	ArrowLeft,
	ArrowRight,
	ArrowUp,
	PanelBottomClose,
	PanelBottomOpen,
	PanelTopClose,
	PanelTopOpen,
	X,
} from "lucide-react";
import {
	type ComponentType,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { beginTabDrag, useTabDrag } from "../lib/pane-drag.ts";
import {
	chooseSheetTab,
	commitPanes,
	currentPanes,
	MIN_BODY,
	moveAcross,
	moveBy,
	pick,
	ROW_HEIGHT,
	resetSplit,
	setPanes,
	shareBounds,
	sheetTabOf,
	splitOf,
	toggleFold,
	usePanes,
} from "../lib/panel-panes.ts";
import { useFittingTabStrip } from "../lib/tab-strip.ts";
import { ScrollRow } from "./ScrollRow.tsx";
import { cx, IconButton } from "./ui.tsx";

/** One tab of the panel, as a pane's tab row lists it. */
export interface TabDef {
	Icon: ComponentType<{ size?: number; className?: string }>;
	label: string;
	/** Figures after the label (`2/12`), or "". */
	count: string;
	/** The figures are of something at work (subagents running): they are drawn as a badge, so that the tab shows it from where it is. */
	busy?: boolean;
	/** What the tab's tooltip says when it is more than the label (the label and what the figures stand for). */
	title?: string;
}

/** The tabs of the panel by their ids: a row lists the ones the layout puts in it. */
export type TabDefs = Record<PanelTab, TabDef>;

/** The divider's keyboard steps, in px of the panes' height (as the panel width's handle). */
const STEP = 16;
const BIG_STEP = 64;

/** Give a tab's trigger the focus, wherever the layout has put it (a trigger is made again when its tab moves to the other pane). */
const focusTab = (tab: PanelTab) => document.querySelector<HTMLElement>(`[data-pane-tab="${tab}"]`)?.focus();

const MENU_ITEM =
	"flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-hover data-[disabled]:cursor-default data-[disabled]:text-faint";

/**
 * One pane of the side panel: a row of the tabs the layout lists for it and the tab it shows. A tab is in one row only
 * (`PaneLayout.rows`): it is moved by dragging it along its row or onto the other pane's row (`lib/pane-drag.ts`), or from
 * its context menu (right-click, the menu key or Shift+F10), which is the way without a pointer. The pane folds to its row with
 * the button at the end of it. A pane reads its own part of the layout, so changing the other pane or moving the divider does
 * not redraw this one. A sheet shows one pane that lists every tab, top row first, and chooses its tab apart from the layout.
 */
export function Pane({
	pane,
	defs,
	body,
	first,
	sheet = false,
	onClose,
}: {
	pane: PaneId;
	defs: TabDefs;
	/** What the tab shows (the pane gives it the room, and the tab's own scrolling stays inside it). */
	body: (tab: PanelTab) => ReactNode;
	/** The pane at the top of the panel: its row is the chat header's height and ends with the panel's Close button. */
	first: boolean;
	/** A sheet shows one pane that lists every tab: nothing folds, and a tab is not moved. */
	sheet?: boolean;
	/** The panel's Close button, at the end of the first pane's row. */
	onClose?: () => void;
}) {
	const t = useT();
	const rows = usePanes((l) => l.rows);
	const tab = usePanes((l) => (sheet ? sheetTabOf(l) : l.shown[pane]));
	const folded = usePanes((l) => l.collapsed === pane) && !sheet;
	// Folding is for a pane that shares the panel: with the other closed, this one is all there is.
	const foldable = usePanes((l) => l.rows.top.length > 0 && l.rows.bottom.length > 0) && !sheet;
	// A tab dragged over this row is marked in it, and the tab being dragged is dimmed where it is.
	const dropHere = useTabDrag((d) => d?.target?.pane === pane && d.target.marker !== null);
	const dragged = useTabDrag((d) => d?.tab ?? null);
	const strip = useRef<HTMLDivElement>(null);
	const sheetStrip = useRef<HTMLUListElement>(null);
	// The tab whose menu is open, and where it opens (the pointer's place, or the tab's own for the keyboard).
	const [menu, setMenu] = useState<{ tab: PanelTab; x: number; y: number } | null>(null);
	// The tab the keyboard opened a menu on, which gets the focus back when the menu closes without choosing.
	const focusBack = useRef<PanelTab | null>(null);
	const row = sheet ? [...rows.top, ...rows.bottom] : rows[pane];
	// Every label while they fit; only the active one (inactive tabs show their icon and count) when they do not. A sheet
	// names every tab, whatever their number, and scrolls (see the strip below).
	useFittingTabStrip(
		sheet ? sheetStrip : strip,
		tab ?? "",
		row.map((id) => `${defs[id].label}|${defs[id].count}`).join(","),
		!sheet,
	);
	if (tab === null) return null;
	const FoldIcon =
		pane === "top" ? (folded ? PanelTopOpen : PanelTopClose) : folded ? PanelBottomOpen : PanelBottomClose;
	// Picking a tab shows it where it is picked; in a folded pane it is the tab that is already shown that is picked again. A
	// sheet shows its own choice and leaves the layout alone.
	const show = (id: PanelTab) => (sheet ? chooseSheetTab(id) : setPanes(pick(currentPanes(), id)));
	const openMenu = (id: PanelTab, x: number, y: number, viaKeyboard: boolean) => {
		focusBack.current = viaKeyboard ? id : null;
		setMenu({ tab: id, x, y });
	};
	const move = (id: PanelTab, to: (l: PaneLayout) => PaneLayout) => {
		setPanes(to(currentPanes()));
		// The tab's trigger is moved or made again by the layout; once it is there it has the focus, and the menu has closed.
		setTimeout(() => focusTab(id), 0);
	};
	const at = menu ? row.indexOf(menu.tab) : -1;
	const across = otherPane(pane);
	const triggers = row.map((id) => {
		const { Icon, label, count, busy, title } = defs[id];
		// A space between the words, for the name the text makes: "Agents 3", not "Agents3". Work in progress is a badge.
		const figures = count ? (
			<span className="tabular-nums">
				{" "}
				{busy ? <span className="rounded-full bg-accent px-1.5 text-accent-fg">{count}</span> : count}
			</span>
		) : null;
		return (
			<Tabs.Trigger
				key={id}
				value={id}
				data-testid={`pane-tab-${id}`}
				data-pane-tab={id}
				data-dragging={dragged === id || undefined}
				aria-label={count ? `${label} ${count}` : label}
				title={title ?? label}
				onClick={() => folded && show(id)}
				onPointerDown={sheet ? undefined : (e) => beginTabDrag(e, id)}
				onContextMenu={
					sheet
						? undefined
						: (e) => {
								e.preventDefault();
								// A menu the keyboard asked for (no pointer, so no place) opens at the tab.
								if (e.clientX === 0 && e.clientY === 0) {
									const box = e.currentTarget.getBoundingClientRect();
									openMenu(id, box.left, box.bottom, true);
								} else openMenu(id, e.clientX, e.clientY, false);
							}
				}
				onKeyDown={
					sheet
						? undefined
						: (e: KeyboardEvent<HTMLButtonElement>) => {
								// The menu key, or Shift+F10: the tab's menu, opened at the tab.
								if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
								e.preventDefault();
								const box = e.currentTarget.getBoundingClientRect();
								openMenu(id, box.left, box.bottom, true);
							}
				}
				className={cx(
					"group/tab shrink-0 whitespace-nowrap rounded-md text-xs text-muted hover:bg-hover hover:text-fg data-[dragging]:opacity-40 data-[state=active]:bg-hover data-[state=active]:text-fg",
					sheet
						? // The icon above its name, a tab to a tap: a row of thirteen bare icons left a phone guessing.
							"flex min-w-12 flex-col items-center gap-0.5 px-1.5 py-1"
						: // A press on a tab is also the start of a drag: no scrolling or selecting takes it over.
							"inline-flex touch-none select-none items-center gap-1 px-1.5 py-1 group-data-[compact]/list:min-w-6 group-data-[compact]/list:justify-center group-data-[compact]/list:gap-0.5 group-data-[compact]/list:px-0.5",
				)}
			>
				{sheet ? (
					<>
						<Icon size={16} className="shrink-0" />
						<span>
							{label}
							{figures}
						</span>
					</>
				) : (
					<>
						<Icon size={13} className="shrink-0" />
						<span className="group-data-[compact]/list:group-data-[state=inactive]/tab:hidden group-data-[compact=icons]/list:hidden">
							{label}
						</span>
						{figures}
					</>
				)}
			</Tabs.Trigger>
		);
	});
	return (
		<section
			className="flex min-h-0 flex-1 flex-col"
			aria-label={sheet ? undefined : t(pane === "top" ? "panel.paneTop" : "panel.paneBottom")}
			data-testid={`panel-pane-${pane}`}
			data-collapsed={folded}
			data-tab={tab}
		>
			<Tabs.Root value={tab} onValueChange={(v) => show(v as PanelTab)} className="flex min-h-0 flex-1 flex-col">
				<div
					className={cx(
						"flex shrink-0 items-center gap-0.5 px-1 data-[drop]:bg-accent-soft",
						first ? "h-13" : "h-10",
						!folded && "border-b border-border",
					)}
					data-testid={pane === "top" ? "right-panel-tabs" : "right-panel-tabs-bottom"}
					data-pane-row={sheet ? undefined : pane}
					data-drop={dropHere || undefined}
				>
					{/* One line at any width. Beside the conversation the strip shrinks the inactive tabs to icons when the labels
					    do not fit, the active one too when that is still too wide, and scrolls sideways (wheel included) only
					    when even that is too wide (see `useFittingTabStrip`). In compact mode every tab keeps a 24 px square (the
					    tap target) and `px-0.5`, so that every tab fits the panel's default width. A sheet lists every tab, more
					    than a phone's width holds: each is named, and the row scrolls, with the edge that has more of it faded
					    and an arrow (`ScrollRow`). The padding keeps focus rings from being clipped. */}
					{sheet ? (
						<Tabs.List asChild>
							<ScrollRow
								ref={sheetStrip}
								fade="from-bg-soft"
								wrapperClassName="-m-1 flex-1"
								className="flex gap-0.5 overflow-x-auto p-1 [scrollbar-width:none]"
								aria-label={t("panel.rightTabsAria")}
							>
								{triggers}
							</ScrollRow>
						</Tabs.List>
					) : (
						<Tabs.List
							ref={strip}
							className="group/list -m-1 flex min-w-0 flex-1 gap-0.5 overflow-x-auto p-1 [scrollbar-width:none] data-[compact]:gap-0"
							aria-label={t(pane === "top" ? "panel.paneTabsTop" : "panel.paneTabsBottom")}
						>
							{triggers}
						</Tabs.List>
					)}
					{foldable ? (
						<IconButton
							label={
								folded
									? t(pane === "top" ? "panel.paneExpandTop" : "panel.paneExpandBottom")
									: t(pane === "top" ? "panel.paneCollapseTop" : "panel.paneCollapseBottom")
							}
							size="sm"
							aria-expanded={!folded}
							data-testid={`pane-fold-${pane}`}
							onClick={() => setPanes(toggleFold(currentPanes(), pane))}
						>
							<FoldIcon size={15} />
						</IconButton>
					) : null}
					{first && onClose ? (
						<IconButton label={t("panel.rightClose")} size="sm" data-testid="right-panel-close" onClick={onClose}>
							<X size={15} />
						</IconButton>
					) : null}
				</div>
				{/* Not a scroller itself: a tab scrolls its own part (the Agents list and the live view of one agent each do), so
				    that its header and steer box stay put. A folded pane keeps its (empty, hidden) tabpanel, so that the tab that is
				    selected still has the element its `aria-controls` names, and draws nothing below its row. */}
				<Tabs.Content
					value={tab}
					forceMount
					hidden={folded}
					className={cx("min-h-0 flex-1 flex-col overflow-hidden", folded ? "hidden" : "flex")}
				>
					{folded ? null : (
						<div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid={`pane-body-${pane}`}>
							{body(tab)}
						</div>
					)}
				</Tabs.Content>
			</Tabs.Root>
			{sheet ? null : (
				<Menu.Root open={menu !== null} onOpenChange={(open) => !open && setMenu(null)}>
					{/* Where the menu opens from: the place of the click or of the tab. Nothing to see, hear or focus. */}
					<Menu.Trigger asChild>
						<span
							aria-hidden
							data-testid="pane-tab-menu-anchor"
							style={{ position: "fixed", left: menu?.x ?? 0, top: menu?.y ?? 0, width: 0, height: 0 }}
						/>
					</Menu.Trigger>
					<Menu.Portal>
						<Menu.Content
							align="start"
							sideOffset={4}
							aria-label={t("panel.tabMenuAria", { tab: menu ? defs[menu.tab].label : "" })}
							data-testid="pane-tab-menu"
							className="z-50 min-w-48 rounded-xl border border-border bg-surface p-1 shadow-2xl"
							onCloseAutoFocus={(e) => {
								// Never the trigger Radix would return to (the anchor): a menu the keyboard opened gives the focus
								// back to the tab, and one of the mouse leaves it where it is.
								e.preventDefault();
								const back = focusBack.current;
								focusBack.current = null;
								if (back !== null) focusTab(back);
							}}
						>
							<Menu.Item
								className={MENU_ITEM}
								data-testid="pane-tab-move-left"
								disabled={at <= 0}
								onSelect={() => menu && move(menu.tab, (l) => moveBy(l, menu.tab, -1))}
							>
								<ArrowLeft size={14} /> {t("panel.tabMoveLeft")}
							</Menu.Item>
							<Menu.Item
								className={MENU_ITEM}
								data-testid="pane-tab-move-right"
								disabled={at < 0 || at >= row.length - 1}
								onSelect={() => menu && move(menu.tab, (l) => moveBy(l, menu.tab, 1))}
							>
								<ArrowRight size={14} /> {t("panel.tabMoveRight")}
							</Menu.Item>
							<Menu.Item
								className={MENU_ITEM}
								data-testid={`pane-tab-move-${across}`}
								disabled={menu === null}
								onSelect={() => menu && move(menu.tab, (l) => moveAcross(l, menu.tab))}
							>
								{across === "top" ? <ArrowUp size={14} /> : <ArrowDown size={14} />}{" "}
								{t(across === "top" ? "panel.tabMoveTop" : "panel.tabMoveBottom")}
							</Menu.Item>
						</Menu.Content>
					</Menu.Portal>
				</Menu.Root>
			)}
		</section>
	);
}

/**
 * The two panes one above the other, with the divider between them. The share the top pane has is remembered; a folded pane
 * is only its row and the other takes the height. A pane with no tab is closed: it is not drawn, the other takes the whole
 * panel, and while a tab is dragged its edge of the panel is a place to drop it on, which opens the pane. Moving the divider
 * redraws this frame, not the panes inside it.
 */
export function PaneSplit({
	defs,
	body,
	onClose,
}: {
	defs: TabDefs;
	body: (tab: PanelTab) => ReactNode;
	onClose: () => void;
}) {
	const share = usePanes(splitOf);
	const folded = usePanes((l) => l.collapsed);
	const topClosed = usePanes((l) => l.rows.top.length === 0);
	const bottomClosed = usePanes((l) => l.rows.bottom.length === 0);
	const dragging = useTabDrag((d) => d !== null);
	const box = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState(0);
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		const measure = () => setHeight(el.clientHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	const open = folded === null && !topClosed && !bottomClosed;
	const bounds = shareBounds(height);
	const drawn = Math.min(bounds.max, Math.max(bounds.min, share));
	const closed: PaneId | null = topClosed ? "top" : bottomClosed ? "bottom" : null;
	// Both frames stay in the tree whichever panes are drawn, so that a pane that stays keeps the state of its tab.
	return (
		<div ref={box} className="relative flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="panel-panes">
			<div
				className={
					topClosed ? "hidden" : cx("flex min-h-0 flex-col", folded === "top" ? "shrink-0" : open ? "shrink" : "flex-1")
				}
				style={open ? { flexBasis: `${drawn * 100}%`, flexGrow: 0, minHeight: ROW_HEIGHT.top + MIN_BODY } : undefined}
			>
				{topClosed ? null : <Pane pane="top" defs={defs} body={body} first onClose={onClose} />}
			</div>
			<div
				className={
					bottomClosed
						? "hidden"
						: cx(
								"relative flex min-h-0 flex-col",
								!topClosed && "border-t border-border",
								folded === "bottom" ? "shrink-0" : "flex-1",
							)
				}
				style={open ? { minHeight: ROW_HEIGHT.bottom + MIN_BODY } : undefined}
			>
				{open ? <PaneDivider box={box} drawn={drawn} bounds={bounds} /> : null}
				{bottomClosed ? null : <Pane pane="bottom" defs={defs} body={body} first={topClosed} onClose={onClose} />}
			</div>
			{dragging && closed ? <DropZone pane={closed} /> : null}
			<DragLayer defs={defs} />
		</div>
	);
}

/**
 * The edge of a closed pane, drawn while a tab is dragged: dropping the tab on it opens the pane with that tab. The top
 * pane's is the strip along the top edge of the panel, above where the tabs of the pane below are (a drop reaches it from
 * anywhere above); the bottom pane's is a band along the bottom edge. The page reads its box for the drop (`data-pane-zone`).
 */
function DropZone({ pane }: { pane: PaneId }) {
	const t = useT();
	const over = useTabDrag((d) => d?.target?.pane === pane && d.target.marker === null);
	return (
		<div
			aria-hidden
			data-pane-zone={pane}
			data-testid={`pane-drop-zone-${pane}`}
			data-over={over || undefined}
			className={cx(
				"pointer-events-none absolute inset-x-1 z-20 flex items-center justify-center rounded-md border border-dashed border-accent bg-bg-soft/90 text-xs leading-none text-accent data-[over]:bg-accent-soft",
				pane === "top" ? "top-0 h-3.5" : "bottom-1 h-10",
			)}
		>
			{t(pane === "top" ? "panel.dropOpenTop" : "panel.dropOpenBottom")}
		</div>
	);
}

/** What follows the pointer while a tab is dragged: the tab's name beside it, and the line where a drop would put it between two tabs. */
function DragLayer({ defs }: { defs: TabDefs }) {
	const drag = useTabDrag((d) => d);
	if (!drag) return null;
	const { Icon, label } = defs[drag.tab];
	const marker = drag.target?.marker;
	return createPortal(
		<>
			<div
				aria-hidden
				data-testid="pane-drag-ghost"
				className="pointer-events-none fixed z-50 flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg shadow-lg"
				style={{ left: drag.x + 12, top: drag.y + 12 }}
			>
				<Icon size={13} className="shrink-0" /> {label}
			</div>
			{marker ? (
				<div
					aria-hidden
					data-testid="pane-drop-marker"
					className="pointer-events-none fixed z-50 w-0.5 rounded-full bg-accent"
					style={{ left: marker.x - 1, top: marker.top, height: marker.bottom - marker.top }}
				/>
			) : null}
		</>,
		document.body,
	);
}

/**
 * The divider between the panes: a focusable horizontal separator whose value is the top pane's share of the height, in
 * percent. Pointer drag, the arrow keys (Shift: bigger steps; Home/End: the bounds), double-click or Enter for the default
 * position. Down is the way the top pane grows.
 */
function PaneDivider({
	box,
	drawn,
	bounds,
}: {
	box: React.RefObject<HTMLDivElement | null>;
	drawn: number;
	bounds: { min: number; max: number };
}) {
	const t = useT();
	const drag = useRef<{ y: number; share: number; height: number; moved: boolean } | null>(null);
	const [dragging, setDragging] = useState(false);

	/** Draw `share` of `height` for the top pane, inside the bounds; `persist: false` while a drag is on its way. */
	const move = (share: number, height: number, persist = true) => {
		const { min, max } = shareBounds(height);
		const next = Math.round(Math.min(max, Math.max(min, share)) * 10000) / 10000;
		setPanes({ ...currentPanes(), split: next }, persist);
	};
	const heightNow = () => box.current?.clientHeight ?? 0;
	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		// No text selection while dragging.
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		drag.current = { y: e.clientY, share: drawn, height: heightNow(), moved: false };
		setDragging(true);
	};
	const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
		const start = drag.current;
		// Drawn as it goes; kept once, where the drag ends.
		if (!start || start.height <= 0) return;
		start.moved = true;
		move(start.share + (e.clientY - start.y) / start.height, start.height, false);
	};
	const endDrag = () => {
		if (drag.current?.moved) commitPanes();
		drag.current = null;
		setDragging(false);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const height = heightNow();
		if (height <= 0) return;
		const step = (e.shiftKey ? BIG_STEP : STEP) / height;
		let next: number | null = null;
		if (e.key === "ArrowDown") next = drawn + step;
		else if (e.key === "ArrowUp") next = drawn - step;
		else if (e.key === "Home") next = bounds.min;
		else if (e.key === "End") next = bounds.max;
		else if (e.key === "Enter") {
			e.preventDefault();
			resetSplit();
			return;
		}
		if (next === null) return;
		e.preventDefault();
		move(next, height);
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: a focusable separator with a value (WAI-ARIA window splitter) is not an <hr>
		<div
			role="separator"
			aria-orientation="horizontal"
			aria-label={t("panel.resizePanes")}
			aria-valuenow={Math.round(drawn * 100)}
			aria-valuemin={Math.round(bounds.min * 100)}
			aria-valuemax={Math.round(bounds.max * 100)}
			tabIndex={0}
			title={t("shell.resizeHint")}
			data-testid="resize-panes"
			data-dragging={dragging ? "true" : undefined}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={endDrag}
			onPointerCancel={endDrag}
			onLostPointerCapture={endDrag}
			onDoubleClick={resetSplit}
			onKeyDown={onKeyDown}
			// The line and grip come from `.resize-handle` (index.css), shared with every palette; centred on the seam's rule. It
			// starts where the panel's own width handle (6 px on its left edge) ends, so that one stays reachable at any height.
			className="resize-handle absolute left-1.5 right-0 -top-[3px] z-10 h-1.5 cursor-row-resize touch-none outline-none"
		/>
	);
}
