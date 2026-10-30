/**
 * A reply too large for one WebSocket message is sent as several, so that the page hears it arrive.
 *
 * A browser tells a page about a WebSocket message once all of it has come in: nothing says that part of one has, and
 * there is no event for the bytes on their way. The page takes a connection that has been silent for 20 s for a dead one
 * (`Socket.look`), and a reply that needs longer than that to arrive (the whole of a conversation of tens of MB, over a
 * link of a few Mbit/s) was answered by giving up on the connection: the page reconnected, asked again, and never got
 * it. Sent in parts of `PART_CHARS`, each is heard as it arrives, which keeps the connection (and the request waiting for
 * the reply, see `Pending.progress`) alive for as long as bytes keep coming, and ends it when they stop.
 *
 * Only a reply omp itself sent in chunks (over 1 MiB, passed on as written: `splitResponse`) is cut, and a smaller one
 * goes in one message as before. A part is a text message `~<req>~<1|0>~<piece>` (the JSON messages all start with `{`):
 * `<piece>` is the next piece of the JSON text of the reply's `data`, as omp wrote it and not escaped, and `1` marks the
 * last. The parts of a reply follow each other in the connection; the reply is complete with the last.
 */

/** The longest piece of a reply in one message, in characters. At 20 KB/s (a link at its worst) one is heard every 7 s. */
export const PART_CHARS = 128 * 1024;

const MARK = "~";

/** The messages that carry a successful reply to `req` whose `data` is the JSON text `data`: one `reply` when it is small. */
export function replyMessages(req: string, data: string, size = PART_CHARS): string[] {
	// A request id that holds the mark would not be found again in a part: such a reply goes whole.
	if (data.length <= size || req.includes(MARK))
		return [`{"t":"reply","req":${JSON.stringify(req)},"ok":true,"data":${data}}`];
	const parts: string[] = [];
	for (let at = 0; at < data.length; ) {
		let end = Math.min(data.length, at + size);
		// A piece never ends inside a surrogate pair: it would not survive being sent as text.
		const last = data.charCodeAt(end - 1);
		if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
		parts.push(`${MARK}${req}${MARK}${end === data.length ? 1 : 0}${MARK}${data.slice(at, end)}`);
		at = end;
	}
	return parts;
}

/** The request a message is a part of a reply to; null for any other message. */
export function partOf(text: string): string | null {
	if (!text.startsWith(MARK)) return null;
	const end = text.indexOf(MARK, 1);
	return end > 1 ? text.slice(1, end) : null;
}

/** What one part of a reply amounts to. */
export interface PartReceived {
	req: string;
	/** The JSON text of the reply's `data` when this was its last part; null while more are to come. */
	data: string | null;
}

/** Puts the parts of replies back together, one connection's worth. */
export class ReplyAssembler {
	private readonly pieces = new Map<string, string[]>();

	/** Take one message that `partOf` named a request for; null for one that is no part. */
	push(text: string): PartReceived | null {
		const req = partOf(text);
		if (req === null) return null;
		const head = req.length + 2;
		const flag = text[head];
		if (text[head + 1] !== MARK || (flag !== "0" && flag !== "1")) return null;
		const list = this.pieces.get(req) ?? [];
		list.push(text.slice(head + 2));
		if (flag === "0") {
			this.pieces.set(req, list);
			return { req, data: null };
		}
		this.pieces.delete(req);
		return { req, data: list.join("") };
	}

	/** Forget what is half received: the connection it came on is over. */
	clear(): void {
		this.pieces.clear();
	}
}
