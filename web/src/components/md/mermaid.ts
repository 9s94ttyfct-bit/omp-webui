import mermaid from "mermaid";

/**
 * Mermaid, for the diagrams of the Markdown editor's preview (`MermaidBlock.tsx`): a chunk of its own, fetched when a file
 * with a `mermaid` block is first previewed, never with the page or the editor.
 *
 * It runs at Mermaid's `strict` security level: the text of a diagram is encoded, its click handlers and links are off, and
 * what it draws passes through Mermaid's own sanitiser. What comes back is scrubbed once more here before it is put in the
 * page (`scrub`), so that a diagram never carries a script, an event handler or a link out of the page whatever Mermaid lets
 * through. The page's Content-Security-Policy (`server/csp.ts`: no inline scripts, images from the page only) holds under all of it.
 */

let initialized: "dark" | "default" | null = null;
let count = 0;

function setup(theme: "dark" | "default"): void {
	if (initialized === theme) return;
	mermaid.initialize({
		startOnLoad: false,
		securityLevel: "strict",
		theme,
		// An error is the block's to say, in the page's words: Mermaid draws no error diagram of its own.
		suppressErrorRendering: true,
		fontFamily: "inherit",
	});
	initialized = theme;
}

/** Elements a diagram never needs, whatever a sanitiser upstream let through. */
const DROP = "script, iframe, object, embed, link, meta, base, form, input, button, textarea, select, audio, video";
/** A CSS `url()` that names something other than an element of the diagram (`url(#arrowhead)`), or an `@import`. */
const FETCHES = /url\s*\(\s*['"]?\s*(?!#)|@import|expression\s*\(/i;

/** Remove from `root` what could run code or reach outside the page: the elements above, event handlers, and links that are not anchors within it. */
export function scrub(root: Element): void {
	for (const el of root.querySelectorAll(DROP)) el.remove();
	for (const el of [root, ...root.querySelectorAll("*")]) {
		for (const attr of [...el.attributes]) {
			const name = attr.name.toLowerCase();
			const value = attr.value.trim().toLowerCase();
			if (name.startsWith("on")) el.removeAttribute(attr.name);
			else if ((name === "href" || name === "xlink:href" || name === "src") && !value.startsWith("#"))
				el.removeAttribute(attr.name);
			else if (name === "style" && FETCHES.test(value)) el.removeAttribute(attr.name);
		}
	}
	// A <style> of the diagram (its colours) may only style it: nothing it names is fetched.
	for (const style of root.querySelectorAll("style")) {
		if (FETCHES.test(style.textContent ?? "")) style.remove();
	}
}

/** The SVG markup of the diagram `code`, scrubbed, in the page's light or dark. Throws Mermaid's error for a diagram it cannot read. */
export async function renderMermaid(code: string, dark: boolean): Promise<string> {
	setup(dark ? "dark" : "default");
	count += 1;
	const { svg } = await mermaid.render(`md-mermaid-${count}`, code);
	// Parsed as HTML (Mermaid's labels are HTML in a foreignObject, which an XML parser may refuse), scrubbed, written back.
	const doc = new DOMParser().parseFromString(`<div>${svg}</div>`, "text/html");
	const box = doc.body.firstElementChild;
	if (!box) return "";
	scrub(box);
	return box.innerHTML;
}
