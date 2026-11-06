import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext } from "@playwright/test";

/**
 * The scripts a released omp's export loads instead of inlining them (its viewer, `marked`, `highlight.js`), each a
 * `<script src>` pinned by an `integrity` hash, kept here so that a test opens an export without the network: the genuine
 * files, fetched once and checked against their hashes, then served from this folder (git ignores it; CI keeps it between
 * runs). A file is named by its hash, so another omp's scripts sit beside these.
 */
export const EXPORT_VIEWER_CACHE = fileURLToPath(new URL("../e2e/.cache/export-viewer/", import.meta.url));

/** Written when a script had to be fetched: CI then saves the folder for the next runs. */
export const EXPORT_VIEWER_FETCHED = join(EXPORT_VIEWER_CACHE, "fetched");

const FETCH_TIMEOUT_MS = 30_000;

/** A pinned script: where the export loads it from, and the hash the browser checks it against (`sha256-…`). */
interface Pinned {
	src: string;
	integrity: string;
}

/** The external scripts `file` pins by Subresource Integrity: the only addresses an export may load. */
export function pinnedScripts(file: string): Pinned[] {
	const out: Pinned[] = [];
	for (const [tag] of readFileSync(file, "utf8").matchAll(/<script\b[^>]*>/g)) {
		const integrity = / integrity="(sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2})"/.exec(tag)?.[1];
		const src = / src="(https:\/\/[^"]+)"/.exec(tag)?.[1];
		if (integrity && src) out.push({ src, integrity });
	}
	return out;
}

/** Whether `body` is what `integrity` names. */
function matches(body: Buffer, integrity: string): boolean {
	const [algorithm, digest] = integrity.split(/-(.*)/s);
	return (
		createHash(algorithm as string)
			.update(body)
			.digest("base64") === digest
	);
}

/** One pinned script's bytes: from the cache, else from its address (then kept). Throws saying which, and why, when neither has it. */
async function scriptOf({ src, integrity }: Pinned): Promise<Buffer> {
	const cached = join(EXPORT_VIEWER_CACHE, `${integrity.replace(/\//g, "_").replace(/\+/g, "-")}.js`);
	if (existsSync(cached)) {
		const body = readFileSync(cached);
		if (matches(body, integrity)) return body;
	}
	let body: Buffer;
	try {
		const res = await fetch(src, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		body = Buffer.from(await res.arrayBuffer());
	} catch (e) {
		throw new Error(
			`The export's pinned script ${src} is not in ${EXPORT_VIEWER_CACHE} and could not be fetched (${(e as Error).message}): run the test once with the network to keep it there`,
		);
	}
	if (!matches(body, integrity)) throw new Error(`${src} as fetched is not the script the export pins (${integrity})`);
	mkdirSync(EXPORT_VIEWER_CACHE, { recursive: true });
	const part = `${cached}.${process.pid}.part`;
	writeFileSync(part, body);
	renameSync(part, cached);
	writeFileSync(EXPORT_VIEWER_FETCHED, "");
	return body;
}

/**
 * Serve the scripts the export `file` pins from the cache in `context`, as their address would (CORS, which a script with
 * `crossorigin` and `integrity` needs): the browser checks them against the hashes as ever. Returns their addresses.
 */
export async function serveExportViewer(context: BrowserContext, file: string): Promise<string[]> {
	const pinned = pinnedScripts(file);
	const bodies = await Promise.all(pinned.map(scriptOf));
	for (const [i, { src }] of pinned.entries())
		await context.route(src, (route) =>
			route.fulfill({
				status: 200,
				contentType: "text/javascript; charset=utf-8",
				headers: { "access-control-allow-origin": "*" },
				body: bodies[i],
			}),
		);
	return pinned.map((p) => p.src);
}
