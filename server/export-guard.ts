/**
 * The script an exported conversation carries (see `export-harden.ts`). `omp --export` writes one HTML file whose own
 * script turns the saved entries into DOM when the file is opened, and it passes the model's Markdown through `marked`
 * with raw HTML left in: a reply with `<img onerror=…>` ran script in the opened file, and `![x](https://…)` fetched.
 * This runs first in the file and makes that inert in three ways: `marked` shows raw HTML as text and refuses every
 * link and image address but the safe ones; everything the page parses into its document (`innerHTML`,
 * `insertAdjacentHTML`, `outerHTML`, `createContextualFragment`) goes through an allow-list sanitiser that adopts the
 * clean nodes instead of serialising them again; and the page's own inline `onclick` toggles become a data attribute
 * handled by one listener, because the file's policy allows no inline handlers. A released omp (18.14 and later) loads
 * its viewer from outside the file and the viewer parses its own shell into the page and renders Markdown with its own
 * fork of `marked` (`ompMarkdown`): the shell's tags are allowed, and the fork is hardened as `marked` is.
 *
 * `exportGuard` is sent to the page as its source text (`Function.prototype.toString`), so it must stay one
 * self-contained function: it may name only its own locals and the browser's globals.
 */
export function exportGuard(): void {
	/** A lookup table of the names in `words`. */
	const table = (words: string): Record<string, true> =>
		Object.fromEntries(words.split(" ").map((word) => [word, true] as const));
	/**
	 * Tags that may stay. Anything else is unwrapped (its children stay) unless it is in `DROP`. The landmarks, the theme
	 * `select` and `omp-session-trace` are the shell a released omp's viewer (18.14 and later) parses into the page itself.
	 */
	const TAGS = table(
		"a abbr aside b blockquote br button caption code col colgroup dd del details div dl dt em footer h1 h2 h3 h4 h5 h6 " +
			"header hr i img input kbd label li main mark nav ol omp-session-trace omp-tool-view option p pre q s samp " +
			"section select small span strong sub summary sup table tbody td tfoot th thead tr u ul",
	);
	/** Tags removed with everything inside them. */
	const DROP = table(
		"script style iframe frame frameset object embed applet noscript noembed noframes template title textarea " +
			"optgroup math xmp plaintext head meta link base form audio video source track canvas dialog portal " +
			"fencedframe slot",
	);
	/** The only SVG the page draws itself: its icons. */
	const SVG_TAGS = table("svg g path circle ellipse rect line polyline polygon");
	const SVG_ATTRS = table(
		"width height viewbox fill stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit fill-rule clip-rule " +
			"opacity d points cx cy r rx ry x y x1 y1 x2 y2 transform xmlns class aria-hidden role focusable",
	);
	const HTML_NS = "http://www.w3.org/1999/xhtml";
	const SVG_NS = "http://www.w3.org/2000/svg";
	/** Attributes any kept HTML element may have (`data-*` and `aria-*` too). */
	const COMMON_ATTRS = table("class id title role lang dir tabindex hidden");
	const TAG_ATTRS: Record<string, string[]> = {
		a: ["href"],
		img: ["src", "alt", "width", "height"],
		ol: ["start", "type", "reversed"],
		td: ["colspan", "rowspan", "align"],
		th: ["colspan", "rowspan", "align", "scope"],
		col: ["span"],
		colgroup: ["span"],
		input: ["type", "checked", "disabled", "placeholder", "autocomplete", "spellcheck"],
		button: ["type", "disabled"],
		select: ["disabled"],
		option: ["value", "selected"],
		details: ["open"],
		// The file's own tool card: React renders it from the data its `data-key` names, so a `payload` attribute is not kept.
		"omp-tool-view": ["open"],
		"omp-session-trace": ["view"],
	};
	/** The inputs that may stay: the transcript's task boxes and the viewer's search field. */
	const INPUT_TYPES = table("checkbox search");
	const STRIP_URL_CHARS = /[\p{Cc}\p{Cf}\s]/gu;
	const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|svg\+xml)[;,]/i;
	const SAFE_STYLE = /^\s*color\s*:\s*var\(\s*--[a-z0-9-]+\s*\)\s*;?\s*$/i;
	const TOGGLE = /^this\.classList\.toggle\('(expanded|collapsed)'\)$/;
	const OWN_TOGGLE = /onclick="this\.classList\.toggle\('(expanded|collapsed)'\)"/g;

	/** A link address that may be followed: `http(s):`, `mailto:` or an in-page anchor, normalised as the browser reads it. */
	function safeHref(value: string): string | null {
		const url = value.replace(STRIP_URL_CHARS, "");
		if (url.startsWith("#")) return url;
		if (/^mailto:/i.test(url)) return url;
		if (!/^https?:\/\//i.test(url)) return null;
		try {
			return new URL(url).href;
		} catch {
			return null;
		}
	}

	/** An image address that loads nothing from the network: an inline image. */
	function safeSrc(value: string): string | null {
		const url = value.replace(/^[\p{Cc}\s]+/u, "");
		return DATA_IMAGE.test(url) ? url : null;
	}

	function escapeText(text: string): string {
		return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
	}

	function cleanAttributes(el: Element): void {
		const tag = el.localName;
		const svg = el.namespaceURI === SVG_NS;
		const own = Object.hasOwn(TAG_ATTRS, tag) ? TAG_ATTRS[tag] : [];
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase();
			let keep: boolean;
			if (svg) keep = Object.hasOwn(SVG_ATTRS, name);
			else if (name === "style") keep = SAFE_STYLE.test(attr.value);
			else
				keep =
					Object.hasOwn(COMMON_ATTRS, name) ||
					name.startsWith("data-") ||
					name.startsWith("aria-") ||
					own.includes(name);
			if (keep && !svg && name === "href") {
				const href = safeHref(attr.value);
				if (href === null) keep = false;
				else el.setAttribute("href", href);
			}
			if (keep && !svg && name === "src") {
				const src = safeSrc(attr.value);
				if (src === null) keep = false;
			}
			if (keep && !svg && tag === "input" && name === "type")
				keep = Object.hasOwn(INPUT_TYPES, attr.value.toLowerCase());
			if (!keep) {
				// The file's own toggles (`onclick="this.classList.toggle('expanded')"`) survive as data the listener below reads.
				const toggle = name === "onclick" ? TOGGLE.exec(attr.value.trim()) : null;
				el.removeAttribute(attr.name);
				if (toggle && !svg) el.setAttribute("data-omp-toggle", toggle[1]);
			}
		}
		if (!svg && tag === "a") {
			if (el.hasAttribute("href")) {
				el.setAttribute("target", "_blank");
				el.setAttribute("rel", "noopener noreferrer");
			}
		}
		if (!svg && tag === "input" && !Object.hasOwn(INPUT_TYPES, (el.getAttribute("type") ?? "").toLowerCase()))
			el.remove();
	}

	/** Make the children of `parent` safe, in place. */
	function cleanChildren(parent: Node): void {
		for (const child of Array.from(parent.childNodes)) {
			if (child.nodeType === 3) continue;
			if (child.nodeType !== 1) {
				child.parentNode?.removeChild(child);
				continue;
			}
			const el = child as Element;
			const tag = el.localName;
			const ns = el.namespaceURI;
			if (ns === SVG_NS) {
				if (!Object.hasOwn(SVG_TAGS, tag)) {
					el.remove();
					continue;
				}
			} else if (ns !== HTML_NS || Object.hasOwn(DROP, tag)) {
				el.remove();
				continue;
			} else if (!Object.hasOwn(TAGS, tag)) {
				cleanChildren(el);
				el.replaceWith(...Array.from(el.childNodes));
				continue;
			}
			if (ns === HTML_NS && tag === "img") {
				const given = el.getAttribute("src") ?? "";
				if (given.trim() === "") {
					// An image with no address yet (the viewer's enlarged-image box) loads nothing: it stays, without one.
					el.removeAttribute("src");
				} else if (safeSrc(given) === null) {
					// Never loaded: what it would have shown is named instead.
					const shown = el.ownerDocument.createElement("span");
					shown.setAttribute("class", "omp-blocked-image");
					shown.textContent = `[image not loaded: ${el.getAttribute("alt") ?? ""}]`;
					el.replaceWith(shown);
					continue;
				}
			}
			cleanAttributes(el);
			if (el.isConnected || el.parentNode) cleanChildren(el);
		}
	}

	const proto = Element.prototype;
	const inner = Object.getOwnPropertyDescriptor(proto, "innerHTML");
	const outer = Object.getOwnPropertyDescriptor(proto, "outerHTML");
	const adjacent = proto.insertAdjacentHTML;
	if (!inner?.set || !outer?.set) return;
	const parseInto = inner.set;

	/** `html` as the clean nodes it makes in the context of `context`, parsed in a document that loads and runs nothing. */
	function cleanNodes(context: Element, html: string): Node[] {
		const doc = document.implementation.createHTMLDocument("");
		const tag = context.localName === "template" ? "div" : context.localName;
		const holder =
			context.namespaceURI === HTML_NS || context.namespaceURI === null
				? doc.createElement(tag)
				: doc.createElementNS(context.namespaceURI, tag);
		// The page's own toggles are named before parsing: an inline handler the policy refuses is reported even in a
		// document that never runs it, once per element.
		parseInto.call(holder, html.replace(OWN_TOGGLE, 'data-omp-toggle="$1"'));
		cleanChildren(holder);
		return Array.from(holder.childNodes);
	}

	Object.defineProperty(proto, "innerHTML", {
		configurable: true,
		enumerable: inner.enumerable,
		get: inner.get,
		set(this: Element, value: unknown) {
			const html = value === null ? "" : String(value);
			const into = this instanceof HTMLTemplateElement ? this.content : this;
			into.replaceChildren(...(html === "" ? [] : cleanNodes(this, html)));
		},
	});
	Object.defineProperty(proto, "outerHTML", {
		configurable: true,
		enumerable: outer.enumerable,
		get: outer.get,
		set(this: Element, value: unknown) {
			const parent = this.parentElement;
			if (!parent) return;
			this.replaceWith(...cleanNodes(parent, String(value)));
		},
	});
	proto.insertAdjacentHTML = function (this: Element, position: InsertPosition, value: string): void {
		const where = String(position).toLowerCase();
		const outside = where === "beforebegin" || where === "afterend";
		const context = outside ? this.parentElement : this;
		const known = outside || where === "afterbegin" || where === "beforeend";
		if (!known || !context) {
			// What the browser does with an unknown position or a root element: its own error.
			adjacent.call(this, position, "");
			return;
		}
		const nodes = cleanNodes(context, String(value));
		if (where === "beforebegin") this.before(...nodes);
		else if (where === "afterend") this.after(...nodes);
		else if (where === "afterbegin") this.prepend(...nodes);
		else this.append(...nodes);
	};
	Range.prototype.createContextualFragment = function (this: Range, value: string): DocumentFragment {
		const node = this.startContainer;
		const context = node instanceof Element ? node : (node.parentElement ?? document.documentElement);
		const fragment = document.createDocumentFragment();
		fragment.append(...cleanNodes(context, String(value)));
		return fragment;
	};

	// The file's inline `onclick` toggles, as one listener: a click runs the toggle of every ancestor that has one, as the
	// handlers did.
	document.addEventListener("click", (event) => {
		for (let el = event.target instanceof Element ? event.target : null; el; el = el.parentElement) {
			const name = el.getAttribute("data-omp-toggle");
			if (name === "expanded" || name === "collapsed") el.classList.toggle(name);
		}
	});

	// `marked` turns the model's Markdown into HTML. Raw HTML in it is shown as text, a link keeps only a safe address, an
	// image only an inline one, and the first parse installs that on top of what the page configured for itself. A released
	// omp's viewer (18.14 and later) has its own fork instead, `ompMarkdown.Marked`, of which it makes instances: each one
	// gets the same on its first parse.
	let marked: unknown;
	type Token = { text?: string; raw?: string; href?: string; title?: string | null; tokens?: unknown[] };
	type Parser = { parseInline(tokens: unknown[]): string };
	const hardened = new WeakSet<object>();
	function harden(lib: { use?: (extension: unknown) => unknown }): void {
		if (hardened.has(lib) || typeof lib.use !== "function") return;
		hardened.add(lib);
		try {
			lib.use({
				renderer: {
					html(token: Token): string {
						return escapeText(token.text ?? token.raw ?? "");
					},
					link(this: { parser: Parser }, token: Token): string {
						const inline = this.parser.parseInline(token.tokens ?? []);
						const href = safeHref(token.href ?? "");
						if (href === null) return inline;
						const title = token.title ? ` title="${escapeText(token.title)}"` : "";
						return `<a href="${escapeText(href)}"${title} target="_blank" rel="noopener noreferrer">${inline}</a>`;
					},
					image(token: Token): string {
						const src = safeSrc(token.href ?? "");
						const alt = escapeText(token.text ?? "");
						if (src === null) return `[image not loaded: ${alt}]`;
						return `<img src="${escapeText(src)}" alt="${alt}">`;
					},
				},
			});
		} catch {
			// The sanitiser and the page's policy still hold.
		}
	}
	/** `lib` with `harden` run on it before its first parse. */
	function guarded<T extends object>(lib: T): T {
		return new Proxy(lib, {
			get(target, key, receiver) {
				const value = Reflect.get(target, key, receiver);
				if ((key !== "parse" && key !== "parseInline") || typeof value !== "function") return value;
				return function (this: unknown, ...args: unknown[]) {
					harden(target);
					return value.apply(this, args);
				};
			},
		});
	}
	Object.defineProperty(window, "marked", {
		configurable: true,
		enumerable: true,
		get: () => marked,
		set(lib: unknown) {
			marked = typeof lib === "object" && lib !== null ? guarded(lib) : lib;
		},
	});
	let markdown: unknown;
	Object.defineProperty(window, "ompMarkdown", {
		configurable: true,
		enumerable: true,
		get: () => markdown,
		set(lib: unknown) {
			const Marked = typeof lib === "object" && lib !== null ? Reflect.get(lib, "Marked") : undefined;
			if (typeof Marked !== "function") {
				markdown = lib;
				return;
			}
			const Hardened = new Proxy(Marked, {
				construct: (target, args, newTarget) => guarded(Reflect.construct(target, args, newTarget)),
			});
			markdown = new Proxy(lib as object, {
				get: (target, key, receiver) => (key === "Marked" ? Hardened : Reflect.get(target, key, receiver)),
			});
		},
	});
}
