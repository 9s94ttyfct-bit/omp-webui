import "katex/dist/katex.min.css";
import rehypeKatex, { type Options } from "rehype-katex";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";

/**
 * Math for the Markdown editor's preview (`$…$` inline, `$$…$$` as a block), typeset by KaTeX: a chunk of its own, with
 * KaTeX's stylesheet and fonts, fetched when a previewed text first has a `$` in it.
 *
 * KaTeX runs untrusted: `\href`, `\url`, `\includegraphics` and the HTML extensions are refused (`trust: false`), a formula
 * it cannot read is shown in red as written (rehype-katex's own handling), and macros cannot expand without end (`maxExpand`).
 */

const katex: Options = {
	trust: false,
	strict: "ignore",
	maxExpand: 1000,
	maxSize: 50,
};

export const mathRemark: PluggableList = [remarkMath];
export const mathRehype: PluggableList = [[rehypeKatex, katex]];
