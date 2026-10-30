import { highlightToHtml } from "./highlighter.ts";

/** Tokenising a block takes tens of milliseconds, the first block of a language more: it happens here, not on the page's thread. */

interface Request {
	id: number;
	code: string;
	lang: string;
}

self.onmessage = async (e: MessageEvent<Request>) => {
	const { id, code, lang } = e.data;
	try {
		postMessage({ id, html: await highlightToHtml(code, lang) });
	} catch {
		postMessage({ id, html: null });
	}
};
