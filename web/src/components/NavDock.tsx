import { Suspense } from "react";
import { lazyChunk } from "../lib/lazy-chunk.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import type { NavGroupProps } from "./NavLinks.tsx";

/**
 * The pages of the sidebar and the rail (#654) are a chunk of their own: the model of what each bar offers, its icons and
 * the first step of a drag are not what the first paint is made of, and this page is. The chunk is asked for as the page
 * starts (the footer's other lines, the versions and the host's load, arrive the same way). Until it is there, the group
 * holds the room its rows will take (`Reserve`), so that nothing on the page moves when they arrive.
 *
 * A chunk that cannot be fetched leaves the bar without its pages instead of putting up the app's Reload screen (the
 * sidebar and the rail sit outside the page's own boundary): the pages are all one click away in the command palette, and
 * the next time a bar draws them the chunk is asked for again.
 */
const { Chunk, preload, retry } = lazyChunk(() => import("./NavLinks.tsx").then((m) => ({ default: m.NavGroup })));
preload();

/** The pages, as `lib/nav-layout.ts` names them: that module is part of the chunk, so what is needed of it is repeated here. */
const PAGES = ["agents", "usage", "memory", "cli", "settings", "guard"];
const GROUPS = ["top", "bottom", "hidden"];

/**
 * How many rows a group shows: what the stored layout (localStorage, read at once) puts in it, less the Guard for a page
 * that is not this computer's. A page the stored copy does not name is at the bottom, as `parseNavLayout` puts it.
 */
function shown({ surface, group, remote }: NavGroupProps): number {
	let stored: Record<string, unknown> | undefined;
	try {
		stored = JSON.parse(localStorage.getItem("ompw.navLayout") ?? "null")?.[surface];
	} catch {
		// A copy that is not JSON is the default layout.
	}
	const seen = new Set<string>();
	const counts = (id: string) => PAGES.includes(id) && !seen.has(id) && (seen.add(id), !(remote && id === "guard"));
	let n = 0;
	for (const g of GROUPS) {
		const list = stored?.[g];
		if (Array.isArray(list)) for (const id of list) if (counts(id) && g === group) n++;
	}
	if (group === "bottom") for (const id of PAGES) if (counts(id)) n++;
	return n;
}

/** The room the rows of a group take (a row is 36 px with 2 px between, a rail's icon 32 px with 4 px between). */
function Reserve(props: NavGroupProps) {
	const n = shown(props);
	if (!n) return null;
	const [row, gap] = props.variant === "rows" ? [36, 2] : [32, 4];
	return (
		<div
			aria-hidden
			data-reserved="true"
			data-testid={`nav-group-${props.surface}-${props.group}`}
			style={{ height: n * row + (n - 1) * gap }}
		/>
	);
}

export function NavGroup(props: NavGroupProps) {
	return (
		<ErrorBoundary fallback={() => null} onError={retry}>
			<Suspense fallback={props.group === "hidden" ? null : <Reserve {...props} />}>
				<Chunk {...props} />
			</Suspense>
		</ErrorBoundary>
	);
}
