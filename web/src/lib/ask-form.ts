import type { LiveState } from "../store/live.ts";

/**
 * omp's `ask` tool hands the model's question to the person as one HTML `<form>`. A host with a form surface (omp's own
 * TUI) draws it whole; over RPC omp has none to offer, so it asks the form's named fields one at a time, as plain `input`,
 * `editor` and `select` dialogs titled with each field's label (`tools/ask.ts`, `askFieldByField`). What the form says
 * around its fields (the paragraphs, the list of steps, the command to run, a table of findings) is in none of those
 * dialogs. The page reads it from the running `ask` call's own arguments and shows it with each of them.
 */

/** One block of what a form says around its fields; `id` is its place in the form. */
export interface FormBlock {
	id: number;
	kind: "text" | "item" | "code";
	text: string;
}

/** What a form's question asks with: the parts omp turns into dialogs, which the dialog itself shows. */
const FIELD_PARTS = "label, input, select, textarea, button, legend, option, script, style, template";
/** Elements read as a block of their own (anything else is read through, for the blocks inside it). */
const BLOCKS = new Set([
	"P",
	"LI",
	"PRE",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"TR",
	"BLOCKQUOTE",
	"DT",
	"DD",
	"FIGCAPTION",
]);

const squeeze = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The blocks of `html`'s first form, in order, as plain text (no markup reaches the page). Null when there is none, or
 * nothing but fields. The HTML is parsed into a document that runs nothing and loads nothing (`DOMParser`).
 */
export function formContext(html: string): FormBlock[] | null {
	if (typeof DOMParser === "undefined") return null;
	const doc = new DOMParser().parseFromString(html, "text/html");
	const root = doc.querySelector("form") ?? doc.body;
	for (const el of root.querySelectorAll(FIELD_PARTS)) el.remove();
	const blocks: FormBlock[] = [];
	const walk = (el: Element) => {
		if (BLOCKS.has(el.tagName)) {
			if (el.tagName === "PRE") {
				const text = (el.textContent ?? "").replace(/^\n+|\s+$/g, "");
				if (text) blocks.push({ id: blocks.length, kind: "code", text });
				return;
			}
			const text =
				el.tagName === "TR"
					? [...el.children]
							.map((cell) => squeeze(cell.textContent ?? ""))
							.filter(Boolean)
							.join(" · ")
					: squeeze(el.textContent ?? "");
			if (text) blocks.push({ id: blocks.length, kind: el.tagName === "LI" ? "item" : "text", text });
			return;
		}
		// Text written straight in a container (a `<div>` with no `<p>`) is a block too.
		let loose = "";
		const flush = () => {
			const text = squeeze(loose);
			if (text) blocks.push({ id: blocks.length, kind: "text", text });
			loose = "";
		};
		for (const node of el.childNodes) {
			if (node.nodeType === node.TEXT_NODE) loose += node.textContent ?? "";
			else if (node.nodeType === node.ELEMENT_NODE) {
				const child = node as Element;
				if (BLOCKS.has(child.tagName) || child.querySelector([...BLOCKS].join(","))) {
					flush();
					walk(child);
				} else loose += ` ${child.textContent ?? ""} `;
			}
		}
		flush();
	};
	walk(root);
	return blocks.length > 0 ? blocks : null;
}

/** The form of the `ask` call that is running in `live` (its newest), or null: a dialog then is not one of its fields. */
export function runningAskForm(live: LiveState): string | null {
	let html: string | null = null;
	for (const tool of Object.values(live.tools)) {
		if (tool.toolName !== "ask" || tool.done) continue;
		const args = tool.args as { html?: unknown } | undefined;
		if (typeof args?.html === "string") html = args.html;
	}
	return html;
}
