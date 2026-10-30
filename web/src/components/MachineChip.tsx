import { lazy, Suspense } from "react";
import { useApp } from "../store/app.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

/**
 * The switcher itself (the menu, the dialog that adds a Mac, the strings) is a chunk of its own, fetched only once a Mac is
 * saved: a page of a computer that has none carries this wrapper and nothing else. A chunk that cannot be fetched is no switcher,
 * and the sidebar goes on without it.
 */
const Switcher = lazy(() => import("./MachineSwitcher.tsx").catch(() => ({ default: () => <></> })));

/** The room the row takes while its chunk loads, as high as the row: the list below it does not move when it arrives. */
const Placeholder = () => (
	<div className="px-3 pt-2" aria-hidden>
		<div className="h-8" />
	</div>
);

/**
 * A page in a window of the macOS app onto another Mac (a remote window) has the shell's window bridge and not the Macs bridge:
 * that window cannot open a Mac, and the browser's way (a new tab) is cancelled there, so a choice would do nothing. The row is
 * left out of it. (A page in a browser has neither bridge, the app's own window has both.)
 */
const inRemoteWindow = (): boolean => {
	const handlers = window.webkit?.messageHandlers;
	return handlers?.ompwWindow !== undefined && handlers.ompwMacs === undefined;
};

/**
 * The machine switcher under the New chat button (#628): this Mac, or another Mac the server has saved to open. It is
 * there only once a Mac is saved, and not in a remote window's page.
 */
export function MachineChip() {
	const saved = useApp((s) => (s.meta?.macs?.length ?? 0) > 0);
	if (!saved || inRemoteWindow()) return null;
	return (
		<ErrorBoundary fallback={() => null}>
			<Suspense fallback={<Placeholder />}>
				<Switcher />
			</Suspense>
		</ErrorBoundary>
	);
}
