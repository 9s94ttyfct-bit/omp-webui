/**
 * Highlighted code for the page: the work is done by `highlight.worker.ts`, started when the first code block
 * asks. Results are kept, so a block that scrolls out of the transcript and back (or renders twice) is not
 * tokenised again and does not flash plain text first.
 */

/** Characters of code and HTML kept; the oldest results go first. */
const CACHE_CHARS = 4_000_000;

const results = new Map<string, string>();
let cached = 0;
const inFlight = new Map<string, Promise<string | null>>();

const keyOf = (code: string, lang: string) => `${lang}\u0000${code}`;

/** The highlighted HTML of `code` if it has been computed already. */
export function highlighted(code: string, lang: string): string | null {
	const key = keyOf(code, lang);
	const html = results.get(key);
	if (html === undefined) return null;
	// Most recently used last.
	results.delete(key);
	results.set(key, html);
	return html;
}

function remember(key: string, html: string): void {
	results.set(key, html);
	cached += key.length + html.length;
	for (const [oldest, value] of results) {
		if (cached <= CACHE_CHARS || oldest === key) break;
		results.delete(oldest);
		cached -= oldest.length + value.length;
	}
}

interface Reply {
	id: number;
	html: string | null;
}

/** The worker, or null once it could not be started: code then stays plain. */
let worker: Worker | null | undefined;
let nextId = 0;
const waiting = new Map<number, (html: string | null) => void>();

function give(id: number, html: string | null): void {
	waiting.get(id)?.(html);
	waiting.delete(id);
}

function start(): Worker | null {
	if (worker !== undefined) return worker;
	try {
		const w = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
		w.onmessage = (e: MessageEvent<Reply>) => give(e.data.id, e.data.html);
		w.onerror = () => {
			// The script did not load or crashed: nothing will answer, so what is waiting stays plain.
			w.terminate();
			worker = null;
			for (const id of [...waiting.keys()]) give(id, null);
		};
		worker = w;
	} catch {
		worker = null;
	}
	return worker;
}

/** `code` as themed HTML, or null when it could not be highlighted (it is then shown as it is). */
export function highlight(code: string, lang: string): Promise<string | null> {
	const key = keyOf(code, lang);
	const done = highlighted(code, lang);
	if (done !== null) return Promise.resolve(done);
	const running = inFlight.get(key);
	if (running) return running;
	const w = start();
	if (!w) return Promise.resolve(null);
	const id = nextId++;
	const request = new Promise<string | null>((resolve) => {
		waiting.set(id, resolve);
		w.postMessage({ id, code, lang });
	}).then((html) => {
		inFlight.delete(key);
		if (html !== null) remember(key, html);
		return html;
	});
	inFlight.set(key, request);
	return request;
}
