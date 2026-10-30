import type { RemoteSnapshot } from "@shared/remote.ts";
import "../i18n/later.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { attachLive, useApp } from "../store/app.ts";
import { remoteApi } from "./remote.ts";
import { socket } from "./ws.ts";

/**
 * "Set up with AI" (Settings › Remote access): the AI helps with the set-up in a conversation of its own. The server
 * turns the switch on and starts the conversation with the remote access tools (`RemoteAi.start`); this opens it and
 * sends the starting prompt, in the language of the page, with where the set-up stands now.
 */

const TUNNEL_STATE: Record<RemoteSnapshot["status"]["state"], MessageKey> = {
	off: "remote.stateOff",
	starting: "remote.stateStarting",
	connected: "remote.stateConnected",
	error: "remote.stateError",
};

/**
 * The first message of the conversation, in the language of the page, with where the set-up stands. That is only what the
 * agent would read from the status tool anyway, and no secrets: whether the AUD is set, and how many addresses, not what they are.
 */
export function startingPrompt(s: RemoteSnapshot): string {
	const { config } = s;
	const no = t("remote.aiNo");
	const unset = t("remote.aiUnset");
	const state = [
		t("remote.aiStateTools", {
			installed: s.installed ? t("remote.aiYes") : no,
			login: s.loggedIn ? t("remote.aiYes") : no,
		}),
		t("remote.aiStateSettings", {
			hostname: config.hostname || unset,
			team: config.team || unset,
			aud: config.aud ? t("remote.aiSet") : unset,
			emails: config.emails.length || unset,
		}),
		t("remote.aiStateTunnel", { state: t(TUNNEL_STATE[s.status.state]) }),
	].join("\n");
	return t("remote.aiPrompt", { state });
}

/**
 * Start the conversation and open it with the starting prompt. False when it could not be started: the card says why
 * (`useRemote.error`), and nothing is left running.
 */
export async function setUpWithAi(snapshot: RemoteSnapshot): Promise<boolean> {
	const info = await remoteApi.startAi();
	if (!info) return false;
	if (!(await attachLive(info.liveId))) return false;
	try {
		await socket.rpc(info.liveId, { type: "prompt", message: startingPrompt(snapshot) });
	} catch (e) {
		useApp.getState().toast("error", (e as Error).message);
		return false;
	}
	useApp.getState().setView({ kind: "chat", file: null, liveId: info.liveId });
	return true;
}
