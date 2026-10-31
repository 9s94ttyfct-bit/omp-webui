import type { Element, Nodes } from "hast";

/**
 * The text of a rendered Markdown node (react-markdown's hast), as a screen reader or GitHub's slugger reads it: every text
 * inside it, in order, without the elements `skip` names (a task's nested list: it is another task's text).
 */
export function hastText(node: Nodes, skip: readonly string[] = []): string {
	if (node.type === "text") return node.value;
	if (node.type !== "element" && node.type !== "root") return "";
	if (node.type === "element" && skip.includes((node as Element).tagName)) return "";
	let out = "";
	for (const child of node.children) out += hastText(child as Nodes, skip);
	return out;
}
