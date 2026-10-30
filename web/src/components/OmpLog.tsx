import { useEffect, useRef } from "react";
import { logLines } from "../store/omp.ts";
import { cx } from "./ui.tsx";

/**
 * The output of an install or update as a terminal shows it, following the end while it grows. `label` names the
 * region for assistive technology; `empty` is shown until the first line.
 */
export function OmpLog({
	log,
	label,
	empty,
	className,
	testid,
}: {
	log: string;
	label: string;
	empty?: string;
	className?: string;
	testid?: string;
}) {
	const ref = useRef<HTMLPreElement>(null);
	const lines = logLines(log);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `log` is what moves the end.
	useEffect(() => {
		const el = ref.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [log]);
	return (
		<pre
			ref={ref}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard to be read (axe: scrollable-region-focusable).
			tabIndex={0}
			role="log"
			aria-label={label}
			data-testid={testid}
			className={cx(
				"max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-bg-soft p-2.5 font-mono text-xs leading-relaxed text-fg",
				className,
			)}
		>
			{lines.length ? lines.join("\n") : <span className="text-muted">{empty}</span>}
		</pre>
	);
}
