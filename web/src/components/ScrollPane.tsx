import type { HTMLAttributes } from "react";
import { useScrolls } from "../lib/scrolls.ts";

/**
 * The scrolling body of a panel tab: while its content is taller than the pane it is a stop of the Tab key, so the
 * keyboard can scroll it (a pane of text only, such as Info, has nothing else to take the focus); otherwise it is none.
 */
export function ScrollPane(props: HTMLAttributes<HTMLDivElement>) {
	const [ref, scrolls] = useScrolls<HTMLDivElement>();
	return <div ref={ref} tabIndex={scrolls ? 0 : undefined} {...props} />;
}
