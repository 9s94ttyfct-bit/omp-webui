import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the launcher hands the browser to open the signed-in page. The address carries the data folder's permanent token, and
 * on Linux every user of the machine can read every process's command line (`/proc/<pid>/cmdline`), where `xdg-open` and a
 * browser it starts keep the address for as long as they run (#287). So there the browser is handed a small page of ours in
 * the data folder (readable by this user only) that sends it on to the address; the token is in that file, never in an
 * argument. Elsewhere other users' arguments are hidden, and the address itself is given.
 */

/** A page of ours that has stood this long is stale: the browser has long read it. */
const STALE_MS = 2 * 60_000;
const PREFIX = "open-";
const SUFFIX = ".html";

/** The page of `url`'s file: it sends the browser on at once, and offers the link where it does not. */
export function redirectPage(url: string): string {
	const attr = url.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
	return `<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0;url=${attr}">\n<title>omp-webui</title>\n<a href="${attr}">Open omp-webui</a>\n`;
}

/** Remove the pages of ours that a launcher that ended before they were taken down left behind. */
export function sweepPages(dir: string, now = Date.now()): void {
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX));
	} catch {
		return;
	}
	for (const name of names) {
		try {
			if (now - statSync(join(dir, name)).mtimeMs > STALE_MS) rmSync(join(dir, name), { force: true });
		} catch {
			// Taken down by another launcher meanwhile.
		}
	}
}

/**
 * What to hand the browser for `url`: on Linux the path of a page in `dir` that sends it on (taken down after a while),
 * anywhere else `url` itself.
 */
export function pageTarget(url: string, linux: boolean, dir: string): string {
	if (!linux) return url;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	sweepPages(dir);
	const file = join(dir, `${PREFIX}${crypto.randomUUID()}${SUFFIX}`);
	writeFileSync(file, redirectPage(url), { mode: 0o600 });
	setTimeout(() => rmSync(file, { force: true }), STALE_MS).unref();
	return file;
}
