import { RefreshCw, TriangleAlert } from "lucide-react";
import { Component, type ReactNode } from "react";
import { useT } from "../i18n/index.ts";
import { isChunkLoadError, reloadOnce } from "../lib/reload.ts";
import { Button } from "./ui.tsx";

/** What replaces a page (or the whole app) that could not render: a reason in plain words and a way back. */
export function ErrorScreen({ error }: { error: Error }) {
	const t = useT();
	// A lazy chunk that is gone means the tab predates the running build: a reload is the whole fix.
	const stale = isChunkLoadError(error);
	return (
		<div className="flex h-full min-w-0 flex-1 items-center justify-center p-6" role="alert" data-testid="error-screen">
			<div className="flex max-w-md flex-col items-center gap-3 text-center">
				<TriangleAlert size={28} className="text-warning" />
				<h1 className="text-lg font-semibold">{stale ? t("shell.errorStaleTitle") : t("shell.errorTitle")}</h1>
				<p className="text-sm text-muted">{stale ? t("shell.errorStale") : t("shell.errorGeneric")}</p>
				<Button variant="primary" onClick={() => location.reload()}>
					<RefreshCw size={14} /> {t("shell.errorReload")}
				</Button>
				{stale ? null : (
					<details className="w-full text-left text-xs text-faint">
						<summary className="cursor-pointer text-center">{t("shell.errorDetails")}</summary>
						<pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-bg-soft p-2 font-mono whitespace-pre-wrap">
							{error.message}
						</pre>
					</details>
				)}
			</div>
		</div>
	);
}

/** What stands where one message could not be rendered: the rest of the conversation stays as it is. */
export function MessageFailed({ error }: { error: Error }) {
	const t = useT();
	return (
		<div
			className="rounded-xl border border-dashed border-warning/50 bg-warning/5 px-3 py-2 text-sm text-muted"
			role="note"
			data-testid="message-failed"
		>
			<div className="flex items-center gap-2">
				<TriangleAlert size={15} className="shrink-0 text-warning" aria-hidden />
				{t("chat.messageFailed")}
			</div>
			<details className="mt-1 text-xs text-faint">
				<summary className="cursor-pointer">{t("shell.errorDetails")}</summary>
				<pre className="mt-1 max-h-32 overflow-auto font-mono whitespace-pre-wrap">{error.message}</pre>
			</details>
		</div>
	);
}

interface Props {
	children: ReactNode;
	/** Shown instead of `children` once something below throws; defaults to the Reload screen. */
	fallback?: (error: Error) => ReactNode;
	/** The error clears when this changes (the page was switched, say), so `children` get another try. */
	resetKey?: unknown;
	onError?: (error: Error) => void;
}

interface State {
	error: Error | null;
	resetKey: unknown;
}

/**
 * Without a boundary a render error unmounts the whole React tree and leaves a blank page. A chunk that
 * failed to load also reloads the tab once to fetch the build it belongs to (see `reloadOnce`).
 */
export class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null, resetKey: this.props.resetKey };

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { error };
	}

	static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
		return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
	}

	componentDidCatch(error: Error): void {
		if (isChunkLoadError(error)) reloadOnce();
		this.props.onError?.(error);
	}

	render(): ReactNode {
		const { error } = this.state;
		if (!error) return this.props.children;
		return this.props.fallback ? this.props.fallback(error) : <ErrorScreen error={error} />;
	}
}
