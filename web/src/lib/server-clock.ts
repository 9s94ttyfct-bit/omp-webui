/**
 * How far this page's clock is from the server's. A time the server stamped (when omp's backoff began, `LiveRetry`) is
 * on its clock; a page on a phone, or on a computer whose clock was set by hand, can be minutes off, and a countdown or
 * an "overdue" worked out from the server's time against the page's own would be wrong by that much. The server says
 * what time it is when a connection opens (`hello`); what a message takes to arrive is a few milliseconds, well below
 * the seconds the page's judgements care about.
 */
let offsetMs = 0;

/** The server's clock reading `serverNow` was heard now, on this page's clock `pageNow`. */
export function noteServerTime(serverNow: number, pageNow: number = Date.now()): void {
	offsetMs = serverNow - pageNow;
}

/** The server's clock minus this page's: what to subtract from a time the server stamped to read it on this page's clock. */
export function serverOffsetMs(): number {
	return offsetMs;
}
