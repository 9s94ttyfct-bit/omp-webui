import type { LiveInfo } from "@shared/protocol.ts";
import { socket } from "./ws.ts";

/**
 * Soft stop (#658): ask the server to end the conversation's process when the turn that runs has ended (`on: false` takes
 * it back). The server holds it (`LiveInfo.softStop`), so every page shows it.
 */
export function setSoftStop(liveId: string, on: boolean): Promise<LiveInfo> {
	return socket.request<LiveInfo>({ t: "soft_stop", liveId, on });
}
