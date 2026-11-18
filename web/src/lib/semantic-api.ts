import type { SemanticHit, SemanticStatus } from "@shared/semantic.ts";
import { post } from "./api.ts";

/**
 * Semantic search (`shared/semantic.ts`): its state, its switch, and a search. Loaded only by the settings card and on the
 * sidebar's first search (`import()`), so none of it is in the first load. A request the server refuses (a page that is not
 * the person's own turning it on: 403) is an error with the server's own words.
 */
async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
	const res = await fetch(path, { signal });
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : res.statusText);
	return body as T;
}

export const semanticApi = {
	status: () => get<SemanticStatus>("/api/semantic"),
	/** Turn it on (download, then index), or off (and delete everything it downloaded and made). */
	set: (on: boolean) => post<SemanticStatus>(`/api/semantic/${on ? "on" : "off"}`, {}),
	/**
	 * The conversations closest to `query` by what they are about, one passage of each, with the query they answer; none
	 * while it is off, when it does not answer, or when it was asked again meanwhile (`signal`). Never fails.
	 */
	related: (query: string, limit: number, signal: AbortSignal) =>
		get<SemanticHit[]>(`/api/semantic/search?q=${encodeURIComponent(query)}&conversations=${limit}`, signal).then(
			(hits) => ({ query, hits }),
			() => ({ query, hits: [] as SemanticHit[] }),
		),
};
