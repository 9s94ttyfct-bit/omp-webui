import { CircleAlert, RefreshCw } from "lucide-react";
import { useT } from "../i18n/index.ts";
import { Button } from "./ui.tsx";

/**
 * A load that failed: what could not be loaded, the reason the server gave, and a Retry. The caller shows its
 * spinner again while the retry runs, so this never sits next to one.
 */
export function LoadError({ title, error, onRetry }: { title: string; error: string; onRetry: () => void }) {
	const t = useT();
	return (
		<div
			role="alert"
			className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm"
			data-testid="load-error"
		>
			<CircleAlert size={16} className="mt-0.5 shrink-0 text-danger" />
			<div className="min-w-0 flex-1">
				<div className="font-medium text-danger">{title}</div>
				<div className="mt-0.5 break-words text-xs text-muted">{error}</div>
			</div>
			<Button size="sm" onClick={onRetry} data-testid="load-retry">
				<RefreshCw size={13} /> {t("common.retry")}
			</Button>
		</div>
	);
}
