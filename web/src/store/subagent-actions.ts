import "../i18n/later.ts";
import { t } from "../i18n/index.ts";
import { continuePrompt } from "../lib/subagent-continue.ts";
import { socket } from "../lib/ws.ts";
import { useApp } from "./app.ts";

/**
 * Retry a subagent that waits to retry, now (#594). omp has no command for it, so this is two real steps: omp's
 * `cancel_subagent` (the wait ends, the subagent is parked with its transcript), then the request to the main agent
 * to bring it back with `write agent://<id>` (see `continuePrompt`), which is a message in the conversation like any
 * the user sends and takes a turn of the main agent. The request is steered when the agent is in the middle of a turn
 * (omp ignores the flag when it is not). Both go out as the user's own act (`socket.act`), as a click on Stop does: a
 * request sent as one of the page's routine reads is refused by a conversation that is paused, which would leave the
 * subagent stopped and nobody asked. Each step says what came of it: a subagent that was over by then is not an
 * error, and one that is stopped but whose request failed says so and what is left to do, for it stays stopped until
 * the main agent brings it back.
 */
export async function continueSubagent(liveId: string, id: string, name: string): Promise<void> {
	const { toast } = useApp.getState();
	try {
		const r = await socket.act<{ cancelled?: boolean }>(liveId, { type: "cancel_subagent", subagentId: id });
		if (!r.cancelled) {
			toast("info", t("panel.agentNotRunning"));
			return;
		}
	} catch (e) {
		toast("error", (e as Error).message);
		return;
	}
	try {
		await socket.act(liveId, { type: "prompt", message: continuePrompt(id), streamingBehavior: "steer" });
		toast("success", t("panel.agentContinued", { name }));
	} catch (e) {
		toast("error", t("panel.agentContinueAskFailed", { name, error: (e as Error).message }));
	}
}
