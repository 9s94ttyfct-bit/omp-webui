import { webUrl } from "./web-url.ts";

/**
 * What a link of rendered Markdown is. A link opens in a window of its own (`target=_blank`), so it must name somewhere
 * else: a relative address (`docs/README.md`, `/src/a.ts#L10`, the empty address react-markdown leaves for a scheme it
 * refuses) names this page, and a click opened a second copy of the app in a browser, or nothing in the macOS app, which
 * hands only web and mail addresses to the system. Footnote references stay on the page, and so does a link to a section
 * (`#install`), which the Markdown editor's preview scrolls to (its headings have GitHub's ids, `lib/slug.ts`); a
 * conversation's text, whose headings have none, shows it as text.
 */
export type LinkTarget =
	/** A web or mail address: a link that opens elsewhere. */
	| { kind: "open"; href: string }
	/** A footnote reference or its way back: scrolls to the element with this id, in the same message. */
	| { kind: "anchor"; id: string }
	/** A link to a section of the same text (`#install`, the fragment decoded): see `lib/slug.ts`. */
	| { kind: "section"; fragment: string }
	/** Nothing a click could do: the text is shown as it is. */
	| { kind: "none" };

/** What remark-rehype gives a footnote's reference and its definition. */
const FOOTNOTE = /^#user-content-fn(?:ref)?-/;

export function linkTarget(href: string | undefined): LinkTarget {
	if (!href) return { kind: "none" };
	if (href.startsWith("#")) {
		let fragment: string;
		try {
			fragment = decodeURIComponent(href.slice(1));
		} catch {
			return { kind: "none" };
		}
		if (fragment === "") return { kind: "none" };
		return FOOTNOTE.test(href) ? { kind: "anchor", id: fragment } : { kind: "section", fragment };
	}
	// `//host/path` names another host, on the scheme of the page that shows it; it is opened over https.
	const absolute = href.startsWith("//") ? `https:${href}` : href;
	const web = webUrl(absolute);
	if (web !== null) return { kind: "open", href: web };
	try {
		const url = new URL(absolute);
		if (url.protocol === "mailto:") return { kind: "open", href: url.href };
	} catch {
		// Not an address at all: a relative path.
	}
	return { kind: "none" };
}
