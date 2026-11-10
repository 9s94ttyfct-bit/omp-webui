import type { SettingsHelpState } from "@shared/settings-help.ts";
import { create } from "zustand";

/**
 * Ask agent for help (Settings) as the page sees it: which conversations may change settings and until when, the changes
 * that wait for the person's Allow or Deny, and the log of what was changed. The server owns all of it
 * (`server/settings-help/`) and tells the person's own pages every change (`settings_help`); the socket's message lands
 * here, so this is in the first chunk and imports nothing but the store library. What shows it and acts on it
 * (`components/SettingsHelp.tsx`, `lib/settings-help.ts`) is loaded with Settings or with the dedicated conversation.
 */
export const useSettingsHelp = create<{ state: SettingsHelpState | null }>(() => ({ state: null }));

/**
 * The socket's `settings_help` message, and the answer of every request that returns the state. The answer is the state
 * as of the request, so one older than the state held (`rev`, within one run of the server: `boot`) is dropped.
 */
export function setSettingsHelpState(state: SettingsHelpState): void {
	useSettingsHelp.setState((s) =>
		s.state !== null && s.state.boot === state.boot && state.rev < s.state.rev ? {} : { state },
	);
}
