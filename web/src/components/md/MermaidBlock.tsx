import { memo, useEffect, useState, useSyncExternalStore } from "react";
import { useT } from "../../i18n/index.ts";
import { CodeBlock } from "../Markdown.tsx";

/**
 * A ```mermaid block of a previewed Markdown file, drawn as its diagram. Mermaid (`mermaid.ts`) is fetched the first time a
 * block is drawn; until then, and while a diagram being typed is drawn again, the block says so (or keeps the last drawing),
 * and a diagram Mermaid cannot read shows why, with its source.
 */

/** Drawings already made, by theme and source: a preview drawn again (every few keystrokes) does not draw them again. */
const drawn = new Map<string, string>();
const DRAWN_KEPT = 64;
/** How long the source must be still before it is drawn: Mermaid takes tens of milliseconds a diagram. */
const SETTLE_MS = 250;

function subscribeDark(change: () => void): () => void {
	const watch = new MutationObserver(change);
	watch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
	return () => watch.disconnect();
}

/** Whether the page is dark now (`lib/theme.ts` puts `dark` on the root element); follows a change of theme. */
function useDark(): boolean {
	return useSyncExternalStore(
		subscribeDark,
		() => document.documentElement.classList.contains("dark"),
		() => false,
	);
}

type Drawing = { key: string; svg: string } | { key: string; error: string };

export const MermaidBlock = memo(function MermaidBlock({ code }: { code: string }) {
	const t = useT();
	const dark = useDark();
	const key = `${dark ? "d" : "l"}\u0000${code}`;
	const [done, setDone] = useState<Drawing | null>(() => {
		const svg = drawn.get(key);
		return svg === undefined ? null : { key, svg };
	});
	useEffect(() => {
		const cached = drawn.get(key);
		if (cached !== undefined) {
			setDone({ key, svg: cached });
			return;
		}
		let alive = true;
		const timer = setTimeout(() => {
			import("./mermaid.ts")
				.then((m) => m.renderMermaid(code, dark))
				.then(
					(svg) => {
						drawn.set(key, svg);
						const oldest = drawn.size > DRAWN_KEPT ? drawn.keys().next().value : undefined;
						if (oldest !== undefined) drawn.delete(oldest);
						if (alive) setDone({ key, svg });
					},
					(e: unknown) => alive && setDone({ key, error: e instanceof Error ? e.message : String(e) }),
				);
		}, SETTLE_MS);
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [key, code, dark]);

	if (done && "error" in done && done.key === key) {
		return (
			<div className="my-3" data-testid="md-mermaid-error">
				<p className="text-xs text-danger" role="note">
					{t("files.mdDiagramFailed", { reason: done.error.split("\n")[0] ?? "" })}
				</p>
				<CodeBlock code={code} lang="mermaid" />
			</div>
		);
	}
	// The last drawing stays while the next one is made: a diagram being typed does not flash its placeholder.
	if (done && "svg" in done) {
		return (
			<figure
				className="md-mermaid my-3 overflow-x-auto rounded-xl border border-border bg-code p-3"
				aria-label={t("files.mdDiagramLabel")}
				data-testid="md-mermaid"
				data-current={done.key === key ? "" : undefined}
				// biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid's strict output, scrubbed again (`mermaid.ts`)
				dangerouslySetInnerHTML={{ __html: done.svg }}
			/>
		);
	}
	return (
		<div
			className="my-3 rounded-xl border border-border bg-code p-3 text-xs text-muted"
			role="status"
			data-testid="md-mermaid-pending"
		>
			{t("files.mdDiagramPending")}
		</div>
	);
});
