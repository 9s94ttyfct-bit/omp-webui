import type { LiveInfo } from "@shared/protocol.ts";
import type { QuotaFloorSettings } from "@shared/quota-floor.ts";
import { useApp } from "../store/app.ts";
import { withInfo } from "../store/live.ts";
import { socket } from "./ws.ts";

/**
 * The quota floor (#652): the floors of each provider, and a conversation's "Continue anyway". Used only by lazy chunks (the
 * settings card and the line a held conversation shows), so none of it is in the first load. A request the server refuses
 * (a floor outside 1–99, say: HTTP 422) is an error with the server's own words.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : res.statusText);
	return body as T;
}

export const quotaFloorApi = {
	/** The floor of each provider that has one (percent of a window that is left). */
	get: () => request<QuotaFloorSettings>("/api/quota-floor"),
	/** Set a provider's floor, or take it away with `null`. The answer is every floor, as `get` says them. */
	set: (provider: string, floor: number | null) =>
		request<QuotaFloorSettings>("/api/quota-floor", {
			method: "POST",
			headers: { "content-type": "application/json", "x-omp-webui": "1" },
			body: JSON.stringify({ provider, floor }),
		}),
	/**
	 * "Continue anyway" (`on`) or "Hold again" for a conversation. The answer is what its pages are told now, which is shown at
	 * once (the `live` frame that says the same follows).
	 */
	override: async (liveId: string, on: boolean): Promise<void> => {
		const info = await socket.request<LiveInfo>({ t: "quota_override", liveId, on });
		useApp.setState((s) => {
			const live = s.lives[liveId];
			return live ? { lives: { ...s.lives, [liveId]: withInfo(live, info) } } : s;
		});
	},
};
