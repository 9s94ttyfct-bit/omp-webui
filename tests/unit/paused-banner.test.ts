import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import * as Tooltip from "@radix-ui/react-tooltip";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { noteServerTime } from "../../web/src/lib/server-clock.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

// The page's modules read localStorage as they load; load them after the stubs are in place.
installGlobals();
const { PausedBanner } = await import("../../web/src/components/PausedBanner.tsx");

/**
 * The banner says how long a conversation has been frozen. The server stamps when it froze omp, on the server's clock:
 * a phone or a computer whose clock was set by hand reads that time minutes off, and "Paused" must not say 0ms for a
 * conversation frozen five minutes ago, nor ten minutes for one frozen a second ago.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);
afterEach(() => noteServerTime(0, 0));

/** The banner as a page with this clock renders it, for a conversation the server froze `agoMs` ago. */
function banner(skewMs: number, agoMs: number): string {
	const pageNow = Date.now();
	const serverNow = pageNow + skewMs;
	noteServerTime(serverNow, pageNow);
	return renderToString(
		createElement(
			Tooltip.Provider,
			null,
			createElement(PausedBanner, {
				since: serverNow - agoMs,
				commands: [],
				onResume: () => {},
				onStop: () => {},
				onStopKey: () => {},
			}),
		),
	);
}

/** The banner's title as a page with this clock reads it. */
function title(skewMs: number, agoMs: number): string {
	const html = banner(skewMs, agoMs);
	const match = /Paused · ([^<]+)</.exec(html);
	if (!match) throw new Error(`no title in ${html}`);
	return match[1];
}

test("a conversation frozen less than a second ago has a title and no time", () => {
	const html = banner(0, 200);
	expect(html).toContain(">Paused<");
	expect(html).not.toContain("0ms");
});

test("a page whose clock is behind the server's still counts from when the server froze omp", () => {
	// The server's clock is five minutes ahead: reading its stamp on this page's clock must not give a time in the future.
	expect(title(300_000, 120_000)).toMatch(/^2m 0s$|^1m 59s$/);
});

test("a page whose clock is ahead of the server's does not count the difference as time paused", () => {
	// The server's clock is ten minutes behind: a conversation frozen two seconds ago is two seconds, not ten minutes.
	expect(title(-600_000, 2_000)).toMatch(/^2\.[0-9]s$|^1\.9s$/);
});

test("a page on the server's clock reads the time as it always did", () => {
	expect(title(0, 5_000)).toMatch(/^5\.[0-9]s$|^4\.9s$/);
});
