import { lazy, memo, Suspense } from "react";
import type { TurnSource } from "../changes/ChangesView.tsx";
import { Spinner } from "../ui.tsx";

/** The tab's code is loaded when the tab is first shown: nothing of it is on the way to the first paint. */
const FilesPane = lazy(() => import("./FilesPane.tsx"));

/**
 * The side panel's Files tab. It is given the two ids that name the conversation, and a way to ask what its turns changed (a
 * function that never changes, so that the panel's own redraws, which every streamed token causes, do not reach the tab).
 */
export const FilesTab = memo(function FilesTab({
	liveId,
	file,
	getTurns,
}: {
	liveId: string | null;
	file: string | null;
	getTurns: () => TurnSource;
}) {
	return (
		<Suspense
			fallback={
				<div className="flex flex-1 items-center justify-center">
					<Spinner />
				</div>
			}
		>
			<FilesPane liveId={liveId} file={file} getTurns={getTurns} />
		</Suspense>
	);
});
