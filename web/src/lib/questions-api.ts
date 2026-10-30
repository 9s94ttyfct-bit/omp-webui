import type { LiveUnattended, Question, QuestionList, UnattendedSettings } from "@shared/unattended.ts";
import { useApp } from "../store/app.ts";

/**
 * The routes of unattended mode (#646): the questions the agents filed, the answers, what the agent is told, and one
 * conversation's switch. A request that the server refuses is an error with the server's own words.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : res.statusText);
	return body as T;
}

const WRITE = { "content-type": "application/json", "x-omp-webui": "1" };
const post = <T>(path: string, body: unknown) =>
	request<T>(path, { method: "POST", headers: WRITE, body: JSON.stringify(body) });

export const questionsApi = {
	/** Every question: the open ones first, then the settled ones. */
	list: () => request<QuestionList>("/api/questions"),
	/**
	 * Answer one: the options chosen and what was written. It goes to its conversation as a message; while that works, it
	 * waits for the turn to end (`followUp`) or is steered into it (`steer`).
	 */
	answer: (id: string, answer: { options: string[]; text: string; delivery: "followUp" | "steer" }) =>
		post<{ question: Question }>("/api/questions/answer", { id, ...answer }),
	/** The person has no answer: the question leaves the open list, and the conversation is told nothing. */
	dismiss: (id: string) => post<{ question: Question }>("/api/questions/dismiss", { id }),
	/** What the agent is told while a conversation is unattended. */
	settings: () => request<UnattendedSettings>("/api/unattended"),
	/** Set it (`null`: the shipped text again). */
	saveInstruction: (instruction: string | null) => post<UnattendedSettings>("/api/unattended", { instruction }),
	/** Whether a conversation that has no process now was left unattended. */
	ofFile: (file: string) =>
		request<{ on: boolean }>(`/api/unattended/session?file=${encodeURIComponent(file)}`).then((r) => r.on),
	/**
	 * Turn a running conversation unattended, or back. The answer is what its pages are told now, which is shown at once (the
	 * `live` frame that says the same follows).
	 */
	setLive: (liveId: string, on: boolean) =>
		post<{ on: boolean; unattended: LiveUnattended | null }>("/api/unattended/live", { liveId, on }).then((r) => {
			useApp.setState((s) => {
				const live = s.lives[liveId];
				if (!live) return s;
				const info = { ...live.info };
				if (r.unattended) info.unattended = r.unattended;
				else delete info.unattended;
				return { lives: { ...s.lives, [liveId]: { ...live, info } } };
			});
			return r.on;
		}),
};
