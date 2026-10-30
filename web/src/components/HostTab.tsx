import { Suspense } from "react";
import { useT } from "../i18n/index.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { HostPaneChunk, retryHostPane } from "./HostIndicator.tsx";
import { Spinner } from "./ui.tsx";

/**
 * The side panel's Host tab (#613): the host's load in full, in the panel's own scroll. The pane of graphs is the chunk the
 * sidebar's popover opens (`HostIndicator`, which the sidebar has loaded already): nothing of it, nor of the chart library, is
 * fetched until a tab or a popover shows it.
 */
export function HostTab() {
	const t = useT();
	return (
		<div className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="host-tab">
			<ErrorBoundary
				onError={retryHostPane}
				fallback={() => <p className="text-xs text-muted">{t("shell.errorGeneric")}</p>}
			>
				<Suspense
					fallback={
						<div className="flex justify-center py-10">
							<Spinner />
						</div>
					}
				>
					<HostPaneChunk />
				</Suspense>
			</ErrorBoundary>
		</div>
	);
}
