import { ChevronLeft, ChevronRight } from "lucide-react";
import { type HTMLAttributes, type Ref, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { cx } from "./ui.tsx";

/**
 * A row that scrolls sideways (tabs, chips) and shows that it does: where more of it lies beyond an edge, that edge
 * fades out and has an arrow that scrolls it. On a phone a row that is simply cut at the window's edge reads as the
 * whole row, so the items past it went unseen. The arrow sits on a plain area of the row's own background, as wide as
 * the arrow: the fade is beside that area, between the arrow and the items, so that no half-faded label is ever read
 * through the arrow ("‹ls & accounts"). The arrows are for the pointer; the keyboard reaches every item by Tab, so
 * they are out of the Tab order.
 */
export function ScrollRow({
	ref,
	fade = "from-bg",
	wrapperClassName,
	children,
	...rest
}: HTMLAttributes<HTMLUListElement> & {
	ref?: Ref<HTMLUListElement>;
	/** The background the row sits on, as a gradient start (`from-…`): the fade ends in it. */
	fade?: string;
	wrapperClassName?: string;
}) {
	const t = useT();
	const own = useRef<HTMLUListElement | null>(null);
	const [edges, setEdges] = useState({ left: false, right: false });
	const measure = useCallback(() => {
		const el = own.current;
		if (!el) return;
		// A pixel of rounding is not more to see.
		const left = el.scrollLeft > 1;
		const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
		setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
	}, []);
	const setRef = useCallback(
		(el: HTMLUListElement | null) => {
			own.current = el;
			if (typeof ref === "function") ref(el);
			else if (ref) ref.current = el;
		},
		[ref],
	);
	// One observer for the row's life: the row and each item, an item that comes later included (a page's cards).
	useEffect(() => {
		const el = own.current;
		if (!el) return;
		const sizes = new ResizeObserver(measure);
		sizes.observe(el);
		for (const child of el.children) sizes.observe(child);
		const items = new MutationObserver((records) => {
			for (const record of records) {
				for (const node of record.addedNodes) if (node instanceof Element) sizes.observe(node);
				for (const node of record.removedNodes) if (node instanceof Element) sizes.unobserve(node);
			}
			measure();
		});
		items.observe(el, { childList: true });
		return () => {
			sizes.disconnect();
			items.disconnect();
		};
	}, [measure]);
	// Items come and go (a page's cards): measure after each render too.
	useLayoutEffect(measure);
	const scroll = (direction: -1 | 1) => {
		const el = own.current;
		if (el) el.scrollBy({ left: direction * Math.max(80, el.clientWidth * 0.7), behavior: "smooth" });
	};
	// The first 65% of the area is the row's background, not a gradient (31 of its 48 pixels: the arrow is 28 and a few
	// more keep the first faded pixels off it); the rest fades into the items.
	const arrow = "absolute inset-y-0 flex w-12 items-center pointer-events-none from-65% to-transparent";
	return (
		<div className={cx("relative min-w-0", wrapperClassName)}>
			<ul ref={setRef} onScroll={measure} {...rest}>
				{children}
			</ul>
			{edges.left ? (
				<div className={cx(arrow, "left-0 justify-start bg-linear-to-r", fade)}>
					<button
						type="button"
						tabIndex={-1}
						aria-label={t("common.scrollLeft")}
						data-testid="scroll-row-left"
						onClick={() => scroll(-1)}
						className="pointer-events-auto inline-flex size-7 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-fg"
					>
						<ChevronLeft size={15} />
					</button>
				</div>
			) : null}
			{edges.right ? (
				<div className={cx(arrow, "right-0 justify-end bg-linear-to-l", fade)}>
					<button
						type="button"
						tabIndex={-1}
						aria-label={t("common.scrollRight")}
						data-testid="scroll-row-right"
						onClick={() => scroll(1)}
						className="pointer-events-auto inline-flex size-7 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-fg"
					>
						<ChevronRight size={15} />
					</button>
				</div>
			) : null}
		</div>
	);
}
