import type { GuidanceProblem, GuidanceTemplate, GuidanceTemplates, LiveGuidance } from "@shared/model-guidance.ts";
import { useApp } from "../store/app.ts";

/**
 * `/api/model-guidance*` (#641): the templates the person saved, and what one conversation carries. Every route reads for
 * any page with the token (a phone's New chat offers the same templates); a change is answered 403 to a page that is not
 * on this computer, as the guard's settings are.
 */
/** A change the server refused, with its word for why when it has one (`GuidanceProblem`), for the page to say. */
export class GuidanceApiError extends Error {
	constructor(
		message: string,
		readonly problem: GuidanceProblem | null,
	) {
		super(message);
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);
	const body = await res.json().catch(() => ({}));
	if (!res.ok)
		throw new GuidanceApiError(
			typeof body.error === "string" ? body.error : res.statusText,
			typeof body.problem === "string" ? (body.problem as GuidanceProblem) : null,
		);
	return body as T;
}

const WRITE_HEADERS = { "content-type": "application/json", "x-omp-webui": "1" };

/** What a conversation carries, the templates it may pick from, and how many other conversations use each (by id). */
export interface SessionGuidanceAnswer {
	guidance: LiveGuidance | null;
	templates: GuidanceTemplates;
	others: Record<string, number>;
}

export const guidanceApi = {
	/** The templates as the server keeps them, and their revision. */
	templates: () => request<GuidanceTemplates>("/api/model-guidance"),
	/** Save a template by id (a new one is added): the server answers with the whole set. */
	save: (template: GuidanceTemplate) =>
		request<GuidanceTemplates>("/api/model-guidance", {
			method: "POST",
			headers: WRITE_HEADERS,
			body: JSON.stringify({ template }),
		}),
	/** Save into a template that must still exist (#715): one deleted meanwhile is refused, not added again. */
	update: (template: GuidanceTemplate) =>
		request<GuidanceTemplates>("/api/model-guidance", {
			method: "POST",
			headers: WRITE_HEADERS,
			body: JSON.stringify({ template, update: true }),
		}),
	/** Forget a template: conversations that picked it keep the text it stood for. */
	remove: (id: string) =>
		request<GuidanceTemplates>("/api/model-guidance", {
			method: "POST",
			headers: WRITE_HEADERS,
			body: JSON.stringify({ remove: id }),
		}),
	/** Put the shipped templates back as they ship. */
	restore: () => request<GuidanceTemplates>("/api/model-guidance/restore", { method: "POST", headers: WRITE_HEADERS }),
	/** What the conversation a running process holds carries, with the templates. */
	ofLive: (liveId: string) =>
		request<SessionGuidanceAnswer>(`/api/model-guidance/session?live=${encodeURIComponent(liveId)}`),
	/** What a conversation with no process was given when it was last open, with the templates. */
	ofFile: (file: string) =>
		request<SessionGuidanceAnswer>(`/api/model-guidance/session?file=${encodeURIComponent(file)}`),
	/**
	 * Change what a running conversation carries (`null`, or an empty text: none). The answer is what it carries now, which
	 * the page shows at once (the `live` frame that says the same follows).
	 */
	change: (liveId: string, guidance: { template?: string; text?: string } | null) =>
		request<{ guidance: LiveGuidance | undefined }>("/api/model-guidance/live", {
			method: "POST",
			headers: WRITE_HEADERS,
			body: JSON.stringify({ liveId, guidance }),
		}).then(({ guidance: now }) => {
			useApp.setState((s) => {
				const live = s.lives[liveId];
				if (!live) return s;
				const info = { ...live.info };
				if (now) info.guidance = now;
				else delete info.guidance;
				return { lives: { ...s.lives, [liveId]: { ...live, info } } };
			});
			return now;
		}),
	/**
	 * Change what a conversation with no process carries when it is opened next (#715). Its process may have started
	 * meanwhile: the server then changes it there, and the answer says what it carries now either way.
	 */
	changeFile: (file: string, guidance: { template?: string; text?: string } | null) =>
		request<{ guidance: LiveGuidance | null | undefined }>("/api/model-guidance/live", {
			method: "POST",
			headers: WRITE_HEADERS,
			body: JSON.stringify({ file, guidance }),
		}).then(({ guidance: now }) => now ?? null),
};
