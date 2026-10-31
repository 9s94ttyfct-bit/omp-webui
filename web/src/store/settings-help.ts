import type { SettingsHelpState } from "@shared/settings-help.ts";
import { create } from "zustand";

/**
 * Ask agent for help (Settings) as the page sees it: which conversations may change settings and until when, the changes
 * that wait for the person's Allow or Deny, and the log of what was changed. The server owns all of it
 * (`server/settings-help/`) and tells the pages on this computer every change (`settings_help`); the socket's message lands
 * here, so this is in the first chunk and imports nothing but the store library. What shows it and acts on it
 * (`components/SettingsHelp.tsx`, `lib/settings-help.ts`) is loaded with Settings or with the dedicated conversation.
 */
export const useSettingsHelp = create<{ state: SettingsHelpState | null }>(() => ({ state: null }));

/** The socket's `settings_help` message, and the answer of every request that returns the state. */
export function setSettingsHelpState(state: SettingsHelpState): void {
	useSettingsHelp.setState({ state });
}
