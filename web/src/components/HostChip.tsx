import { lazy, Suspense } from "react";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

/**
 * All of the host's load (#613) — the line, its popover, the socket feed, the strings — is a chunk of its own. A chunk that
 * cannot be fetched is no indicator: nothing else depends on it, so it is not allowed to take the page down with it.
 */
const Indicator = lazy(() => import("./HostIndicator.tsx").catch(() => ({ default: () => <></> })));

/**
 * The host's load in the sidebar's footer (`line`) and in the rail that stays when the sidebar is put away (`rail`). The chunk
 * is fetched once this is on screen, so the first page carries this much and no more; like the footer's other lines (the
 * versions, an update, remote access) the indicator appears when it is ready. The sidebar and the rail sit outside the
 * page's own boundary, so an indicator that fails to render is dropped here instead of putting up the app's Reload screen.
 */
export function HostChip({ variant }: { variant: "line" | "rail" }) {
	return (
		<ErrorBoundary fallback={() => null}>
			<Suspense fallback={null}>
				<Indicator variant={variant} />
			</Suspense>
		</ErrorBoundary>
	);
}
