import type { GuardDecision } from "@shared/guard.ts";
import { useGuard } from "../store/guard.ts";

/** The transcript files whose decisions were asked for: once each, for as long as the page lives. */
const asked = new Set<string>();

/**
 * Ask the server for what the guard decided about the agent whose transcript is `file` (a conversation's own file, or a
 * subagent's), so that the cards of a conversation that was decided before this page opened it show their verdict. The
 * server answers from its log: no transcript is read. A decision that arrived live is newer and stays. Nothing is asked of a
 * page that came through the tunnel: it is refused.
 */
export function loadGuardDecisions(file: string | undefined | null, remote: boolean): void {
	if (!file || remote || asked.has(file)) return;
	asked.add(file);
	void fetch(`/api/guard/decisions?file=${encodeURIComponent(file)}`)
		.then((res) => (res.ok ? (res.json() as Promise<{ decisions: GuardDecision[] }>) : Promise.reject(new Error())))
		.then(({ decisions }) =>
			useGuard.setState((s) => {
				const byCall = { ...s.byCall };
				for (const d of decisions) if (d.toolCallId && !(d.toolCallId in byCall)) byCall[d.toolCallId] = d;
				return { byCall };
			}),
		)
		// Asked again the next time the conversation is opened.
		.catch(() => asked.delete(file));
}
