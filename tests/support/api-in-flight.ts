import type { Page, Request } from "@playwright/test";

/**
 * The page's requests to the server's API not answered yet, counted from the moment this is called on. A screen that is
 * still loading what it shows (`/api/model-config`, `/api/models`: seconds on a loaded runner) draws again when the answer
 * comes, however long nothing was drawn before it.
 */
export function apiInFlight(page: Page): () => number {
	const open = new Set<Request>();
	page.on("request", (r) => {
		if (new URL(r.url()).pathname.startsWith("/api/")) open.add(r);
	});
	page.on("requestfinished", (r) => open.delete(r));
	page.on("requestfailed", (r) => open.delete(r));
	return () => open.size;
}
