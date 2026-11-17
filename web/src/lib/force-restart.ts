import { attachLiveForFile, useApp } from "../store/app.ts";
import { socket } from "./ws.ts";

/**
 * Force restart (`force_restart`): the turn that runs is aborted, the conversation's omp ended and started again on the same
 * session file; the page follows to the new process. The server refuses a paused conversation. Used by the "This session"
 * panel's Restart and by what asks for a restart to apply a change (the isolated environment's switch and badge).
 */
export async function forceRestart(liveId: string): Promise<void> {
	const file = useApp.getState().lives[liveId]?.info.sessionFile;
	const answer = await socket.request<{ liveId: string }>({ t: "force_restart", liveId });
	if (file) await attachLiveForFile(file, answer.liveId);
}
