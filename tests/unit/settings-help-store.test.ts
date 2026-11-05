import { expect, test } from "bun:test";
import type { SettingsHelpState, SettingsRequest } from "../../shared/settings-help.ts";
import { setSettingsHelpState, useSettingsHelp } from "../../web/src/store/settings-help.ts";

/**
 * Ask agent for help's state as the page holds it (`store/settings-help.ts`): it arrives on the socket (`settings_help`)
 * and as the answer to a request, which is the state as of the request and can arrive after a newer message.
 */

const request: SettingsRequest = {
	id: "r1",
	liveId: "L1",
	key: "ompw.theme",
	old: "dark",
	new: "light",
	askedAt: 1,
	expiresAt: 2,
};
const state = (rev: number, boot: string, requests: SettingsRequest[]): SettingsHelpState => ({
	boot,
	rev,
	folder: "/f",
	grants: [],
	ended: [],
	requests,
	changes: [],
});

test("an answer older than the message the page already took is dropped", () => {
	// The socket says a change waits for the person; then the answer of a GET sent before it arrives.
	setSettingsHelpState(state(5, "run-1", [request]));
	setSettingsHelpState(state(4, "run-1", []));
	expect(useSettingsHelp.getState().state?.requests).toEqual([request]);
});

test("a newer state, or another run of the server's, is taken", () => {
	setSettingsHelpState(state(5, "run-1", [request]));
	setSettingsHelpState(state(6, "run-1", []));
	expect(useSettingsHelp.getState().state?.requests).toEqual([]);
	setSettingsHelpState(state(1, "run-2", [request]));
	expect(useSettingsHelp.getState().state?.requests).toEqual([request]);
});
